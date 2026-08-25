package scan

import (
	"math"
	"time"

	"github.com/earlisreal/eTape/engine/internal/feed"
	"github.com/earlisreal/eTape/engine/internal/session"
)

const (
	relativeVolumeLookback   = 15
	relativeVolumeStartHour  = 4
	relativeVolumeMaxMinutes = 16 * 60
)

// relativeVolumeProfile is built once for an ET date and never mutated after
// publication to the poller cache. counts is separate from means because an
// early-close day may have no sample at a later minute.
type relativeVolumeProfile struct {
	day      int64
	complete bool
	means    [relativeVolumeMaxMinutes]float64
	counts   [relativeVolumeMaxMinutes]int
}

func relativeVolumeSessionStart(day time.Time) time.Time {
	et := day.In(session.Loc())
	return time.Date(et.Year(), et.Month(), et.Day(), relativeVolumeStartHour, 0, 0, 0, session.Loc())
}

func relativeVolumePhase(phase session.Phase) bool {
	return phase == session.PreMarket || phase == session.RTH || phase == session.PostMarket
}

// relativeVolumeMinute returns the wall-clock minute since 04:00 ET. It uses
// the NYSE schedule for the upper boundary so early-close days and DST stay in
// the session package's calendar model.
func relativeVolumeMinute(now time.Time) (int, bool) {
	et := now.In(session.Loc())
	s := session.Schedule(et)
	if !s.TradingDay || !relativeVolumePhase(session.PhaseAt(et)) {
		return 0, false
	}
	start := relativeVolumeSessionStart(s.Date)
	if et.Before(start) || !et.Before(s.DataClose) {
		return 0, false
	}
	minutes := (et.Hour()-relativeVolumeStartHour)*60 + et.Minute()
	if minutes < 0 || minutes >= relativeVolumeMaxMinutes {
		return 0, false
	}
	return minutes, true
}

func relativeVolumeBarMinute(bucketMs int64, schedule session.DaySchedule) (int, bool) {
	et := time.UnixMilli(bucketMs).In(session.Loc())
	if !schedule.TradingDay || et.Year() != schedule.Date.Year() || et.Month() != schedule.Date.Month() || et.Day() != schedule.Date.Day() || et.Second() != 0 || et.Nanosecond() != 0 {
		return 0, false
	}
	minute := (et.Hour()-relativeVolumeStartHour)*60 + et.Minute()
	start := relativeVolumeSessionStart(schedule.Date)
	if minute < 0 || minute >= relativeVolumeMaxMinutes || et.Before(start) || !et.Before(schedule.DataClose) {
		return 0, false
	}
	return minute, true
}

func relativeVolumeDays(now time.Time) []time.Time {
	days := make([]time.Time, relativeVolumeLookback)
	day := session.PreviousTradingDay(now)
	for i := len(days) - 1; i >= 0; i-- {
		days[i] = day
		day = session.PreviousTradingDay(day)
	}
	return days
}

func relativeVolumeArchiveRange(now time.Time) (fromMs, toMs int64, ok bool) {
	et := now.In(session.Loc())
	if !relativeVolumePhase(session.PhaseAt(et)) {
		return 0, 0, false
	}
	days := relativeVolumeDays(et)
	from := relativeVolumeSessionStart(days[0])
	to := session.Schedule(days[len(days)-1]).DataClose.Add(-time.Millisecond)
	return from.UnixMilli(), to.UnixMilli(), true
}

func addRelativeVolume(a, b int64) (int64, bool) {
	if a < 0 || b < 0 || a > int64(1<<63-1)-b {
		return 0, false
	}
	return a + b, true
}

// buildRelativeVolumeProfile accepts only complete historical dates, but it
// may return a usable profile from any non-zero subset of the 15 dates.
func buildRelativeVolumeProfile(now time.Time, bars []feed.Bar) (*relativeVolumeProfile, bool) {
	et := now.In(session.Loc())
	current := session.Schedule(et)
	if !current.TradingDay || !relativeVolumePhase(session.PhaseAt(et)) {
		return nil, false
	}
	days := relativeVolumeDays(et)
	targets := make(map[int64]map[int]int64, len(days))
	for _, day := range days {
		s := session.Schedule(day)
		key := s.Date.UnixMilli()
		targets[key] = map[int]int64{}
	}
	invalid := make(map[int64]bool, len(days))
	validDay := make(map[int64]bool, len(days))
	for _, bar := range bars {
		etBar := time.UnixMilli(bar.BucketMs).In(session.Loc())
		key := time.Date(etBar.Year(), etBar.Month(), etBar.Day(), 0, 0, 0, 0, session.Loc()).UnixMilli()
		buckets, wanted := targets[key]
		if !wanted || invalid[key] {
			continue
		}
		s := session.Schedule(etBar)
		minute, inSession := relativeVolumeBarMinute(bar.BucketMs, s)
		if !inSession {
			continue
		}
		if _, duplicate := buckets[minute]; duplicate || bar.Volume < 0 {
			invalid[key] = true
			continue
		}
		buckets[minute] = bar.Volume
	}

	var sums [relativeVolumeMaxMinutes]float64
	validDays := 0
	for _, day := range days {
		s := session.Schedule(day)
		key := s.Date.UnixMilli()
		buckets := targets[key]
		expected := int(s.DataClose.Sub(relativeVolumeSessionStart(s.Date)) / time.Minute)
		if invalid[key] || expected <= 0 || len(buckets) != expected {
			continue
		}
		var cumulative int64
		var daySums [relativeVolumeMaxMinutes]float64
		valid := true
		for minute := 0; minute < expected; minute++ {
			volume, present := buckets[minute]
			if !present {
				valid = false
				break
			}
			daySums[minute] = float64(cumulative)
			if math.IsInf(daySums[minute], 0) {
				valid = false
				break
			}
			next, ok := addRelativeVolume(cumulative, volume)
			if !ok {
				valid = false
				break
			}
			cumulative = next
		}
		if valid {
			validDays++
			validDay[key] = true
			for minute := 0; minute < expected; minute++ {
				sums[minute] += daySums[minute]
				if math.IsInf(sums[minute], 0) {
					validDay[key] = false
					validDays--
					break
				}
			}
		}
	}
	if validDays == 0 {
		return nil, false
	}
	profile := &relativeVolumeProfile{day: current.Date.UnixMilli(), complete: validDays == relativeVolumeLookback}
	for minute := 0; minute < relativeVolumeMaxMinutes; minute++ {
		// counts are the number of valid historical days that reach this
		// minute. A normal day reaches all 960 buckets; early-close days do not.
		for _, day := range days {
			s := session.Schedule(day)
			expected := int(s.DataClose.Sub(relativeVolumeSessionStart(s.Date)) / time.Minute)
			if expected > minute && validDay[s.Date.UnixMilli()] {
				profile.counts[minute]++
			}
		}
		if profile.counts[minute] > 0 {
			profile.means[minute] = sums[minute] / float64(profile.counts[minute])
			if math.IsNaN(profile.means[minute]) || math.IsInf(profile.means[minute], 0) {
				profile.means[minute] = 0
				profile.counts[minute] = 0
			}
		}
	}
	return profile, true
}

func relativeVolumeAt(profile *relativeVolumeProfile, now time.Time, currentVolume int64) *float64 {
	if profile == nil || currentVolume < 0 {
		return nil
	}
	et := now.In(session.Loc())
	s := session.Schedule(et)
	minute, ok := relativeVolumeMinute(et)
	if !ok || profile.day != s.Date.UnixMilli() || profile.counts[minute] == 0 || profile.means[minute] <= 0 {
		return nil
	}
	value := float64(currentVolume) / profile.means[minute]
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}
