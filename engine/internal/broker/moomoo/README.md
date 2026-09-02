# moomoo Broker Adapter

Native OpenD `Trd_*` execution adapter for both paper and live accounts.
Inputs: account selection and normalized orders; outputs: normalized
pushes/snapshots. Trade unlock stays in OpenD GUI. The engine-wide account
poller reads `Trd_GetFunds` plus the daily flow summary, then calculates
close-to-close Day P&L from the persisted baseline after signed deposits and
withdrawals; the UI labels this source `Calculated`. Paper accounts are shown
but excluded from Max Day Loss. Test: `go test ./internal/broker/moomoo`.
