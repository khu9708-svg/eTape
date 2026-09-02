# Health

Aggregates service readiness/degradation for UI and logs. Inputs: component
status and cached live-Alpaca account health from the engine-wide account
poller; outputs: health snapshot/events. Health reporting never performs an
Alpaca REST request. The `engine-alpaca` link is present when a configured live
Alpaca account is being polled and uses that account's latest `/v2/account`
RTT. Test: `go test ./internal/health`.
