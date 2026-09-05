# DOM Ladder Average-Entry Row

Status: Approved on 2026-09-04.

## Goal

Show the Average Entry Price of the DOM Ladder's Link Group-scoped Open
Position by bolding the exact matching real book row's price and displayed
size.

## Non-goals

- Do not change engine, broker, WebSocket, or generated-contract code.
- Do not add a setting, palette token, row tint, border, label, animation,
  virtual row, nearest-price match, auto-scroll, or edge indicator.
- Do not mark LULD Boundary Rows, aggregate venues, infer a missing basis, or
  change order/risk behavior.

## Current-code evidence

- `ExecStore.positions()` already exposes full `exec.positions` snapshots as
  `PositionRow` values with `venue`, `symbol`, signed `qty`, and `avgPrice`.
- `LinkGroups.venueFor(group)` supplies the selected Execution Venue; a pinned
  panel has none.
- `LadderPanel` already subscribes imperatively to `stores.exec`, but today
  passes only working orders into `buildLadderState()`.
- `ladderState.ts` separates real `LadderRow` entries from virtual
  `LULDBoundaryRow` entries, and `paintLadder.ts` owns all row text rendering.
- The Ladder registry declares `exec.orders` but not `exec.positions`; the
  latter must become an explicit panel dependency.
- ADR 0005 requires venue-scoped UI context, and ADR 0004 requires DOM
  annotations to remain display-only. No new ADR is warranted for this
  reversible presentation change.

## Agreed design

- Select at most one position: same symbol and selected Link Group Execution
  Venue, nonzero quantity, and finite positive `avgPrice`. Pinned ladders,
  absent venues, NET/null-venue rows, invalid basis values, and flat positions
  produce no cue.
- Carry that optional price into the pure paint state. Match it with the same
  exact numeric equality used by working-order marks.
- Bold every visible real bid or ask row at that price, including both sides of
  a transient crossed/stale book. Never bold a virtual LULD Boundary Row.
- Bold only the existing 11px mono price and size text. Keep depth bars,
  flashes, working-order marks, colors, ordering, and scroll position intact.
- The canvas accessible name says that an Average-Entry Row is present only
  while an exact real matching row is visible; it says nothing for an
  offscreen/nonmatching basis.
- Recompute through the existing execution-store and Link Group invalidation
  paths after fills, partial exits, reversals, flattening, symbol changes, and
  venue changes. There is no saved preference.

## File-level implementation

1. In `ui/src/chrome/panels/registry.tsx`, add `exec.positions` to the DOM
   Ladder topics so its position dependency is declared alongside book, tape,
   and working-order data.

2. In `ui/src/chrome/panels/LadderPanel.tsx`, during each scheduled paint,
   resolve `linkGroups.venueFor(groupRef.current)`, find the one eligible
   `stores.exec.positions()` row for the current symbol, and pass its average
   price (or `null`) into `buildLadderState()`. Extend the existing imperative
   accessible-label update with the state-provided visible-entry result; do not
   introduce React state, polling, or a new subscription.

3. In `ui/src/render/ladder/ladderState.ts`, add the optional average-entry
   price to `LadderPaintState` and `buildLadderState()` inputs. Normalize it to
   a finite positive value and derive whether an exact *real* row is currently
   visible after the existing row offset and LULD fallback rules. Keep this
   small pure projection shared by paint and accessibility so they cannot
   disagree.

4. In `ui/src/render/ladder/paintLadder.ts`, select the bold mono font only
   while drawing a matching ordinary `LadderRow`'s size and price. Restore the
   normal font for all other rows and leave `drawLULDBoundary()` unchanged.

5. Update focused tests:
   - `ui/src/render/ladder/ladderState.test.ts`: cover valid exact real-row
     matching, both-side matching, invalid/no basis, LULD exclusion, and the
     visible-versus-scrolled-off accessibility result; use the existing canvas
     spy to verify only matching price/size text is bold.
   - `ui/src/chrome/panels/LadderPanel.test.tsx`: publish venue-scoped position
     snapshots and verify the emitted paint state and canvas label; verify an
     unrelated venue, pinned panel, and flatten/venue switch remove the cue on
     the next existing repaint.

6. Update `ui/src/render/ladder/README.md` with the venue scope, exact-real-row
   rule, text-only presentation, scrolling behavior, and accessible-name rule.
   The glossary terms are already captured in `CONTEXT.md` during planning.

## Validation

- During implementation: `cd ui && npm test -- ladder`, then `npm run lint`
  and `npm run build` (which includes typechecking).
- Before handoff, run the CI-equivalent Windows checklist required for an
  approved plan: engine test/race/vet/lint, `mingw32-make -C engine
  gen-ts-check`, UI `npm ci`, lint, test, build, and `git diff --check`.
- Manually verify a linked venue with an exact long and short entry price;
  another venue's position; a pinned ladder; a row scrolled out of view; an
  entry absent from depth; a matching LULD row; partial exit/reversal/flat; and
  a Link Group venue switch. Confirm no order behavior changes and that the
  accessible label changes only while a bold real row is visible.

## Rollout, rollback, and risks

This is an immediately effective, UI-only display cue with no migration or
compatibility change. Rollback is a scoped revert of the Ladder UI and its
documentation. Exact matching deliberately leaves no cue when a broker basis
is not a real ladder price; that avoids fabricating depth or moving the
trader's viewport.
