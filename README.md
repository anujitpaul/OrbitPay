# OrbitPay

A minimal, non-custodial USDC payment app for Arc Mainnet: send USDC to any wallet and receive USDC with your address and a QR code. It comes with its own `OrbitPay.sol` payment contract.

Built with [Arc Studio](https://studio.arc.io)

## Features

- Connect with any EVM wallet: installed browser extensions are detected automatically (MetaMask, Rabby, Trust Wallet, OKX, Bitget, Brave Wallet, Frame, Coinbase Wallet and others), plus WalletConnect for mobile wallets by QR code or deep link.
- Easy connect and disconnect, automatic detection of the wallet's network, and a one-tap switch to Arc Mainnet.
- Live USDC balance.
- Send USDC with address and amount checks, a review step, wallet confirmation, and a success message only after the transaction receipt is verified.
- Receive USDC: copy your address, show a QR code, and see recent incoming USDC transfers.
- Payment assistant: a chat that runs in your browser (no API key, no server). Ask about your balance, recent payments or totals, look up a transaction hash, or say "send 25 USDC to 0x…" and it fills in the Send form for you to review. It never sends anything itself.
- Invoices: create a signed USDC invoice (client name and wallet, project, description, amount, deadline, delivery links and work images), get a shareable link and QR code, and download a PDF. Clients open the link without a wallet, then pay from the client wallet named on the invoice. An invoice only turns Paid after the payment's receipt and USDC Transfer event are verified on Arc Mainnet; payments of the wrong amount or from another wallet never count. Invoices live in your browser and travel inside the link (no server), so the link is the only copy a client has.
- Transaction history: every USDC payment you sent or received on Arc Mainnet, read from the chain (including payments made before this session), with Pending, Confirmed and Failed status, amount, sender, receiver, date and time, and an Arc Explorer link. New payments are saved the moment you submit them, and history refreshes after every payment, on reconnect and when you switch accounts. Older history loads in steps because the public RPC limits block ranges.
- Configurable RPC URL, USDC address and OrbitPay contract address (Settings dialog or environment variables).

## Tech stack

React, Vite, TypeScript, Tailwind CSS, wagmi, viem, ConnectKit (wallet modal, EIP-6963 wallet discovery), Solidity 0.8.28 with Foundry and OpenZeppelin, jsPDF and qrcode for invoice PDFs.

## Network

Arc Mainnet, chain ID 5042, USDC `0x3600000000000000000000000000000000000000` (6 decimals), explorer https://explorer.arc.io. This app moves real funds. Review everything yourself before using it with real USDC.

## Development

Prerequisites: [Bun](https://bun.sh) and [Foundry](https://book.getfoundry.sh).

```bash
bun install
bun run dev          # start the app
bun run check        # lint and typecheck
bunx vite build      # production build
bun run contracts:test   # Solidity tests
bun run test:assistant   # payment assistant tests
```

### Environment variables

All are optional. Put them in `.env` and restart the dev server.

- `VITE_ARC_RPC_URL`: Arc RPC endpoint (default `https://rpc.mainnet.arc.io`).
- `VITE_ARC_RPC_FALLBACK_URLS`: comma-separated backup Arc RPC endpoints used when the main one fails or rate limits (default: the public QuickNode and Blockdaemon endpoints from the Arc docs). Set it to an empty value to turn fallbacks off, for example if you only want to talk to your own RPC.
- `VITE_USDC_ADDRESS`: USDC token address (default is the Arc USDC address above).
- `VITE_ORBITPAY_ADDRESS`: your deployed OrbitPay contract. When empty, the app sends direct USDC transfers.
- `VITE_WALLETCONNECT_PROJECT_ID`: project ID from https://cloud.walletconnect.com. Without it, browser-extension wallets and Coinbase Wallet still work, but mobile QR connections are off.

Values saved in the Settings dialog take priority over environment variables.

## Deploying the contract

See [docs/DEPLOY_REMIX.md](docs/DEPLOY_REMIX.md).
