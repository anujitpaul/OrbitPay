import { useState, useSyncExternalStore } from 'react'
import { useModal } from 'connectkit'
import { AlertTriangle, ArrowDownUp, CheckCircle2, Circle, Loader2, Network, SkipForward, XCircle } from 'lucide-react'
import { isAddress, type Address } from 'viem'
import { useAccount } from 'wagmi'
import { useBridgeBalance, useBridgeFees, useBridgeRun, useForwardPlan, type BridgeParams, type BridgeSpeed } from '@/hooks/useBridge'
import { feeFromBps } from '@/lib/bridge/cctp'
import { ARC_KEY, getBridgeChain, listBridgeChains, registryProblems, type BridgeChain } from '@/lib/bridge/routes'
import { getBridgeRecords, subscribeBridgeStore, type BridgeRecord } from '@/lib/bridge/store'
import { displayUsdc } from '@/lib/format'
import { formatUsdc, parseUsdc } from '@/onchain-money'
import { BridgeHistory, StatusBadge, TxLink } from './BridgeHistory'

const LARGE_TRANSFER = 100_000_000n // 100 USDC

function parseAmount(text: string): bigint | undefined {
  if (text === '' || text === '.') return undefined
  try {
    return parseUsdc(text)
  } catch {
    return undefined
  }
}

export function BridgeCard() {
  const { address, isConnected } = useAccount()
  const { setOpen } = useModal()
  const { state: run, run: start, reset } = useBridgeRun()

  const chains = listBridgeChains()
  const arc = chains.find((c) => c.key === ARC_KEY)
  const others = chains.filter((c) => c.key !== ARC_KEY)
  const registryIssues = registryProblems(arc)

  const [outbound, setOutbound] = useState(true) // true: Arc -> other chain
  const [otherKey, setOtherKey] = useState(others.find((c) => c.key === 'Base')?.key ?? others[0]?.key ?? '')
  const [amountText, setAmountText] = useState('')
  const [ownWallet, setOwnWallet] = useState(true)
  const [customRecipient, setCustomRecipient] = useState('')
  const [speed, setSpeed] = useState<BridgeSpeed>('FAST')
  const [delivery, setDelivery] = useState<'forwarded' | 'self'>('forwarded')

  const other = getBridgeChain(otherKey)
  const source: BridgeChain | undefined = outbound ? arc : other
  const destination: BridgeChain | undefined = outbound ? other : arc

  const balance = useBridgeBalance(source)
  const fees = useBridgeFees(source, destination)

  const amount = parseAmount(amountText)
  const recipientText = ownWallet ? (address ?? '') : customRecipient.trim()

  const forwarded = delivery === 'forwarded'
  const planQuery = useForwardPlan(source, destination, amount && amount > 0n ? amount : undefined, speed === 'FAST', forwarded)
  const planResult = forwarded ? planQuery.data : undefined
  const plan = planResult?.ok ? planResult.plan : undefined
  const planChecking = forwarded && Boolean(amount && amount > 0n) && (planQuery.isLoading || (planQuery.isFetching && !planQuery.data))
  const planFailure = planResult && !planResult.ok ? planResult.reason : planQuery.isError ? 'Could not verify the forwarding route with Circle.' : undefined
  // Fast Transfer is only used where Circle offers it for the source chain.
  const effectiveSpeed: BridgeSpeed = forwarded && plan && !plan.fastAvailable ? 'SLOW' : speed
  const fastOffered = !(forwarded && plan && !plan.fastAvailable)

  const amountError = (() => {
    if (amountText === '') return undefined
    if (amount === undefined) return 'Enter a valid amount with up to 6 decimals.'
    if (amount === 0n) return 'Amount must be greater than zero.'
    if (balance.data !== undefined && amount > balance.data) return `Insufficient balance. You have ${displayUsdc(balance.data)} USDC on ${source?.title}.`
    if (plan && balance.data !== undefined && plan.totalDebit > balance.data) return `Not enough USDC for the amount plus Circle’s fee: ${displayUsdc(plan.totalDebit)} USDC needed, you have ${displayUsdc(balance.data)}.`
    return undefined
  })()

  const recipientError = (() => {
    if (recipientText === '') return undefined
    if (!isAddress(recipientText, { strict: true })) return 'Enter a valid EVM wallet address (0x…, 42 characters).'
    const lower = recipientText.toLowerCase()
    if (/^0x0{40}$/.test(lower)) return 'The zero address cannot receive USDC.'
    if (destination && [destination.usdc, destination.tokenMessenger, destination.messageTransmitter].some((a) => a.toLowerCase() === lower)) {
      return 'That is a protocol contract, not a wallet. USDC sent there would be lost.'
    }
    return undefined
  })()

  const ready = Boolean(source && destination && amount && amount > 0n && !amountError && recipientText !== '' && !recipientError && registryIssues.length === 0 && (!forwarded || plan))
  const params: BridgeParams | undefined =
    ready && source && destination && amount
      ? { source, destination, amount, recipient: recipientText as Address, speed: effectiveSpeed, delivery }
      : undefined

  const bps = effectiveSpeed === 'FAST' ? fees.data?.fastBps : fees.data?.standardBps
  const protocolFee = amount !== undefined && bps !== undefined ? feeFromBps(amount, bps) : undefined
  const receive = amount !== undefined && protocolFee !== undefined ? amount - protocolFee : undefined
  const upfront = plan?.mode === 'upfront'

  const records = useSyncExternalStore(subscribeBridgeStore, () => getBridgeRecords(address))
  const active = run.recordId ? records.find((r) => r.id === run.recordId) : undefined
  const working = run.phase === 'switching' || run.phase === 'running'
  const showProgress = working || (active !== undefined && active.id === run.recordId)

  const submit = () => {
    if (params) void start(params)
  }

  if (!arc || registryIssues.length > 0) {
    return (
      <section className="glass rounded-3xl p-6 text-center" aria-label="Bridge USDC">
        <h2 className="display text-lg font-semibold">Bridge unavailable</h2>
        <p className="mt-2 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
          {registryIssues.join(' ') || 'Circle’s CCTP chain list could not be loaded.'} The bridge is turned off rather than risk sending USDC on the wrong route.
        </p>
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="glass rounded-3xl p-5" aria-label="Bridge USDC">
        <div className="mb-4 flex items-center gap-2">
          <Network className="size-5" style={{ color: 'var(--accent)' }} />
          <div>
            <h2 className="display text-lg font-semibold leading-tight">Bridge USDC</h2>
            <p className="text-xs" style={{ color: 'var(--subtle)' }}>
              Circle’s native CCTP V2: USDC is burned on one chain and minted on the other.
            </p>
          </div>
        </div>

        {showProgress ? (
          <Progress record={active} run={run} source={source} destination={destination} onDone={reset} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
              <ChainPicker label="From" fixedChain={outbound ? arc : undefined} value={otherKey} onChange={setOtherKey} options={others} />
              <button
                type="button"
                onClick={() => setOutbound((v) => !v)}
                aria-label="Swap direction"
                className="inner mb-0.5 flex size-11 items-center justify-center rounded-2xl"
              >
                <ArrowDownUp className="size-4 rotate-90" />
              </button>
              <ChainPicker label="To" fixedChain={outbound ? undefined : arc} value={otherKey} onChange={setOtherKey} options={others} />
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <label htmlFor="bridge-amount" className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
                  USDC amount
                </label>
                <span className="text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
                  {balance.isError ? 'Balance unavailable' : balance.data !== undefined ? `Balance on ${source?.title}: ${displayUsdc(balance.data)}` : isConnected ? 'Loading balance…' : ''}
                  {balance.data !== undefined && balance.data > 0n && (
                    <button type="button" onClick={() => setAmountText(formatUsdc(balance.data))} className="ml-2 font-semibold underline underline-offset-4" style={{ color: 'var(--accent)' }}>
                      Max
                    </button>
                  )}
                </span>
              </div>
              <div className="field mt-1.5 flex items-center gap-2 rounded-2xl px-4" style={amountError ? { borderColor: 'var(--danger)' } : undefined}>
                <input
                  id="bridge-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amountText}
                  onChange={(e) => {
                    const v = e.target.value.replace(/,/g, '.')
                    if (/^\d*\.?\d{0,6}$/.test(v)) setAmountText(v)
                  }}
                  className="display h-12 min-w-0 flex-1 bg-transparent text-2xl font-bold tabular-nums outline-none placeholder:text-slate-600"
                />
                <span className="text-sm font-medium" style={{ color: 'var(--subtle)' }}>
                  USDC
                </span>
              </div>
              {amountError && (
                <p className="mt-1.5 text-xs" role="alert" style={{ color: 'var(--danger)' }}>
                  {amountError}
                </p>
              )}
            </div>

            <div>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={ownWallet} onChange={(e) => setOwnWallet(e.target.checked)} className="size-4 accent-[var(--accent)]" />
                Receive on my connected wallet
              </label>
              {!ownWallet && (
                <div className="mt-1">
                  <label htmlFor="bridge-recipient" className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
                    Recipient on {destination?.title}
                  </label>
                  <input
                    id="bridge-recipient"
                    value={customRecipient}
                    onChange={(e) => setCustomRecipient(e.target.value)}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="0x…"
                    className="field mono mt-1.5 h-12 w-full rounded-2xl px-4 text-sm outline-none placeholder:text-slate-500"
                    style={recipientError ? { borderColor: 'var(--danger)' } : undefined}
                  />
                  {recipientError && (
                    <p className="mt-1.5 text-xs" role="alert" style={{ color: 'var(--danger)' }}>
                      {recipientError}
                    </p>
                  )}
                  <p className="mt-1.5 text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
                    Use an address you control on {destination?.title}. A wrong address cannot be recovered.
                  </p>
                </div>
              )}
            </div>

            <div role="radiogroup" aria-label="Delivery" className="grid grid-cols-2 gap-2">
              {(
                [
                  { id: 'forwarded', title: 'Circle delivers it', hint: destination ? `No ${destination.nativeSymbol} gas needed on ${destination.title}` : 'No gas needed on the destination' },
                  { id: 'self', title: 'I’ll mint it myself', hint: destination ? `Needs ${destination.nativeSymbol} on ${destination.title}` : 'Needs destination gas' },
                ] as const
              ).map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="radio"
                  aria-checked={delivery === d.id}
                  onClick={() => setDelivery(d.id)}
                  className="min-h-14 rounded-2xl px-3 py-2 text-left text-sm"
                  style={delivery === d.id ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
                >
                  <span className="block font-semibold">{d.title}</span>
                  <span className="block text-xs opacity-80">{d.hint}</span>
                </button>
              ))}
            </div>
            {forwarded && (
              <p className="text-xs text-pretty" role="status" style={{ color: planFailure ? 'var(--danger)' : 'var(--subtle)' }}>
                {planChecking
                  ? 'Verifying the route and fee quote with Circle…'
                  : planFailure
                    ? `Forwarding is not available right now: ${planFailure} Choose “I’ll mint it myself” or try again.`
                    : plan
                      ? `Route verified with Circle: Forwarding Service ${upfront ? 'with the fee paid upfront in USDC' : 'with the fee taken from the transfer'}.`
                      : 'Enter an amount to verify the route and see Circle’s fee.'}
              </p>
            )}

            <div role="radiogroup" aria-label="Transfer speed" className="grid grid-cols-2 gap-2">
              {(['FAST', 'SLOW'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={effectiveSpeed === s}
                  aria-disabled={s === 'FAST' && !fastOffered}
                  disabled={s === 'FAST' && !fastOffered}
                  onClick={() => setSpeed(s)}
                  className="min-h-14 rounded-2xl px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  style={effectiveSpeed === s ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
                >
                  <span className="block font-semibold">{s === 'FAST' ? 'Fast' : 'Standard'}</span>
                  <span className="block text-xs opacity-80">
                    {s === 'FAST' ? (fastOffered ? 'Attested sooner, Circle fee may apply' : `Not offered from ${source?.title ?? 'this chain'}`) : 'Waits for finality, no Circle fee'}
                  </span>
                </button>
              ))}
            </div>

            <dl className="inner divide-y divide-white/10 rounded-2xl text-sm" aria-label="Transfer summary">
              <SummaryRow label="Route" value={source && destination ? `${source.title} (domain ${source.domain}) → ${destination.title} (domain ${destination.domain})` : '—'} />
              {forwarded ? (
                <>
                  <SummaryRow label="Destination mint" value="Circle’s Forwarding Service" hint={destination ? `No ${destination.nativeSymbol} gas needed on ${destination.title}` : undefined} />
                  <SummaryRow label={upfront ? 'Amount to deliver' : 'You send'} value={amount ? `${displayUsdc(amount)} USDC` : '—'} />
                  <SummaryRow
                    label="Forwarding fee"
                    value={plan ? `${displayUsdc(plan.forwardFee)} USDC` : planChecking ? 'Verifying…' : '—'}
                    hint={plan ? (upfront ? `Quoted by Circle, paid in USDC on ${source?.title}` : 'Quoted by Circle, deducted from the transfer') : undefined}
                  />
                  {plan && plan.fastFee > 0n && <SummaryRow label="Fast Transfer fee" value={`${displayUsdc(plan.fastFee)} USDC`} hint="Circle’s pre-finality fee" />}
                  <SummaryRow label="Total from your wallet" value={plan ? `${displayUsdc(plan.totalDebit)} USDC` : '—'} />
                  <SummaryRow label={plan && !upfront ? 'Recipient gets (at least)' : 'Recipient gets'} value={plan ? `${displayUsdc(plan.receives)} USDC` : '—'} strong hint={plan && upfront ? 'The full amount: fees are charged on top' : undefined} />
                </>
              ) : (
                <>
                  <SummaryRow label="You send" value={amount ? `${displayUsdc(amount)} USDC` : '—'} />
                  <SummaryRow
                    label="Circle fee"
                    value={fees.isError ? 'Unavailable' : protocolFee === undefined ? (fees.isLoading ? 'Loading…' : '—') : protocolFee === 0n ? '0.00 USDC' : `≈ ${displayUsdc(protocolFee)} USDC`}
                    hint={bps !== undefined ? `${bps} bps (${effectiveSpeed === 'FAST' ? 'fast' : 'standard'})` : undefined}
                  />
                  <SummaryRow label="Recipient gets (approx.)" value={receive !== undefined ? `${displayUsdc(receive)} USDC` : '—'} strong />
                </>
              )}
              <SummaryRow label="Network fee" value={`Paid in ${source?.nativeSymbol ?? 'the native token'}`} hint={`On ${source?.title ?? 'the source chain'}, shown by your wallet`} />
            </dl>

            {amount !== undefined && amount >= LARGE_TRANSFER && (
              <p className="flex items-start gap-2 text-xs text-pretty" style={{ color: 'var(--warn)' }}>
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> This is a large transfer of real USDC. Double-check the chains and recipient.
              </p>
            )}

            {run.phase === 'error' && !active && (
              <p className="flex items-start gap-2 text-sm text-pretty" role="alert" style={{ color: 'var(--danger)' }}>
                <XCircle className="mt-0.5 size-4 shrink-0" /> {run.message ?? 'The transfer did not start.'} Nothing was sent.
              </p>
            )}

            <button
              type="button"
              disabled={isConnected && !ready}
              onClick={isConnected ? submit : () => setOpen(true)}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-sm font-semibold transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            >
              {isConnected ? `Bridge to ${destination?.title ?? ''}${forwarded ? ' with Circle forwarding' : ''}` : 'Connect wallet'}
            </button>
            <p className="text-center text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
              {forwarded
                ? `Mainnet, real USDC. Your wallet asks you to confirm the approval (if needed) and the burn. Circle then mints on ${destination?.title ?? 'the destination chain'} for you: no destination gas and no mint transaction from your wallet. Circle’s fee quote expires after about 2 minutes. Bridging cannot be undone.`
                : `Mainnet, real USDC. Your wallet will ask you to confirm the approval (if needed), the burn, then the mint on ${destination?.title ?? 'the destination chain'}. Bridging cannot be undone.`}{' '}
              Non-EVM chains such as Solana aren’t available here.
            </p>
          </div>
        )}
      </section>

      <BridgeHistory activeId={run.recordId} />
    </div>
  )
}

function ChainPicker({ label, fixedChain, value, onChange, options }: { label: string; fixedChain: BridgeChain | undefined; value: string; onChange: (key: string) => void; options: BridgeChain[] }) {
  const id = `bridge-${label.toLowerCase()}`
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
        {label}
      </label>
      {fixedChain ? (
        <div id={id} className="field mt-1.5 flex h-12 items-center rounded-2xl px-3 text-sm font-semibold">
          {fixedChain.title}
        </div>
      ) : (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="field mt-1.5 h-12 w-full min-w-0 rounded-2xl pl-3 pr-1 text-[13px] font-semibold outline-none">
          {options.map((c) => (
            <option key={c.key} value={c.key} style={{ color: '#0b1628' }}>
              {c.title.replace(/ Mainnet$/, '')}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function SummaryRow({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2.5">
      <dt style={{ color: 'var(--muted)' }}>{label}</dt>
      <dd className={`min-w-0 text-right ${strong ? 'font-bold' : 'font-medium'}`}>
        <span className="break-words tabular-nums">{value}</span>
        {hint && (
          <span className="block text-[11px] font-normal" style={{ color: 'var(--subtle)' }}>
            {hint}
          </span>
        )}
      </dd>
    </div>
  )
}

function Progress({ record, run, source, destination, onDone }: { record: BridgeRecord | undefined; run: ReturnType<typeof useBridgeRun>['state']; source?: BridgeChain; destination?: BridgeChain; onDone: () => void }) {
  const status = record?.status ?? 'pending'
  const failed = status === 'failed'
  const completed = status === 'completed'
  const attested = status === 'attested' || completed
  const steps: { id: string; label: string; done: boolean; skipped?: boolean }[] = [
    { id: 'approve', label: 'Approve USDC', done: Boolean(record?.approveHash), skipped: !record?.approveHash && Boolean(record?.burnHash) },
    { id: 'burn', label: `Burn on ${source?.title ?? 'source'}`, done: Boolean(record?.burnHash) },
    { id: 'attest', label: 'Circle attestation', done: attested || Boolean(record?.mintHash) },
    { id: 'mint', label: record?.forwarder ? `Circle mints on ${destination?.title ?? 'destination'}` : `Mint on ${destination?.title ?? 'destination'}`, done: completed },
  ]
  const activeIndex = steps.findIndex((s) => !s.done && !s.skipped)
  const walletHint =
    run.phase === 'switching'
      ? 'Switching your wallet to the source chain…'
      : run.stage === 'approve'
        ? 'Confirm the approval (and then the burn) in your wallet.'
        : run.stage === 'burn'
          ? 'Confirm the burn in your wallet.'
          : run.stage === 'mint'
            ? record?.forwarder
              ? `Circle is minting on ${destination?.title}. Nothing to confirm in your wallet.`
              : `Confirm the mint on ${destination?.title} in your wallet.`
            : undefined

  return (
    <div className="flex flex-col gap-4" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <p className="display text-lg font-bold tabular-nums">{record ? `${displayUsdc(BigInt(record.amount))} USDC` : 'Starting transfer'}</p>
        <StatusBadge status={status} />
      </div>

      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => {
          const isActive = i === activeIndex && !failed && !completed
          return (
            <li key={s.id} className="flex items-center gap-3 text-sm">
              {s.done ? (
                <CheckCircle2 className="size-5 shrink-0" style={{ color: 'var(--success)' }} />
              ) : s.skipped ? (
                <SkipForward className="size-5 shrink-0" style={{ color: 'var(--subtle)' }} />
              ) : failed && i === activeIndex ? (
                <XCircle className="size-5 shrink-0" style={{ color: 'var(--danger)' }} />
              ) : isActive ? (
                <Loader2 className="size-5 shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
              ) : (
                <Circle className="size-5 shrink-0" style={{ color: 'var(--subtle)' }} />
              )}
              <span style={{ color: s.done || isActive ? 'var(--ink)' : 'var(--muted)' }}>
                {s.label}
                {s.skipped ? ' (already approved)' : ''}
              </span>
            </li>
          )
        })}
      </ol>

      {walletHint && <p className="text-sm text-pretty">{walletHint}</p>}
      {record && (
        <p className="text-sm text-pretty" style={{ color: failed ? 'var(--danger)' : 'var(--muted)' }}>
          {record.detail}
          {completed && record.received ? ` ${displayUsdc(BigInt(record.received))} USDC received.` : ''}
        </p>
      )}
      {record?.error && !completed && (
        <p className="break-words text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
          {record.error}
        </p>
      )}

      <div className="flex flex-col gap-0.5">
        {record?.approveHash && <TxLink chainKey={record.source} hash={record.approveHash} label="Approval" />}
        {record?.burnHash && <TxLink chainKey={record.source} hash={record.burnHash} label="Source burn" />}
        {record?.mintHash && <TxLink chainKey={record.destination} hash={record.mintHash} label="Destination mint" />}
      </div>

      {(completed || failed || (run.phase !== 'running' && run.phase !== 'switching')) && (
        <button type="button" onClick={onDone} className="flex h-11 w-full items-center justify-center rounded-xl text-sm font-semibold" style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}>
          {completed ? 'New transfer' : 'Back to bridge'}
        </button>
      )}
      {!completed && !failed && (run.phase === 'running' || run.phase === 'switching') && (
        <p className="text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
          Keep this tab open. You can switch tabs; progress continues. Nothing is marked complete until the mint is confirmed on {destination?.title}.
        </p>
      )}
    </div>
  )
}
