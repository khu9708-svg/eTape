# LULD Boundary Rows in DOM Ladder

Status: Approved on 2026-08-25.

## Goal

Restore the Level 2 top strip to the existing best-bid × best-ask and spread
readout. Replace the fixed-strip Estimated LULD copy and dashed L/U markers
with side-specific, display-only LULD Boundary Rows in the DOM ladder.

The lower band belongs in the descending bid sequence and the upper band in the
ascending ask sequence, matching the trader-provided reference. Each row shows
its exact LULD price when that price is inside the panel's Configured Depth.

## Non-goals

- Do not change the Estimated LULD calculation, registry, feed ingestion,
  `md.book` contract, BookStore, subscriptions, or order behavior.
- Do not add a new setting, topic, dependency, React state path, or depth-data
  request.
- Do not show a visual LULD status while a value is unavailable or warming.
- Do not make the red annotation on the reference image a product-color
  requirement.
- Do not retain the dashed L/U markers after LULD Boundary Rows ship.

## Current-code evidence

- `paintLadder.ts` already has the required top-strip formatter,
  `spreadLabel()`, but uses it only when `estimatedLuld` is absent. The LULD
  formatter currently replaces it whenever an Estimated LULD value exists.
- `ladderState.ts` limits the UI projection to 1–60 configured real levels per
  side, while viewport height determines how many are visible at once and the
  remainder is reached with `rowOffset`.
- OpenD requests up to 60 U.S. book levels and the BookStore retains the full
  received replacement snapshot; the panel's depth setting does not alter the
  subscription.
- The existing `visibleLULDMarkers()` projects two overlay lines. It cannot
  express the intended side-specific depth rows or the configured-depth
  fallback.

## Agreed design

### Top strip

Always use the pre-LULD top-strip behavior:

~~~text
best bid × best ask · spread value
~~~

Use the existing fixed-decimal formatter. Leave the strip blank when either
book side is absent; never fabricate a bid, ask, or spread.

### LULD Boundary Rows

Only a valid priced Estimated LULD state creates rows:

- Insert the lower price into the bid-side sequence in descending-price order.
- Insert the upper price into the ask-side sequence in ascending-price order.
- A row is explicitly labelled `LULD` in the outer value column, with the
  boundary price in that side's price column. It has no depth bar, size,
  working-order mark, or trade flash.
- Use the existing warning palette and explicit text rather than treating the
  reference image's red annotation as a product-color instruction.
- If an Estimated LULD is frozen but has valid prices, keep both rows and add
  an explicit `FROZEN` qualifier. It remains an estimate, not a halt signal.
- Warming, unavailable, invalid, unknown, and unpriced frozen values create no
  visual row. Their state remains available through the canvas accessible text.
- If a boundary equals a real book price, keep the real price level first and
  insert a separate LULD Boundary Row immediately after it on that side.

### Visibility, scrolling, and configured-depth fallback

Configured Depth always counts real book levels, never LULD Boundary Rows.
The scroll range must continue to make every configured real level reachable.

For each side independently:

1. When a boundary's sorted position is within Configured Depth, insert it in
   the logical side sequence. It is not pinned: it is absent while below the
   viewport and appears only after scrolling reaches its exact position. Once
   in view it scrolls normally.
2. When its sorted position is beyond Configured Depth, show one plain `LULD`
   Boundary Row fixed in that side's bottom visible slot at every scroll
   position. Do not add an `OUTSIDE DEPTH` qualifier or edge cue.
3. A bottom fallback consumes one visible slot on its own side, but does not
   reduce Configured Depth. Extend the maximum logical scroll offset when
   necessary so the final real book level remains reachable.

The lower and upper rows may therefore be at different vertical positions.
Each side applies its own in-range and fallback rule, so the reference's two
bottom rows occur only when both boundaries are beyond that side's configured
depth.

### Accessibility and display-only boundary

Update the canvas accessible name when the LULD state or values change. It
continues to expose state, values, tier, registry date, reason, and frozen
status even when the visual row is intentionally absent. No visual treatment
may imply an official LULD band, regulatory status, or order constraint.

The existing display-only ADR remains applicable; no new ADR is required.

## File-level implementation

1. In `ui/src/render/ladder/ladderState.ts`, derive per-side logical ladder
   entries from the existing book and nested `estimatedLuld` value. Preserve up
   to the configured number of real levels, insert in-range LULD Boundary Rows
   at their sorted prices, and calculate the independent bottom-fallback rows.
   Make `visibleLadderRows()` and `maxLadderOffset()` account for virtual rows
   without hiding the final configured real level.

2. In `ui/src/render/ladder/paintLadder.ts`, always paint `spreadLabel()` in
   the fixed strip. Paint normal depth and LULD Boundary Rows with the existing
   warning palette; omit depth-only effects from LULD rows. Remove the
   fixed-strip LULD formatter branch, `drawLULDMarkers()`, and its dashed-line
   behavior.

3. In `ui/src/chrome/panels/LadderPanel.tsx`, pass the LULD-aware state into
   viewport/offset clamping and preserve the current imperative scheduler and
   accessible-name update path. Do not route book or LULD updates through React
   state.

4. Update `ui/src/render/ladder/ladderState.test.ts` and
   `ui/src/chrome/panels/LadderPanel.test.tsx` to cover restored BBO text;
   bid/ask insertion order; equal-price rows; in-range visibility while
   scrolling; independent side positions; configured-depth bottom fallback;
   reachability of the final real level; frozen labels; absence during
   warming/unavailable; removal of markers; and accessible text.

5. Update `ui/src/render/ladder/README.md` during implementation with the
   new row, scrolling, accessibility, and display-only behavior. Do not edit
   generated `ui/src/gen/wsmsg.ts` because the wire contract is unchanged.

## Validation

Run focused ladder tests throughout implementation, then the required
CI-equivalent Windows checklist for the approved change, including the UI
lint, test, typecheck, build, and E2E commands and `git diff --check`.

Manually verify a shallow panel with Configured Depth 10 and a deep panel with
Configured Depth 60. For each, verify an in-range row appears only at its
sorted position, an out-of-range row remains at the bottom, scrolling still
reaches the final real level, and a frozen row is visibly qualified.

## Rollout, rollback, and risks

This is a UI-only rollout with no migration or compatibility change. Rollback
is a scoped UI revert to the prior fixed-strip/marker presentation.

The explicit user choice to keep beyond-depth rows plain can make a pinned row
look like a regular position at a glance; the `LULD` label and the enduring
display-only accessible description are the safeguards. Hiding unpriced states
also makes the absence of a visual LULD intentional rather than a data claim.
