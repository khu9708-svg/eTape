package exec

import (
	"context"
	"testing"
	"time"

	"github.com/earlisreal/eTape/engine/internal/clock"
	"github.com/earlisreal/eTape/engine/internal/session"
)

type pollBroker struct {
	venue VenueID
	acct  AccountSnapshot
	read  bool
}

func (b *pollBroker) Capabilities() Capabilities { return Capabilities{CalculatedDayPnL: true} }
func (b *pollBroker) SubmitOrder(context.Context, OrderRequest) (OrderAck, error) {
	return OrderAck{}, nil
}
func (b *pollBroker) ReplaceOrder(context.Context, string, ReplaceRequest) error { return nil }
func (b *pollBroker) CancelOrder(context.Context, string) error                  { return nil }
func (b *pollBroker) CancelAll(context.Context, string) error                    { return nil }
func (b *pollBroker) Flatten(context.Context) error                              { return nil }
func (b *pollBroker) ResetBalance(context.Context, float64) error                { return nil }
func (b *pollBroker) Snapshot(context.Context) (AccountSnapshot, []Position, []Order, error) {
	return b.acct, nil, nil, nil
}
func (b *pollBroker) Events() <-chan BrokerEvent { return nil }

func (b *pollBroker) PollAccount(context.Context) (AccountSnapshot, bool, time.Duration, error) {
	if !b.read {
		return AccountSnapshot{}, true, 0, context.Canceled
	}
	return b.acct, true, time.Millisecond, nil
}

func TestAccountPollerCalculatesCloseToClosePnl(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 9, 2, 14, 0, 0, 0, time.UTC))
	b := &pollBroker{venue: "moomoo-live", read: true, acct: AccountSnapshot{Venue: "moomoo-live", Equity: 125, NetCashFlow: 10}}
	var got []BrokerEvent
	demands := NewAccountDemandRegistry()
	demands.Set(1, "account", b.venue)
	p := NewAccountPoller(AccountPollerConfig{Brokers: map[VenueID]Broker{b.venue: b}, Demands: demands, RiskVenues: map[VenueID]bool{}, Clock: clk, Emit: func(e BrokerEvent) { got = append(got, e) }})
	p.pollOnce(context.Background())
	if len(got) != 2 {
		t.Fatalf("events = %d, want account + freshness", len(got))
	}
	first := got[0].(BrokerAccount).Account
	if first.DayPnL != 0 || !first.DayPnLProvisional || first.DayPnLSource != "calculated" {
		t.Fatalf("first account = %#v", first)
	}
	b.acct.Equity = 140
	p.pollOnce(context.Background())
	second := got[2].(BrokerAccount).Account
	if second.DayPnL != 5 || !second.DayPnLProvisional || second.SodEquity != 125 {
		t.Fatalf("second account = %#v", second)
	}
}

func TestAccountPollerCarriesNearCloseEquityAcrossCycle(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 9, 2, 19, 59, 0, 0, time.UTC))
	venue := VenueID("moomoo-paper")
	b := &pollBroker{venue: venue, read: true, acct: AccountSnapshot{Venue: venue, Equity: 125}}
	demands := NewAccountDemandRegistry()
	demands.Set(1, "account", venue)
	p := NewAccountPoller(AccountPollerConfig{Brokers: map[VenueID]Broker{venue: b}, Demands: demands, Clock: clk, Interval: time.Minute})
	p.pollOnce(context.Background())
	clk.Advance(time.Minute)
	b.acct.Equity = 130
	p.pollOnce(context.Background())
	got := p.baselines[venue]
	if got.Equity != 125 || got.Provisional || got.CycleStartMs != session.TradingCycleStart(clk.Now()).UnixMilli() {
		t.Fatalf("baseline after close = %#v", got)
	}
	// The first post-close snapshot is measured against the captured close.
	if gotAccount := p.last[venue]; gotAccount.DayPnL != 5 || gotAccount.SodEquity != 125 || gotAccount.DayPnLProvisional {
		t.Fatalf("post-close account = %#v", gotAccount)
	}
}
