import { getAddress, type Address, type Hex } from 'viem'

/**
 * Circle's attestation service (Iris) for mainnet CCTP V2. Public, no API key, CORS-enabled.
 * https://developers.circle.com/cctp/references/cctp-api
 */
export const IRIS_BASE_URL = 'https://iris-api.circle.com'

export interface IrisMessage {
  message: Hex
  attestation: Hex | 'PENDING'
  eventNonce: Hex
  cctpVersion: number
  /** "complete" once Circle has signed; "pending_confirmations" before that. */
  status: string
  delayReason?: string | null
  /** Set by Iris once the destination mint has been seen onchain. */
  destinationMintTxHash?: Hex
  /** Forwarding Service progress and the mint transaction Circle itself submitted on the destination chain. */
  forwardState?: string
  forwardTxHash?: Hex
}

export interface IrisFee {
  finalityThreshold: number
  /** Basis points. */
  minimumFee: number
}

export class IrisError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'IrisError'
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'))
    })
  })

/** GET with a timeout and exponential backoff. 404 is a normal "not indexed yet" answer and is returned as undefined. */
async function getJson<T>(path: string, signal?: AbortSignal, attempts = 4): Promise<T | undefined> {
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted()
    try {
      const timeout = AbortSignal.timeout(12_000)
      const response = await fetch(`${IRIS_BASE_URL}${path}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      if (response.status === 404) return undefined
      if (response.status === 429 || response.status >= 500) throw new IrisError(`Circle's attestation service is busy (HTTP ${response.status}).`, response.status)
      if (!response.ok) throw new IrisError(`Circle's attestation service returned HTTP ${response.status}.`, response.status)
      return (await response.json()) as T
    } catch (error) {
      if (signal?.aborted) throw error
      last = error
      if (error instanceof IrisError && error.status !== undefined && error.status < 500 && error.status !== 429) throw error
      if (attempt < attempts - 1) await sleep(600 * 2 ** attempt, signal)
    }
  }
  throw last instanceof Error ? last : new IrisError("Couldn't reach Circle's attestation service.")
}

/** The burn message for a transaction, or undefined while Circle has not indexed the burn yet. */
export async function fetchIrisMessage(sourceDomain: number, burnTxHash: Hex, signal?: AbortSignal): Promise<IrisMessage | undefined> {
  const data = await getJson<{ messages?: IrisMessage[] }>(`/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`, signal)
  const message = data?.messages?.[0]
  if (!message) return undefined
  if (message.cctpVersion !== 2) throw new IrisError('Circle returned a CCTP V1 message. OrbitPay only supports CCTP V2.')
  return message
}

export async function fetchIrisFees(sourceDomain: number, destinationDomain: number, signal?: AbortSignal): Promise<IrisFee[]> {
  const data = await getJson<IrisFee[]>(`/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`, signal)
  if (!Array.isArray(data)) throw new IrisError('Circle has no fee schedule for this route.')
  return data
}

/** True when the message carries a signed attestation that can be submitted to the destination chain. */
export function isAttested(message: IrisMessage | undefined): message is IrisMessage & { attestation: Hex } {
  return Boolean(message && message.status === 'complete' && message.attestation !== 'PENDING' && message.attestation.startsWith('0x') && message.attestation.length > 2)
}

export interface ForwardFeeSchedule {
  finalityThreshold: number
  /** Protocol fee, basis points. */
  minimumFee: number
  /** Forwarding Service fee in USDC base units, by priority. Fluctuates with destination gas prices. */
  forwardFee: { low: number; med: number; high: number }
}

/** Circle's fee schedule including the Forwarding Service fee. Throws when the route has no forwarding fee. */
export async function fetchForwardFees(sourceDomain: number, destinationDomain: number, signal?: AbortSignal): Promise<ForwardFeeSchedule[]> {
  const data = await getJson<Partial<ForwardFeeSchedule>[]>(`/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}?forward=true`, signal)
  const rows = (data ?? []).filter((r): r is ForwardFeeSchedule => typeof r.finalityThreshold === 'number' && typeof r.minimumFee === 'number' && typeof r.forwardFee?.med === 'number')
  if (rows.length === 0) throw new IrisError('Circle does not offer the Forwarding Service for this route.')
  return rows
}

export type QuoteFeeType = 'FORWARD' | 'PRE_FINALITY'

export interface UpfrontQuote {
  /** The blob submitted to TokenMessengerWithFees. Used exactly as Circle returned it. */
  signedQuote: Hex
  issuedAt: number
  /** Unix seconds when the quote stops being accepted (TIMESTAMP mode). BLOCK_NUMBER quotes are estimated. */
  expiresAt: number
  /** Total fee in the fee token's base units. */
  feeTotal: bigint
  burnAmount: bigint
  feeToken: Address
  items: { type: QuoteFeeType; amount: bigint }[]
  /** TokenMessengerWithFees address the quote is bound to (first quote argument). */
  messenger: Address
}

export class QuoteUnavailableError extends IrisError {
  constructor(
    message: string,
    readonly errorCode: string,
  ) {
    super(message, 400)
    this.name = 'QuoteUnavailableError'
  }
}

/**
 * Asks Circle's Quote API for a signed, time-limited upfront fee quote. The quote is bound to this exact transfer,
 * so request it with the same amount and destination that are submitted onchain. FAST adds the PRE_FINALITY fee
 * (only some source chains offer it).
 */
export async function requestUpfrontQuote(
  sourceDomain: number,
  destinationDomain: number,
  params: { amount: bigint; feeToken: Address; fast: boolean },
  signal?: AbortSignal,
): Promise<UpfrontQuote> {
  const requests = params.fast ? [{ type: 'FORWARD' }, { type: 'PRE_FINALITY' }] : [{ type: 'FORWARD' }]
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted()
    try {
      const timeout = AbortSignal.timeout(12_000)
      const response = await fetch(`${IRIS_BASE_URL}/v2/quote/burn/usdc/${sourceDomain}/${destinationDomain}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: params.amount.toString(), feeToken: params.feeToken, requests }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      if (response.status === 429 || response.status >= 500) throw new IrisError(`Circle's quote service is busy (HTTP ${response.status}).`, response.status)
      if (!response.ok) {
        throw new QuoteUnavailableError(typeof body.error === 'string' ? body.error : `Circle declined the fee quote (HTTP ${response.status}).`, typeof body.errorCode === 'string' ? body.errorCode : 'UNKNOWN')
      }
      return parseQuote(body, params.amount)
    } catch (error) {
      if (signal?.aborted || error instanceof QuoteUnavailableError) throw error
      last = error
      if (attempt < 2) await sleep(600 * 2 ** attempt, signal)
    }
  }
  throw last instanceof Error ? last : new IrisError("Couldn't reach Circle's quote service.")
}

/** Validates Circle's quote response field by field before anything is built from it. */
export function parseQuote(body: Record<string, unknown>, expectedBurn: bigint): UpfrontQuote {
  const bad = (what: string) => new IrisError(`Circle returned an unusable fee quote (${what}).`)
  const signedQuote = body.signedQuote
  if (typeof signedQuote !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signedQuote) || signedQuote.length % 2 !== 0) throw bad('signature')
  const expiry = body.expiry as { mode?: string; expiresAt?: number; blockEstimatedAt?: number } | undefined
  const expiresAt = expiry?.mode === 'TIMESTAMP' ? expiry.expiresAt : expiry?.blockEstimatedAt
  if (typeof expiresAt !== 'number') throw bad('expiry')
  if (typeof body.burnAmount !== 'string' || BigInt(body.burnAmount) !== expectedBurn) throw bad('burn amount differs from the request')
  if (typeof body.feeTotalAmount !== 'string' || typeof body.feeToken !== 'string') throw bad('fee')
  const rawItems = Array.isArray(body.items) ? (body.items as { type?: string; amount?: string; args?: unknown[] }[]) : []
  const items: { type: QuoteFeeType; amount: bigint }[] = []
  for (const i of rawItems) {
    if ((i.type === 'FORWARD' || i.type === 'PRE_FINALITY') && typeof i.amount === 'string') items.push({ type: i.type, amount: BigInt(i.amount) })
  }
  const feeTotal = BigInt(body.feeTotalAmount)
  if (items.length === 0 || items.reduce((sum, i) => sum + i.amount, 0n) !== feeTotal) throw bad('fee items do not add up')
  const messenger = rawItems[0]?.args?.[0]
  if (typeof messenger !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(messenger)) throw bad('contract')
  return {
    signedQuote: signedQuote as Hex,
    issuedAt: typeof body.issuedAt === 'number' ? body.issuedAt : 0,
    expiresAt,
    feeTotal,
    burnAmount: BigInt(body.burnAmount),
    feeToken: getAddress(body.feeToken),
    items,
    messenger: getAddress(messenger),
  }
}
