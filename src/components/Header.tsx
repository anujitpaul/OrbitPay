import { ConnectKitButton } from 'connectkit'
import { LogOut, Settings, Wallet } from 'lucide-react'
import { useAccount, useBlockNumber, useDisconnect, useSwitchChain } from 'wagmi'
import { arcMainnet } from '@/config'
import { shortAddress } from '@/lib/format'
import { ARC_CHAIN_ID } from '@/lib/settings'

export function OrbitMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="orbit-g" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f28a45" />
          <stop offset="1" stopColor="#c87942" />
        </linearGradient>
        <linearGradient id="orbit-ring" x1="4" y1="30" x2="36" y2="10" gradientUnits="userSpaceOnUse">
          <stop stopColor="#e8a66d" />
          <stop offset="1" stopColor="#f28a45" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="13" fill="#192b42" stroke="rgba(242,138,69,0.35)" />
      <ellipse cx="20" cy="20" rx="13.5" ry="5.6" transform="rotate(-28 20 20)" stroke="url(#orbit-ring)" strokeWidth="1.8" />
      <circle cx="20" cy="20" r="5.2" fill="url(#orbit-g)" />
      <circle cx="30.4" cy="13.2" r="2.3" fill="#ffffff" />
    </svg>
  )
}

/** Live Arc status: a block-height heartbeat, so the dot is green only while the RPC really answers. */
function NetworkStatus() {
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  const block = useBlockNumber({ chainId: ARC_CHAIN_ID, query: { refetchInterval: 20_000, staleTime: 10_000 } })
  const wrong = isConnected && chainId !== ARC_CHAIN_ID
  const down = block.isError && !block.data

  const tone = wrong ? 'var(--warn)' : down ? 'var(--danger)' : 'var(--success)'
  const label = wrong ? 'Wrong network' : down ? 'RPC offline' : 'Arc Mainnet'
  const Tag = wrong ? 'button' : 'div'
  return (
    <Tag
      {...(wrong ? { type: 'button' as const, onClick: () => switchChain({ chainId: arcMainnet.id }), disabled: isPending, title: 'Switch your wallet to Arc Mainnet' } : { title: down ? 'Could not reach Arc' : `Arc Mainnet is live${block.data ? `, block ${block.data.toLocaleString('en-US')}` : ''}` })}
      className="flex h-10 items-center gap-2 rounded-full px-3.5 text-xs font-semibold"
      style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', color: 'var(--ink)' }}
      aria-label={`Network status: ${label}`}
    >
      <span className={`size-2 rounded-full ${wrong || down ? '' : 'live-dot'}`} style={{ background: tone }} aria-hidden="true" />
      <span className={wrong ? 'inline' : 'hidden sm:inline'}>{wrong ? 'Switch network' : label}</span>
    </Tag>
  )
}

interface HeaderProps {
  /** Omit on pages that have no settings (the public invoice page). */
  onOpenSettings?: () => void
}

export function Header({ onOpenSettings }: HeaderProps) {
  const { isConnected, isConnecting, connector } = useAccount()
  const { disconnect } = useDisconnect()

  return (
    <header className="flex items-center justify-between gap-3 py-4 sm:py-6">
      <div className="flex items-center gap-3">
        <OrbitMark />
        <div className="leading-none">
          <span className="display block text-xl font-bold" style={{ color: 'var(--ink)' }}>
            OrbitPay
          </span>
          <span className="mt-1 hidden text-[11px] font-medium uppercase tracking-[0.14em] sm:block" style={{ color: 'var(--subtle)' }}>
            USDC payments on Arc
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2">
        <NetworkStatus />
        <ConnectKitButton.Custom>
          {({ isConnected: connected, show, address }) => (
            <button
              type="button"
              onClick={show}
              title={connected ? `Connected with ${connector?.name ?? 'your wallet'}` : 'Choose a wallet'}
              className="flex h-10 items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-sm font-semibold transition-transform hover:-translate-y-px active:scale-[0.98]"
              style={
                connected
                  ? { background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }
                  : { background: 'var(--accent-fill)', color: 'var(--accent-ink)' }
              }
            >
              {connected && connector?.icon ? <img src={connector.icon} alt="" className="size-5 rounded-md" /> : <Wallet className="size-4" />}
              <span className={connected ? 'mono text-xs' : ''}>
                {isConnecting ? 'Connecting…' : connected && address ? shortAddress(address) : 'Connect'}
                {!connected && !isConnecting && <span className="hidden sm:inline">&nbsp;wallet</span>}
              </span>
            </button>
          )}
        </ConnectKitButton.Custom>
        {isConnected && (
          <button
            type="button"
            onClick={() => disconnect()}
            aria-label="Disconnect wallet"
            title="Disconnect wallet"
            className="hidden size-10 items-center justify-center rounded-full transition-colors hover:bg-white/10 sm:flex"
            style={{ color: 'var(--muted)' }}
          >
            <LogOut className="size-[18px]" />
          </button>
        )}
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className="flex size-10 items-center justify-center rounded-full transition-colors hover:bg-white/10"
            style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            <Settings className="size-[18px]" />
          </button>
        )}
      </div>
    </header>
  )
}
