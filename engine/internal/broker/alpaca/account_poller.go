package alpaca

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/earlisreal/eTape/engine/internal/clock"
	"github.com/earlisreal/eTape/engine/internal/exec"
)

const accountPollInterval = time.Second

type accountPollResult struct {
	venue      exec.VenueID
	generation uint64
	account    exec.AccountSnapshot
	admitted   bool
	rtt        time.Duration
	err        error
}

// AccountPoller is the legacy Alpaca-only poller retained for compatibility
// with older callers. Production wiring uses exec.AccountPoller, which polls
// every live risk venue and each demanded Account panel independently.
type AccountPoller struct {
	clk      clock.Clock
	adapters map[exec.VenueID]*Adapter

	mu         sync.Mutex
	active     exec.VenueID
	generation uint64
	busy       bool
	cancel     context.CancelFunc
	wake       chan struct{}

	healthMu     sync.RWMutex
	healthActive bool
	healthOK     bool
	healthRTT    time.Duration
	changes      chan struct{}
}

func NewAccountPoller(adapters map[exec.VenueID]*Adapter, active exec.VenueID, clk clock.Clock) *AccountPoller {
	if clk == nil {
		clk = clock.System{}
	}
	copyAdapters := make(map[exec.VenueID]*Adapter, len(adapters))
	for venue, adapter := range adapters {
		copyAdapters[venue] = adapter
	}
	_, activeAlpaca := copyAdapters[active]
	return &AccountPoller{
		clk:          clk,
		adapters:     copyAdapters,
		active:       active,
		generation:   1,
		wake:         make(chan struct{}, 1),
		healthActive: activeAlpaca,
		changes:      make(chan struct{}, 1),
	}
}

// SetActiveVenue switches the legacy account source immediately. The request
// context is canceled before the new selection is scheduled; its completion
// is still generation-checked so a transport that ignores cancellation cannot
// publish stale health.
func (p *AccountPoller) SetActiveVenue(venue exec.VenueID) {
	p.mu.Lock()
	if p.active == venue {
		p.mu.Unlock()
		return
	}
	p.active = venue
	p.generation++
	cancel := p.cancel
	p.mu.Unlock()

	_, activeAlpaca := p.adapters[venue]
	p.healthMu.Lock()
	p.healthActive = activeAlpaca
	p.healthOK = false
	p.healthRTT = 0
	p.healthMu.Unlock()
	p.notifyHealth()

	if cancel != nil {
		cancel()
	}
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// Latest implements health's account-health source for legacy callers. New
// wiring uses exec.AccountPoller directly.
func (p *AccountPoller) Latest() (rtt time.Duration, ok, active bool) {
	p.healthMu.RLock()
	defer p.healthMu.RUnlock()
	return p.healthRTT, p.healthOK, p.healthActive
}

func (p *AccountPoller) Changes() <-chan struct{} { return p.changes }

func (p *AccountPoller) notifyHealth() {
	select {
	case p.changes <- struct{}{}:
	default:
	}
}

func (p *AccountPoller) selection() (exec.VenueID, uint64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active, p.generation
}

func (p *AccountPoller) start(ctx context.Context, results chan<- accountPollResult) bool {
	p.mu.Lock()
	if p.busy {
		p.mu.Unlock()
		return false
	}
	venue, generation := p.active, p.generation
	adapter := p.adapters[venue]
	if adapter == nil {
		p.mu.Unlock()
		return false
	}
	requestCtx, cancel := context.WithCancel(ctx)
	p.busy = true
	p.cancel = cancel
	p.mu.Unlock()
	go func() {
		acct, admitted, rtt, err := adapter.pollAccount(requestCtx)
		results <- accountPollResult{
			venue: venue, generation: generation, account: acct,
			admitted: admitted, rtt: rtt, err: err,
		}
	}()
	return true
}

func (p *AccountPoller) finish() {
	p.mu.Lock()
	p.busy = false
	p.cancel = nil
	p.mu.Unlock()
}

func (p *AccountPoller) setHealth(ok bool, rtt time.Duration) {
	p.healthMu.Lock()
	p.healthOK = ok
	p.healthRTT = rtt
	p.healthMu.Unlock()
	p.notifyHealth()
}

func (p *AccountPoller) Run(ctx context.Context) error {
	tick := p.clk.NewTicker(accountPollInterval)
	defer tick.Stop()
	results := make(chan accountPollResult, 1)
	p.start(ctx, results)
	var failed bool
	var failureGeneration uint64

	for {
		select {
		case <-ctx.Done():
			p.mu.Lock()
			if p.cancel != nil {
				p.cancel()
			}
			p.mu.Unlock()
			return ctx.Err()
		case <-p.wake:
			p.start(ctx, results)
		case <-tick.C():
			p.start(ctx, results)
		case result := <-results:
			p.finish()
			venue, generation := p.selection()
			if result.generation != generation || result.venue != venue {
				failed = false
				failureGeneration = generation
				p.start(ctx, results)
				continue
			}
			if !result.admitted {
				continue
			}
			if result.err != nil {
				p.setHealth(false, 0)
				if !failed || failureGeneration != generation {
					slog.Warn("alpaca account poll failed", "venue", venue, "err", result.err)
				}
				failed = true
				failureGeneration = generation
				continue
			}
			p.setHealth(true, result.rtt)
			result.account.Venue = venue
			p.adapters[venue].emit(exec.BrokerAccount{Account: result.account})
			if failed && failureGeneration == generation {
				slog.Info("alpaca account poll recovered", "venue", venue)
			}
			failed = false
		}
	}
}

func (a *Adapter) pollAccount(ctx context.Context) (exec.AccountSnapshot, bool, time.Duration, error) {
	if err := ctx.Err(); err != nil {
		return exec.AccountSnapshot{}, false, 0, err
	}
	start := time.Now()
	acct, admitted, err := a.rest.pollAccount(ctx)
	return acct, admitted, time.Since(start), err
}

// PollAccount exposes the account-only, reserve-aware REST request to the
// engine-wide account poller.
func (a *Adapter) PollAccount(ctx context.Context) (exec.AccountSnapshot, bool, time.Duration, error) {
	acct, admitted, rtt, err := a.pollAccount(ctx)
	acct.Venue = a.venue
	return acct, admitted, rtt, err
}
