import type { Address } from 'viem'
import { FAST_FINALITY_THRESHOLD, STANDARD_FINALITY_THRESHOLD, feeFromBps } from './cctp'
import { fetchForwardFees, QuoteUnavailableError, requestUpfrontQuote, type UpfrontQuote } from './iris'
import { bridgePublicClient } from './actions'
import { TOKEN_MESSENGER_WITH_FEES, type BridgeChain } from './routes'

/** Everything shown to the user, and used to build the burn, for a transfer delivered by Circle's Forwarding Service. */
export interface ForwardPlan {
  /** upfront: fee paid in USDC on top, recipient gets the full amount. deducted: fee comes out of the burned amount. */
  mode: 'upfront' | 'deducted'
  /** Fast Transfer applies (false when the source chain does not offer it). */
  fast: boolean
  fastAvailable: boolean
  forwardFee: bigint
  /** Fast Transfer (pre-finality) protocol fee. */
  fastFee: bigint
  feeTotal: bigint
  /** USDC burned on the source chain. */
  burnAmount: bigint
  /** USDC that leaves the wallet on the source chain. */
  totalDebit: bigint
  /** USDC the recipient receives (a floor in deducted mode). */
  receives: bigint
  quote?: UpfrontQuote
  maxFee?: bigint
  threshold: number
}

export type ForwardPlanResult = { ok: true; plan: ForwardPlan } | { ok: false; reason: string; retryable: boolean }

const codeCache = new Map<string, boolean>()

/** The TokenMessengerWithFees address must hold contract code on the source chain before any quote is trusted. */
async function hasContractCode(source: BridgeChain, address: Address): Promise<boolean> {
  const key = `${source.chainId}:${address.toLowerCase()}`
  const cached = codeCache.get(key)
  if (cached !== undefined) return cached
  const code = await bridgePublicClient(source).getCode({ address })
  const present = Boolean(code && code !== '0x')
  if (present) codeCache.set(key, true)
  return present
}

/**
 * Verifies the route with Circle live and prices it. Preferred: upfront fees through TokenMessengerWithFees (the fee is
 * paid in USDC on top, so the recipient receives the full amount). If Circle's Quote API does not offer upfront fees for
 * the route, the documented fallback is used: depositForBurnWithHook with the forwarding fee covered by maxFee.
 */
export async function buildForwardPlan(
  source: BridgeChain,
  destination: BridgeChain,
  amount: bigint,
  wantFast: boolean,
  signal?: AbortSignal,
): Promise<ForwardPlanResult> {
  if (!destination.forwarderDestination) {
    return { ok: false, reason: `Circle’s Forwarding Service does not support ${destination.title} as a destination.`, retryable: false }
  }
  if (amount <= 0n) return { ok: false, reason: 'Enter an amount first.', retryable: false }
  try {
    let fastAvailable = true
    let quote: UpfrontQuote | undefined
    try {
      quote = await requestUpfrontQuote(source.domain, destination.domain, { amount, feeToken: source.usdc, fast: wantFast }, signal)
    } catch (error) {
      if (!(error instanceof QuoteUnavailableError)) throw error
      if (error.errorCode === 'PRE_FINALITY_UNAVAILABLE' && wantFast) {
        fastAvailable = false
        try {
          quote = await requestUpfrontQuote(source.domain, destination.domain, { amount, feeToken: source.usdc, fast: false }, signal)
        } catch (inner) {
          if (!(inner instanceof QuoteUnavailableError)) throw inner
        }
      }
    }

    if (quote) {
      if (quote.messenger.toLowerCase() !== TOKEN_MESSENGER_WITH_FEES.toLowerCase()) {
        return { ok: false, reason: 'Circle’s fee quote points at a contract that is not the documented TokenMessengerWithFees. The route is blocked.', retryable: false }
      }
      if (!(await hasContractCode(source, quote.messenger))) {
        return { ok: false, reason: `TokenMessengerWithFees is not deployed on ${source.title}.`, retryable: false }
      }
      if (quote.feeToken.toLowerCase() !== source.usdc.toLowerCase()) return { ok: false, reason: 'Circle quoted the fee in another token. The route is blocked.', retryable: false }
      const forwardFee = quote.items.find((i) => i.type === 'FORWARD')?.amount
      if (forwardFee === undefined) return { ok: false, reason: 'Circle’s quote does not include the forwarding fee.', retryable: true }
      const fastFee = quote.items.find((i) => i.type === 'PRE_FINALITY')?.amount ?? 0n
      const fast = wantFast && fastAvailable
      return {
        ok: true,
        plan: {
          mode: 'upfront',
          fast,
          fastAvailable,
          forwardFee,
          fastFee,
          feeTotal: quote.feeTotal,
          burnAmount: amount,
          totalDebit: amount + quote.feeTotal,
          receives: amount,
          quote,
          threshold: fast ? FAST_FINALITY_THRESHOLD : STANDARD_FINALITY_THRESHOLD,
        },
      }
    }

    // Fallback: documented forwarding hook, fee deducted from the burn.
    const schedule = await fetchForwardFees(source.domain, destination.domain, signal)
    const row = schedule.find((r) => (wantFast ? r.finalityThreshold <= FAST_FINALITY_THRESHOLD : r.finalityThreshold >= STANDARD_FINALITY_THRESHOLD)) ?? schedule[0]
    const forwardFee = BigInt(row.forwardFee.med) // Circle recommends "med" or higher
    const fastFee = feeFromBps(amount, row.minimumFee)
    const maxFee = forwardFee + fastFee
    return {
      ok: true,
      plan: {
        mode: 'deducted',
        fast: wantFast,
        fastAvailable: true,
        forwardFee,
        fastFee,
        feeTotal: maxFee,
        burnAmount: amount + maxFee,
        totalDebit: amount + maxFee,
        receives: amount,
        maxFee,
        threshold: row.finalityThreshold,
      },
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return { ok: false, reason: error instanceof Error ? error.message : 'Could not verify the forwarding route with Circle.', retryable: true }
  }
}
