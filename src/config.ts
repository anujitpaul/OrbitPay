/**
 * wagmi configuration: Arc Mainnet only, MetaMask + WalletConnect.
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig, type CreateConnectorFn } from 'wagmi'
import { defineChain } from 'viem'
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors'
import { registerChain } from './tracing'
import { ARC_CHAIN_ID, ARC_CHAIN_NAME, ARC_EXPLORER_BASE, ARC_NATIVE_DECIMALS, settings } from './lib/settings'

export const arcMainnet = defineChain({
  id: ARC_CHAIN_ID,
  name: ARC_CHAIN_NAME,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: ARC_NATIVE_DECIMALS },
  rpcUrls: { default: { http: [settings.rpcUrl] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: ARC_EXPLORER_BASE } },
})

// Pre-register the chain RPC URL so trace events show the chain name immediately
registerChain(arcMainnet.id, settings.rpcUrl)

// Wallet support:
// - Every installed browser extension that announces itself via EIP-6963 (MetaMask, Rabby, Trust Wallet,
//   OKX, Bitget, Brave Wallet, Frame, Coinbase, Phantom EVM, and more) is discovered automatically
//   (multiInjectedProviderDiscovery below), so no wallet is hard-coded or favoured.
// - injected() is the generic fallback for wallets and in-app browsers that only set window.ethereum.
// - Coinbase Wallet is added for its mobile and extension flows (regular accounts only, no smart wallet).
// - WalletConnect covers mobile wallets via QR code or deep link when a project ID is configured.
const connectors: CreateConnectorFn[] = [
  injected(),
  coinbaseWallet({ appName: 'OrbitPay', preference: 'eoaOnly' }),
]

if (settings.walletConnectProjectId) {
  connectors.push(
    walletConnect({
      projectId: settings.walletConnectProjectId,
      showQrModal: false, // the wallet picker renders the pairing QR itself
      metadata: {
        name: 'OrbitPay',
        description: 'Send and receive USDC on Arc',
        url: window.location.origin,
        icons: [],
      },
    }),
  )
}

export const config = createConfig({
  chains: [arcMainnet],
  connectors,
  multiInjectedProviderDiscovery: true,
  transports: {
    // Timeout + retry keep a slow RPC from hanging the UI; batching merges parallel reads.
    [arcMainnet.id]: http(settings.rpcUrl, { timeout: 10_000, retryCount: 3, retryDelay: 400, batch: true }),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
