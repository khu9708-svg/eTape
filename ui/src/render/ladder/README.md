# Ladder Renderer

The fixed chrome strip always shows the best bid × best ask and spread when
both real book sides exist. A valid priced `estimatedLuld` state adds a
display-only `LULD` Boundary Row to the lower bid sequence and upper ask
sequence. Frozen values add `FROZEN`; warming, unavailable, invalid, unknown,
and unpriced values add no visual row. Boundary rows use the warning palette,
have no depth bar, size, order mark, or trade flash, and are never dashed
markers or order/risk controls.

Configured Depth counts real price levels only. An in-range boundary is inserted
at its sorted price and scrolls with that side. A boundary beyond Configured
Depth is shown as a plain bottom-slot fallback on its own side; that slot can
extend the shared logical scroll range so the final configured real level stays
reachable. The canvas accessible name stays imperative and includes the symbol,
LULD state, values, tier, registry date, reason, and frozen status whenever the
state changes. Book and LULD data never passes through React state.

Canvas DOM ladder painter. Inputs: order-book/quote state and viewport; output:
price-level canvas. U.S. books can project 1–60 configured real levels plus
virtual boundary rows onto a viewport-sized canvas with a logical row offset;
render directly from store snapshots, coalesced per frame. Test:
`npm test -- ladder`.
