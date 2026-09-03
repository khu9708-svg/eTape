# Chart Legend Free Float

Status: Approved on 2026-09-02; implemented on 2026-09-03 in `d8d82698`.

## Goal

Show the current symbol's **Free Float** share count on every Chart Panel's
TradingView-style legend, on its own row directly above Volume.

The legend will reuse the existing Moomoo-backed `stock.detail.floatShares`
value and the Scanner's compact-share formatter, producing text such as:

```text
Float  12.3M
Vol     1.24M
```

## Non-Goals

- Do not display Free-Float Market Cap, shares outstanding, or another
  fundamental.
- Do not read the value from Scanner state or require the symbol to appear in
  Scanner results.
- Do not add another provider request, cache, engine field, WebSocket type, or
  generated TypeScript change.
- Do not reconstruct historical Free Float or change the value when the
  crosshair inspects an older candle.
- Do not restore Free Float to the Stock Info Panel.
- Do not add a chart setting, feature flag, tooltip, timestamp, stale badge,
  colour signal, or separate component.
- Do not route Free Float through `LegendView`; that model remains bar,
  crosshair, and indicator data only.

## Current-Code Evidence

- [`CONTEXT.md`](../../CONTEXT.md) defines **Free Float** as publicly tradable
  shares and distinguishes it from **Free-Float Market Cap**.
- [`engine/internal/scan/scan.go`](../../engine/internal/scan/scan.go) maps
  Moomoo `EquitySnapshotExData.OutstandingShares` into Scanner Free Float.
- [`engine/internal/stockinfo/stockinfo.go`](../../engine/internal/stockinfo/stockinfo.go)
  independently maps that same Moomoo field into
  `StockDetailPayload.FloatShares`.
- [`engine/internal/uihub/wsmsg/payloads.go`](../../engine/internal/uihub/wsmsg/payloads.go)
  already owns the nullable raw-share wire field; the generated
  [`ui/src/gen/wsmsg.ts`](../../ui/src/gen/wsmsg.ts) contract already exposes
  `floatShares: number | null`.
- [`ui/src/data/StockDetailStore.ts`](../../ui/src/data/StockDetailStore.ts)
  retains the latest detail per symbol and exposes `detailFor(symbol)`.
- [`ui/src/chrome/format.ts`](../../ui/src/chrome/format.ts) owns
  `formatCompactShares`, which the
  [`ScannerPanel`](../../ui/src/chrome/panels/ScannerPanel.tsx) already uses for
  its Float column.
- [`ui/src/chrome/panels/ChartPanel.tsx`](../../ui/src/chrome/panels/ChartPanel.tsx)
  owns the current chart symbol and renders
  [`TVLegend`](../../ui/src/chrome/panels/tv/TVLegend.tsx), whose second row
  currently starts with Volume.
- [`ui/src/chrome/panels/registry.tsx`](../../ui/src/chrome/panels/registry.tsx)
  declares Chart Panel topics but does not list `stock.detail`. The app
  currently subscribes the union of all catalog topics, so Stock Info makes
  the data available incidentally; the Chart definition must declare its own
  dependency.

## Design Decisions

### Metric and source

Use `stores.stockDetail.detailFor(chartSymbol)?.floatShares`, not a Scanner
row. Both paths use Moomoo `OutstandingShares`, but they refresh independently;
brief timing differences between Scanner and Chart are acceptable. Reading
Stock Detail keeps Free Float available for any chart symbol.

Scanner treats a non-positive snapshot value as unresolved, while Stock Detail
preserves an explicit provider zero. The approved Chart contract follows Stock
Detail: missing data renders `Float —`, and an explicit zero renders
`Float 0`.

### State flow

Free Float is low-frequency symbol metadata, so select its primitive value
with `useSyncExternalStore` in `ChartPanel` and pass it to `TVLegend` as a
normal prop. The snapshot selector must be keyed by `chartSymbol`; updates for
other symbols may notify the selector but must not rerender the chart when its
selected primitive is unchanged.

Keep Free Float outside the imperative `TVLegendHandle.update` path. That path
updates high-frequency OHLC, Volume, Reported Price, and indicator values from
the current bar/crosshair view; adding symbol metadata there would falsely tie
Free Float to historical inspection.

### Presentation and lifecycle

- Add one always-present `Float` row immediately above the existing Volume
  row.
- Format with the existing `formatCompactShares` helper, matching Scanner
  suffixes and precision (`950K`, `12.3M`, `3.2B`, `3.21T`).
- Use the same muted label/value treatment as Volume, with no directional
  colour.
- On a symbol change, render that symbol's cached value or `Float —`
  immediately; never carry the previous symbol's value.
- Keep the current value while the crosshair moves through history.
- Preserve the last successful value during a transient Stock Detail refresh
  failure, matching the store's existing behavior.
- Add no visibility setting or timestamp.

## File-Level Implementation Steps

### 1. Declare the Chart Panel's existing-data dependency

In [`ui/src/chrome/panels/registry.tsx`](../../ui/src/chrome/panels/registry.tsx):

- add `stock.detail` to the Chart Panel topic list;
- leave its `chart` demand profile unchanged, since the existing chart demand
  already puts its symbol in the Stock Info poller's active-symbol universe.

Update
[`ui/src/chrome/panels/registry.test.tsx`](../../ui/src/chrome/panels/registry.test.tsx)
to pin the topic and unchanged demand profile.

### 2. Select Free Float for the displayed chart symbol

In [`ui/src/chrome/panels/ChartPanel.tsx`](../../ui/src/chrome/panels/ChartPanel.tsx):

- import and use `useSyncExternalStore`;
- select only `detailFor(chartSymbol)?.floatShares ?? null`, rather than the
  whole Stock Detail snapshot;
- pass the primitive value to `TVLegend`;
- keep chart bars, `LegendView`, controllers, scheduler revisions, and
  persisted panel settings unchanged.

Extend
[`ui/src/chrome/panels/ChartPanel.test.tsx`](../../ui/src/chrome/panels/ChartPanel.test.tsx)
with one focused integration test proving that the displayed symbol receives
its own Free Float and that switching to a symbol without a value shows a dash
instead of the previous symbol's value.

### 3. Render one static legend row

In [`ui/src/chrome/panels/tv/TVLegend.tsx`](../../ui/src/chrome/panels/tv/TVLegend.tsx):

- add a required nullable `floatShares` prop;
- reuse `formatCompactShares`;
- render `Float` and its formatted value in a flex row directly above Volume;
- use existing muted legend styling and a stable test id for the value.

Update
[`ui/src/chrome/panels/tv/TVLegend.test.tsx`](../../ui/src/chrome/panels/tv/TVLegend.test.tsx)
to cover row order, compact formatting, missing data, and explicit zero using
the existing harness. Do not create another formatter or test harness.

### 4. Document the completed input flow

When implementing the plan, update
[`ui/src/chrome/panels/tv/README.md`](../../ui/src/chrome/panels/tv/README.md)
to list current Free Float from the low-frequency Stock Detail store as a
legend input and state that it is independent of crosshair/bar updates.

No glossary update is needed because `CONTEXT.md` already defines both Free
Float terms. No ADR is warranted: this is a small, reversible presentation
change with no architectural lock-in or provider decision.

## Tests

### Focused checks during implementation

```powershell
Set-Location ui
npm test -- TVLegend ChartPanel registry
npm run typecheck
Set-Location ..
git diff --check
```

The focused tests must prove:

- Chart declares `stock.detail` while retaining `demand: "chart"`;
- `12_300_000` renders as `Float 12.3M` above Volume;
- missing data renders `Float —` and explicit zero renders `Float 0`;
- another symbol's Stock Detail update does not replace the displayed value;
- changing to an uncached symbol does not flash the prior symbol's value;
- crosshair-driven imperative legend updates leave the Float row unchanged.

### Required validation after implementation

Because this will execute an approved plan, run the CI-equivalent Windows
checklist from [`README.md`](../../README.md#ci-equivalent-validation-on-windows):

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

Report every result and every skipped required check with its reason. No live
order or account action is needed.

## Manual Acceptance Scenarios

1. Open any Chart Panel on a symbol with known Free Float. Confirm the muted
   Float row appears directly above Volume and matches Scanner formatting.
2. Move the crosshair across historical candles. Confirm OHLC and Volume
   follow the inspected bar while Float stays unchanged.
3. Change to a symbol whose Stock Detail is not cached. Confirm the old value
   disappears immediately and `Float —` remains until the new value arrives.
4. Open several Monitoring Workspace charts. Confirm each shows the Free Float
   for its own symbol, including symbols absent from the current Scanner rows.
5. Simulate a missed Stock Detail refresh after a successful value. Confirm the
   last successful Float remains visible without a stale badge.
6. Check a narrow/short Chart Panel in both themes. Confirm the added row is
   readable, subdued, and does not cover chart controls.

## Rollout and Rollback

This is an additive UI-only readout with no migration, persisted setting,
provider request, or wire-contract change. Ship it with the normal UI build
after automated and manual validation.

Rollback is a direct revert of the Chart topic, Stock Detail selector, legend
prop/row, focused tests, and TV integration documentation. No stored data or
engine state needs cleanup.

## Risks and Mitigations

- **Wrong-symbol flash:** key the selector directly by `chartSymbol` and
  normalize an absent entry to `null` before rendering.
- **React churn from other symbols:** return only the selected primitive from
  the external-store snapshot so unchanged values do not rerender the chart.
- **Scanner/Chart timing mismatch:** both surfaces use the same Moomoo field
  but independent pollers; document and accept brief refresh skew rather than
  coupling Chart to Scanner membership.
- **Misleading zero:** distinguish an absent value (`—`) from the explicit zero
  that Stock Detail intentionally preserves.
- **Legend crowding:** use one compact row above Volume and the existing muted
  typography; manually verify the minimum practical panel size.
- **Hidden topic dependency:** declare `stock.detail` on Chart even though the
  app currently subscribes it through the catalog-wide topic union.
- **Accidental historical semantics:** keep Free Float out of `LegendView` and
  the imperative crosshair update handle.

## Completion Criteria

- Every Chart Panel shows `Float <compact shares>` directly above Volume.
- The value uses `stock.detail.floatShares`, the same Moomoo Free Float metric
  shown by Scanner, without depending on Scanner state.
- Missing, zero, symbol-switch, transient-failure, and historical-crosshair
  behavior match the approved decisions.
- No engine, generated contract, provider request, persistence, setting,
  Free-Float Market Cap, or Stock Info behavior changes.
- Focused tests, the CI-equivalent checklist, documentation updates, and hosted
  CI pass before implementation is complete.
