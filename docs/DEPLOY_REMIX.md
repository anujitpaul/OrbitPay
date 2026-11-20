# Deploying OrbitPay.sol from Remix (Arc Mainnet)

Deploying to mainnet moves real funds and cannot be undone. Review the contract yourself (or get an independent audit) and rehearse on Arc Testnet first. Arc Studio does not deploy or sign anything for you.

## What gets deployed

`contracts/OrbitPay.sol` is a small, non-custodial payment contract. It has no owner, no admin functions, no withdraw function and holds no funds. A payment is a single `pay(to, amount, memo)` call that moves USDC straight from the payer to the recipient and emits `PaymentSent`.

## Before you start

- A wallet (MetaMask) with USDC on Arc Mainnet. USDC is also the gas token on Arc, so the same balance pays the deployment fee.
- Arc Mainnet added to the wallet:
  - Chain ID: `5042`
  - RPC: `https://rpc.mainnet.arc.io`
  - Explorer: `https://explorer.arc.io`
  - Currency: USDC
- The USDC token address on Arc: `0x3600000000000000000000000000000000000000` (6 decimals).

## Steps

1. Open https://remix.ethereum.org and create a file `OrbitPay.sol`. Paste the contents of `contracts/OrbitPay.sol`.
   The file imports OpenZeppelin (`@openzeppelin/contracts/...`). Remix fetches it automatically from npm. For a reproducible build, this project was tested with OpenZeppelin `5.6.1`.
2. Open the **Solidity compiler** tab:
   - Compiler: `0.8.28` (any version satisfying `^0.8.24` works).
   - Enable the optimizer with `200` runs (matches the tested build).
   - Leave the EVM version on a value supported by Arc (check Arc's docs if unsure).
   - Click **Compile OrbitPay.sol**.
3. Open **Deploy & run transactions**:
   - Environment: **Injected Provider - MetaMask**. Confirm MetaMask shows chain ID `5042`.
   - Contract: `OrbitPay`.
   - Constructor argument `usdcAddress`: `0x3600000000000000000000000000000000000000`.
   - Click **Deploy** and confirm in your wallet.
4. Copy the deployed contract address from Remix and check it on https://explorer.arc.io.
5. Confirm on the explorer (or in Remix, by calling the `usdc` getter) that the contract's `usdc` value is the USDC address above.

## Connect the app to your contract

Use either option:

- In the app, open **Settings** (gear icon), paste the contract address into "OrbitPay contract address" and save.
- Or set `VITE_ORBITPAY_ADDRESS=0xYourContract` in `.env` and restart `bun run dev`.

With a contract address set, the app asks for an approval for exactly the amount you send, then calls `pay`. Without one, the app sends a plain USDC transfer.

## Optional: verify the source

Verify `OrbitPay.sol` on Arc Explorer using the same compiler version, optimizer settings and constructor argument so others can read the code.
