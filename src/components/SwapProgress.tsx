import { AlertCircle, CheckCircle2, Circle, Clock, ExternalLink, Loader2, XCircle } from 'lucide-react'
import type { SwapState } from '@/hooks/useSwap'
import { ARC_CHAIN_ID } from '@/lib/settings'
import { fmtToken } from '@/lib/swap/format'
import { buildTxExplorerUrl } from '@/onchain-facts'

const fmt = fmtToken

function TxLink({ hash, label }: { hash: string; label: string }) {
  return (
    <a href={buildTxExplorerUrl(ARC_CHAIN_ID, hash)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold underline-offset-4 hover:underline" style={{ color: 'var(--accent)' }}>
      {label} <ExternalLink className="size-3.5" aria-hidden />
    </a>
  )
}

type StepState = 'done' | 'active' | 'todo' | 'skipped' | 'failed'

function Step({ state, label, hint }: { state: StepState; label: string; hint?: string }) {
  const icon =
    state === 'done' ? <CheckCircle2 className="size-5" style={{ color: 'var(--success)' }} aria-hidden />
    : state === 'active' ? <Loader2 className="size-5 animate-spin" style={{ color: 'var(--accent)' }} aria-hidden />
    : state === 'failed' ? <XCircle className="size-5" style={{ color: 'var(--danger)' }} aria-hidden />
    : <Circle className="size-5" style={{ color: 'var(--subtle)' }} aria-hidden />
  return (
    <li className="flex items-start gap-3" aria-current={state === 'active' ? 'step' : undefined}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>
        <span className="block text-sm font-semibold" style={{ color: state === 'todo' || state === 'skipped' ? 'var(--subtle)' : 'var(--ink)' }}>
          {label}
          {state === 'skipped' ? ' (not needed)' : ''}
        </span>
        {hint && state === 'active' && (
          <span className="block text-xs" style={{ color: 'var(--muted)' }}>
            {hint}
          </span>
        )}
      </span>
    </li>
  )
}

interface SwapProgressProps {
  state: SwapState
  onDone: () => void
  onRetry: () => void
}

/** Step-by-step status of a swap. "Done" is shown only after the swap transaction's receipt says success. */
export function SwapProgress({ state, onDone, onRetry }: SwapProgressProps) {
  const { tokenIn, tokenOut, amountIn, phase } = state
  if (!tokenIn || !tokenOut || amountIn === undefined) return null
  const busy = ['checking', 'approve-wallet', 'approve-confirming', 'permit-wallet', 'swap-wallet', 'swap-confirming'].includes(phase)
  const approved = Boolean(state.approveHash) || ['permit-wallet', 'swap-wallet', 'swap-confirming', 'success'].includes(phase)
  const approveStep: StepState = state.approveHash && phase !== 'approve-wallet' && phase !== 'approve-confirming' ? 'done'
    : phase === 'approve-wallet' || phase === 'approve-confirming' ? 'active'
    : approved ? 'skipped' : 'todo'
  const permitStep: StepState = phase === 'permit-wallet' ? 'active' : ['swap-wallet', 'swap-confirming', 'success'].includes(phase) ? 'done' : 'todo'
  const swapStep: StepState = phase === 'success' ? 'done' : phase === 'swap-wallet' || phase === 'swap-confirming' ? 'active' : 'todo'

  if (phase === 'success') {
    return (
      <div className="flex flex-col gap-4" role="status">
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <CheckCircle2 className="size-12" style={{ color: 'var(--success)' }} aria-hidden />
          <h2 className="display text-xl font-semibold">Swap confirmed</h2>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Confirmed onchain on Arc Mainnet.
          </p>
        </div>
        <dl className="inner flex flex-col gap-2 rounded-2xl p-4 text-sm">
          <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted)' }}>Sent</dt><dd className="font-semibold">{fmt(amountIn, tokenIn.decimals)} {tokenIn.symbol}</dd></div>
          <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted)' }}>Received</dt><dd className="font-semibold" style={{ color: 'var(--success)' }}>{state.received !== undefined && state.received > 0n ? `${fmt(state.received, tokenOut.decimals)} ${tokenOut.symbol}` : `at least ${state.minReceived !== undefined ? fmt(state.minReceived, tokenOut.decimals) : '?'} ${tokenOut.symbol}`}</dd></div>
        </dl>
        {state.hash && <TxLink hash={state.hash} label="View swap on Arc Explorer" />}
        <button type="button" onClick={onDone} className="h-12 rounded-2xl text-sm font-semibold" style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}>
          New swap
        </button>
      </div>
    )
  }

  if (phase === 'pending') {
    return (
      <div className="flex flex-col gap-4" role="status">
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <Clock className="size-12" style={{ color: 'var(--warn)' }} aria-hidden />
          <h2 className="display text-xl font-semibold">Not confirmed yet</h2>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>{state.message}</p>
        </div>
        {state.hash && <TxLink hash={state.hash} label="Check on Arc Explorer" />}
        <button type="button" onClick={onDone} className="h-12 rounded-2xl text-sm font-semibold" style={{ background: 'var(--surface-strong)', color: 'var(--ink)' }}>
          Back to swap
        </button>
      </div>
    )
  }

  if (phase === 'error' || phase === 'cancelled') {
    return (
      <div className="flex flex-col gap-4" role="alert">
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          {phase === 'cancelled' ? <AlertCircle className="size-12" style={{ color: 'var(--warn)' }} aria-hidden /> : <XCircle className="size-12" style={{ color: 'var(--danger)' }} aria-hidden />}
          <h2 className="display text-xl font-semibold">{phase === 'cancelled' ? 'Cancelled' : 'Swap not completed'}</h2>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>{state.message}</p>
        </div>
        {state.approveHash && (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Your approval went through, so it will not be asked again for this amount.
          </p>
        )}
        {state.hash && <TxLink hash={state.hash} label="View transaction" />}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onDone} className="h-12 rounded-2xl text-sm font-semibold" style={{ background: 'var(--surface-strong)', color: 'var(--ink)' }}>
            Edit swap
          </button>
          <button type="button" onClick={onRetry} className="h-12 rounded-2xl text-sm font-semibold" style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4" aria-busy={busy}>
      <div>
        <h2 className="display text-lg font-semibold">Swapping {fmt(amountIn, tokenIn.decimals)} {tokenIn.symbol} for {tokenOut.symbol}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>Confirm each request in your wallet. Do not close this page.</p>
      </div>
      <ol className="inner flex flex-col gap-3 rounded-2xl p-4" aria-label="Swap steps">
        <Step state={phase === 'checking' ? 'active' : 'done'} label="Checking live price and your balance" hint="Reading the best pool on Arc." />
        <Step state={approveStep} label={`Approve ${tokenIn.symbol} (exact amount)`} hint={phase === 'approve-wallet' ? 'Confirm the approval in your wallet.' : 'Waiting for the approval to confirm onchain.'} />
        <Step state={permitStep} label="Sign the spending permission" hint="This is a signature, not a transaction. It costs no fee." />
        <Step state={swapStep} label={`Swap ${tokenIn.symbol} for ${tokenOut.symbol}`} hint={phase === 'swap-wallet' ? 'Confirm the swap in your wallet.' : 'Waiting for the swap to confirm onchain.'} />
      </ol>
      {state.approveHash && <TxLink hash={state.approveHash} label="Approval transaction" />}
      {state.hash && <TxLink hash={state.hash} label="Swap transaction" />}
    </div>
  )
}
