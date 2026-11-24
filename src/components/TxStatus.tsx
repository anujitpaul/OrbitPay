import { AlertCircle, CheckCircle2, Clock, ExternalLink, Loader2, XCircle } from 'lucide-react'
import type { SendState } from '@/hooks/useSendPayment'
import { displayUsdc, shortAddress } from '@/lib/format'
import { ARC_CHAIN_ID } from '@/lib/settings'
import { buildTxExplorerUrl } from '@/onchain-facts'

interface TxStatusProps {
  state: SendState
  onDone: () => void
  onEdit: () => void
  onRetry: () => void
}

const BUSY_COPY: Record<string, { title: string; body: string }> = {
  checking: { title: 'Preparing payment', body: 'Checking your balance and approval on Arc.' },
  'approve-wallet': { title: 'Approve USDC in your wallet', body: 'This lets OrbitPay move exactly this amount, nothing more.' },
  'approve-confirming': { title: 'Confirming approval', body: 'Waiting for the approval to be confirmed onchain.' },
  'pay-wallet': { title: 'Confirm payment in your wallet', body: 'Review the details in your wallet and approve to send.' },
  'pay-confirming': { title: 'Confirming payment', body: 'Waiting for the payment to be confirmed onchain.' },
}

function ExplorerLink({ hash, label }: { hash: string; label: string }) {
  return (
    <a
      href={buildTxExplorerUrl(ARC_CHAIN_ID, hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold underline-offset-4 hover:underline"
      style={{ color: 'var(--accent)' }}
    >
      {label} <ExternalLink className="size-3.5" />
    </a>
  )
}

export function TxStatus({ state, onDone, onEdit, onRetry }: TxStatusProps) {
  const { phase, to, amount, hash, approveHash, message } = state
  const summary =
    amount !== undefined && to ? `${displayUsdc(amount)} USDC to ${shortAddress(to)}` : undefined

  if (phase in BUSY_COPY) {
    const copy = BUSY_COPY[phase]
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center" role="status" aria-live="polite">
        <Loader2 className="size-9 animate-spin" style={{ color: 'var(--accent)' }} />
        <div>
          <p className="display text-lg font-semibold">{copy.title}</p>
          <p className="mt-1 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
            {copy.body}
          </p>
          {summary && (
            <p className="mono mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
              {summary}
            </p>
          )}
        </div>
        {phase === 'approve-confirming' && approveHash && <ExplorerLink hash={approveHash} label="View approval" />}
        {phase === 'pay-confirming' && hash && <ExplorerLink hash={hash} label="View transaction" />}
      </div>
    )
  }

  if (phase === 'success') {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center" role="status" aria-live="polite">
        <CheckCircle2 className="size-10" style={{ color: 'var(--success)' }} />
        <div>
          <p className="display text-xl font-semibold">Payment confirmed</p>
          {summary && (
            <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              {summary}
            </p>
          )}
          <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
            Verified from the transaction receipt on Arc.
          </p>
        </div>
        {hash && <ExplorerLink hash={hash} label="View on Arc Explorer" />}
        <button
          type="button"
          onClick={onDone}
          className="mt-1 h-12 w-full rounded-2xl text-sm font-semibold transition-transform active:scale-[0.99]"
          style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}
        >
          Send another payment
        </button>
      </div>
    )
  }

  if (phase === 'pending') {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center" role="status">
        <Clock className="size-10" style={{ color: 'var(--warn)' }} />
        <div>
          <p className="display text-lg font-semibold">Still waiting for confirmation</p>
          <p className="mt-1 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
            {message}
          </p>
        </div>
        {hash && <ExplorerLink hash={hash} label="Check on Arc Explorer" />}
        <button
          type="button"
          onClick={onDone}
          className="h-12 w-full rounded-2xl text-sm font-semibold"
          style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
        >
          Back to send
        </button>
      </div>
    )
  }

  if (phase === 'cancelled') {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center" role="status">
        <AlertCircle className="size-10" style={{ color: 'var(--warn)' }} />
        <div>
          <p className="display text-lg font-semibold">Cancelled</p>
          <p className="mt-1 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
            {message}
          </p>
        </div>
        <div className="flex w-full gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="h-12 flex-1 rounded-2xl text-sm font-semibold"
            style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onRetry}
            className="h-12 flex-1 rounded-2xl text-sm font-semibold"
            style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  // error
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center" role="alert">
      <XCircle className="size-10" style={{ color: 'var(--danger)' }} />
      <div>
        <p className="display text-lg font-semibold">Payment failed</p>
        <p className="mt-1 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
          {message}
        </p>
      </div>
      {hash && <ExplorerLink hash={hash} label="View transaction" />}
      <div className="flex w-full gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="h-12 flex-1 rounded-2xl text-sm font-semibold"
          style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="h-12 flex-1 rounded-2xl text-sm font-semibold"
          style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}
        >
          Try again
        </button>
      </div>
    </div>
  )
}
