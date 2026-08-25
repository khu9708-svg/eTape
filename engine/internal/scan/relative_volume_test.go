package scan

import (
	"context"
	"errors"
	"math"
	"sync/atomic"
	"testing"
	"time"

	"github.com/earlisreal/eTape/engine/internal/clock"
	"github.com/earlisreal/eTape/engine/internal/config"
	"github.com/earlisreal/eTape/engine/internal/feed"
	"github.com/earlisreal/eTape/engine/internal/session"
)

func relativeVolumeET(raw string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04:05", raw, session.Loc())
	if err != nil {
		panic(err)
	}
	return t
}

func fullRelativeVolumeDay(day time.Time, volume func(int) int64) []feed.Bar {
	s := session.Schedule(day)
	start := relativeVolumeSessionStart(s.Date)
	var bars []feed.Bar
	for i, at := 0, start; at.Before(s.DataClose); i, at = i+1, at.Add(time.Minute) {
		bars = append(bars, feed.Bar{Symbol: "US.TEST", BucketMs: at.UnixMilli(), Volume: volume(i)})
	}
	return bars
}

func previousRelativeVolumeDays(now time.Time) []time.Time {
	days := make([]time.Time, relativeVolumeLookback)
	day := session.PreviousTradingDay(now)
	for i := len(days) - 1; i >= 0; i-- {
		days[i] = day
		day = session.PreviousTradingDay(day)
	}
	return days
}

func allRelativeVolumeBars(now time.Time, volume func(int, int) int64) []feed.Bar {
	var bars []feed.Bar
	for dayIndex, day := range previousRelativeVolumeDays(now) {
		bars = append(bars, fullRelativeVolumeDay(day, func(minute int) int64 {
			return volume(dayIndex, minute)
		})...)
	}
	return bars
}

func valueOfRelativeVolume(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func waitForRelativeVolumeCalls(t *testing.T, calls *atomic.Int32, want int32) {
	t.Helper()
	deadline := time.After(time.Second)
	for calls.Load() < want {
		select {
		case <-deadline:
			t.Fatalf("history calls=%d, want %d", calls.Load(), want)
		default:
			time.Sleep(time.Millisecond)
		}
	}
}

func waitForRelativeVolumeIdle(t *testing.T, p *Poller, key relativeVolumeCacheKey) {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		p.mu.RLock()
		pending := p.relativeVolumePending[key]
		p.mu.RUnlock()
		if !pending {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("relative volume request remained pending")
		default:
			time.Sleep(time.Millisecond)
		}
	}
}

func TestRelativeVolumeDaysAreExactlyPriorTradingSessions(t *testing.T) {
	now := relativeVolumeET("2026-07-06 10:00:00")
	got := relativeVolumeDays(now)
	want := []string{
		"2026-06-11", "2026-06-12", "2026-06-15", "2026-06-16", "2026-06-17",
		"2026-06-18", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25",
		"2026-06-26", "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d dates, want %d", len(got), len(want))
	}
	for i, day := range got {
		if got := day.Format("2006-01-02"); got != want[i] {
			t.Fatalf("day[%d]=%s, want %s", i, got, want[i])
		}
	}
	from, to, ok := relativeVolumeHistoryRange(now)
	if !ok || !from.Equal(relativeVolumeET("2026-06-11 04:00:00")) || !to.Equal(relativeVolumeET("2026-07-02 17:00:00")) {
		t.Fatalf("history range=%s..%s/%v", from, to, ok)
	}
}

func TestRelativeVolumeUsesCompletedMinuteAndExcludesCurrentDay(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:54")
	bars := allRelativeVolumeBars(now, func(day, _ int) int64 { return int64(day + 1) })
	profile, ok := buildRelativeVolumeProfile(now, bars)
	if !ok || profile == nil || !profile.complete {
		t.Fatalf("profile unavailable: ok=%v profile=%+v", ok, profile)
	}
	// 04:00 through 10:02 is 363 finalized buckets. The current 10:03
	// bucket, if present, must not affect either side of the calculation.
	if got := relativeVolumeAt(profile, now, 5808); got == nil || *got != 2 {
		t.Fatalf("relative volume=%v, want 2", valueOfRelativeVolume(got))
	}
	withCurrent := append(bars, feed.Bar{Symbol: "US.TEST", BucketMs: relativeVolumeET("2026-07-08 10:03:00").UnixMilli(), Volume: 9_999_999})
	profile, ok = buildRelativeVolumeProfile(now, withCurrent)
	if !ok || profile == nil {
		t.Fatal("current-date bars should not affect the historical profile")
	}
	if got := relativeVolumeAt(profile, now, 5808); got == nil || *got != 2 {
		t.Fatalf("current-date bar changed relative volume=%v, want 2", valueOfRelativeVolume(got))
	}
}

func TestRelativeVolumeMissingMinuteContributesZero(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:00")
	days := previousRelativeVolumeDays(now)
	bars := allRelativeVolumeBars(now, func(_, _ int) int64 { return 10 })
	missingDay := days[0].Format("2006-01-02")
	missingMinute := 10
	filtered := bars[:0]
	for _, bar := range bars {
		et := time.UnixMilli(bar.BucketMs).In(session.Loc())
		day := et.Format("2006-01-02")
		minute := (et.Hour()-relativeVolumeStartHour)*60 + et.Minute()
		if day == missingDay && minute == missingMinute {
			continue
		}
		filtered = append(filtered, bar)
	}
	profile, ok := buildRelativeVolumeProfile(now, filtered)
	if !ok || profile == nil || !profile.complete {
		t.Fatalf("sparse profile unavailable: ok=%v profile=%+v", ok, profile)
	}
	if got := profile.counts[363]; got != relativeVolumeLookback {
		t.Fatalf("sparse day count=%d, want %d", got, relativeVolumeLookback)
	}
	want := float64(14*3630+3620) / relativeVolumeLookback
	if got := profile.means[363]; math.Abs(got-want) > 1e-9 {
		t.Fatalf("baseline=%v, want %v", got, want)
	}
}

func TestRelativeVolumeRequiresAllFifteenDates(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:00")
	days := previousRelativeVolumeDays(now)
	bars := allRelativeVolumeBars(now, func(_, _ int) int64 { return 10 })
	missingDay := days[0].Format("2006-01-02")
	filtered := bars[:0]
	for _, bar := range bars {
		if time.UnixMilli(bar.BucketMs).In(session.Loc()).Format("2006-01-02") != missingDay {
			filtered = append(filtered, bar)
		}
	}
	if profile, ok := buildRelativeVolumeProfile(now, filtered); ok || profile != nil {
		t.Fatalf("missing historical date profile=%+v ok=%v, want unavailable", profile, ok)
	}
}

func TestRelativeVolumeRejectsInvalidValuesAndZeroBaseline(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:00")
	days := previousRelativeVolumeDays(now)
	bars := allRelativeVolumeBars(now, func(_, _ int) int64 { return 10 })
	for i, bar := range bars {
		if time.UnixMilli(bar.BucketMs).In(session.Loc()).Format("2006-01-02") == days[0].Format("2006-01-02") && i%100 == 0 {
			bar.Volume = -1
			bars[i] = bar
			break
		}
	}
	if profile, ok := buildRelativeVolumeProfile(now, bars); ok || profile != nil {
		t.Fatalf("negative volume profile=%+v ok=%v, want unavailable", profile, ok)
	}

	zero := allRelativeVolumeBars(now, func(_, _ int) int64 { return 0 })
	profile, ok := buildRelativeVolumeProfile(now, zero)
	if !ok || profile == nil {
		t.Fatalf("zero-volume history should form all dates: ok=%v", ok)
	}
	if got := relativeVolumeAt(profile, now, 1); got != nil {
		t.Fatalf("zero baseline produced %v", *got)
	}
}

func TestRelativeVolumeHonorsEarlyCloseAndCalendar(t *testing.T) {
	now := relativeVolumeET("2026-11-30 16:30:00")
	bars := allRelativeVolumeBars(now, func(day, _ int) int64 { return int64(day + 1) })
	profile, ok := buildRelativeVolumeProfile(now, bars)
	if !ok || profile == nil {
		t.Fatalf("profile unavailable across Thanksgiving: ok=%v", ok)
	}
	if got := profile.counts[750]; got != relativeVolumeLookback {
		t.Fatalf("early-close day missing before data close: count=%d", got)
	}
	now = relativeVolumeET("2026-11-30 18:00:00")
	profile, ok = buildRelativeVolumeProfile(now, bars)
	if !ok || profile == nil {
		t.Fatalf("profile unavailable after early close: ok=%v", ok)
	}
	if got := profile.counts[840]; got != relativeVolumeLookback-1 {
		t.Fatalf("early-close day contributed after data close: count=%d want=%d", got, relativeVolumeLookback-1)
	}
	if got := relativeVolumeAt(profile, now, 1); got == nil {
		t.Fatal("normal-day history should still provide a denominator after early close")
	}
	if _, ok := buildRelativeVolumeProfile(relativeVolumeET("2026-07-11 10:00:00"), bars); ok {
		t.Fatal("weekend current date must be unavailable")
	}
}

func TestRelativeVolumeHandlesDSTAndBounds(t *testing.T) {
	now := relativeVolumeET("2026-03-09 10:00:00")
	bars := allRelativeVolumeBars(now, func(day, _ int) int64 { return int64(day + 1) })
	profile, ok := buildRelativeVolumeProfile(now, bars)
	if !ok || profile == nil {
		t.Fatal("DST profile unavailable")
	}
	if got := relativeVolumeAt(profile, now, 1); got == nil || math.IsNaN(*got) || math.IsInf(*got, 0) {
		t.Fatalf("DST relative volume=%v", valueOfRelativeVolume(got))
	}
	for _, raw := range []string{"2026-03-09 03:59:59", "2026-03-09 20:00:00", "2026-03-08 10:00:00"} {
		if got := relativeVolumeAt(profile, relativeVolumeET(raw), 1); got != nil {
			t.Fatalf("%s produced %v", raw, *got)
		}
	}
}

func TestRelativeVolumeWorkerStoresProfileAndPokes(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:54")
	var calls atomic.Int32
	ranges := make(chan [2]time.Time, 1)
	p := New(config.Scan{}, nil, nil, clock.NewFake(now), nil, nil, func(ctx context.Context, symbol string, from, to time.Time) ([]feed.Bar, error) {
		if symbol != "US.TEST" || ctx == nil {
			t.Fatal("scanner fetcher received invalid arguments")
		}
		calls.Add(1)
		ranges <- [2]time.Time{from, to}
		return allRelativeVolumeBars(now, func(day, _ int) int64 { return int64(day + 1) }), nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.runRelativeVolumeWorker(ctx)

	p.enqueueRelativeVolume("US.TEST", now)
	waitForRelativeVolumeCalls(t, &calls, 1)
	key := relativeVolumeCacheKey{symbol: "US.TEST", day: session.Schedule(now).Date.UnixMilli()}
	waitForRelativeVolumeIdle(t, p, key)
	p.mu.RLock()
	entry := p.relativeVolumeCache[key]
	p.mu.RUnlock()
	if !entry.complete || entry.profile == nil || !entry.profile.complete {
		t.Fatalf("complete history was not cached: %+v", entry)
	}
	select {
	case <-p.poke:
	case <-time.After(time.Second):
		t.Fatal("successful profile did not poke scanner refresh")
	}
	r := <-ranges
	if !r[0].Equal(relativeVolumeET("2026-06-15 04:00:00")) || !r[1].Equal(relativeVolumeET("2026-07-07 20:00:00")) {
		t.Fatalf("fetch range=%s..%s, want oldest prior day through newest prior close", r[0], r[1])
	}
}

func TestRelativeVolumeWorkerRetriesRequestErrors(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:54")
	var calls atomic.Int32
	p := New(config.Scan{}, nil, nil, clock.NewFake(now), nil, nil, func(context.Context, string, time.Time, time.Time) ([]feed.Bar, error) {
		calls.Add(1)
		return nil, errors.New("temporary")
	})
	clk := p.clk.(*clock.Fake)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.runRelativeVolumeWorker(ctx)

	delays := []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, 30 * time.Minute, 30 * time.Minute}
	key := relativeVolumeCacheKey{symbol: "US.TEST", day: session.Schedule(now).Date.UnixMilli()}
	for i, delay := range delays {
		attemptAt := clk.Now()
		p.enqueueRelativeVolume("US.TEST", attemptAt)
		waitForRelativeVolumeCalls(t, &calls, int32(i+1))
		waitForRelativeVolumeIdle(t, p, key)
		p.mu.RLock()
		entry := p.relativeVolumeCache[key]
		p.mu.RUnlock()
		if got := entry.nextAttempt; !got.Equal(attemptAt.Add(delay)) {
			t.Fatalf("attempt %d retryAt=%s, want %s", i+1, got, attemptAt.Add(delay))
		}
		clk.Advance(delay)
	}
}

func TestRelativeVolumeWorkerTerminallyCachesIncompleteHistory(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:54")
	var calls atomic.Int32
	p := New(config.Scan{}, nil, nil, clock.NewFake(now), nil, nil, func(context.Context, string, time.Time, time.Time) ([]feed.Bar, error) {
		calls.Add(1)
		return nil, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.runRelativeVolumeWorker(ctx)
	key := relativeVolumeCacheKey{symbol: "US.TEST", day: session.Schedule(now).Date.UnixMilli()}
	p.enqueueRelativeVolume(key.symbol, now)
	waitForRelativeVolumeCalls(t, &calls, 1)
	waitForRelativeVolumeIdle(t, p, key)
	p.enqueueRelativeVolume(key.symbol, now.Add(time.Hour))
	time.Sleep(10 * time.Millisecond)
	if got := calls.Load(); got != 1 {
		t.Fatalf("terminal incomplete history was retried, calls=%d", got)
	}
	p.mu.RLock()
	entry := p.relativeVolumeCache[key]
	p.mu.RUnlock()
	if !entry.terminal || entry.complete || entry.profile != nil {
		t.Fatalf("terminal cache entry=%+v", entry)
	}
}

func TestRelativeVolumeWorkerDropsLatePreviousDayResult(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:54")
	clk := clock.NewFake(now)
	started := make(chan struct{})
	release := make(chan struct{})
	p := New(config.Scan{}, nil, nil, clk, nil, nil, func(ctx context.Context, symbol string, from, to time.Time) ([]feed.Bar, error) {
		close(started)
		select {
		case <-release:
			return allRelativeVolumeBars(now, func(day, _ int) int64 { return int64(day + 1) }), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.runRelativeVolumeWorker(ctx)
	key := relativeVolumeCacheKey{symbol: "US.TEST", day: session.Schedule(now).Date.UnixMilli()}
	p.enqueueRelativeVolume(key.symbol, now)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("history worker did not start")
	}
	clk.Advance(24 * time.Hour)
	p.resetIfNewDay(clk.Now())
	close(release)
	waitForRelativeVolumeIdle(t, p, key)
	p.mu.RLock()
	_, present := p.relativeVolumeCache[key]
	p.mu.RUnlock()
	if present {
		t.Fatal("late previous-day profile overwrote the new ET-day cache")
	}
}
