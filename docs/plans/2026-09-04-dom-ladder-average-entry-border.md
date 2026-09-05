# DOM Ladder Average-Entry Border

Status: Approved on 2026-09-04.

## Goal

Make the already implemented DOM Ladder Average-Entry Row easier to scan by
retaining its bold price and size text and framing each matching book-side row
with a neutral one-pixel border. This supersedes the proposed underline; no
underline is added.

## Non-goals

- Do not change position selection, Link Group venue scoping, exact-price
  matching, scroll behavior, or the accessible-name rule from the implemented
  Average-Entry Row cue.
- Do not draw a full-width ladder-row border, a row tint, an animation, a
  label, a nearest-price fallback, or an edge/offscreen indicator.
- Do not add a palette token, preference, engine change, WebSocket change, or
  generated-contract change.
- Do not border virtual LULD Boundary Rows or alter working-order, depth-bar,
  or trade-flash behavior.

## Current-code evidence

- `LadderPanel` already resolves the Link Group-scoped eligible position and
  passes its average price to `buildLadderState()`; `LadderPaintState` carries
  the normalized result into the canvas painter.
- In `ui/src/render/ladder/paintLadder.ts`, `drawSide()` recognizes an exact
  average-entry price on ordinary `LadderRow` values and already makes its
  price and size text bold. Bids and asks are independently painted into the
  left and right halves of the canvas.
- The painter layers depth bars and trade flashes first, then text, then the
  bronze working-order inner-edge mark. Its structural center divider uses
  `borderStrong`.
- `applyCanvasSize()` normalizes painters to CSS pixels, so a one-CSS-pixel
  canvas stroke remains device-pixel-ratio aware.
- `ladderState.test.ts` has a focused recording canvas context and covers
  valid matches, crossed books, invalid bases, virtual LULD rows, and
  viewport visibility. The ladder README currently documents bold text and
  explicitly says no border exists.

## Agreed design

- Keep the existing bold 11px mono price and size text for every exact,
  visible real matching row. The existing position eligibility, exact matching,
  LULD exclusion, crossed-book behavior, and accessibility text remain
  unchanged.
- Draw a square-cornered, one-CSS-pixel `p.text` outline around the matching
  **half-row** only: a bid match is framed on the bid half and an ask match on
  the ask half. A crossed/stale book with the same price on both sides frames
  both halves independently.
- Inset the outline inside the half-row bounds with half-pixel-aligned canvas
  coordinates. It must not overwrite the center divider, outer panel edge, or
  the opposite side's row.
- Paint the outline after the matching text and before the existing
  working-order mark. Depth and flash fills remain behind it; a bronze
  working-order mark stays visible above it at the divider side.
- Use the normal text color in each theme. Do not reuse the bronze
  working-order color, bid/ask direction colors, or introduce a new palette
  token.

## File-level implementation

1. In `ui/src/render/ladder/paintLadder.ts`, extend the existing
   `isAverageEntry` branch in `drawSide()`:
   - Preserve the current bold-font logic for size and price.
   - After those text draws, set a one-pixel text-color stroke and draw one
     inset, half-pixel-aligned rectangle wholly inside the current bid or ask
     half-row.
   - Do this before the existing `hasOrder` block, so the order mark keeps its
     established visual priority. Do not change `drawLULDBoundary()` or add a
     generalized decoration abstraction.

2. In `ui/src/render/ladder/ladderState.test.ts`, extend the recording canvas
   context to capture rectangle strokes and their relevant paint properties.
   Update the Average-Entry Row tests to assert:
   - one border for an exact ordinary bid or ask match, alongside the existing
     two bold text draws;
   - one border per matching side in a crossed book;
   - no border for invalid/absent bases, virtual LULD rows, or a matching row
     outside the viewport; and
   - the rectangle stays within the appropriate half-row rather than crossing
     the center divider.

3. In `ui/src/render/ladder/README.md`, replace the text-only/no-border
   description with the agreed cue: bold price and size plus a neutral,
   one-pixel inset border around each matching real bid/ask half-row. Retain
   the existing exact-match, LULD, crossed-book, scrolling, and accessibility
   statements.

## Validation

- Run the focused painter suite: `cd ui && npm test -- ladder`.
- Run UI static checks: `cd ui && npm run lint` and `cd ui && npm run build`.
- Because this is an approved plan, complete the repository's CI-equivalent
  Windows checklist before handoff: engine test/race/vet/lint,
  `mingw32-make -C engine gen-ts-check`, UI `npm ci`, lint, test, build, and
  `git diff --check`; list each skipped required check with its reason.
- Manually verify light and dark themes, bid and ask matches, a transient
  crossed book, depth and trade-flash overlap, a matching working-order mark,
  a scrolled-off row, an absent basis, and a LULD boundary. Confirm the canvas
  accessible name and all order behavior remain unchanged.

## Rollout, rollback, and risks

This is an immediate, display-only UI change with no migration or persisted
state. Roll back with a scoped revert of the painter, focused test, and ladder
README update. The main risk is visual clutter or a border colliding with the
ladder divider at high DPI; the half-row-only, inset outline and focused canvas
assertions keep it distinct from both the structural divider and the bronze
working-order mark.
