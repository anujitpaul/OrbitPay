# OrbitPay

> Built with Arc Studio - money-powered apps in minutes

Project memory for future agents or humans.

## What This App Does

Minimal USDC payment dApp on Arc Mainnet (chain 5042) with two features only: Send USDC and Receive USDC. No swap, bridge, staking or smart wallet. Non-custodial: the user approves every transaction in their own wallet.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS (Arc Dark tokens in `src/index.css`)
- Web3: wagmi v2, viem, ConnectKit modal. Wallets: EIP-6963 auto-discovery of every installed extension, generic injected fallback, Coinbase Wallet (EOA only), and WalletConnect (only when `VITE_WALLETCONNECT_PROJECT_ID` is set). No wallet is hard-coded or favoured
- Contracts: Solidity, Foundry. `contracts/OrbitPay.sol`, tests in `contracts/test/` (`bun run contracts:test`)
- Chain: Arc Mainnet (5042). USDC `0x3600000000000000000000000000000000000000`, 6 decimals. Chain facts come from `@/onchain-facts`.

## Key Files

- `src/config.ts` - wagmi config (Arc Mainnet only, RPC timeout/retry/batching)
- `src/lib/settings.ts` - RPC, USDC and OrbitPay address resolution (localStorage > VITE_ env > defaults)
- `src/hooks/useSendPayment.ts` - approve + pay flow with simulation and receipt verification
- `src/hooks/useReceivedPayments.ts` - bounded USDC Transfer log scan for the connected wallet
- `src/components/` - Header, NetworkBanner, BalanceCard, SendCard, ReceiveCard, TxStatus, SettingsDialog
- `docs/DEPLOY_REMIX.md` - Remix deployment instructions

## Decisions

- The contract has no owner, no withdraw, no custody. `pay(to, amount, memo)` does `safeTransferFrom(payer, to, amount)` and emits `PaymentSent`.
- The app approves exactly the amount being sent, never unlimited.
- Success is shown only after a successful receipt (and the `PaymentSent` event when routed through the contract).
- Nothing has been deployed by Arc Studio. Deployed contract address: not deployed yet (set `VITE_ORBITPAY_ADDRESS` or use Settings).

## To Run

```bash
bun install
bun run dev
```
