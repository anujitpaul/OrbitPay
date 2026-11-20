import { RefreshCw } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import { useAccount } from 'wagmi'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { ARC_CHAIN_NAME } from '@/lib/settings'
import { displayUsdc } from '@/lib/format'

export function BalanceCard() {
  const { isConnected } = useAccount()
  const { balance, isLoading, isError, refetch } = useUsdcBalance()

  return (
    <section className="glass rounded-3xl p-5" aria-label="USDC balance">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TokenUSDC variant="branded" size={20} />
          <span className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
            USDC balance
          </span>
        </div>
        {isConnected && (
          <button
            type="button"
            onClick={() => void refetch()}
            aria-label="Refresh balance"
            className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-white/10"
            style={{ color: 'var(--subtle)' }}
          >
            <RefreshCw className="size-4" />
          </button>
        )}
      </div>

      <div className="flex items-baseline gap-2">
        {!isConnected ? (
          <span className="display text-4xl font-bold" style={{ color: 'var(--subtle)' }}>
            --
          </span>
        ) : isLoading ? (
          <span className="h-10 w-40 animate-pulse rounded-lg bg-white/10" />
        ) : isError || balance === undefined ? (
          <span className="display text-2xl font-bold" style={{ color: 'var(--danger)' }}>
            Unavailable
          </span>
        ) : (
          <span className="display text-4xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
            {displayUsdc(balance)}
          </span>
        )}
        <span className="text-lg font-medium" style={{ color: 'var(--subtle)' }}>
          USDC
        </span>
      </div>

      <p className="mt-1.5 text-xs" style={{ color: 'var(--muted)' }}>
        {!isConnected
          ? 'Connect a wallet to see your live balance.'
          : isError
            ? 'Could not reach the Arc RPC. Tap refresh to retry.'
            : `Live on ${ARC_CHAIN_NAME} Mainnet. USDC also pays network fees.`}
      </p>
    </section>
  )
}
