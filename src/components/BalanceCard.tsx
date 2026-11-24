import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, RefreshCw } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import { useAccount } from 'wagmi'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { ARC_CHAIN_NAME } from '@/lib/settings'
import { displayUsdc } from '@/lib/format'

export type QuickTab = 'send' | 'receive' | 'swap'

const ACTIONS: { id: QuickTab; label: string; Icon: typeof ArrowUpRight; primary?: boolean }[] = [
  { id: 'send', label: 'Send', Icon: ArrowUpRight, primary: true },
  { id: 'receive', label: 'Receive', Icon: ArrowDownLeft },
  { id: 'swap', label: 'Swap', Icon: ArrowLeftRight },
]

export function BalanceCard({ onNavigate }: { onNavigate?: (tab: QuickTab) => void }) {
  const { isConnected } = useAccount()
  const { balance, isLoading, isError, isFetching, refetch } = useUsdcBalance()
  const [whole, fraction] = balance === undefined ? ['', ''] : displayUsdc(balance).split('.')

  return (
    <section className="glass rise relative overflow-hidden rounded-[2rem] p-5 sm:p-8" aria-label="USDC balance">
      <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-28 size-80 rounded-full" style={{ background: 'radial-gradient(circle, rgba(242,138,69,0.34) 0%, rgba(242,138,69,0) 66%)' }} />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-16 size-72 rounded-full" style={{ background: 'radial-gradient(circle, rgba(200,121,66,0.2) 0%, rgba(200,121,66,0) 68%)' }} />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-8 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(232,166,109,0.7), transparent)' }} />

      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl" style={{ background: 'rgba(242,138,69,0.14)', border: '1px solid rgba(242,138,69,0.28)' }}>
              <TokenUSDC variant="branded" size={20} />
            </span>
            <span className="text-xs font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--muted)' }}>
              USDC balance
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold sm:inline-flex" style={{ background: 'rgba(111,214,162,0.1)', color: 'var(--success)', border: '1px solid rgba(111,214,162,0.25)' }}>
              <span className="live-dot size-1.5 rounded-full" style={{ background: 'var(--success)' }} aria-hidden="true" />
              Live · {ARC_CHAIN_NAME} Mainnet
            </span>
            {isConnected && (
              <button
                type="button"
                onClick={() => void refetch()}
                aria-label="Refresh balance"
                title="Refresh balance"
                className="flex size-10 items-center justify-center rounded-full transition-colors hover:bg-white/10"
                style={{ color: 'var(--highlight)', border: '1px solid var(--border)' }}
              >
                <RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {!isConnected ? (
            <span className="display text-5xl font-bold sm:text-6xl" style={{ color: 'var(--subtle)' }}>
              --
            </span>
          ) : isLoading ? (
            <span className="h-14 w-56 animate-pulse rounded-xl bg-white/10" />
          ) : isError || balance === undefined ? (
            <span className="display text-3xl font-bold" style={{ color: 'var(--danger)' }}>
              Unavailable
            </span>
          ) : (
            <span className="display text-5xl font-bold tabular-nums sm:text-6xl" style={{ color: 'var(--ink)' }}>
              {whole}
              <span style={{ color: 'var(--highlight)', fontSize: '0.62em' }}>.{fraction}</span>
            </span>
          )}
          <span className="text-lg font-semibold" style={{ color: 'var(--muted)' }}>
            USDC
          </span>
        </div>

        <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          {!isConnected
            ? 'Connect a wallet to see your live balance.'
            : isError
              ? 'Could not reach the Arc RPC. Tap refresh to retry.'
              : `Live on ${ARC_CHAIN_NAME} Mainnet. USDC also pays network fees.`}
        </p>

        {onNavigate && (
          <div className="mt-6 grid grid-cols-3 gap-2.5 sm:max-w-md">
            {ACTIONS.map(({ id, label, Icon, primary }) => (
              <button
                key={id}
                type="button"
                onClick={() => onNavigate(id)}
                aria-label={`Go to ${label}`}
                className="flex h-12 items-center justify-center gap-2 rounded-2xl text-sm font-semibold transition-transform hover:-translate-y-px active:scale-[0.98]"
                style={primary ? { background: 'var(--accent-fill)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
