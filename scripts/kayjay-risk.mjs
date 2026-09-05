// One normalized KAYJAY risk contract, translated per venue. Adapters map the
// contract to venue-specific calls; a feature a venue/product does not support
// is reported as unsupported, never simulated.
//
// Contract fields (all optional, at least one required):
//   stopLoss          absolute price
//   takeProfit        absolute price
//   trailingStop      absolute distance (quote units)
//   trailingPercent   percent distance (0 < p < 100)
//   maxHoldSeconds    integer > 0
//   breakEven         { triggerPrice, offset } | true
//   reduceOnly        true  (tighten/reduce only; never widen risk)

export class RiskError extends Error {
  constructor(code, message) { super(message); this.name = "RiskError"; this.code = code; }
}
const fail = (code, message) => { throw new RiskError(code, message); };

const PRICE = v => typeof v === "number" && Number.isFinite(v) && v > 0;
const INT = v => Number.isSafeInteger(v) && v > 0;

export function normalizeRiskContract(input) {
  if (!input || typeof input !== "object") fail("empty", "A risk contract object is required.");
  const c = {};
  if (input.stopLoss != null) { if (!PRICE(input.stopLoss)) fail("stop_loss", "stopLoss must be a positive price."); c.stopLoss = input.stopLoss; }
  if (input.takeProfit != null) { if (!PRICE(input.takeProfit)) fail("take_profit", "takeProfit must be a positive price."); c.takeProfit = input.takeProfit; }
  if (input.trailingStop != null) { if (!PRICE(input.trailingStop)) fail("trailing_stop", "trailingStop must be a positive distance."); c.trailingStop = input.trailingStop; }
  if (input.trailingPercent != null) { if (typeof input.trailingPercent !== "number" || !(input.trailingPercent > 0 && input.trailingPercent < 100)) fail("trailing_percent", "trailingPercent must be between 0 and 100."); c.trailingPercent = input.trailingPercent; }
  if (input.maxHoldSeconds != null) { if (!INT(input.maxHoldSeconds)) fail("max_hold", "maxHoldSeconds must be a positive integer."); c.maxHoldSeconds = input.maxHoldSeconds; }
  if (input.breakEven != null) {
    if (input.breakEven === true) c.breakEven = true;
    else if (typeof input.breakEven === "object" && PRICE(input.breakEven.triggerPrice)) c.breakEven = { triggerPrice: input.breakEven.triggerPrice, offset: Number(input.breakEven.offset) || 0 };
    else fail("break_even", "breakEven must be true or { triggerPrice, offset }.");
  }
  if (input.trailingStop != null && input.trailingPercent != null) fail("trailing_conflict", "Set trailingStop or trailingPercent, not both.");
  c.reduceOnly = input.reduceOnly === true;
  if (!Object.keys(c).some(k => k !== "reduceOnly")) fail("empty", "The risk contract has no actionable field.");
  return c;
}

// Per-venue capability. Verified against each authority's real surface — not aspirational.
const VENUE_CAPABILITY = {
  ATLAS: { stopLoss: "absolute-tighten", takeProfit: false, trailingStop: false, trailingPercent: false, maxHoldSeconds: false, breakEven: false,
    note: "ATLAS protective API exposes absolute stop-loss tightening only." },
  JINX: { stopLoss: false, takeProfit: false, trailingStop: false, trailingPercent: false, maxHoldSeconds: false, breakEven: false,
    note: "JINX has no protective-order API; risk is enforced by its own engine, not forwarded." },
  COINBASE: { stopLoss: "stop-limit", takeProfit: "limit", trailingStop: false, trailingPercent: false, maxHoldSeconds: "client-side", breakEven: false,
    note: "Coinbase Advanced Trade supports bracket stop-limit and take-profit limit orders; trailing and break-even are not native." },
};

/**
 * Translate the normalized contract for a venue. Returns { supported, unsupported,
 * venueOrder } where venueOrder is the venue-shaped protective instruction (or
 * null when nothing is supported). Never emulates an unsupported feature.
 */
export function translateForVenue(contract, venue) {
  const cap = VENUE_CAPABILITY[venue];
  if (!cap) fail("unknown_venue", `Unknown venue: ${venue}`);
  const c = normalizeRiskContract(contract);
  const supported = {}; const unsupported = [];
  for (const field of ["stopLoss", "takeProfit", "trailingStop", "trailingPercent", "maxHoldSeconds", "breakEven"]) {
    if (c[field] == null) continue;
    if (cap[field]) supported[field] = { value: c[field], via: cap[field] };
    else unsupported.push({ field, reason: `${venue} does not support ${field}. ${cap.note}` });
  }
  if (venue === "ATLAS" && c.reduceOnly === false && c.stopLoss != null) {
    // ATLAS only *tightens*; a non-reduce-only request is still translated but flagged.
    supported.stopLoss = { ...supported.stopLoss, tightenOnly: true };
  }
  let venueOrder = null;
  if (venue === "COINBASE" && (supported.stopLoss || supported.takeProfit)) {
    venueOrder = { type: "bracket",
      stop_trigger_price: supported.stopLoss ? String(c.stopLoss) : undefined,
      limit_price: supported.takeProfit ? String(c.takeProfit) : undefined };
  } else if (venue === "ATLAS" && supported.stopLoss) {
    venueOrder = { route: "protective/tighten-stop", new_stop_price: c.stopLoss };
  }
  return { venue, supported, unsupported, venueOrder, capabilityNote: cap.note };
}
