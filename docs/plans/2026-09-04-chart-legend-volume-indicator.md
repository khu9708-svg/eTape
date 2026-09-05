# Chart Legend and Unified Volume Indicator

Status: Approved on 2026-09-04.

This plan replaces the approved-but-unimplemented 2026-09-03 Chart Legend
Visibility Colors plan. The legend presentation work and the Volume merge must
ship together because the old plan deliberately treated built-in `Vol` and the
catalog `VOLUME` indicator as separate displays.

## Goal

Give every Chart Panel one **Volume Indicator** instead of the two overlapping
implementations it has today.

The Volume Indicator is present and visible by default, uses the existing lower
25% band of the price pane, reads the Chart Panel's display bars directly, and
participates in the ordinary indicator lifecycle. It can be hidden, styled,
removed, and re-added, but it cannot be duplicated. Its compact legend label is
`Vol`; the picker, settings dialog, documentation, and domain language use
`Volume`.

Complete the pending legend visibility presentation in the same change:
visible labels use primary chart text, hidden labels use muted text, hidden
values are suppressed, and plotted values retain the colors that identify
them.

## Domain Language

[`CONTEXT.md`](../../CONTEXT.md) defines **Volume Indicator** as the single,
default Chart Indicator that displays each bar's traded share volume. `Vol` is
only its compact Chart Panel legend label. Do not reintroduce “built-in Vol” or
“Volume overlay” as separate concepts.

No ADR is warranted. This is a local, reversible chart-model cleanup rather
than a hard-to-reverse architectural choice.

## Non-Goals

- Do not move Volume into a separate pane or make its 25% band resizable.
- Do not allow multiple Volume Indicator instances.
- Do not retain deleted Volume styling for a later re-add; re-adding uses
  visible directional defaults.
- Do not send Volume through `md.indicator`, `IndicatorStore`, chart-window
  indicator hydration, or React market-data state.
- Do not change candle construction, bar aggregation, other indicator
  calculations, scanner volume fields, or order behavior.
- Do not change the Float legend row, indicator control icons, pane-collapse
  semantics, or chart theme tokens.
- Do not add a dependency, feature flag, database migration, new WebSocket
  message shape, or generated TypeScript edit.
- Do not preserve mixed-version operation between a new engine and an old UI;
  engine and UI ship as one application. A full-application rollback remains
  supported as described below.

## Current-Code Evidence

- [`ui/src/render/chart/ChartController.ts`](../../ui/src/render/chart/ChartController.ts)
  always creates a private histogram during `mount`, fills it from `DisplayBar`
  through `toVolume`, and toggles it through `setVolumeVisible`.
- [`ui/src/chrome/panels/tv/ChartSettingsDialog.tsx`](../../ui/src/chrome/panels/tv/ChartSettingsDialog.tsx)
  exposes the built-in histogram as persisted `chartSettings.volume`, defaulting
  to `true`.
- [`ui/src/render/chart/indicatorSeries.ts`](../../ui/src/render/chart/indicatorSeries.ts)
  also defines `VOLUME` as an ordinary main-pane histogram. The picker can add
  it repeatedly, and its state is persisted in `settings.indicators`.
- [`ui/src/chrome/panels/ChartPanel.tsx`](../../ui/src/chrome/panels/ChartPanel.tsx)
  hydrates every catalog indicator through the engine and independently applies
  `chartSettings.volume`, so both Volume implementations can be active together.
- [`engine/internal/md/ind_calcs.go`](../../engine/internal/md/ind_calcs.go)
  implements `VOLUME` as a stateless copy of `Bar.V`; the UI already has that
  value in its authoritative bar stream.
- The built-in series preserves Chart Panel display semantics: `toVolume`
  omits synthetic No-Trade Bars and Data Gaps and colors real and Volume-Only
  Bars from their candle direction. The engine indicator does not own those
  display-only states.
- [`ui/src/chrome/panels/tv/TVLegend.tsx`](../../ui/src/chrome/panels/tv/TVLegend.tsx)
  always renders a fixed `Vol` row and separately renders every catalog
  indicator, including added `VOLUME` instances with ordinary controls.
- [`ui/src/chrome/panels/tv/legendView.ts`](../../ui/src/chrome/panels/tv/legendView.ts)
  already reads the represented bar's volume and direction, while separately
  looking up catalog indicator values in `IndicatorStore`.
- Built-in presets do not persist a `VOLUME` instance. They rely on the fixed
  default histogram and persist `chartSettings.volume: true`.

## Design Decisions

### One persisted Volume Indicator

Keep `VOLUME` in the UI indicator catalog, but make it a singleton with one
stable per-panel instance ID. The Volume Indicator is included in every new
Chart Panel's initial normalized indicator list.

- While Volume exists, omit it from the indicator picker.
- Removing it removes its legend row and plotted series and makes `Volume`
  available in the picker again.
- Re-adding it creates the stable instance with visible directional defaults;
  no deleted style tombstone is retained.
- Generic indicators remain repeatable and retain their existing IDs and
  ordering.

The persisted `settings.indicators` list is the current model's source of truth
for Volume presence, visibility, and style. Remove Volume from the Chart
Settings UI. Retain `chartSettings.volume: false` only as a write-only rollback
projection for the previous application version; current code must not read it
after migration.

### Volume is a local bar-derived indicator

The controller creates the Volume histogram only when it receives the canonical
`VOLUME` instance. It seeds and incrementally updates that series from the same
`DisplayBar[]` used for candles.

Volume must not:

- call `SubscribeIndicator` or `UnsubscribeIndicator`;
- allocate an `IndicatorStore` key;
- contribute a chart-window `indicatorSeriesKeys` entry;
- wait for indicator hydration; or
- contribute an indicator-store revision to the paint scheduler.

This keeps high-frequency data on the existing imperative bar/controller path
and preserves No-Trade Bar, Volume-Only Bar, and Data Gap behavior.

### Placement and reclaimed geometry

When Volume is visible, retain the existing invisible overlay scale and lower
25% band. Reserve the same band on the right candle scale so candles and the
histogram do not overlap.

When either the whole Volume Indicator or its sole histogram output is hidden,
or when the instance is removed, remove the overlay's visible data and restore
the price scale's ordinary lower margin. No invisible state may leave one
quarter of the Chart Panel blank. Showing or re-adding Volume restores both
scale margins and current data immediately.

Centralize that two-scale update in the controller so add, update, remove,
palette change, chart-type change, and reload cannot disagree about geometry.

### Directional default with a monochrome override

With no custom histogram color, each Volume bar uses the existing `volUp` or
`volDown` palette color according to `close >= open`. Its legend value uses the
same color as the represented bar.

Selecting one color in Volume settings is an explicit monochrome override: all
Volume bars and the represented legend value use that color. The dialog's
Defaults action clears the override and restores directional colors.

Histogram settings expose only controls that affect histograms: `Show` and
`Color`. Do not show inert width or line-style controls for Volume or the MACD
histogram. Existing line slots retain width and line-style controls.

### Unified legend presentation

Keep live legend writes imperative; do not route bar or indicator values
through React state.

- The symbol/timeframe title and `O/H/L/C` labels use primary chart text.
- OHLC values and percentage change retain the represented bar's up/down color.
- Float remains muted.
- Pin the canonical Volume row directly below Float, regardless of indicator
  insertion order. Its label is `Vol`.
- Visible Volume uses a primary label and shows its compact value in the plotted
  bar's directional or monochrome-override color.
- Whole-instance or sole-output hiding makes `Vol` muted and suppresses its
  value. Removing Volume removes the row.
- Other visible indicator labels use primary chart text and their values retain
  configured series colors.
- A wholly hidden indicator keeps only its muted label and hover controls; all
  values and the MACD signal badge are visually suppressed.
- Hiding one output suppresses only that output's value. The other outputs and
  indicator label remain visible.
- A collapsed pane is not a hidden indicator; its legend styling and values do
  not change.

Keep hidden value cells mounted with their existing refs and suppress them with
presentation styles. Imperative updates continue while hidden, so showing a
series reveals current values without a stale frame.

### One-time Chart Panel migration

Add a small persisted chart-indicator model version. Normalize at the Chart
Panel boundary, then immediately persist the normalized indicators, model
version, and rollback projection. Do not introduce a workspace-wide migration
framework.

For an unversioned Chart Panel:

1. Filter unknown catalog types using the existing behavior.
2. Treat missing legacy `chartSettings.volume` as `true`.
3. Find every persisted `VOLUME` instance. An added instance is visible only
   when neither its whole-instance flag nor its `hist` output is hidden.
4. The canonical Volume is visible if either the legacy built-in histogram or
   any added Volume instance was visible.
5. If an added Volume was visible, preserve the first visible instance's valid
   custom histogram color. Otherwise use directional defaults.
6. Replace every old Volume instance with one stable canonical instance,
   discarding duplicates, legacy color containers after projection, and inert
   histogram width/line-style fields.
7. If the old built-in was hidden and no added Volume was visible, retain one
   hidden canonical Volume instance. The old setting represented hiding, not
   removal.
8. Write the current model version and `chartSettings.volume: false` alongside
   the normalized list.

For a versioned Chart Panel, absence of `VOLUME` means the user removed it; do
not recreate it. Still reject duplicate imported instances at the same
normalization seam. Preserve the current canonical instance's visibility and
style rather than reapplying legacy union rules.

Update built-in presets to emit the current version, canonical default Volume
instance, and rollback projection directly. Newly created bare Chart Panels
can use the same normalizer once and persist the result.

### Remove dead engine support

After the UI stops subscribing to `VOLUME`, remove `IndVolume`, the `newCalc`
branch, the stateless Volume calculator, and their test case from the Go market
data package. Keep `VOLUME` as a UI-side `IndicatorType` because it remains a
persisted Chart Indicator.

The `SubscribeIndicator` message shape remains unchanged and generated sources
must not be edited. A new engine should reject an unexpected `VOLUME`
subscription as an unknown type, like any unsupported value.

## File-Level Implementation Steps

### 1. Normalize the indicator model

In [`ui/src/render/chart/indicatorSeries.ts`](../../ui/src/render/chart/indicatorSeries.ts):

- retain the `VOLUME` catalog entry and `IndicatorInstance` shape;
- add the current chart-indicator model version and stable per-panel Volume ID;
- extend the existing catalog filtering seam into one pure normalizer that
  implements the migration and singleton rules above;
- keep migration output minimal: one canonical Volume and unchanged non-Volume
  instances; and
- expose only the small shared Volume visibility/color helpers needed by the
  controller and legend.

Pin normalization with table-driven cases in
[`ui/src/render/chart/indicatorSeries.test.ts`](../../ui/src/render/chart/indicatorSeries.test.ts):

- untouched legacy default;
- legacy built-in hidden;
- visible custom added Volume with built-in visible or hidden;
- all representations hidden;
- multiple added Volume instances;
- unknown indicator types;
- versioned removal that remains removed; and
- versioned canonical state that is idempotent.

### 2. Make Volume controller-owned but bar-derived

In [`ui/src/render/chart/ChartController.ts`](../../ui/src/render/chart/ChartController.ts)
and [`ui/src/render/chart/chartTheme.ts`](../../ui/src/render/chart/chartTheme.ts):

- stop creating a histogram unconditionally in `mount`;
- let `addIndicator(VOLUME)` create the singleton local histogram with the
  existing overlay scale and immediately seed any displayed bars;
- update the optional local histogram beside candle updates and full `setData`
  calls, including display-only gap handling;
- branch Volume out of subscribe, unsubscribe, store reset, reload resubscribe,
  and indicator snapshot logic;
- apply whole-instance and `hist` visibility plus monochrome override changes
  in place, reseeding per-point colors only when needed;
- remove `volumeVisible` and `setVolumeVisible`;
- add the ordinary no-Volume candle margin and one controller helper that keeps
  right and overlay scale margins synchronized; and
- reapply directional colors and geometry correctly across palette and chart
  type changes.

Update [`ui/src/render/chart/ChartController.test.ts`](../../ui/src/render/chart/ChartController.test.ts)
to prove:

- mount creates only the main price series;
- local Volume add seeds bars without a command or store dependency;
- append, tail replacement, full reload, No-Trade Bar, Volume-Only Bar, and Data
  Gap paths update the histogram correctly;
- hiding and removal reclaim the band, while showing and re-adding restore it;
- custom color and Defaults/directional behavior survive live updates and theme
  changes; and
- local Volume removal/disposal sends no unsubscribe command.

### 3. Make the panel persist one lifecycle

In [`ui/src/chrome/panels/ChartPanel.tsx`](../../ui/src/chrome/panels/ChartPanel.tsx):

- initialize `instances` from the pure normalizer and persist one migration
  patch after mount when normalization is required;
- write the model version and `chartSettings.volume: false` compatibility
  projection with subsequent relevant config changes;
- never queue hydration, request chart-window indicator points, read indicator
  revisions, or reset `IndicatorStore` for `VOLUME`;
- use the stable Volume ID and reject an add when the singleton already exists;
- preserve generic remove/hide/settings controls and reset-to-default behavior
  on re-add; and
- remove every `setVolumeVisible` call.

In [`ui/src/chrome/panels/tv/ChartSettingsDialog.tsx`](../../ui/src/chrome/panels/tv/ChartSettingsDialog.tsx),
remove the Volume toggle and the current-model `volume` field while allowing
ChartPanel's persisted legacy projection.

In [`ui/src/chrome/panels/tv/ChartHeaderControls.tsx`](../../ui/src/chrome/panels/tv/ChartHeaderControls.tsx)
and [`ui/src/chrome/panels/tv/IndicatorPickerPopover.tsx`](../../ui/src/chrome/panels/tv/IndicatorPickerPopover.tsx),
omit `Volume` while the canonical instance exists and restore it immediately
after removal. Do not make other indicators singleton.

In [`ui/src/chrome/panels/tv/IndicatorSettingsDialog.tsx`](../../ui/src/chrome/panels/tv/IndicatorSettingsDialog.tsx),
show only `Show` and `Color` for histogram slots. Make the absence of a Volume
override read as directional/default behavior; the existing Defaults action
clears the override.

Update [`ui/src/chrome/presets.ts`](../../ui/src/chrome/presets.ts) so every
built-in Chart Panel starts directly in the current model.

Extend the adjacent component and panel tests to cover default persistence,
picker singleton behavior, remove/re-add defaults, compatibility writes, absence
of Volume hydration keys, the reduced Chart Settings surface, meaningful
histogram settings, and preset output.

### 4. Merge the legend rows and finish visibility colors

In [`ui/src/chrome/panels/tv/legendView.ts`](../../ui/src/chrome/panels/tv/legendView.ts):

- resolve Volume from the represented `DisplayBar`, not `IndicatorStore`;
- use compact volume formatting and the exact plotted directional/custom color;
  and
- keep other indicator lookup and MACD signal behavior unchanged.

In [`ui/src/chrome/panels/tv/TVLegend.tsx`](../../ui/src/chrome/panels/tv/TVLegend.tsx):

- delete the unconditional built-in Volume row;
- render the canonical `VOLUME` instance once after Float with label `Vol` and
  ordinary hover controls;
- exclude it from the remaining overlay-indicator iteration;
- apply the approved primary/muted label and hidden-value rules;
- keep hidden cells mounted for imperative updates; and
- preserve Float, pane controls, and collapsed-pane behavior.

Extend [`ui/src/chrome/panels/tv/legendView.test.ts`](../../ui/src/chrome/panels/tv/legendView.test.ts)
and [`ui/src/chrome/panels/tv/TVLegend.test.tsx`](../../ui/src/chrome/panels/tv/TVLegend.test.tsx)
for direction and custom colors, `Vol` naming/order, whole and sole-output
visibility, removal, primary OHLC labels, per-output hiding, MACD badges,
collapsed panes, and muted Float.

### 5. Delete the redundant engine calculator

In [`engine/internal/md/indicator.go`](../../engine/internal/md/indicator.go),
[`engine/internal/md/ind_calcs.go`](../../engine/internal/md/ind_calcs.go), and
[`engine/internal/md/indicator_test.go`](../../engine/internal/md/indicator_test.go),
remove engine `VOLUME` registration, calculation, and expectations. Retain the
generic unknown-type rejection path.

Update [`ui/src/wire/contract.ts`](../../ui/src/wire/contract.ts) so its
`md.indicator` keying comment lists only the indicator types that actually
stream from the engine. Do not edit
[`ui/src/gen/wsmsg.ts`](../../ui/src/gen/wsmsg.ts); `gen-ts-check` must remain
clean.

### 6. Update durable subsystem guidance

- Update [`ui/README.md`](../../ui/README.md) to distinguish engine-computed
  indicators from the local bar-derived Volume Indicator when describing
  synthetic display bars.
- Update [`ui/src/render/chart/README.md`](../../ui/src/render/chart/README.md)
  with the singleton, bar-derived Volume flow and reclaimed hidden/removed
  geometry.
- Update [`ui/src/chrome/panels/tv/README.md`](../../ui/src/chrome/panels/tv/README.md)
  with unified legend naming, ordering, visibility colors, and imperative value
  updates.
- Keep the root README's `Volume` feature listing; Volume remains a Chart
  Indicator.

## Focused Tests

During implementation, run the smallest checks that cover each changed seam:

```powershell
Set-Location engine
go test ./internal/md
Set-Location ..\ui
npm test -- indicatorSeries ChartController ChartPanel ChartSettingsDialog ChartHeaderControls IndicatorPickerPopover IndicatorSettingsDialog legendView TVLegend
npm run typecheck
Set-Location ..
git diff --check
```

The focused tests must demonstrate that no `VOLUME` subscription, hydration
key, or indicator-store read survives, not merely that the duplicate is hidden
visually.

## Required Validation After Implementation

This approved plan spans engine and UI and changes persisted configuration, so
run the complete CI-equivalent Windows checklist from
[`README.md`](../../README.md#ci-equivalent-validation-on-windows), following
the workflow if they drift:

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

The reported `golangci-lint` version must be `2.12.2`; use the pinned fallback
command documented in the root README if necessary. Hosted CI remains
authoritative. Report every check run and every skipped required check with its
reason.

## Manual Acceptance Scenarios

1. Open a new Chart Panel. Confirm exactly one directional Volume histogram and
   one `Vol` row below Float; confirm the picker does not offer `Volume`.
2. Hover `Vol`, hide it, and confirm its label becomes muted, its value
   disappears, and candles reclaim the lower band. Show it and confirm current
   data and the 25% band return immediately.
3. Remove Volume. Confirm both row and histogram disappear, candles reclaim the
   band, and `Volume` returns to the picker. Re-add it and confirm directional
   defaults return without an old custom color.
4. Select a Volume color. Confirm every histogram bar and the crosshair/latest
   legend value use that color. Use Defaults and confirm up/down colors return.
5. Move the crosshair across ordinary, Volume-Only, No-Trade, and Data Gap
   intervals. Confirm `Vol` matches the represented display bar and no phantom
   engine-indicator values appear.
6. Open Chart Settings and confirm no Volume toggle remains.
7. Add, hide, partially hide, collapse, edit, and remove non-Volume indicators.
   Confirm primary/muted labels, suppressed values, MACD badge behavior, and
   pane behavior match the legend rules without changing series colors.
8. Load representative legacy layouts: built-in visible, built-in hidden,
   custom added Volume, both representations visible, and duplicate added
   Volumes. Confirm each normalizes once to the approved canonical state and
   stays stable after reload.
9. Inspect persisted config after migration and removal. Confirm the model
   version, canonical indicator list, and `chartSettings.volume: false`
   rollback projection are present and unrelated settings are unchanged.
10. Apply every built-in preset and check light and dark themes. Confirm each
    starts with one Volume Indicator and theme changes refresh directional bars
    and legend colors.

No live order, account mutation, or broker action is required.

## Rollout and Rollback

Ship engine and UI together. Each Chart Panel normalizes and persists its state
at its own configuration boundary; no background database or workspace rewrite
runs.

A full rollback restores the previous engine calculator. The retained
`chartSettings.volume: false` projection prevents the old built-in histogram
from plotting underneath the persisted canonical `VOLUME` instance, and a
removed Volume remains absent. The previous UI may still render its fixed
legacy `Vol` legend label according to that version's presentation rules, but
the plotted histogram and persisted user choice remain usable.

Rolling back does not reconstruct duplicate legacy Volume instances discarded
during migration. That loss is intentional: the approved model permits only
one instance.

## Risks and Mitigations

- **Removed Volume reappears after reload:** gate default insertion on the
  persisted model version and test a versioned empty indicator list.
- **A duplicate remains hidden underneath the canonical series:** remove the
  unconditional controller series and assert series creation and commands, not
  only DOM output.
- **Volume waits on or dirties the indicator store:** exclude it from hydration
  keys, revision sums, reset paths, and legend lookups; pin each boundary.
- **Synthetic or gap bars gain false volume:** continue using `toVolume` against
  `DisplayBar` and cover No-Trade Bar, Volume-Only Bar, and Data Gap cases.
- **Hidden Volume wastes chart height:** update right and overlay margins from
  one controller helper on every lifecycle and style path.
- **Palette changes leave old per-point colors:** reseed the local histogram
  when directional palette colors change.
- **Migration overwrites unrelated panel settings:** persist a patch containing
  only normalized indicators, the model version, and the copied Chart Settings
  object with its compatibility field changed.
- **Legend shows stale data after unhiding:** keep imperative cells mounted and
  updating while their presentation is suppressed.
- **Histogram settings promise inert behavior:** render width and line-style
  controls only for line slots.
- **Engine/UI contract drifts:** keep the wire shape unchanged, edit no generated
  file, and run `gen-ts-check` plus both subsystem suites.

## Completion Criteria

- Every new, preset, imported, and migrated Chart Panel has zero or one Volume
  Indicator according to persisted user choice.
- No separate built-in Volume series, setting, legend row, engine calculator,
  subscription, hydration key, or store dependency remains.
- Visible Volume uses direct display-bar data, the existing 25% band, and
  directional colors unless explicitly overridden.
- Hidden or removed Volume frees the reserved band and follows the approved
  legend lifecycle.
- `Vol` appears once below Float; `Volume` is used everywhere else.
- Existing configurations normalize once, preserve the approved visible/style
  outcome, and remain stable on reload and usable after full rollback.
- The broader legend visibility-color behavior is implemented without moving
  high-frequency values into React state.
- Focused tests, the full CI-equivalent checklist, manual acceptance, relevant
  README updates, and hosted CI all complete successfully before the
  implementation is handed off.
