import { useState } from 'react'
import { AlertCircle, CheckCircle2, Clock, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import { useBridgeRecords } from '@/hooks/useBridge'
import { explorerTxUrl, getBridgeChain, listBridgeChains } from '@/lib/bridge/routes'
import type { BridgeRecord, BridgeStatus } from '@/lib/bridge/store'
import { displayUsdc, shortAddress } from '@/lib/format'

export const STATUS_COPY: Record<BridgeStatus, { label: string; color: string; bg: string }> = {
  pending: { label: 'Pending', color: 'var(--warn)', bg: 'rgba(242,197,124,0.14)' },
  attested: { label: 'Ready to mint', color: 'var(--accent)', bg: 'rgba(172,198,233,0.16)' },
  completed: { label: 'Completed', color: 'var(--success)', bg: 'rgba(141,216,159,0.14)' },
  failed: { label: 'Failed', color: 'var(--danger)', bg: 'rgba(255,138,138,0.12)' },
}

export function StatusBadge({ status, label }: { status: BridgeStatus; label?: string }) {
  const s = STATUS_COPY[status]
  const Icon = status === 'completed' ? CheckCircle2 : status === 'failed' ? AlertCircle : status === 'attested' ? ShieldCheck : Clock
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: s.bg, color: s.color }}>
      <Icon className="size-3" /> {label ?? s.label}
    </span>
  )
}

export function TxLink({ chainKey, hash, label }: { chainKey: string; hash: string; label: string }) {
  const chain = getBridgeChain(chainKey)
  if (!chain) return null
  return (
    <a
      href={explorerTxUrl(chain, hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="mono inline-flex min-h-8 items-center gap-1 text-xs underline-offset-4 hover:underline"
      style={{ color: 'var(--accent)' }}
      title={hash}
    >
      {label} {shortAddress(hash, 8, 6)} <ExternalLink className="size-3" />
    </a>
  )
}

function whenText(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

interface RowProps {
  r: BridgeRecord
  claiming: boolean
  retrying: boolean
  claimError?: string
  onComplete: (r: BridgeRecord) => void
  onRetry: (r: BridgeRecord) => void
}

function Row({ r, claiming, retrying, claimError, onComplete, onRetry }: RowProps) {
  const source = getBridgeChain(r.source)
  const destination = getBridgeChain(r.destination)
  const canComplete = r.status === 'attested' && !r.forwarder && !r.mintHash
  const canRetry = Boolean(r.burnHash) && (r.status === 'pending' || r.status === 'failed')
  const badgeLabel = r.status === 'pending' && r.burnHash ? 'Pending attestation' : r.status === 'attested' && r.forwarder ? 'Attestation received' : undefined
  return (
    <li className="inner rounded-2xl p-3.5" aria-label={`Bridge ${r.source} to ${r.destination}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {source?.title ?? r.source} → {destination?.title ?? r.destination}
          </p>
          <p className="text-xs" style={{ color: 'var(--subtle)' }}>
            {whenText(r.createdAt)} · {r.speed === 'FAST' ? 'Fast' : 'Standard'}
            {r.forwarder ? ' · Forwarding Service' : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <p className="display text-base font-bold tabular-nums">{displayUsdc(BigInt(r.amount))} USDC</p>
          <StatusBadge status={r.status} label={badgeLabel} />
        </div>
      </div>

      <p className="mt-2 break-words text-xs text-pretty" style={{ color: r.status === 'failed' ? 'var(--danger)' : 'var(--muted)' }}>
        {r.detail}
        {r.status === 'completed' && r.received ? ` ${displayUsdc(BigInt(r.received))} USDC received.` : ''}
      </p>
      {r.error && r.status !== 'completed' && (
        <p className="mt-1 break-words text-[11px] text-pretty" style={{ color: 'var(--subtle)' }}>
          {r.error}
        </p>
      )}
      <p className="mono mt-1 break-all text-[11px]" style={{ color: 'var(--subtle)' }} title={r.recipient}>
        To {r.recipient}
      </p>

      <div className="mt-2 flex flex-col gap-0.5">
        {r.approveHash && <TxLink chainKey={r.source} hash={r.approveHash} label="Approval" />}
        {r.burnHash && <TxLink chainKey={r.source} hash={r.burnHash} label="Source burn" />}
        {r.mintHash && <TxLink chainKey={r.destination} hash={r.mintHash} label="Destination mint" />}
      </div>

      {canComplete && (
        <button
          type="button"
          disabled={claiming}
          onClick={() => onComplete(r)}
          className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
        >
          {claiming && <Loader2 className="size-4 animate-spin" />}
          {claiming ? 'Confirm in your wallet…' : `Resume mint on ${destination?.title ?? r.destination}`}
        </button>
      )}
      {canRetry && (
        <button
          type="button"
          disabled={retrying}
          onClick={() => onRetry(r)}
          className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
        >
          {retrying && <Loader2 className="size-4 animate-spin" />}
          Retry attestation
        </button>
      )}
      {(canComplete || canRetry) && (
        <p className="mt-1.5 text-[11px] text-pretty" style={{ color: 'var(--subtle)' }}>
          Recovery only reads Circle and the chains. It never repeats the approval or the burn, and a mint always needs your wallet confirmation.
        </p>
      )}
      {claimError && (
        <p className="mt-2 text-xs text-pretty" role="alert" style={{ color: 'var(--danger)' }}>
          {claimError}
        </p>
      )}
    </li>
  )
}

function RecoverForm({ onRecover }: { onRecover: (sourceKey: string, hash: string) => Promise<{ ok: true } | { ok: false; message: string }> }) {
  const chains = listBridgeChains()
  const [open, setOpen] = useState(false)
  const [sourceKey, setSourceKey] = useState('Arc')
  const [hash, setHash] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>(undefined)

  const submit = async () => {
    setBusy(true)
    setMessage(undefined)
    const result = await onRecover(sourceKey, hash)
    setBusy(false)
    if (result.ok) {
      setHash('')
      setMessage({ ok: true, text: 'Transfer found and added to the history below.' })
    } else {
      setMessage({ ok: false, text: result.message })
    }
  }

  return (
    <div className="mb-3">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="min-h-9 text-xs font-semibold underline underline-offset-4" style={{ color: 'var(--accent)' }}>
        {open ? 'Hide recovery' : 'Recover a transfer from its burn transaction'}
      </button>
      {open && (
        <div className="inner mt-2 flex flex-col gap-2 rounded-2xl p-3">
          <p className="text-xs text-pretty" style={{ color: 'var(--muted)' }}>
            Paste the hash of a burn you already made. OrbitPay reads it from the chain (read-only), then checks Circle’s attestation against it. Nothing is sent.
          </p>
          <label htmlFor="recover-chain" className="sr-only">
            Chain of the burn
          </label>
          <select id="recover-chain" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} className="field h-11 rounded-xl px-3 text-sm outline-none">
            {chains.map((c) => (
              <option key={c.key} value={c.key} style={{ color: '#0b1628' }}>
                Burned on {c.title.replace(/ Mainnet$/, '')}
              </option>
            ))}
          </select>
          <label htmlFor="recover-hash" className="sr-only">
            Burn transaction hash
          </label>
          <input
            id="recover-hash"
            value={hash}
            onChange={(e) => setHash(e.target.value)}
            placeholder="0x… burn transaction hash"
            autoComplete="off"
            spellCheck={false}
            className="field mono h-11 rounded-xl px-3 text-xs outline-none placeholder:text-slate-500"
          />
          <button
            type="button"
            disabled={busy || hash.trim() === ''}
            onClick={() => void submit()}
            className="flex h-10 items-center justify-center gap-2 rounded-xl text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Find transfer
          </button>
          {message && (
            <p className="text-xs text-pretty" role={message.ok ? 'status' : 'alert'} style={{ color: message.ok ? 'var(--success)' : 'var(--danger)' }}>
              {message.text}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function BridgeHistory({ activeId }: { activeId: string | undefined }) {
  const { records, claiming, retrying, claimError, refreshError, refresh, complete, retryAttestation, recover } = useBridgeRecords(activeId)
  return (
    <section className="glass rounded-3xl p-5" aria-label="Bridge history">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="display text-lg font-semibold">Bridge history</h2>
        <button type="button" onClick={() => void refresh()} className="min-h-9 rounded-full px-3 text-xs font-semibold" style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}>
          Refresh
        </button>
      </div>
      <RecoverForm onRecover={async (k, h) => { const r = await recover(k, h); return r.ok ? { ok: true } : r }} />
      {refreshError && (
        <p className="mb-3 text-xs text-pretty" role="alert" style={{ color: 'var(--danger)' }}>
          Couldn’t refresh from Circle: {refreshError} It retries automatically.
        </p>
      )}
      {records.length === 0 ? (
        <p className="py-4 text-center text-sm" style={{ color: 'var(--muted)' }}>
          No bridge transfers from this wallet yet. Transfers you start here are saved on this device and tracked automatically.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {records.map((r) => (
            <Row key={r.id} r={r} claiming={claiming === r.id} retrying={retrying === r.id} onRetry={(rec) => void retryAttestation(rec)} claimError={claimError?.id === r.id ? claimError.message : undefined} onComplete={(rec) => void complete(rec)} />
          ))}
        </ul>
      )}
    </section>
  )
}
