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
- `src/lib/historyScan.ts` - chunked, throttled eth_getLogs scan of USDC Transfer logs (ERC-20 contract and Arc's native system emitter), merged per tx
- `src/lib/historyStore.ts` - per-wallet history store (scan state, cache, polling); `src/lib/txStore.ts` - locally saved submitted hashes + scan cache
- `src/hooks/useTransactionHistory.ts` - merges chain rows with pending/failed local rows, resolves receipts
- `src/components/` - Header, NetworkBanner, BalanceCard, SendCard, ReceiveCard, TxStatus, SettingsDialog
- `docs/DEPLOY_REMIX.md` - Remix deployment instructions

## Decisions

- History: Arc logs USDC Transfers from two emitters (ERC-20 `0x3600...` at 6 decimals, native system emitter `0xffff...fffE` at 18 decimals). Both are read and merged; native-only sends are converted to 6 decimals. The public RPC rejects spans of 10,000+ blocks and rate limits bursts (about 3 calls per second sustained), so scans use 9,000-block chunks with a throttle and load older history on demand.
- RPC failover: `settings.fallbackRpcUrls` (QuickNode, Blockdaemon). wagmi uses a viem `fallback` transport; the history scan uses its own `RpcPool` (per-endpoint throttle, learned block-range limit, cooldown on 429 or network errors, skip on `4444 pruned history`). Blockdaemon is pruned (only recent blocks), dRPC rejects log ranges over 100 blocks so it is not used. Interrupted scans keep progress in localStorage (`orbitpay:scan:v1:*`).
- Reverted txs emit no logs, so Failed rows exist only for payments submitted from this browser (saved by hash).

- The contract has no owner, no withdraw, no custody. `pay(to, amount, memo)` does `safeTransferFrom(payer, to, amount)` and emits `PaymentSent`.
- The app approves exactly the amount being sent, never unlimited.
- Success is shown only after a successful receipt (and the `PaymentSent` event when routed through the contract).
- Nothing has been deployed by Arc Studio. Deployed OrbitPay (Arc Mainnet, chain 5042): `0xB9Fe116564f44C1Ba25614AB13F21487C098C4c9`, deployed by the user's own wallet `0x0D29B10a4cdCeAe1c2aAA76A459D31b032fb3300` (not by Arc Studio). Configured through `VITE_ORBITPAY_ADDRESS` in `.env`. Checked read-only: code is present, `usdc()` returns `0x3600000000000000000000000000000000000000`, and the bytecode matches the local source compiled without the optimizer apart from the immutable USDC slots and the metadata hash. Not source-verified on the explorer.

## To Run

```bash
bun install
bun run dev
```
- Payment assistant (`src/components/AssistantCard.tsx`, `src/hooks/useAssistant.ts`, `src/lib/assistant/`): rule-based and local, no LLM or backend. It reads the live balance and loaded history and can only prefill the Send form (`SendCard` `prefill` prop). Unit tests: `bun run test:assistant` (`tests/assistant.test.ts`).
