import { ConnectKitButton } from 'connectkit'
import { LogOut, Settings, Wallet } from 'lucide-react'
import { useAccount, useDisconnect } from 'wagmi'
import { shortAddress } from '@/lib/format'

function OrbitMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="#14253d" stroke="rgba(172,198,233,0.45)" />
      <ellipse cx="16" cy="16" rx="11" ry="5" transform="rotate(-28 16 16)" stroke="#acc6e9" strokeWidth="1.6" />
      <circle cx="16" cy="16" r="4" fill="#acc6e9" />
      <circle cx="25" cy="11" r="2" fill="#f4f7fb" />
    </svg>
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
    <header className="flex items-center justify-between gap-3 py-5">
      <div className="flex items-center gap-2.5">
        <OrbitMark />
        <span className="display text-xl font-bold" style={{ color: 'var(--ink)' }}>
          OrbitPay
        </span>
      </div>
      <div className="flex items-center gap-2">
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className="flex size-11 items-center justify-center rounded-full transition-colors hover:bg-white/10"
            style={{ color: 'var(--muted)' }}
          >
            <Settings className="size-5" />
          </button>
        )}
        <ConnectKitButton.Custom>
          {({ isConnected: connected, show, address }) => (
            <button
              type="button"
              onClick={show}
              title={connected ? `Connected with ${connector?.name ?? 'your wallet'}` : 'Choose a wallet'}
              className="flex h-11 items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98]"
              style={
                connected
                  ? { background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }
                  : { background: 'var(--accent)', color: 'var(--accent-ink)' }
              }
            >
              {connected && connector?.icon ? (
                <img src={connector.icon} alt="" className="size-5 rounded-md" />
              ) : (
                <Wallet className="size-4" />
              )}
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
            className="flex size-11 items-center justify-center rounded-full transition-colors hover:bg-white/10"
            style={{ color: 'var(--muted)' }}
          >
            <LogOut className="size-5" />
          </button>
        )}
      </div>
    </header>
  )
}
