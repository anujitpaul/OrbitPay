import { ArrowDownLeft, ArrowUpRight, CheckCircle2, ExternalLink, Loader2, Repeat2, XCircle } from 'lucide-react'
import { displayUsdc, shortAddress } from '@/lib/format'
import { ARC_CHAIN_ID } from '@/lib/settings'
import type { HistoryTx } from '@/lib/txStore'
import { buildTxExplorerUrl } from '@/onchain-facts'

const DIRECTION = {
  in: { label: 'Received', sign: '+', Icon: ArrowDownLeft, tint: 'rgba(141,216,159,0.12)', color: 'var(--success)' },
  out: { label: 'Sent', sign: '-', Icon: ArrowUpRight, tint: 'rgba(172,198,233,0.14)', color: 'var(--accent)' },
  self: { label: 'To self', sign: '', Icon: Repeat2, tint: 'rgba(255,255,255,0.08)', color: 'var(--muted)' },
} as const

function formatWhen(tx: HistoryTx): { date: string; time: string } | undefined {
  const ms = tx.timestamp !== undefined ? tx.timestamp * 1000 : tx.createdAt
  if (ms === undefined) return undefined
  const d = new Date(ms)
  return {
    date: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }
}

function StatusBadge({ tx }: { tx: HistoryTx }) {
  if (tx.status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: 'rgba(242,197,124,0.14)', color: 'var(--warn)' }}>
        <Loader2 className="size-3 animate-spin" /> Pending
      </span>
    )
  }
  if (tx.status === 'failed') {
    return (
      <span title={tx.message} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: 'rgba(240,133,146,0.14)', color: 'var(--danger)' }}>
        <XCircle className="size-3" /> Failed
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: 'rgba(141,216,159,0.14)', color: 'var(--success)' }}>
      <CheckCircle2 className="size-3" /> Confirmed
    </span>
  )
}

function amountText(tx: HistoryTx): string {
  if (tx.dust) return '<0.000001'
  return displayUsdc(tx.amount)
}

export function ActivityRow({ tx }: { tx: HistoryTx }) {
  const dir = DIRECTION[tx.direction]
  const when = formatWhen(tx)
  const url = buildTxExplorerUrl(ARC_CHAIN_ID, tx.hash)
  const struck = tx.status === 'failed'

  return (
    <li className="inner rounded-2xl p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full" style={{ background: dir.tint }}>
          <dir.Icon className="size-4" style={{ color: dir.color }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{dir.label}</span>
              <StatusBadge tx={tx} />
            </div>
            <span
              className={`display text-base font-semibold tabular-nums ${struck ? 'line-through opacity-60' : ''}`}
              style={{ color: tx.direction === 'in' ? 'var(--success)' : 'var(--ink)' }}
            >
              {dir.sign}
              {amountText(tx)} <span className="text-xs font-medium" style={{ color: 'var(--subtle)' }}>USDC</span>
            </span>
          </div>

          <dl className="mono mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>
            <dt style={{ color: 'var(--subtle)' }}>From</dt>
            <dd className="break-all" title={tx.from}>
              {shortAddress(tx.from, 8, 6)}
            </dd>
            <dt style={{ color: 'var(--subtle)' }}>To</dt>
            <dd className="break-all" title={tx.to}>
              {shortAddress(tx.to, 8, 6)}
            </dd>
          </dl>

          {tx.status === 'failed' && tx.message && (
            <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
              {tx.message}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--subtle)' }}>
            <span className="tabular-nums">
              {when ? `${tx.source === 'local' && tx.timestamp === undefined ? 'Submitted ' : ''}${when.date}, ${when.time}` : tx.blockNumber !== undefined ? `Block ${tx.blockNumber.toLocaleString('en-US')} · loading time…` : 'Time unavailable'}
            </span>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`View transaction ${tx.hash} on Arc Explorer`}
              className="mono inline-flex min-h-8 items-center gap-1 underline-offset-4 hover:underline"
              style={{ color: 'var(--accent)' }}
              title={tx.hash}
            >
              {shortAddress(tx.hash, 8, 6)} <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
      </div>
    </li>
  )
}

export function ActivityList({ items }: { items: HistoryTx[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((tx) => (
        <ActivityRow key={tx.id} tx={tx} />
      ))}
    </ul>
  )
}
