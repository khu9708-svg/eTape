# TradingView Chart Integration

Lightweight Charts adapter and chart-specific UI integration. Inputs: bar/indicator/drawing stores plus current Free Float from the low-frequency Stock Detail store; Free Float is independent of crosshair/bar updates. Outputs: imperative series/marker mutations. Preserve stable controller ownership and dispose subscriptions on unmount. Test: `npm test -- tv`.
