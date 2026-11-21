import { useEffect, useMemo, useState } from 'react'
import { useModal } from 'connectkit'
import { History, Loader2, RefreshCw } from 'lucide-react'
import type { TransactionHistory } from '@/hooks/useTransactionHistory'
import { ActivityList } from './ActivityList'

type Filter = 'all' | 'in' | 'out'

const PAGE = 20

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'out', label: 'Sent' },
  { id: 'in', label: 'Received' },
]

export function scanSummary(history: TransactionHistory): string {
  const { head, scannedFrom, scannedFromTime, complete, scanProgress } = history.snapshot
  if (scanProgress !== undefined && head === undefined) return `Searching Arc… ${scanProgress.toLocaleString('en-US')} blocks scanned so far.`
  if (complete) return 'Full history loaded, back to the first block.'
  if (head === undefined || scannedFrom === undefined) return 'Reading transfers from Arc…'
  const blocks = (head - scannedFrom + 1n).toLocaleString('en-US')
  const since = scannedFromTime
    ? ` Scanned back to ${new Date(scannedFromTime * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${blocks} blocks).`
    : ` Scanned ${blocks} blocks.`
  return since.trim()
}

export function HistoryCard({ history }: { history: TransactionHistory }) {
  const { setOpen } = useModal()
  const [filter, setFilter] = useState<Filter>('all')
  const [shown, setShown] = useState(PAGE)
  const { snapshot, items, isConnected } = history

  const visible = useMemo(
    () => items.filter((i) => filter === 'all' || i.direction === filter),
    [items, filter],
  )

  const onScreen = useMemo(() => visible.slice(0, shown), [visible, shown])
  const { ensureTimes } = history
  useEffect(() => {
    ensureTimes(onScreen.map((r) => r.id))
  }, [onScreen, ensureTimes])

  if (!isConnected) {
    return (
      <section className="glass rounded-3xl p-6 text-center" aria-label="Transaction history">
        <p className="display text-lg font-semibold">Transaction history</p>
        <p className="mx-auto mt-1 max-w-xs text-sm text-pretty" style={{ color: 'var(--muted)' }}>
          Connect your wallet to see every USDC payment you sent or received on Arc Mainnet.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 h-12 w-full rounded-2xl text-sm font-semibold"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
        >
          Connect wallet
        </button>
      </section>
    )
  }

  const busy = snapshot.loadingLatest || snapshot.loadingOlder
  const firstLoad = !snapshot.hasLoaded && busy && items.length === 0

  return (
    <section className="glass rounded-3xl p-5" aria-label="Transaction history">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="display flex items-center gap-2 text-base font-semibold">
          <History className="size-4" style={{ color: 'var(--accent)' }} /> Transaction history
        </h2>
        <button
          type="button"
          onClick={history.refresh}
          aria-label="Refresh history"
          className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-white/10"
          style={{ color: 'var(--subtle)' }}
        >
          {snapshot.loadingLatest ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </button>
      </div>

      <div role="group" aria-label="Filter transactions" className="mb-3 flex gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => {
              setFilter(f.id)
              setShown(PAGE)
            }}
            className="h-9 rounded-full px-4 text-xs font-semibold transition-colors"
            style={filter === f.id ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', color: 'var(--muted)' }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {snapshot.error && (
        <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-2xl p-3 text-xs" style={{ background: 'rgba(240,133,146,0.1)', border: '1px solid rgba(240,133,146,0.3)', color: 'var(--ink)' }}>
          <span className="text-pretty">{snapshot.error}</span>
          <button
            type="button"
            onClick={history.refresh}
            className="h-9 shrink-0 rounded-xl px-3 font-semibold"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            Retry
          </button>
        </div>
      )}

      {firstLoad ? (
        <div className="flex flex-col gap-2" aria-label="Loading history">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-white/10" />
          ))}
        </div>
      ) : visible.length > 0 ? (
        <>
          <ActivityList items={onScreen} />
          {visible.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className="mt-2 h-11 w-full rounded-2xl text-sm font-semibold"
              style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            >
              Show more ({visible.length - shown} more loaded)
            </button>
          )}
        </>
      ) : (
        <p className="py-4 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
          {busy ? 'Searching Arc for your transfers…' : 'No USDC transfers found in the scanned range yet.'}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <p className="text-xs text-pretty" style={{ color: 'var(--subtle)' }} aria-live="polite">
          {scanSummary(history)}
        </p>
        {!snapshot.complete && snapshot.scannedFrom !== undefined && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={history.loadOlder}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-2xl text-sm font-semibold disabled:opacity-50"
              style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            >
              {snapshot.loadingOlder && !snapshot.scanningAll && <Loader2 className="size-4 animate-spin" />}
              Load older
            </button>
            {snapshot.scanningAll ? (
              <button
                type="button"
                onClick={history.stop}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-2xl text-sm font-semibold"
                style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
              >
                <Loader2 className="size-4 animate-spin" /> Stop scanning
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={history.scanAll}
                className="h-11 flex-1 rounded-2xl text-sm font-semibold disabled:opacity-50"
                style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
              >
                Scan full history
              </button>
            )}
          </div>
        )}
        <p className="text-[11px] text-pretty" style={{ color: 'var(--subtle)' }}>
          Read directly from Arc. The public RPC limits how many blocks can be searched at once, so older history loads in steps. Payments that failed before reaching a block only appear if you sent them from this browser.
        </p>
      </div>
    </section>
  )
}
