import { AlertTriangle, Loader2 } from 'lucide-react'
import { useAccount, useSwitchChain } from 'wagmi'
import { arcMainnet } from '@/config'
import { parseTxError } from '@/lib/errors'

/** Shown only when a wallet is connected to a network other than Arc Mainnet. */
export function NetworkBanner() {
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending, error } = useSwitchChain()

  if (!isConnected || chainId === arcMainnet.id) return null

  const rejected = error ? parseTxError(error).rejected : false

  return (
    <div
      role="alert"
      className="mb-4 flex flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-center sm:justify-between"
      style={{ background: 'rgba(242,197,124,0.1)', border: '1px solid rgba(242,197,124,0.35)' }}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0" style={{ color: 'var(--warn)' }} />
        <div>
          <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
            Wrong network
          </p>
          <p className="text-xs text-pretty" style={{ color: 'var(--muted)' }}>
            {error && rejected
              ? 'Network switch cancelled in your wallet. Switch to Arc Mainnet (chain ID 5042) to send USDC.'
              : error
                ? 'Your wallet could not switch networks. Add Arc Mainnet (chain ID 5042) in your wallet settings, then try again.'
                : 'Your wallet is on another network. Switch to Arc Mainnet to send USDC.'}
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled={isPending}
        onClick={() => switchChain({ chainId: arcMainnet.id })}
        className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:opacity-60"
        style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
      >
        {isPending && <Loader2 className="size-4 animate-spin" />}
        {isPending ? 'Check your wallet…' : 'Switch to Arc Mainnet'}
      </button>
    </div>
  )
}
