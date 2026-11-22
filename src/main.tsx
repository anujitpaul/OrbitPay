/*
 *  ███████╗████████╗██╗   ██╗██████╗ ██╗ ██████╗
 *  ██╔════╝╚══██╔══╝██║   ██║██╔══██╗██║██╔═══██╗
 *  ███████╗   ██║   ██║   ██║██║  ██║██║██║   ██║
 *  ╚════██║   ██║   ██║   ██║██║  ██║██║██║   ██║
 *  ███████║   ██║   ╚██████╔╝██████╔╝██║╚██████╔╝
 *  ╚══════╝   ╚═╝    ╚═════╝ ╚═════╝ ╚═╝ ╚═════╝
 *
 *  Built with Arc Studio
 *  https://studio.arc.io
 */

import './tracing'
import './console-capture'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectKitProvider } from 'connectkit'
import { Toaster } from 'sonner'
import { config } from './config'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installShareSync } from './lib/share'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: false, staleTime: 10_000 } },
})

installShareSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider
          theme="midnight"
          options={{
            initialChainId: 5042,
            // Let any wallet connect, then OrbitPay offers a one-tap switch to Arc Mainnet.
            enforceSupportedChains: false,
            hideNoWalletCTA: false,
            walletConnectName: 'WalletConnect',
            walletConnectCTA: 'both', // QR code for desktop, deep link for mobile
            hideQuestionMarkCTA: true,
          }}
          customTheme={{
            '--ck-font-family': "'DM Sans', sans-serif",
            '--ck-body-background': '#0f1f36',
            '--ck-primary-button-background': '#14253d',
            '--ck-accent-color': '#acc6e9',
            '--ck-accent-text-color': '#0b1628',
          }}
        >
          <App />
          <Toaster position="top-center" />
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
    </ErrorBoundary>
  </StrictMode>,
)

