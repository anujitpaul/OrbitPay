/**
 * Reads USDC Transfer history for one wallet straight from Arc via eth_getLogs.
 *
 * Arc emits USDC Transfer logs from two emitters (https://docs.arc.io/arc/references/usdc-system-events.md):
 *  - the ERC-20 USDC contract (6 decimals), for ERC-20 interface calls only
 *  - the native system emitter 0xffff...fffE (18 decimals), for every explicit USDC movement,
 *    including plain native sends that never touch the ERC-20 contract
 * An ERC-20 transfer logs from both, so the pair is merged into one row.
 *
 * The public RPC caps block ranges and rate limits bursts, so scanning is chunked, throttled,
 * and adapts its chunk size when the node says a range is too large.
 */

import { toEventSelector, type Address, type Hex, type Log, type PublicClient } from 'viem'
import { transferEvent } from './abi'
import type { HistoryTx } from './txStore'

export const SYSTEM_EMITTER: Address = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE'
export const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)')

const START_CHUNK = 9_000n // the primary public RPC rejects spans of 10,000 blocks or more
const MIN_CHUNK = 50n
const CEILING_CHUNK = 40_000n // never probe above this, even on endpoints that accept more
const MIN_GAP_MS = 300
const MAX_GAP_MS = 2_000
const DOWN_MS = 30_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class RangeLimitError extends Error {
  constructor(
    message: string,
    readonly endpoint?: Endpoint,
  ) {
    super(message)
    this.name = 'RangeLimitError'
  }
}

type ErrorKind = 'range' | 'rate' | 'pruned' | 'transient' | 'fatal'

export function classify(error: unknown): ErrorKind {
  const parts: string[] = []
  let cursor: unknown = error
  for (let depth = 0; depth < 5 && cursor instanceof Error; depth++) {
    const code = (cursor as { code?: unknown }).code
    parts.push(cursor.message, (cursor as { details?: string }).details ?? '', typeof code === 'number' || typeof code === 'string' ? String(code) : '')
    cursor = (cursor as { cause?: unknown }).cause
  }
  const text = parts.join(' ').toLowerCase()
  if (/pruned|history unavailable|4444|missing trie node|state .* not available/.test(text)) return 'pruned'
  if (/range|too large|too many (blocks|results|logs)|query returned more|exceeds? (the )?(max|limit)|-32012/.test(text)) return 'range'
  if (/rate limit|too many requests|429|-32005|limit exceeded/.test(text)) return 'rate'
  if (/-32014|not (yet )?imported|timeout|timed out|fetch|network|http request failed|502|503|504|econn|socket|failed to load|offline/.test(text)) {
    return 'transient'
  }
  return 'fatal'
}

export interface Endpoint {
  url: string
  client: PublicClient
  chunk: bigint
  ceiling: bigint
  gap: number
  nextSlot: number
  downUntil: number
}

/**
 * A set of Arc RPC endpoints with per-endpoint throttling, learned block-range limits and failover.
 * Index 0 is the user's configured endpoint and is preferred while it is healthy.
 */
export class RpcPool {
  readonly endpoints: Endpoint[]

  constructor(urls: string[], makeClient: (url: string) => PublicClient) {
    this.endpoints = [...new Set(urls)].map((url) => ({
      url,
      client: makeClient(url),
      chunk: START_CHUNK,
      ceiling: CEILING_CHUNK,
      gap: MIN_GAP_MS,
      nextSlot: 0,
      downUntil: 0,
    }))
  }

  /** Forget cooldowns (used when the browser comes back online). */
  reset(): void {
    for (const ep of this.endpoints) {
      ep.downUntil = 0
      ep.gap = MIN_GAP_MS
    }
  }

  private pick(skip: Set<Endpoint>): Endpoint | undefined {
    const now = Date.now()
    return this.endpoints.find((ep) => !skip.has(ep) && ep.downUntil <= now)
  }

  private async throttle(ep: Endpoint, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const now = Date.now()
    const wait = Math.max(0, ep.nextSlot - now)
    ep.nextSlot = Math.max(now, ep.nextSlot) + ep.gap
    if (wait > 0) await sleep(wait)
    signal?.throwIfAborted()
  }

  /**
   * Runs fn against the best healthy endpoint. Rate limits and network errors cool that endpoint
   * down and fail over to the next one; if every endpoint is cooling down it waits and tries again.
   * Range errors are reported to the caller (with the endpoint) so it can shrink the chunk.
   */
  async run<T>(fn: (ep: Endpoint) => Promise<T>, signal?: AbortSignal, preferred?: Endpoint): Promise<T> {
    let lastError: unknown
    // Patient on purpose: when every endpoint is cooling down we wait for the first one to recover (up to a minute).
    const deadline = Date.now() + 60_000
    // Endpoints that cannot serve this particular request (pruned history): skipped for this call only.
    const skip = new Set<Endpoint>()
    for (let attempt = 0; attempt < 40 && Date.now() < deadline; attempt++) {
      signal?.throwIfAborted()
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('You appear to be offline.')
      const ep = (preferred && !skip.has(preferred) && preferred.downUntil <= Date.now() ? preferred : undefined) ?? this.pick(skip)
      if (!ep && skip.size >= this.endpoints.length) {
        throw new Error('This block range is not available from any configured Arc RPC (history is pruned).')
      }
      if (!ep) {
        const soonest = Math.min(...this.endpoints.map((e) => e.downUntil))
        await sleep(Math.min(3_000, Math.max(250, soonest - Date.now())))
        continue
      }
      await this.throttle(ep, signal)
      try {
        const value = await fn(ep)
        ep.gap = Math.max(MIN_GAP_MS, ep.gap - 25)
        return value
      } catch (error) {
        if (signal?.aborted) throw error
        lastError = error
        const kind = classify(error)
        if (kind === 'range') throw new RangeLimitError(error instanceof Error ? error.message : 'range too large', ep)
        if (kind === 'fatal') throw error
        if (kind === 'pruned') {
          skip.add(ep)
          continue
        }
        if (kind === 'rate') {
          ep.gap = Math.min(MAX_GAP_MS, ep.gap * 2)
          if (ep.gap >= 1_000) ep.downUntil = Date.now() + DOWN_MS
          await sleep(Math.min(ep.gap, 1_000))
        } else {
          // Network or node trouble: try another endpoint straight away, and rest this one briefly.
          ep.downUntil = Date.now() + 5_000
          await sleep(300 * (attempt + 1))
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('RPC request failed')
  }

  async getBlockNumber(signal?: AbortSignal): Promise<bigint> {
    return this.run((ep) => ep.client.getBlockNumber(), signal)
  }
}

// ---------------------------------------------------------------------------
// Block timestamps (cached)
// ---------------------------------------------------------------------------

const blockTimes = new Map<string, number>()

export async function getBlockTime(pool: RpcPool, blockNumber: bigint, signal?: AbortSignal): Promise<number | undefined> {
  const key = blockNumber.toString()
  const hit = blockTimes.get(key)
  if (hit !== undefined) return hit
  try {
    const block = await pool.run((ep) => ep.client.getBlock({ blockNumber, includeTransactions: false }), signal)
    const ts = Number(block.timestamp)
    blockTimes.set(key, ts)
    return ts
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Log fetching
// ---------------------------------------------------------------------------

interface RawTransfer {
  hash: Hex
  blockNumber: bigint
  logIndex: number
  emitter: 'erc20' | 'native'
  from: Address
  to: Address
  value: bigint
}

type TransferLog = Log<bigint, number, false, typeof transferEvent, true>

function toRaw(log: TransferLog, usdc: Address): RawTransfer | undefined {
  if (log.removed || log.transactionHash === null || log.blockNumber === null || log.logIndex === null) return undefined
  const { from, to, value } = log.args
  return {
    hash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    emitter: log.address.toLowerCase() === usdc.toLowerCase() ? 'erc20' : 'native',
    from,
    to,
    value,
  }
}

async function fetchRaw(
  pool: RpcPool,
  address: Address,
  usdc: Address,
  fromBlock: bigint,
  toBlock: bigint,
  ep: Endpoint,
  signal?: AbortSignal,
): Promise<RawTransfer[]> {
  const emitters: Address[] = [usdc, SYSTEM_EMITTER]
  const base = { address: emitters, event: transferEvent, fromBlock, toBlock, strict: true } as const
  // Two filtered queries (as sender, as receiver); sequential so the throttle spaces them out.
  const sent = await pool.run((e) => e.client.getLogs({ ...base, args: { from: address } }), signal, ep)
  const received = await pool.run((e) => e.client.getLogs({ ...base, args: { to: address } }), signal, ep)
  const seen = new Set<string>()
  const out: RawTransfer[] = []
  for (const log of [...sent, ...received]) {
    const raw = toRaw(log, usdc)
    if (!raw) continue
    const key = `${raw.hash}:${raw.logIndex}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(raw)
  }
  return out
}

/** Merges the ERC-20 log and the matching native system log of one transfer into a single row. */
export function resolveTransfers(raws: RawTransfer[], address: Address, scale: bigint): Omit<HistoryTx, 'timestamp'>[] {
  const byHash = new Map<Hex, RawTransfer[]>()
  for (const r of raws) byHash.set(r.hash, [...(byHash.get(r.hash) ?? []), r])
  const me = address.toLowerCase()
  const rows: Omit<HistoryTx, 'timestamp'>[] = []

  for (const group of byHash.values()) {
    const erc20 = group.filter((r) => r.emitter === 'erc20')
    const matched = new Set<number>()
    const natives = group.filter((r) => r.emitter === 'native')
    const kept: { raw: RawTransfer; amount: bigint; dust: boolean }[] = erc20.map((raw) => ({ raw, amount: raw.value, dust: false }))

    for (const n of natives) {
      const pair = erc20.findIndex(
        (e, i) => !matched.has(i) && e.from.toLowerCase() === n.from.toLowerCase() && e.to.toLowerCase() === n.to.toLowerCase() && e.value * scale === n.value,
      )
      if (pair >= 0) {
        matched.add(pair)
        continue
      }
      const amount = n.value / scale
      kept.push({ raw: n, amount, dust: amount === 0n })
    }

    for (const { raw, amount, dust } of kept) {
      const from = raw.from.toLowerCase()
      const to = raw.to.toLowerCase()
      rows.push({
        id: `${raw.hash}:${raw.logIndex}`,
        hash: raw.hash,
        from: raw.from,
        to: raw.to,
        amount,
        dust,
        status: 'confirmed',
        direction: from === me && to === me ? 'self' : from === me ? 'out' : 'in',
        blockNumber: raw.blockNumber,
        logIndex: raw.logIndex,
        source: 'chain',
      })
    }
  }
  return rows
}

export interface ScanOptions {
  pool: RpcPool
  address: Address
  usdc: Address
  scale: bigint
  signal?: AbortSignal
}

/**
 * Scans [fromBlock, toBlock] (inclusive), newest chunk first. Calls onChunk after each chunk with
 * its rows and the lowest block now covered; return true from it to stop early. Chunk size adapts
 * to each endpoint's block-range limit, and failed endpoints are swapped out transparently.
 */
export async function scanBlocks(
  opts: ScanOptions,
  fromBlock: bigint,
  toBlock: bigint,
  onChunk: (rows: HistoryTx[], coveredFrom: bigint) => boolean | void,
): Promise<{ coveredFrom: bigint; stopped: boolean }> {
  const { pool, address, usdc, scale, signal } = opts
  let cursor = toBlock
  while (cursor >= fromBlock) {
    signal?.throwIfAborted()
    const ep = pool.endpoints.find((e) => e.downUntil <= Date.now()) ?? pool.endpoints[0]
    const size = ep.chunk
    const low = cursor - size + 1n > fromBlock ? cursor - size + 1n : fromBlock
    let raws: RawTransfer[]
    try {
      raws = await fetchRaw(pool, address, usdc, low, cursor, ep, signal)
    } catch (error) {
      const limited = error instanceof RangeLimitError ? (error.endpoint ?? ep) : undefined
      if (limited) {
        if (limited !== ep && limited.chunk < size) {
          // The request failed over to an endpoint with a smaller limit than the one that sized it.
          ep.chunk = limited.chunk
          continue
        }
        if (limited.chunk > MIN_CHUNK) {
          // The node refused this span: remember the limit for that endpoint and retry smaller.
          limited.chunk = limited.chunk / 2n > MIN_CHUNK ? limited.chunk / 2n : MIN_CHUNK
          limited.ceiling = limited.chunk
          if (limited !== ep) ep.chunk = limited.chunk
          continue
        }
      }
      throw error
    }
    // A full-size chunk succeeded: probe a larger span next time, up to the endpoint's ceiling.
    if (cursor - low + 1n === size && size < ep.ceiling) ep.chunk = size * 2n > ep.ceiling ? ep.ceiling : size * 2n
    // Timestamps are filled in lazily for the rows on screen (one extra RPC call per block).
    const rows: HistoryTx[] = resolveTransfers(raws, address, scale).map((row) => ({ ...row }))
    const stop = onChunk(rows, low)
    if (low === 0n || low <= fromBlock) return { coveredFrom: low, stopped: false }
    cursor = low - 1n
    if (stop === true) return { coveredFrom: low, stopped: true }
  }
  return { coveredFrom: fromBlock, stopped: false }
}
