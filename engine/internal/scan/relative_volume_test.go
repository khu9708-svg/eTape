package scan

import (
	"context"
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
	et := s.Date
	start := time.Date(et.Year(), et.Month(), et.Day(), 4, 0, 0, 0, session.Loc())
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

func TestRelativeVolumeUsesExclusiveCurrentMinute(t *testing.T) {
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

func TestRelativeVolumeWorkerRetriesIncompleteAndReusesComplete(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:54")
	var calls atomic.Int32
	p := New(config.Scan{}, nil, nil, clock.NewFake(now), nil, nil, func(string, int64, int64) ([]feed.Bar, error) {
		if calls.Add(1) == 1 {
			bars := allRelativeVolumeBars(now, func(day, _ int) int64 { return int64(day + 1) })
			return bars[:len(bars)-1], nil
		}
		return allRelativeVolumeBars(now, func(day, _ int) int64 { return int64(day + 1) }), nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.runRelativeVolumeWorker(ctx)

	p.enqueueRelativeVolume("US.TEST", now)
	waitForRelativeVolumeCalls(t, &calls, 1)
	waitForRelativeVolumeIdle(t, p, relativeVolumeCacheKey{symbol: "US.TEST", day: session.Schedule(now).Date.UnixMilli()})
	key := relativeVolumeCacheKey{symbol: "US.TEST", day: session.Schedule(now).Date.UnixMilli()}
	p.mu.RLock()
	first := p.relativeVolumeCache[key]
	p.mu.RUnlock()
	if first.complete || first.profile == nil || first.profile.complete {
		t.Fatalf("incomplete archive should publish only a partial profile: %+v", first)
	}

	// Same-minute requests are throttled; the next minute retries the incomplete entry.
	p.enqueueRelativeVolume("US.TEST", now)
	p.enqueueRelativeVolume("US.TEST", now.Add(time.Minute))
	waitForRelativeVolumeCalls(t, &calls, 2)
	waitForRelativeVolumeComplete(t, p, key)
	p.mu.RLock()
	second := p.relativeVolumeCache[key]
	p.mu.RUnlock()
	if !second.complete || second.profile == nil {
		t.Fatalf("complete archive should publish a reusable profile: %+v", second)
	}
	p.enqueueRelativeVolume("US.TEST", now.Add(2*time.Minute))
	if got := calls.Load(); got != 2 {
		t.Fatalf("complete profile should be reused, reader calls=%d", got)
	}
}

func waitForRelativeVolumeCalls(t *testing.T, calls *atomic.Int32, want int32) {
	t.Helper()
	deadline := time.After(time.Second)
	for calls.Load() < want {
		select {
		case <-deadline:
			t.Fatalf("reader calls=%d, want %d", calls.Load(), want)
		default:
			time.Sleep(time.Millisecond)
		}
	}
}

func waitForRelativeVolumeComplete(t *testing.T, p *Poller, key relativeVolumeCacheKey) {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		p.mu.RLock()
		complete := p.relativeVolumeCache[key].complete
		p.mu.RUnlock()
		if complete {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("relative volume profile did not complete")
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

func TestRelativeVolumeUsesAvailableCompleteDays(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:00")
	days := previousRelativeVolumeDays(now)
	bars := append(fullRelativeVolumeDay(days[len(days)-1], func(int) int64 { return 10 }),
		fullRelativeVolumeDay(days[len(days)-2], func(int) int64 { return 20 })...)
	profile, ok := buildRelativeVolumeProfile(now, bars)
	if !ok || profile == nil || profile.complete {
		t.Fatalf("partial profile=%+v ok=%v, want usable incomplete profile", profile, ok)
	}
	if got := relativeVolumeAt(profile, now, 15*363); got == nil || *got != 1 {
		t.Fatalf("relative volume=%v, want 1", valueOfRelativeVolume(got))
	}
}

func TestRelativeVolumeRejectsIncompleteDaysButAcceptsZeroVolume(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:00")
	days := previousRelativeVolumeDays(now)
	valid := fullRelativeVolumeDay(days[len(days)-1], func(i int) int64 {
		if i == 10 {
			return 0
		}
		return 10
	})
	incomplete := fullRelativeVolumeDay(days[len(days)-2], func(int) int64 { return 20 })
	incomplete = incomplete[:len(incomplete)-1]
	profile, ok := buildRelativeVolumeProfile(now, append(valid, incomplete...))
	if !ok || profile == nil || profile.complete {
		t.Fatalf("profile=%+v ok=%v, want one valid incomplete profile", profile, ok)
	}
	if got := profile.counts[363]; got != 1 {
		t.Fatalf("zero-volume day was rejected at minute 363: count=%d", got)
	}
}

func TestRelativeVolumeRejectsNoValidDayAndInvalidValues(t *testing.T) {
	now := relativeVolumeET("2026-07-08 10:03:00")
	if profile, ok := buildRelativeVolumeProfile(now, nil); ok || profile != nil {
		t.Fatalf("empty archive profile=%+v ok=%v, want unavailable", profile, ok)
	}
	days := previousRelativeVolumeDays(now)
	negative := fullRelativeVolumeDay(days[len(days)-1], func(i int) int64 {
		if i == 2 {
			return -1
		}
		return 10
	})
	profile, ok := buildRelativeVolumeProfile(now, negative)
	if ok || profile != nil {
		t.Fatalf("negative volume profile=%+v ok=%v, want unavailable", profile, ok)
	}
	zero := fullRelativeVolumeDay(days[len(days)-1], func(int) int64 { return 0 })
	profile, ok = buildRelativeVolumeProfile(now, zero)
	if !ok || profile == nil {
		t.Fatalf("zero-volume archive should build a profile: ok=%v", ok)
	}
	for _, current := range []int64{-1, 0} {
		if got := relativeVolumeAt(profile, now, current); got != nil {
			t.Fatalf("current volume %d produced %v", current, *got)
		}
	}
	if got := relativeVolumeAt(profile, now, math.MaxInt64); got != nil && (math.IsNaN(*got) || math.IsInf(*got, 0)) {
		t.Fatalf("invalid result=%v", *got)
	}
}

func TestRelativeVolumeHonorsEarlyCloseAndCalendar(t *testing.T) {
	now := relativeVolumeET("2026-11-30 16:30:00")
	bars := allRelativeVolumeBars(now, func(day, _ int) int64 { return int64(day + 1) })
	profile, ok := buildRelativeVolumeProfile(now, bars)
	if !ok || profile == nil {
		t.Fatalf("profile unavailable across Thanksgiving: ok=%v", ok)
	}
	if got := relativeVolumeAt(profile, now, 1); got == nil {
		t.Fatal("early-close history should contribute before its data close")
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

func TestRelativeVolumeRejectsInvalidCurrentTime(t *testing.T) {
	bars := allRelativeVolumeBars(relativeVolumeET("2026-03-09 10:00:00"), func(day, _ int) int64 { return int64(day + 1) })
	profile, ok := buildRelativeVolumeProfile(relativeVolumeET("2026-03-09 10:00:00"), bars)
	if !ok || profile == nil {
		t.Fatal("DST profile unavailable")
	}
	for _, raw := range []string{"2026-03-09 03:59:59", "2026-03-09 20:00:00", "2026-03-08 10:00:00"} {
		if got := relativeVolumeAt(profile, relativeVolumeET(raw), 1); got != nil {
			t.Fatalf("%s produced %v", raw, *got)
		}
	}
}
