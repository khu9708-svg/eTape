# 10-Second Chart Reported-Price Clarity

Status: approved; implementation not started

## Goal

Make the live 10-second chart explain why its trusted close can differ from the newest Time & Sales print without weakening eTape's trade-report eligibility policy.

When the two values differ, the chart will retain its Last-Eligible Price and add one compact, display-only `Reported 8.464` readout. The result should make the chart and tape visibly consistent while keeping odd lots and other price-ineligible reports from changing OHLC, indicators, execution marks, or orders.

## Observed Behavior and Root Cause

This is a semantic difference, not a clock-synchronization delay:

- The 10-second candle close and execution mark follow the **Last-Eligible Price**.
- Time & Sales contains every **Reported Print**, including reports that are volume-eligible but not price-eligible.
- The top Time & Sales row therefore can be the **Last Reported Price** without being allowed to move the candle.

The 2026-08-26 WVVIP snapshot showed the chart at `8.36` while Time & Sales showed `8.464 × 30`. A read-only OpenD query established the exact sequence, using the exchange timestamps displayed by eTape:

| Time | Price | Size | OpenD condition | Effect |
|---|---:|---:|---|---|
| 04:29:14.597 | 8.3562 | 112 | `AUTO_MATCH` | Last-Eligible Price becomes 8.3562; chart displays 8.36 |
| 04:29:14.830 | 8.4638 | 1 | `ODD_LOT` | Reported and volume-eligible only |
| 04:29:15.079 | 8.4638 | 30 | `ODD_LOT` | Last Reported Price becomes 8.4638; chart close remains 8.3562 |
| 04:29:19.578 | 8.4709 | 104 | `AUTO_MATCH` | Last-Eligible and Last Reported prices converge at display precision |

The two odd-lot rows were visible on tape by design. Their condition made them `rangeEligible=false`, `lastEligible=false`, and `volumeEligible=true`, so they could add volume but could not change open, high, low, close, or the execution mark.

## Historical Eligibility Rationale

Commit `74c847b` (`feat: add trade report eligibility`, 2026-08-14) introduced the current condition-aware policy. The motivating NVDA observation, retained in the [trade-report eligibility specification](../../.scratch/trade-report-eligibility/spec.md), was a `223.123 × 10` print at 10:07:03 among prints near `222.93–222.96`; allowing every report into OHLC produced a false-looking wick.

That older specification also proposed persistent compact condition badges on non-regular tape rows. This approved plan supersedes that presentation detail: badge metadata remains available to the existing optional hover detail, while the visible tape remains Price/Size/Time only.

The historical NVDA print's exact condition cannot be proven because raw ticks were not archived. Its size and location are consistent with an odd lot, but size alone must never infer eligibility. Current code and tests deliberately prove both sides:

- an OpenD odd-lot condition remains visible and contributes eligible volume without changing OHLC or marks;
- the same small trade with an automatic-match condition remains price-forming.

The new readout must preserve this policy. It explains excluded reports; it does not admit them into candle statistics.

## Canonical Language

The repository glossary in [CONTEXT.md](../../CONTEXT.md) owns these terms:

- **Last-Eligible Price** is the trusted price established by the most recent Last-Eligible Print. It remains the candle close and execution reference.
- **Last Reported Price** is the price of the newest Reported Print accepted into Time & Sales order, regardless of eligibility.

“Last price” is too ambiguous for code, documentation, tests, and user-facing explanations involving this distinction.

## Non-Goals

- Do not change the Trade-Report Condition matrix or odd-lot eligibility.
- Do not let Last Reported Price affect candle OHLC, volume, VWAP, indicators, autoscale, execution marks, simulated fills, risk checks, or orders.
- Do not connect adjacent candles visually. A 10-second candle keeps the first Last-Eligible Print in its exchange-time bucket as its true open, even when it differs from the previous close.
- Do not add a horizontal price line, price-axis badge, connector, candle glyph, sound, or notification.
- Do not add badges or persistent condition columns to Time & Sales. Its visible rows remain the existing clean Price/Size/Time layout; the current optional details-on-hover behavior remains unchanged.
- Do not change one-minute or larger timeframes, official K-line inputs, or historical aggregation.
- Do not add a setting, feature flag, provider option, or per-panel Time & Sales coupling.
- Do not make the chart obey a Time & Sales panel's Minimum Trade Size filter. That filter remains panel-local and display-only; it does not redefine the newest Reported Print.
- Do not add raw-tick persistence, a correction journal, a database migration, or archived-bar rewriting.
- Do not change Go wire types or generated TypeScript contracts.

## Current-Code Evidence

- [`engine/internal/md/eligibility.go`](../../engine/internal/md/eligibility.go) centrally stamps independent range, last, and volume permissions. Odd-lot conditions receive volume permission only.
- [`engine/internal/md/tickagg.go`](../../engine/internal/md/tickagg.go) updates range only from Range-Eligible Prints, open/close only from Last-Eligible Prints, and volume only from Volume-Eligible Prints. The first Last-Eligible Print establishes the bucket open.
- [`engine/internal/md/eligibility_test.go`](../../engine/internal/md/eligibility_test.go) contains the deterministic `223.123` odd-lot protection and trusted-prior-close Volume-Only Bar coverage.
- [`engine/internal/md/bars_test.go`](../../engine/internal/md/bars_test.go) covers odd-lot bar aggregation.
- [`ui/src/data/TapeRing.ts`](../../ui/src/data/TapeRing.ts) already provides an O(1), per-symbol `lastTick(symbol)` and per-symbol `getRev(symbol)`. No new store or data model is needed.
- [`ui/src/chrome/panels/registry.tsx`](../../ui/src/chrome/panels/registry.tsx) currently routes bars, indicators, and fills to Chart Panels, but not `md.tape`.
- [`ui/src/chrome/panels/ChartPanel.tsx`](../../ui/src/chrome/panels/ChartPanel.tsx) already polls per-store revisions, tracks Live/Future/Historical viewport mode, derives the same-session eligible price, and updates its legend imperatively.
- [`ui/src/chrome/panels/tv/TVLegend.tsx`](../../ui/src/chrome/panels/tv/TVLegend.tsx) already exposes an imperative update handle and has room beside Volume for a compact readout.
- [`ui/src/render/format.ts`](../../ui/src/render/format.ts) defines `QUOTE_DECIMALS = 3`, matching Time & Sales display precision.
- [`ui/src/render/tape/paintTape.ts`](../../ui/src/render/tape/paintTape.ts) intentionally paints only Price/Size/Time. [`ui/src/chrome/panels/TapePanel.tsx`](../../ui/src/chrome/panels/TapePanel.tsx) uses condition metadata only for the optional hover detail.
- [`engine/internal/feed/feed.go`](../../engine/internal/feed/feed.go) already includes `SubTicker` in Chart Demand. Routing `md.tape` to a Chart Panel therefore does not create another OpenD subscription or alter engine demand.

## Design Decisions

### Candle truth remains condition-aware

The engine remains authoritative for Last-Eligible Price and 10-second OHLC. Last Reported Price is a UI projection from the existing tape ring and cannot feed back into bars or execution.

### Presentation

- Add `Reported 8.464` to the existing second chart-legend row beside Volume.
- Format with `QUOTE_DECIMALS` (three decimals), matching Time & Sales.
- Use the chart's muted neutral colour rather than buy/sell or candle direction colours. The value is informational, not an actionable mark.
- Draw no price line or price-axis badge. An axis badge could collide with the existing close/countdown badge and would either disappear or distort scale for an excluded outlier.

### Visibility

Show the readout only when all of the following are true:

1. the selected timeframe is `10s`;
2. the chart is in Live View or Future Buffer, not Historical View;
3. a current eligible chart reference and a newest per-symbol Reported Print are available; and
4. their three-decimal formatted prices differ.

The readout remains explicitly live while the crosshair inspects another candle. It disappears as soon as a later update makes the two three-decimal values equal. It follows the tape-ring head with no independent timeout, timestamp reordering, or freshness heuristic.

Comparing formatted values is deliberate: differences too small to change either three-decimal quote display add no useful information and must not make the label flicker.

### Scope and state flow

The implementation stays UI-only and imperative:

| Input | Existing owner | New use |
|---|---|---|
| Last-Eligible Price | Engine 10-second bar close | Read only for the comparison |
| Last Reported Price | Per-symbol `TapeRing.lastTick` | Read only for legend text |
| Tape revision | Per-symbol `TapeRing.getRev` | Dirties the matching live 10-second Chart Panel |
| Viewport mode | Existing ChartController callback/ref | Hides the readout in Historical View |

No streaming tick enters React state.

## File-Level Implementation Steps

### 1. Route existing tape updates to Chart Panels

In [`ui/src/chrome/panels/registry.tsx`](../../ui/src/chrome/panels/registry.tsx):

- add `md.tape` to the Chart Panel's topic list;
- retain the existing `chart` demand profile unchanged.

Update [`ui/src/chrome/panels/registry.test.tsx`](../../ui/src/chrome/panels/registry.test.tsx) to pin the new topic list and unchanged demand profile.

### 2. Repaint only the relevant 10-second chart

In [`ui/src/chrome/panels/ChartPanel.tsx`](../../ui/src/chrome/panels/ChartPanel.tsx):

- add a last-seen tape revision beside the existing bar/indicator/fill/drawing cursors;
- read `stores.tape.getRev(currentSymbol)` only for `10s`, so tape traffic does not repaint larger timeframes;
- include viewport-mode changes in the surface dirty check so entering Historical View hides the label even when no market message arrives;
- use the existing same-day eligible-bar selection, `stores.tape.lastTick(currentSymbol)`, and `QUOTE_DECIMALS` to derive either `Reported n.nnn` or no text;
- pass that value through the existing imperative legend update path;
- keep bar synchronization, controller data, price scale, and React state untouched.

Do not introduce a new controller, store, timer, subscription manager, or chart primitive.

### 3. Add one imperative legend cell

In [`ui/src/chrome/panels/tv/TVLegend.tsx`](../../ui/src/chrome/panels/tv/TVLegend.tsx):

- extend the existing legend handle/update input with the optional reported-price text;
- add one empty-by-default span after Volume on the second row;
- write or clear its text imperatively with the rest of the legend cells;
- style it with the existing muted chart colour and numeric font behavior.

No new setting or standalone React component is needed.

### 4. Document the completed flow

When implementing the plan:

- update [`ui/README.md`](../../ui/README.md) to state that a 10-second Chart Panel consumes the bounded tape ring only for the display-only Last Reported Price comparison;
- update [`ui/src/render/chart/README.md`](../../ui/src/render/chart/README.md) with the visibility rules and the guarantee that the readout cannot affect chart data or autoscale;
- leave the Tape Renderer guide unchanged unless implementation changes its current Price/Size/Time or hover behavior—it should not.

No ADR is warranted: this is a small, reversible presentation decision that does not move an architectural boundary.

## Tests

### Focused UI regressions

Extend the existing tests rather than creating a new test harness:

- [`ui/src/chrome/panels/registry.test.tsx`](../../ui/src/chrome/panels/registry.test.tsx): Chart topics include `md.tape`; the demand profile remains `chart`.
- [`ui/src/chrome/panels/tv/TVLegend.test.tsx`](../../ui/src/chrome/panels/tv/TVLegend.test.tsx): the imperative update shows `Reported 8.464` and clears it without React tick state.
- [`ui/src/chrome/panels/ChartPanel.test.tsx`](../../ui/src/chrome/panels/ChartPanel.test.tsx):
  - a tape-only revision for the chart's symbol dirties a live `10s` surface;
  - a foreign symbol's tape revision and any tape revision on `1m` do not dirty it;
  - eligible `8.3562` plus reported odd lot `8.4638` renders `Reported 8.464` without changing candle close;
  - equal three-decimal values suppress the readout;
  - a subsequent eligible/bar update that converges with the tape clears it;
  - Live View and Future Buffer show it, while Historical View hides it;
  - crosshair inspection does not relabel the live Reported Price as historical OHLC.

### Eligibility safety regressions

The engine is unchanged, but rerun its focused protection tests:

```powershell
Set-Location engine
go test ./internal/md -run 'TestOddLotIsVisibleVolumeOnlyAndCannotMovePriceOrMark|TestVolumeOnlyBarUsesTrustedPriorCloseAndDedupsBeforeEligibility' -count=1
```

These tests must continue proving that `223.123` odd lots can contribute volume without moving range, close, or mark.

### Required validation after implementation

Because this executes an approved plan, complete the repository's CI-equivalent Windows checklist from the root README:

```powershell
Set-Location engine
go test ./...
go test -race -short ./...
go vet ./...
golangci-lint run
Set-Location ..
mingw32-make -C engine gen-ts-check
Set-Location ui
npm ci
npm run lint
npm test
npm run build
Set-Location ..
git diff --check
git ls-files --eol '*.go'
```

Report every result and any skipped required check with its reason. Hosted CI remains authoritative and must pass after the eventual push. No live order action is needed for validation.

## Manual Acceptance Scenarios

1. Replay or inject the WVVIP sequence above. The candle remains at the Last-Eligible Price while the second legend row shows `Reported 8.464` after either odd lot.
2. Deliver the later `AUTO_MATCH 8.4709`. The bar updates normally and the Reported readout disappears once both values format to `8.471`.
3. Replay the NVDA `223.123` odd-lot scenario. The print stays on tape and may add volume, but it creates no wick, does not move the mark, and appears only in the chart's neutral Reported readout while it differs.
4. Tag the same small print as `AUTO_MATCH`. It remains eligible, updates the candle normally, and produces no persistent mismatch readout after the bar update.
5. Confirm adjacent 10-second candles retain their real first eligible opens, including genuine gaps from the previous close, with no visual connector.
6. Scroll into Historical View and confirm the Reported readout disappears; return to Live View or Future Buffer and confirm it returns if the mismatch still exists.
7. Confirm one-minute and larger charts, Time & Sales columns, VWAP, indicators, autoscale, execution marks, and order behavior are unchanged.

## Rollout and Rollback

This is a UI-only additive readout with no migration, stored setting, wire change, or historical rewrite. Ship it with the normal UI build after automated and read-only manual validation.

Rollback is a direct revert of the Chart Panel topic/revision/legend changes and documentation. The engine's existing eligibility protection remains in place either way.

## Risks and Mitigations

- **High-frequency React churn:** keep tape revisions and legend writes in the existing imperative scheduler; do not store streamed prices in React state.
- **Cross-symbol repainting:** use the TapeRing's per-symbol revision, matching the existing per-symbol bar strategy.
- **Larger-timeframe churn:** poll tape revisions only for `10s`.
- **Misleading actionable colour:** render Reported Price neutrally and never feed it into price scale, orders, marks, or risk.
- **Narrow chart crowding:** place the short readout on the existing Volume row rather than the already-dense OHLC row or price axis.
- **Out-of-order or cached reports:** follow Time & Sales ordering exactly. The label says Reported, not Eligible, and adds no timestamp heuristic that could silently disagree with tape.
- **Brief eligible-message ordering difference:** if a qualifying tape update reaches the UI before its bar update, the label may appear for one paint and then clear. That accurately exposes the two current read models rather than mutating either one.
- **Panel-local tape filtering:** Minimum Trade Size may hide a print in one Tape Panel, but it remains a Reported Print. Do not couple the Chart Panel to one of potentially several tape configurations.

## Completion Criteria

- The WVVIP mismatch is explained on the live 10-second chart as `Reported 8.464` while OHLC remains condition-correct.
- Odd lots cannot create chart spikes or move execution state.
- Real first eligible opens and genuine inter-bar gaps remain unchanged and unconnected.
- Time & Sales remains the clean Price/Size/Time surface requested by the user.
- The readout is neutral, three-decimal, live-context-only, mismatch-only, and always enabled for `10s`.
- No engine, wire, database, persistence, settings, or larger-timeframe behavior changes.
- Focused tests, the CI-equivalent checklist, documentation updates, and hosted CI all pass before completion.
