# Wallet Face — donor provenance

The Phantom / Backpack wallet-connect surface in the KAYJAY Face
(`ui/src/chrome/panels/walletConnect.ts` + the `WalletPanel` in
`KayjayPanel.tsx`) adapts proven patterns from four reference repos cloned to
`C:\Users\kevin\Projects\KAYJAY\_donors` (a disposable reference workspace,
**never** committed into this repo):

| Donor | Pattern taken | Where it lives here |
|---|---|---|
| `TeamRaccoons/Unified-Wallet-Kit` | wallet adapter model — detect → connect → disconnect → reactive state; `connect({ onlyIfTrusted })` silent-reconnect | `walletConnect.ts` `detectWallets` / `connect` / `reconnect` / `subscribe` |
| `wallet-ui/wallet-ui` | reactive connection-state machine (phase enum), wallet selector plumbing | `WalletConnectionState` / `ConnectionPhase` |
| `coral-xyz/backpack` | balance header, SOL + SPL holdings list, recent-activity presentation | `WalletPanel` "on-chain owner wallet state" section (fed by the JINX worker `/wallet` owner block) |
| `loyal-labs/loyal-app` | owner-wallet vs automated-agent separation, approval/verification state | `WalletPanel` owner-vs-signer split; `owner_verified` / `owner_mismatch` phases gate owner-approved signing |

No donor code is copied verbatim and no donor dependency is added — eTape's UI
stays on its lean stack (React only). JINX autonomous execution continues to
sign with the D5f local keypair server-side; Phantom is the **owner wallet**
identity and owner-approved-signing surface only.
