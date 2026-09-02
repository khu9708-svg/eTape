# Execution Core

Broker-neutral lifecycle, gates, routing, reconciliation, and round-trip
tracking. Link Groups choose the execution venue; there is no runtime global
venue fallback. The account poller requests every configured live venue for
risk and each venue demanded by an open Account panel, deduplicated per venue.
Account failures retain the last snapshot and become stale after five
intervals; stale live data blocks new openings until the user unlocks again,
while reductions remain allowed. Max Day Loss aggregates configured live
venues only. The Account projection uses scheduled NYSE close-to-close cycles:
closing fills accumulate cycle P&L, open symbols retain partial-exit
realization, and a close rebases carried positions to their latest marks.
Alpaca keeps broker-authoritative Day P&L in the display; Moomoo calculates it
from its persisted equity baseline and cash-flow adjustment. Realized P&L is
the local cycle ledger and remains visible after flattening. Test:
`go test ./internal/exec`.
