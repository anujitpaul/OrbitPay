import { useMemo, useState } from 'react'
import { useModal } from 'connectkit'
import { isAddress, type Address } from 'viem'
import { Loader2, ShieldCheck } from 'lucide-react'
import { useAccount, useSwitchChain } from 'wagmi'
import { arcMainnet } from '@/config'
import { useSendPayment } from '@/hooks/useSendPayment'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { displayUsdc } from '@/lib/format'
import { settings } from '@/lib/settings'
import { formatUsdc, parseUsdc } from '@/onchain-money'
import { TxStatus } from './TxStatus'

function parseAmountInput(value: string): bigint | undefined {
  if (value === '' || value === '.') return undefined
  try {
    return parseUsdc(value)
  } catch {
    return undefined
  }
}

export function SendCard() {
  const { address, isConnected, chainId } = useAccount()
  const { setOpen } = useModal()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { balance } = useUsdcBalance()
  const { state, send, reset } = useSendPayment()

  const [recipient, setRecipient] = useState('')
  const [amountText, setAmountText] = useState('')
  const [reviewing, setReviewing] = useState(false)

  const wrongChain = isConnected && chainId !== arcMainnet.id
  const trimmed = recipient.trim()
  const amount = parseAmountInput(amountText)

  const recipientError = useMemo(() => {
    if (trimmed === '') return undefined
    if (!isAddress(trimmed)) return 'Enter a valid wallet address (0x…, 42 characters).'
    const lower = trimmed.toLowerCase()
    if (lower === '0x0000000000000000000000000000000000000000') return 'The zero address cannot receive payments.'
    if (address && lower === address.toLowerCase()) return 'You cannot send USDC to your own wallet.'
    if (lower === settings.usdcAddress.toLowerCase() || lower === settings.orbitPayAddress?.toLowerCase()) {
      return 'That is a contract address, not a wallet.'
    }
    return undefined
  }, [trimmed, address])

  const amountError = useMemo(() => {
    if (amountText === '') return undefined
    if (amount === undefined) return 'Enter a valid amount with up to 6 decimals.'
    if (amount === 0n) return 'Amount must be greater than zero.'
    if (balance !== undefined && amount > balance) return `Insufficient balance. You have ${displayUsdc(balance)} USDC.`
    return undefined
  }, [amountText, amount, balance])

  const formReady = trimmed !== '' && !recipientError && amount !== undefined && amount > 0n && !amountError

  const busy = state.phase !== 'idle'

  const submit = () => {
    if (!formReady || amount === undefined) return
    void send(trimmed as Address, amount)
  }

  const resetAll = () => {
    reset()
    setReviewing(false)
    setRecipient('')
    setAmountText('')
  }

  const backToEdit = () => {
    reset()
    setReviewing(false)
  }

  const primary = (() => {
    if (!isConnected) return { label: 'Connect wallet', disabled: false, onClick: () => setOpen(true) }
    if (wrongChain) {
      return {
        label: switching ? 'Check your wallet…' : 'Switch to Arc Mainnet',
        disabled: switching,
        onClick: () => switchChain({ chainId: arcMainnet.id }),
      }
    }
    return { label: 'Review payment', disabled: !formReady, onClick: () => setReviewing(true) }
  })()

  return (
    <section className="glass rounded-3xl p-5" aria-label="Send USDC">
      {busy ? (
        <TxStatus state={state} onDone={resetAll} onEdit={backToEdit} onRetry={submit} />
      ) : reviewing && amount !== undefined ? (
        <div className="flex flex-col gap-4">
          <h2 className="display text-lg font-semibold">Review payment</h2>
          <dl className="inner divide-y divide-white/10 rounded-2xl text-sm">
            <Row label="You send" value={`${displayUsdc(amount)} USDC`} strong />
            <Row label="To" value={trimmed} mono />
            <Row label="Network" value="Arc Mainnet" />
            <Row
              label="Route"
              value={settings.orbitPayAddress ? 'OrbitPay contract (approve, then pay)' : 'Direct USDC transfer'}
            />
          </dl>
          <p className="flex items-start gap-2 text-xs text-pretty" style={{ color: 'var(--muted)' }}>
            <ShieldCheck className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--accent)' }} />
            This moves real USDC on Arc Mainnet. Payments are irreversible, so double-check the address.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={backToEdit}
              className="h-12 flex-1 rounded-2xl text-sm font-semibold"
              style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={submit}
              className="h-12 flex-[2] rounded-2xl text-sm font-semibold transition-transform active:scale-[0.99]"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            >
              Confirm in wallet
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <label htmlFor="recipient" className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
              Recipient
            </label>
            <div className="field inner rounded-2xl px-4 transition-shadow" aria-invalid={Boolean(recipientError)}>
              <input
                id="recipient"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="0x…"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="mono h-12 w-full bg-transparent text-sm outline-none placeholder:text-slate-500"
              />
            </div>
            {recipientError && (
              <p className="mt-1.5 text-xs" role="alert" style={{ color: 'var(--danger)' }}>
                {recipientError}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="amount" className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
              Amount
            </label>
            <div className="field inner rounded-2xl p-4 transition-shadow">
              <div className="flex items-baseline gap-2">
                <input
                  id="amount"
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => {
                    const v = e.target.value.replace(',', '.')
                    if (/^\d*\.?\d{0,6}$/.test(v)) setAmountText(v)
                  }}
                  placeholder="0.00"
                  autoComplete="off"
                  className="display w-full bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:text-slate-600"
                />
                <span className="text-sm font-medium" style={{ color: 'var(--subtle)' }}>
                  USDC
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs" style={{ color: 'var(--subtle)' }}>
                  Keep a little USDC for network fees.
                </span>
                <button
                  type="button"
                  disabled={balance === undefined || balance === 0n}
                  onClick={() => balance !== undefined && setAmountText(formatUsdc(balance))}
                  className="min-h-9 px-1 text-xs font-semibold disabled:opacity-40"
                  style={{ color: 'var(--accent)' }}
                >
                  {balance !== undefined ? `Balance ${displayUsdc(balance)} · Max` : 'Balance unavailable'}
                </button>
              </div>
            </div>
            {amountError && (
              <p className="mt-1.5 text-xs" role="alert" style={{ color: 'var(--danger)' }}>
                {amountError}
              </p>
            )}
          </div>

          {!settings.orbitPayAddress && (
            <p className="text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
              No OrbitPay contract set, so this sends a direct USDC transfer. Add your deployed contract in Settings to route payments through it.
            </p>
          )}

          <button
            type="button"
            disabled={primary.disabled}
            onClick={primary.onClick}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-sm font-semibold transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            {switching && <Loader2 className="size-4 animate-spin" />}
            {primary.label}
          </button>
        </div>
      )}
    </section>
  )
}

function Row({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt style={{ color: 'var(--subtle)' }}>{label}</dt>
      <dd className={`text-right ${mono ? 'mono break-all text-xs' : ''} ${strong ? 'display text-base font-semibold' : ''}`} style={{ color: 'var(--ink)' }}>
        {value}
      </dd>
    </div>
  )
}
