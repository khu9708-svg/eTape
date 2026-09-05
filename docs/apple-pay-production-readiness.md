# Apple Pay / Coinbase Onramp — production readiness

Production domain: **`kayjaytrades.com`**

## What is wired (code-complete)

`scripts/kayjay-payments.mjs` `createPaymentAdapter({ environment })`:

- `environment: "sandbox"` (default) — sandbox owner reference (`sandbox-*`),
  Coinbase Apple Pay sandbox, `domain: "localhost"`, `useApplePaySandbox=true`
  on the hosted link.
- `environment: "production"` —
  - `domain: "kayjaytrades.com"` on every Onramp order request
  - owner reference must be `owner-*` (a real reference, not a sandbox one)
  - optional `redirectUrl`, validated to be `https://…kayjaytrades.com`
  - no `useApplePaySandbox` param on the hosted link
  - the hosted-link result carries `ownerActionRequired: "OWNER LIVE VERIFY REQUIRED"`
  - a Coinbase `403` / "Onramp is not enabled" / "domain not allowlisted" /
    "Apple Pay … not" response is surfaced as
    `production_approval_required` with the message
    **`COINBASE / APPLE PAY PRODUCTION APPROVAL REQUIRED`**.

Environment selection (`scripts/kayjay.mjs` `coinbasePaymentEnvironment()`):
`~/.eTape/coinbase-payment-env.json` `{ "environment": "production" }`, else
`KAYJAY_COINBASE_ENV=production`, else `sandbox`. Exposed to the Face via the
`fund_env` payment action.

Credentials: the already-configured `~/.eTape/coinbase.env`
(`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`) — same as every other Coinbase call.

## What Coinbase requires before a live Apple Pay charge (external, owner)

These are done in the **Coinbase Developer Platform portal** (portal.cdp.coinbase.com),
not in code:

1. **Enable Onramp for the app/project** in the portal (Onramp → Get started).
2. **Domain allowlist** — add `kayjaytrades.com` (and any subdomain that hosts
   the funding UI) to the app's Onramp **Allowed domains**.
3. **Apple Pay production enablement** — Coinbase enables guest-checkout Apple
   Pay per app after review; request it in the portal if the option is gated.
4. **(hosting)** serve the funding UI from `https://kayjaytrades.com` so the
   `domain` the adapter sends matches the page origin Coinbase sees.

Until 1–3 are done, `environment: "production"` calls return
`production_approval_required`. There is nothing further to build.

## The final owner action

Once Coinbase enablement is complete: set
`~/.eTape/coinbase-payment-env.json` to `{ "environment": "production" }`,
open the Fund panel, enter an amount + destination, confirm — then the single
real Apple Pay charge is **`OWNER LIVE VERIFY REQUIRED`**.
