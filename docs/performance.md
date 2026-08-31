# Performance Evidence

Measurements describe Earl's network, entitlements, symbols, and market sessions; they are evidence, not service guarantees. Raw scripts and captures remain under [prototypes](../prototypes/README.md).

## Market data and quotas

- **2026-07-03 OpenD request benchmark:** US subscribe calls measured 42-49 ms; five-symbol batched TICKER subscribe measured about 50 ms total. Cached one-symbol and six-symbol quote reads both measured about 5 ms. `get_cur_kline` for 1,000 one-minute bars measured about 9 ms. Source: `41aa9993777cab4ea59e711775094c516032ebf2^:docs/2026-07-03-moomoo-latency-benchmark.md`.
- **2026-07-03 quota probe:** repeated history requests for the same symbols consumed no additional history slot. The account then reported 100 subscription slots and 100 historical K-line slots. Same source and `prototypes/moomoo_latency_bench*.py`.
- **2026-08-31 quota recheck:** OpenD reported 300 total stock subscription slots and 300 historical K-line slots. The 14-slot live subscription total exactly matched its per-subtype entries, including separate `K_DAY` and `K_1M` slots for the same symbol. Current moomoo v10.10 documentation defines stock history as one slot per symbol across periods in a rolling seven-day window and documents tier totals of 100, 300, 1,000, and 2,000. See [quota rules](https://openapi.moomoo.com/moomoo-api-doc/en/intro/authority.html), [subscription status](https://openapi.moomoo.com/moomoo-api-doc/en/quote/query-subscription.html), and [historical quota](https://openapi.moomoo.com/moomoo-api-doc/en/quote/get-history-kl-quota.html). eTape's runtime setting and built-in `feed.quota_slots` default were raised from 100 to the observed 300-slot entitlement after this recheck.
- **2026-07-03 pre-market rank:** poll RTT median 83 ms, p95 120 ms; hot-row change interval median 2.0 s; rank volume lag versus LV3 snapshot median 7 s and p95 17 s. Source: `41aa9993777cab4ea59e711775094c516032ebf2^:docs/2026-07-03-premarket-scanner-api.md`; script `prototypes/premarket_rank_latency.py`.
- **2026-07-06 push cadence:** session-specific quote, ticker, order-book, and K-line observations live in `prototypes/push_cadence_measure.py` and captures. Do not generalize cadence beyond measured symbols/session. Source: `41aa9993777cab4ea59e711775094c516032ebf2^:docs/2026-07-06-feed-measurements.md`.

## Execution

- **2026-07-06/07 venue runs:** observed real-fill latency was about 0.23 s Alpaca, 0.33-0.44 s TradeZero, and 0.9-1.0 s moomoo. Runs mixed venue, session, routing, and small-order conditions; comparisons are directional. Source: `41aa9993777cab4ea59e711775094c516032ebf2^:docs/2026-07-06-venue-latency-benchmark.md`; harness `prototypes/venue_order_latency_bench.py`.
- Network-only checks earlier measured Alpaca REST around 210-214 ms and TradeZero around 272-301 ms, with TradeZero outliers. These are transport floors, not fill quality. Source: `41aa9993777cab4ea59e711775094c516032ebf2^:docs/2026-07-03-alpaca-api.md`.

## Journal

- **2026-07-12 boot probe:** journal seal/vacuum timing and database-volume observations depend on retained days, event mix, storage, and SQLite state. Use source methodology before quoting any number: `41aa9993777cab4ea59e711775094c516032ebf2^:docs/2026-07-12-journal-seal-vacuum-boot-timing.md`.
- Production invariant matters more than snapshot size: one writer owns writes, WAL permits readers, failures surface without blocking market-data flow. See [store guide](../engine/internal/store/README.md).
