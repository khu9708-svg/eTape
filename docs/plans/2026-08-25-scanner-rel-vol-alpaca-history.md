# Scanner REL VOL: Alpaca SIP History Isolated from Charts

**Status:** Approved for Codex Luna Max execution  
**Date:** 2026-08-25  
**Scope:** Scanner Relative Volume (Daily Rate) history acquisition and profile construction only  
**Supersedes:** The archive-backed history-acquisition and initial-availability portions of [2026-08-24-scanner-relative-volume-daily-rate.md](2026-08-24-scanner-relative-volume-daily-rate.md). It does not replace the already-landed UI, WebSocket, filter, or scanner-sync work.

## Goal

Make the Scanner's existing `REL VOL` column available and correct even when:

- `[backfill] intraday_days = 2`;
- the chart uses a deliberately short local intraday history window; and
- scanner symbols need a 15-session same-time baseline.

The calculation remains:

\[
REL\ VOL(t) = \frac{V_{live,current}(04{:}00 \ldots t)}
{mean\left(V_{history,day}(04{:}00 \ldots t)\right)}
\]

Where:

- the numerator is the existing live Moomoo cumulative scanner volume;
- the denominator uses the same ET minute across the preceding 15 NYSE trading sessions;
- normal sessions run from 04:00 ET through the schedule's 20:00 ET data close; and
- `REL VOL` is unavailable (`—`) until a usable profile exists.

This is a time-of-day-relative daily-volume measure, not the legacy provider Volume Ratio and not a percentage.

## Locked decisions

| Area | Decision |
| --- | --- |
| Scanner coverage | Fetch history only for the existing sticky Scanner pool, capped at 30 symbols. Do not fetch for every transient displayed row. |
| Historical source | Use Alpaca SIP historical 1-minute bars only. IEX, demo mode, missing credentials, or an unavailable SIP client leave the value as `—`. |
| Historical storage | Keep raw Alpaca bars process-local: fetch, build a compact profile, then discard the raw bars. Do not store them in `bars_1m` and do not add a table or migration. |
| Baseline dates | Exactly the prior 15 NYSE trading dates from `session.PreviousTradingDay`; weekends and market holidays do not count. |
| Session window | 04:00 ET to each day's schedule `DataClose`: normally 20:00 ET, and the schedule's earlier close on an early-close day. Overnight is excluded. |
| Sparse historical bars | For a qualifying historical day, a missing individual minute contributes zero volume. |
| Empty historical day | If any of the 15 requested dates has no valid in-window bar, the profile is terminally unavailable for that symbol and ET day. Do not use a partial baseline. |
| Early closes | A prior early-close session is valid, but contributes only until its own `DataClose`; it is not a zero-filled denominator sample after that time. |
| Numerator | Preserve the live Moomoo cumulative scanner volume, including pre-market, RTH, and post-market. Do not fetch a delayed Alpaca current-day numerator. |
| Alpaca delay | Preserve the existing hard `now - 16 minutes` cap in `hist/alpaca.Client.Intraday1m`. Scanner requests are exclusively for completed historical sessions, so the cap remains a safety guard rather than a source of current-day delay. |
| Failures | Retry request failures after 1, 5, 15, then 30 minutes (capped). A successful response that cannot form all 15 qualifying days is terminally `—` for that ET day. |
| Publication | On a successful profile build, immediately non-blockingly poke the normal Scanner poller so the standard scanner payload publishes the new value. |
| Charts | Preserve `intraday_days`, `WarmArchive`, `PrepareChart`, archive reads, and chart foreground/background scheduling unchanged. Generic Scanner pool chart prewarming remains in place, but is not an REL VOL input. |
| Configuration/UI | Add no config setting, database schema, WebSocket field, or UI change. The existing column name stays `REL VOL`. |

## Why this is isolated from the local archive

`intraday_days` controls chart-oriented archive retention and must remain free to be small. It cannot reliably provide the 15 prior sessions needed by this calculation.

More importantly, `bars_1m` has no source/feed provenance, and archive upserts do not record an explicit zero for a missing minute. Mixing earlier Moomoo/archive rows with Alpaca SIP rows could turn a genuinely quiet minute into an incorrect denominator. A transient, source-pure Alpaca fetch avoids both failure modes with no migration and no impact on chart loading.

The retained object is only the compact per-symbol REL VOL profile. It is discarded on engine restart and refreshed for each new ET day; raw historical bars are not retained.

## Existing-code evidence

| Existing location | Relevant behavior | Plan consequence |
| --- | --- | --- |
| `engine/internal/backfill/backfill.go` | `WarmArchive` and `PrepareChart` use `Config.IntradayDays`; `PrepareChart` has a separate foreground lane. | Do not alter chart/archive behavior or borrow its retention window for REL VOL. |
| `engine/internal/backfill/window.go` | Intraday retention is based on calendar days. | Do not make this setting a hidden REL VOL lookback. |
| `engine/internal/scan/scan.go` | The Scanner owns a sticky pool, existing REL VOL queue/cache, normal polling, and `poke`. | Reuse this worker lifecycle and publish path; replace only its archive-reader input. |
| `engine/internal/scan/relative_volume.go` | It already derives 15 prior trading dates and calculates same-time values. | Keep the public behavior and reshape profile completeness rules around the locked decisions. |
| `engine/internal/store/bars.go` | `bars_1m` lacks feed provenance and archive range writes cannot express a missing bar as an authoritative zero. | Never use it as the SIP REL VOL baseline. |
| `engine/internal/hist/alpaca/alpaca.go` | `Intraday1m` pages Alpaca bars and clamps any end time at `now - 16m`; its client has a shared 200/minute token bucket. | Reuse this client directly for completed sessions; do not duplicate pagination, rate limiting, or the delay guard. |
| `engine/cmd/etape/main.go` | The resolved Alpaca historical client is currently constructed inside the backfill wiring and Scanner receives `st.ReadBars1m`. | Expose one narrow scanner fetch closure only when the existing resolved feed is SIP. |

## Design

### 1. Keep chart history and Scanner REL VOL history separate

Do not change:

- `backfill.Config.IntradayDays`;
- `backfill.PrepareChart`;
- `backfill.WarmArchive`;
- `backfillOne`;
- `hub.SetHistoryWarm`;
- chart archive reads or the foreground chart-loading lane; or
- the existing generic `p.backfill(sym)` invocation when the sticky Scanner pool admits a symbol.

That generic pool backfill continues to prewarm chart data exactly as it does today. REL VOL must not wait for it, read from it, or extend it.

### 2. Supply Scanner a direct, SIP-only historical fetch function

In `engine/cmd/etape/main.go`, retain the resolved Alpaca historical client long enough to construct a small context-aware closure matching the existing `Client.Intraday1m` call. Pass that closure into `startPollers` and then `scan.New`.

Only create/pass it when all of the following are true:

1. the application is not in demo mode;
2. the existing Alpaca historical client was successfully configured; and
3. its configured feed is SIP.

Otherwise pass `nil`; the Scanner leaves REL VOL unavailable. Do not add a provider interface, alternate IEX fallback, config field, or new client.

Hoist/reuse the already-resolved Alpaca client rather than creating a second client. This preserves its existing pagination, request throttling, credentials path, and 16-minute safety clamp.

### 3. Fetch one bounded completed-history range per pooled symbol

When a current ET-day pool member lacks a profile:

1. derive its exact 15 prior trading dates with the existing `relativeVolumeDays(now)`;
2. request one inclusive historical range from the oldest date at 04:00 ET through the newest date's schedule `DataClose` boundary;
3. pass the range to Alpaca `Intraday1m`;
4. build the in-memory profile from the returned bars; and
5. discard the returned raw slice after the profile is built.

The requested 15 normal-session windows contain at most 14,400 one-minute slots, so Alpaca's existing 10,000-bar pagination makes this normally two page requests per symbol. With the 30-symbol pool, the initial cold start is at most roughly 60 page calls before any retry; the shared client token bucket remains the final rate guard.

Never request current-day history. This preserves the `now - 16m` hard limit and avoids blending delayed Alpaca volume into the live numerator.

### 4. Build a strict, source-pure cumulative profile

Refine `buildRelativeVolumeProfile` in `engine/internal/scan/relative_volume.go`:

1. Bucket fetched bars by ET trading date and minute offset from 04:00.
2. Ignore bars outside the requested date/session window and retain the existing bar validity checks.
3. For each expected historic trading date, determine that date's own `DataClose` from the exchange schedule.
4. Treat a date as qualifying only if it has at least one valid in-window bar. If any of the 15 dates is non-qualifying, return an unavailable profile rather than averaging fewer days.
5. For every qualifying date, materialize missing eligible minute offsets as zero volume.
6. Convert each date's minute volumes to cumulative volume using the existing candle-boundary convention: a value at time `t` includes all completed bars from 04:00 through the same offset used by `relativeVolumeAt`.
7. At each offset, average only the qualifying historical dates whose scheduled session includes that offset. This admits valid early-close days without inventing post-close zero-volume samples.
8. Mark an offset unavailable if it has no eligible historic dates or its resulting denominator is zero.

`relativeVolumeAt` remains the hot-path lookup and division only. It must continue to return `—` outside the 04:00-to-`DataClose` window, before a profile is ready, or when the baseline is zero.

### 5. Preserve a small asynchronous cache with clear retry semantics

Keep the existing Scanner-owned worker/cache/queue rather than adding a service or persistence layer.

- Key cache entries by `(symbol, ET date)`.
- Queue work only for sticky-pool symbols and deduplicate pending work.
- On an Alpaca request error, record the next retry time using 1, 5, 15, then 30-minute delays.
- On a successfully fetched but incomplete/zero-baseline profile, cache terminal unavailability for the current ET day; do not repeatedly refetch it.
- On an ET-date rollover, clear or expire the previous-day entries and queue the current pool again.
- Include the target ET date in queued work or otherwise verify it on completion, so a late previous-day fetch cannot publish into the new day's cache.
- After a valid profile is stored, call the existing non-blocking `p.poke`; do not add a parallel payload, timer, or React state path.

The Scanner poll loop must never block on a history request. Until a profile is ready, its normal row calculation emits `—`.

## File-level execution plan

### 1. `engine/cmd/etape/main.go`

- Locate the existing Alpaca historical client setup presently tied to `cfg.Backfill.Enabled`.
- Refactor only enough to retain the successfully constructed client for Scanner wiring when SIP is configured, without changing daily/intraday backfill chains or their enablement semantics.
- Build the nil-or-SIP direct history closure once.
- Thread that closure through `startPollers` into `scan.New`.
- Keep `backfillOne` and the existing `st.ReadBars1m` behavior for all non-REL-VOL uses untouched; remove `st.ReadBars1m` from the REL VOL path only.
- Add/update focused main wiring tests to prove:
  - SIP produces a non-nil Scanner history fetcher;
  - IEX, missing Alpaca setup, and demo mode produce nil; and
  - scanner wiring does not require `intraday_days >= 15`.

### 2. `engine/internal/scan/scan.go`

- Replace the REL VOL-specific archive-reader dependency with the narrow direct historical fetch closure; use its existing context/cancellation model.
- Do not introduce a one-implementation interface.
- Start the REL VOL worker only when that closure is non-nil.
- Retain the sticky pool admission, generic `backfill` prewarming, existing queue dedupe, normal snapshot refresh, and regular `poke` route.
- Make cache rollover/stale-completion handling explicit using the current ET date.
- Preserve all Scanner hot-path work as an in-memory profile lookup plus division.

### 3. `engine/internal/scan/relative_volume.go`

- Retain `relativeVolumeLookback = 15`, the 04:00 start, session date helpers, and the current same-time lookup convention.
- Replace all-minutes-present validation with per-date qualification:
  - missing minute in a date that has valid data => zero;
  - fully empty expected date => profile unavailable;
  - early close => no denominator contribution after its close.
- Ensure baseline construction requires all 15 dates before a profile is considered complete.
- Keep denominator-zero and unavailable results safe: no Infinity, NaN, zero-filled fake profile, or stale prior-day output.
- Keep timestamps normalized to `America/New_York`; never rely on the machine's local timezone.

### 4. `engine/internal/scan/relative_volume_test.go`

Replace/archive-specific expectations and add deterministic unit coverage for:

- exact 15 previous trading dates across a weekend and market holiday;
- normal 04:00-to-20:00 same-minute cumulative arithmetic;
- existing live numerator behavior for pre-market, RTH, and post-market;
- one missing minute inside an otherwise valid historic date contributing zero;
- one entirely empty expected historic date producing unavailable;
- a zero denominator producing unavailable;
- an early-close date participating before its data close but being absent from later denominator counts;
- ET/DST boundary handling;
- current day excluded from the request/baseline;
- no profile/value outside 04:00-to-current-day `DataClose`.

Update or remove the old partial-profile test: a baseline built from fewer than 15 historic dates is no longer valid.

### 5. `engine/internal/scan/scan_test.go`

- Update `scan.New` construction for the narrow direct fetch closure.
- Test a cold sticky-pool symbol reports `—` without blocking normal scan rows.
- Test only pooled symbols enqueue history work; transient visible rows do not.
- Test a successful fetch builds/stores a profile and triggers a non-blocking normal scan refresh.
- Test the 1/5/15/30-minute retry progression for request errors.
- Test terminal unavailable behavior after a successful but incomplete historical response.
- Test an ET-day rollover and a late stale worker result cannot overwrite the new day's entry.
- Assert the generic Scanner pool chart-prewarm callback is still called independently of REL VOL history fetching.

### 6. `engine/internal/hist/alpaca/alpaca.go` and tests

Do not change the delay clamp or pagination behavior unless a focused test exposes an actual defect. Add a caller-level test if necessary to prove that an old completed-session end time passes through unchanged and that no Scanner request can expand into current-day data.

Keep the existing tests that prove:

- `Intraday1m` caps a current/future end at `now - 16 minutes`; and
- a completed historical end is preserved.

### 7. Documentation after code/test completion

Update these documents in the same execution change:

- `engine/internal/scan/README.md`: REL VOL formula, 15-session SIP profile, bounded Scanner pool, unavailable states, and live numerator.
- `engine/internal/backfill/README.md`: explicitly state that `intraday_days` is chart/archive retention and not REL VOL history.
- `engine/internal/hist/alpaca/README.md`: document direct completed-session scanner profile fetches, reuse of pagination/rate limiting, and the retained delay guard.
- `README.md`: user-facing explanation that REL VOL can populate independently of short chart history and requires Alpaca SIP historical access.
- `docs/external-apis.md`: SIP requirement, 15-minute Alpaca historical delay guard, bounded request behavior, and no persistence of raw Scanner profile inputs.
- `CONTEXT.md`: retain the already-recorded domain glossary semantics; do not duplicate this implementation detail elsewhere in it.

## Required validation

Run focused checks during implementation:

```powershell
cd engine
go test ./internal/hist/alpaca ./internal/scan ./cmd/etape
go test -race ./internal/scan
go build ./cmd/etape
```

Because this changes engine startup wiring and Scanner behavior, then run the repository's CI-equivalent Windows checklist:

```powershell
cd engine
go build ./cmd/etape
go test ./...
mingw32-make gen-ts-check
cd ..\ui
npm test
npm run typecheck
npm run e2e
```

Perform a read-only live smoke check with `[backfill] intraday_days = 2`:

1. Start the engine with valid Alpaca SIP historical credentials.
2. Confirm a newly pooled symbol first shows `—` and the Scanner remains responsive.
3. Confirm it updates through the ordinary Scanner payload after its background profile finishes.
4. Confirm no direct Scanner request writes a range into `bars_1m` (chart archive contents and chart load behavior remain unchanged).
5. Verify pre-market, RTH, and post-market values use live cumulative volume; do not test by relaxing the Alpaca 16-minute cap.
6. Compare one fresh, timestamped Warrior Scanner sample as a reasonableness check, allowing for provider/feed and timestamp differences rather than tuning a hidden multiplier.

## Rollout, observability, and rollback

- Log one concise, rate-limited reason for unavailable REL VOL: no SIP fetcher, request error/retry time, incomplete historical date, or zero baseline. Do not log raw bars or a line per minute.
- Track enough counters/log fields to distinguish queued, ready, retrying, and terminal-unavailable pool entries during troubleshooting.
- No schema migration, data repair, cache migration, or UI deployment is needed.
- If a production issue appears, rollback is limited to the Scanner direct-fetch wiring and profile changes. Existing chart backfill, local archive data, and UI continue to operate normally.
- The intentional tradeoff is a fresh bounded Alpaca request after process restart. Add durable profile caching only if measured restart traffic or startup latency proves it necessary; do not preemptively persist raw one-minute bars.

## Execution handoff

Codex Luna Max should implement this in the file order above, keep the diff focused on REL VOL history acquisition/profile rules, and avoid unrelated Scanner cleanup. After all required checks pass, update the listed READMEs, commit the scoped change, and push directly to `main` as required by this repository's agent guide.
