import { useState } from 'react'
import { useModal } from 'connectkit'
import { parseUnits } from 'viem'
import { AlertTriangle, ArrowDownUp, Loader2, RefreshCw, Settings2, ShieldCheck } from 'lucide-react'
import { useAccount, useReadContract, useSwitchChain } from 'wagmi'
import { arcMainnet } from '@/config'
import { useDebounced, useSwapBalances, useSwapDeployment, useSwapExecute, useSwapFeePreview, useSwapQuote, usePairLiquidity } from '@/hooks/useSwap'
import { displayUsdc } from '@/lib/format'
import { fmtToken, pct, rateText } from '@/lib/swap/format'
import { SWAP_TOKENS, tokenBySymbol, type SwapToken } from '@/lib/swap/tokens'
import { PERMIT2, PRICE_IMPACT_BLOCK, PRICE_IMPACT_WARN, SLIPPAGE_DEFAULT_BPS, SLIPPAGE_MAX_BPS, SLIPPAGE_WARN_BPS, erc20Abi, minOut, routeLabel } from '@/lib/swap/uniswap'
import { SwapProgress } from './SwapProgress'

const PRESETS = [10, 50, 100]

function parseAmount(text: string, decimals: number): bigint | undefined {
  if (text === '' || text === '.') return undefined
  try {
    const v = parseUnits(text, decimals)
    return v > 0n ? v : undefined
  } catch {
    return undefined
  }
}

function TokenSelect({ id, label, value, other, onChange, pairs }: { id: string; label: string; value: SwapToken; other: SwapToken; onChange: (symbol: string) => void; pairs?: Record<string, number> }) {
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">{label}</label>
      <select
        id={id}
        value={value.symbol}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 min-w-[7.5rem] appearance-none rounded-full pl-4 pr-9 text-sm font-semibold outline-none"
        style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
      >
        {SWAP_TOKENS.map((t) => {
          const noPool = t.symbol !== other.symbol && pairs !== undefined && (pairs[`${t.symbol}/${other.symbol}`] ?? 0) === 0
          return (
            <option key={t.symbol} value={t.symbol} disabled={noPool} style={{ background: '#142238', color: '#ffffff' }}>
              {t.symbol}{noPool ? ' (no pool)' : ''}
            </option>
          )
        })}
      </select>
      <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'var(--muted)' }} aria-hidden>▾</span>
    </div>
  )
}

export function SwapCard() {
  const { address, isConnected, chainId } = useAccount()
  const { setOpen } = useModal()
  const { switchChain, isPending: switching } = useSwitchChain()
  const deployment = useSwapDeployment()
  const { balances } = useSwapBalances()
  const pairs = usePairLiquidity()
  const exec = useSwapExecute()

  const [fromSym, setFromSym] = useState('USDC')
  const [toSym, setToSym] = useState('EURC')
  const [amountText, setAmountText] = useState('')
  const [slippageBps, setSlippageBps] = useState(SLIPPAGE_DEFAULT_BPS)
  const [customSlip, setCustomSlip] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [acceptedLoss, setAcceptedLoss] = useState(false)

  const from = tokenBySymbol(fromSym) as SwapToken
  const to = tokenBySymbol(toSym) as SwapToken
  const amountIn = parseAmount(amountText, from.decimals)
  const debouncedAmount = useDebounced(amountIn, 450)
  const settled = debouncedAmount === amountIn
  const wrongNetwork = isConnected && chainId !== arcMainnet.id
  const pairCount = pairs.data?.[`${fromSym}/${toSym}`]
  const pairKnownEmpty = pairs.data !== undefined && (pairCount ?? 0) === 0
  const quote = useSwapQuote(from, to, debouncedAmount, !deployment.problem && !deployment.checking && !pairKnownEmpty)
  const best = settled ? quote.best : undefined

  const fromBal = balances?.[fromSym]
  const toBal = balances?.[toSym]
  const allowance = useReadContract({ address: from.address, abi: erc20Abi, functionName: 'allowance', args: address ? [address, PERMIT2] : undefined, chainId: arcMainnet.id, query: { enabled: Boolean(address), refetchInterval: 15_000 } })
  const needsApprove = amountIn !== undefined && allowance.data !== undefined && allowance.data < amountIn
  const fee = useSwapFeePreview(needsApprove)

  const insufficient = amountIn !== undefined && fromBal !== undefined && amountIn > fromBal.balance
  const decimalsBad = balances !== undefined && (!balances[fromSym]?.decimalsOk || !balances[toSym]?.decimalsOk)
  const impact = best?.priceImpact ?? 0
  const highImpact = impact > PRICE_IMPACT_BLOCK
  const minReceived = best ? minOut(best.amountOut, slippageBps) : undefined

  const setToken = (side: 'from' | 'to', symbol: string) => {
    setReviewing(false)
    setAcceptedLoss(false)
    if (side === 'from') {
      if (symbol === toSym) setToSym(fromSym)
      setFromSym(symbol)
    } else {
      if (symbol === fromSym) setFromSym(toSym)
      setToSym(symbol)
    }
  }
  const flip = () => {
    setFromSym(toSym)
    setToSym(fromSym)
    setAmountText('')
    setReviewing(false)
    setAcceptedLoss(false)
  }
  const onSlippageCustom = (value: string) => {
    if (!/^\d{0,1}(\.\d{0,2})?$/.test(value)) return
    setCustomSlip(value)
    const n = Math.round(parseFloat(value) * 100)
    if (Number.isFinite(n) && n >= 0) setSlippageBps(Math.min(n, SLIPPAGE_MAX_BPS))
  }

  const blocker: string | undefined = !isConnected ? undefined
    : deployment.problem ?? (decimalsBad ? 'A token reported unexpected decimals, so swapping is disabled.' : undefined)

  let cta: { label: string; disabled: boolean; action?: () => void } = { label: 'Enter an amount', disabled: true }
  if (!isConnected) cta = { label: 'Connect wallet', disabled: false, action: () => setOpen(true) }
  else if (blocker) cta = { label: 'Swap unavailable', disabled: true }
  else if (wrongNetwork) cta = { label: switching ? 'Switching…' : 'Switch to Arc Mainnet', disabled: switching, action: () => switchChain({ chainId: arcMainnet.id }) }
  else if (amountIn === undefined) cta = { label: 'Enter an amount', disabled: true }
  else if (insufficient) cta = { label: `Insufficient ${fromSym}`, disabled: true }
  else if (pairKnownEmpty || quote.noRoute) cta = { label: 'No route at this size', disabled: true }
  else if (!best || quote.loading || !settled) cta = { label: 'Getting best price…', disabled: true }
  else if (highImpact && !acceptedLoss) cta = { label: 'Confirm the price impact to continue', disabled: true }
  else cta = { label: 'Review swap', disabled: false, action: () => setReviewing(true) }

  const start = () => {
    if (amountIn === undefined) return
    void exec.run({ tokenIn: from, tokenOut: to, amountIn, slippageBps, acceptedLoss })
  }
  const showProgress = exec.state.phase !== 'idle'

  return (
    <section className="glass rounded-3xl p-5" aria-label="Swap tokens">
      {showProgress ? (
        <SwapProgress
          state={exec.state}
          onDone={() => {
            exec.reset()
            setReviewing(false)
            if (exec.state.phase === 'success') setAmountText('')
          }}
          onRetry={start}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="display text-lg font-semibold">Swap</h2>
            <button type="button" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen} aria-label="Slippage settings" className="flex h-11 items-center gap-1.5 rounded-full px-3 text-xs font-semibold" style={{ background: 'var(--surface-strong)', color: 'var(--muted)' }}>
              <Settings2 className="size-4" aria-hidden /> {(slippageBps / 100).toFixed(slippageBps % 10 === 0 ? 1 : 2)}%
            </button>
          </div>

          <p className="inline-flex items-start gap-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'rgba(242,138,69,0.09)', color: 'var(--muted)' }}>
            <ShieldCheck className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
            <span>Swaps run on Arc Mainnet and move real funds, through Uniswap’s Universal Router with live pool prices. You confirm every step in your wallet.</span>
          </p>

          {settingsOpen && (
            <div className="inner rounded-2xl p-4" role="group" aria-label="Slippage tolerance">
              <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>Slippage tolerance</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {PRESETS.map((bps) => (
                  <button key={bps} type="button" onClick={() => { setSlippageBps(bps); setCustomSlip('') }} aria-pressed={slippageBps === bps && customSlip === ''} className="h-11 rounded-full px-4 text-sm font-semibold" style={slippageBps === bps && customSlip === '' ? { background: 'var(--accent-fill)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', color: 'var(--ink)' }}>
                    {(bps / 100).toFixed(bps === 50 ? 1 : 1)}%
                  </button>
                ))}
                <label className="field inner flex h-11 items-center gap-1 rounded-full px-3">
                  <span className="sr-only">Custom slippage percent</span>
                  <input inputMode="decimal" value={customSlip} onChange={(e) => onSlippageCustom(e.target.value)} placeholder="Custom" className="w-16 bg-transparent text-sm outline-none" />
                  <span className="text-sm" style={{ color: 'var(--muted)' }}>%</span>
                </label>
              </div>
              <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                You get at least the minimum shown, or the swap is refused and nothing is spent. The limit is {SLIPPAGE_MAX_BPS / 100}%.
              </p>
              {slippageBps > SLIPPAGE_WARN_BPS && (
                <p className="mt-1 text-xs" role="status" style={{ color: 'var(--warn)' }}>Above 0.5% the price can move further against you before the swap is refused.</p>
              )}
            </div>
          )}

          {reviewing && best && minReceived !== undefined && amountIn !== undefined ? (
            <div className="flex flex-col gap-4">
              <h3 className="display text-base font-semibold">Review swap</h3>
              <dl className="inner flex flex-col gap-2.5 rounded-2xl p-4 text-sm">
                <Row k="You pay" v={`${fmtToken(amountIn, from.decimals)} ${fromSym}`} strong />
                <Row k="You receive (estimate)" v={`${fmtToken(best.amountOut, to.decimals)} ${toSym}`} strong />
                <Row k={`Minimum received (${(slippageBps / 100).toFixed(2)}% slippage)`} v={`${fmtToken(minReceived, to.decimals)} ${toSym}`} />
                <Row k="Rate" v={`1 ${fromSym} = ${rateText(amountIn, from.decimals, best.amountOut, to.decimals)} ${toSym}`} />
                <Row k="Price impact" v={pct(impact)} tone={impact > PRICE_IMPACT_WARN ? 'warn' : undefined} />
                <Row k="Route" v={routeLabel(best.route)} />
                <Row k="Network fee (approx.)" v={fee !== undefined ? `${displayUsdc(fee)} USDC${needsApprove ? ' incl. approval' : ''}` : '…'} />
                <Row k="Deadline" v="20 minutes" />
              </dl>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                {needsApprove ? `First you approve exactly ${fmtToken(amountIn, from.decimals)} ${fromSym}, then sign a spending permission, then confirm the swap.` : 'You sign a spending permission if needed, then confirm the swap.'} The price is checked again just before sending.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setReviewing(false)} className="h-12 rounded-2xl text-sm font-semibold" style={{ background: 'var(--surface-strong)', color: 'var(--ink)' }}>Back</button>
                <button type="button" onClick={start} className="h-12 rounded-2xl text-sm font-semibold" style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}>Confirm swap</button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <div className="field inner rounded-2xl p-4 transition-shadow">
                  <div className="flex items-center justify-between gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                    <label htmlFor="swap-amount" className="font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>You pay</label>
                    <span>
                      Balance: {fromBal ? fmtToken(fromBal.balance, from.decimals) : isConnected ? '…' : '–'}
                      {fromBal && fromBal.balance > 0n && (
                        <button type="button" onClick={() => setAmountText(fmtToken(fromBal.balance, from.decimals, from.decimals).replace(/,/g, ''))} className="ml-2 inline-flex min-h-11 items-center px-1 font-semibold" style={{ color: 'var(--accent)' }}>Max</button>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      id="swap-amount"
                      inputMode="decimal"
                      value={amountText}
                      onChange={(e) => {
                        const v = e.target.value.replace(',', '.')
                        if (new RegExp(`^\\d*\\.?\\d{0,${from.decimals}}$`).test(v)) { setAmountText(v); setAcceptedLoss(false) }
                      }}
                      placeholder="0.00"
                      autoComplete="off"
                      aria-invalid={insufficient}
                      className="display h-12 min-w-0 flex-1 bg-transparent text-3xl font-semibold outline-none placeholder:text-slate-600"
                    />
                    <TokenSelect id="swap-from" label="Token to pay with" value={from} other={to} onChange={(s) => setToken('from', s)} pairs={pairs.data} />
                  </div>
                </div>

                <div className="relative z-10 -my-3 flex justify-center">
                  <button type="button" onClick={flip} aria-label="Switch tokens" className="flex size-11 items-center justify-center rounded-full transition-transform hover:rotate-180" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border-strong)', color: 'var(--accent)' }}>
                    <ArrowDownUp className="size-5" aria-hidden />
                  </button>
                </div>

                <div className="inner rounded-2xl p-4">
                  <div className="flex items-center justify-between gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                    <span className="font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>You receive (estimate)</span>
                    <span>Balance: {toBal ? fmtToken(toBal.balance, to.decimals) : isConnected ? '…' : '–'}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <output aria-live="polite" className="display flex h-12 min-w-0 flex-1 items-center truncate text-3xl font-semibold" style={{ color: best ? 'var(--ink)' : 'var(--subtle)' }}>
                      {best ? fmtToken(best.amountOut, to.decimals) : quote.loading || (amountIn !== undefined && !settled) ? '…' : '0.00'}
                    </output>
                    <TokenSelect id="swap-to" label="Token to receive" value={to} other={from} onChange={(s) => setToken('to', s)} pairs={pairs.data} />
                  </div>
                </div>
              </div>

              {pairKnownEmpty && (
                <p className="text-xs" role="status" style={{ color: 'var(--warn)' }}>There is no pool with liquidity for {fromSym} and {toSym} on Arc right now, so this pair cannot be swapped.</p>
              )}
              {blocker && <p className="text-xs" role="alert" style={{ color: 'var(--danger)' }}>{blocker}</p>}
              {deployment.failed && !deployment.problem && (
                <p className="text-xs" role="alert" style={{ color: 'var(--danger)' }}>Could not verify the swap contracts on Arc. <button type="button" onClick={deployment.retry} className="font-semibold underline">Retry</button></p>
              )}
              {quote.error && !pairKnownEmpty && (
                <p className="text-xs" role="alert" style={{ color: 'var(--danger)' }}>{quote.error} <button type="button" onClick={quote.refetch} className="font-semibold underline">Retry</button></p>
              )}

              {best && settled && amountIn !== undefined && (
                <dl className="inner flex flex-col gap-2 rounded-2xl p-4 text-sm" aria-label="Quote details">
                  <Row k="Rate" v={`1 ${fromSym} = ${rateText(amountIn, from.decimals, best.amountOut, to.decimals)} ${toSym}`} />
                  <Row k="Minimum received" v={minReceived !== undefined ? `${fmtToken(minReceived, to.decimals)} ${toSym}` : '–'} />
                  <Row k="Price impact" v={pct(impact)} tone={impact > PRICE_IMPACT_WARN ? 'warn' : undefined} />
                  <Row k="Route" v={routeLabel(best.route)} />
                  <Row k="Network fee (approx.)" v={fee !== undefined ? `${displayUsdc(fee)} USDC${needsApprove ? ' incl. approval' : ''}` : '…'} />
                  <p className="flex items-center gap-1.5 pt-1 text-xs" style={{ color: 'var(--subtle)' }}>
                    {quote.refreshing ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <RefreshCw className="size-3" aria-hidden />} Live price, refreshed every few seconds
                  </p>
                </dl>
              )}

              {best && impact > PRICE_IMPACT_WARN && (
                <div className="rounded-2xl p-3 text-sm" role="alert" style={{ background: 'rgba(232,166,109,0.12)', color: 'var(--warn)' }}>
                  <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>This swap moves the pool price by {pct(impact)}. A smaller amount gets a better rate.</span>
                  </p>
                  {highImpact && (
                    <label className="mt-2 flex min-h-11 items-center gap-2 text-sm font-semibold">
                      <input type="checkbox" checked={acceptedLoss} onChange={(e) => setAcceptedLoss(e.target.checked)} className="size-5" />
                      I accept a loss of about {pct(impact)}
                    </label>
                  )}
                </div>
              )}

              <button
                type="button"
                disabled={cta.disabled}
                onClick={cta.action}
                className="flex h-14 items-center justify-center gap-2 rounded-2xl text-base font-semibold transition-transform active:scale-[0.99] disabled:opacity-40"
                style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}
              >
                {(switching || (cta.label === 'Getting best price…')) && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {cta.label}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function Row({ k, v, strong, tone }: { k: string; v: string; strong?: boolean; tone?: 'warn' }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt style={{ color: 'var(--muted)' }}>{k}</dt>
      <dd className={`text-right ${strong ? 'font-semibold' : 'font-medium'}`} style={tone === 'warn' ? { color: 'var(--warn)' } : undefined}>{v}</dd>
    </div>
  )
}
