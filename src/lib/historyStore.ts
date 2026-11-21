/**
 * One observable history store per wallet. Lives outside React so scans survive tab switches,
 * and so Send can ask for an immediate refresh once a payment is confirmed.
 */

import type { Address } from 'viem'
import { getBlockTime, scanBlocks, type RpcPool } from './historyScan'
import { loadScanCache, saveScanCache, type HistoryTx } from './txStore'

export interface HistorySnapshot {
  /** Confirmed rows read from the chain, newest first. */
  items: HistoryTx[]
  /** Highest block fully scanned. */
  head: bigint | undefined
  /** Lowest block scanned so far. */
  scannedFrom: bigint | undefined
  /** Timestamp (seconds) of the lowest scanned block, when known. */
  scannedFromTime: number | undefined
  /** True once the scan reached block 0. */
  complete: boolean
  loadingLatest: boolean
  loadingOlder: boolean
  scanningAll: boolean
  error: string | undefined
  hasLoaded: boolean
  /** Blocks searched so far during the first scan, before a full result exists. */
  scanProgress: bigint | undefined
}

const INITIAL_TARGET = 10 // stop the first scan once this many rows are found
const OLDER_TARGET = 10
const BUDGET_CHUNKS = 40 // chunks per "load" step, roughly 30 seconds on the public RPC

export const emptySnapshot: HistorySnapshot = {
  items: [],
  head: undefined,
  scannedFrom: undefined,
  scannedFromTime: undefined,
  complete: false,
  loadingLatest: false,
  loadingOlder: false,
  scanningAll: false,
  error: undefined,
  hasLoaded: false,
  scanProgress: undefined,
}

function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return ''
  const message = error instanceof Error ? error.message : ''
  if (/offline/i.test(message) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return 'You appear to be offline. History will update automatically when your connection returns.'
  }
  if (/pruned/i.test(message)) return 'These older blocks are not available from the configured Arc RPC endpoints. Try another RPC in Settings.'
  if (/rate limit|429|-32005/i.test(message)) return 'The Arc RPC is rate limiting requests. Retry in a moment.'
  return 'Could not read transactions from the Arc RPC. Check your connection and retry.'
}

function mergeRows(existing: HistoryTx[], incoming: HistoryTx[]): HistoryTx[] {
  const map = new Map(existing.map((r) => [r.id, r]))
  for (const row of incoming) map.set(row.id, { ...map.get(row.id), ...row })
  return [...map.values()].sort((a, b) => {
    const blockA = a.blockNumber ?? 0n
    const blockB = b.blockNumber ?? 0n
    if (blockA !== blockB) return blockA > blockB ? -1 : 1
    return (b.logIndex ?? 0) - (a.logIndex ?? 0)
  })
}

export class HistoryStore {
  private state: HistorySnapshot = emptySnapshot
  private listeners = new Set<() => void>()
  private abort: AbortController | undefined
  private running = false
  private refreshWanted = false
  private users = 0
  private timesRunning = false
  private timeAbort: AbortController | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    readonly address: Address,
    private readonly usdc: Address,
    private readonly scale: bigint,
    private readonly pool: RpcPool,
  ) {
    const cached = loadScanCache(address, usdc)
    if (cached) {
      this.state = { ...emptySnapshot, items: cached.items, head: cached.head, scannedFrom: cached.scannedFrom, complete: cached.scannedFrom === 0n, hasLoaded: true }
    }
  }

  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  getSnapshot = (): HistorySnapshot => this.state

  private set(patch: Partial<HistorySnapshot>): void {
    this.state = { ...this.state, ...patch }
    if (patch.items !== undefined || patch.head !== undefined || patch.scannedFrom !== undefined) {
      if (this.state.head !== undefined && this.state.scannedFrom !== undefined) {
        saveScanCache(this.address, this.usdc, this.state.head, this.state.scannedFrom, this.state.items)
      }
    }
    this.listeners.forEach((fn) => fn())
  }

  /** Called by each mounted hook. The first user starts the background refresh loop. */
  retain(): () => void {
    this.users += 1
    if (this.users === 1) {
      void this.refresh(true)
      this.timer = setInterval(() => {
        if (document.visibilityState === 'visible') void this.refresh()
      }, 15_000)
      window.addEventListener('online', this.onOnline)
      document.addEventListener('visibilitychange', this.onVisible)
    }
    return () => {
      this.users -= 1
      if (this.users === 0) {
        if (this.timer) clearInterval(this.timer)
        this.timer = undefined
        window.removeEventListener('online', this.onOnline)
        document.removeEventListener('visibilitychange', this.onVisible)
        this.abort?.abort()
        this.timeAbort?.abort()
      }
    }
  }

  /** The connection came back: forget endpoint cooldowns and catch up immediately. */
  private onOnline = (): void => {
    this.pool.reset()
    void this.refresh(true)
  }

  private onVisible = (): void => {
    if (document.visibilityState === 'visible') void this.refresh()
  }

  private begin(): AbortController {
    this.abort = new AbortController()
    return this.abort
  }

  /** Reads everything newer than the last scanned block (or the newest window on first load). */
  async refresh(urgent = false): Promise<void> {
    if (this.running) {
      // Background polls never interrupt a running scan; an explicit request (after a Send) does.
      if (urgent) this.refreshWanted = true
      return
    }
    this.running = true
    const controller = this.begin()
    this.set({ loadingLatest: true })
    try {
      const head = await this.pool.getBlockNumber(controller.signal)
      const opts = { pool: this.pool, address: this.address, usdc: this.usdc, scale: this.scale, signal: controller.signal }
      const known = this.state.head
      let items = this.state.items

      if (known !== undefined && this.state.scannedFrom !== undefined) {
        if (head > known) {
          await scanBlocks(opts, known + 1n, head, (rows) => {
            items = mergeRows(items, rows)
            this.set({ items })
          })
        }
        this.set({ head: head > known ? head : known, hasLoaded: true })
      } else {
        // First load: search newest to oldest until enough rows are found. Coverage is saved after every
        // chunk, so an interrupted scan keeps its progress and a later refresh continues from there.
        let found = 0
        const result = await scanBlocks(opts, 0n, head, (rows, covered) => {
          items = mergeRows(items, rows)
          found += rows.length
          this.set({ items, head, scannedFrom: covered, scanProgress: head - covered + 1n, complete: covered === 0n, hasLoaded: found > 0 || this.state.hasLoaded })
          return found >= INITIAL_TARGET
        })
        const time = await getBlockTime(this.pool, result.coveredFrom, controller.signal)
        this.set({ head, scannedFrom: result.coveredFrom, scannedFromTime: time, complete: result.coveredFrom === 0n, hasLoaded: true, scanProgress: undefined })
      }
      this.set({ error: undefined })
    } catch (error) {
      const message = describeError(error)
      if (message) this.set({ error: message, hasLoaded: true })
    } finally {
      this.running = false
      this.set({ loadingLatest: false })
      if (this.refreshWanted) {
        this.refreshWanted = false
        void this.refresh(true)
      }
    }
  }

  /** Scans further back in time. With untilDone, keeps going to the first block (cancel with stop()). */
  async loadOlder(untilDone = false): Promise<void> {
    const from = this.state.scannedFrom
    if (this.running || from === undefined || from === 0n) return
    this.running = true
    const controller = this.begin()
    this.set({ loadingOlder: true, scanningAll: untilDone, error: undefined })
    try {
      const opts = { pool: this.pool, address: this.address, usdc: this.usdc, scale: this.scale, signal: controller.signal }
      let items = this.state.items
      let cursor = from
      while (cursor > 0n) {
        let found = 0
        let chunks = 0
        const result = await scanBlocks(opts, 0n, cursor - 1n, (rows, covered) => {
          items = mergeRows(items, rows)
          found += rows.length
          chunks += 1
          this.set({ items, scannedFrom: covered })
          return chunks >= BUDGET_CHUNKS || (!untilDone && found >= OLDER_TARGET)
        })
        cursor = result.coveredFrom
        const time = await getBlockTime(this.pool, cursor, controller.signal)
        this.set({ scannedFrom: cursor, scannedFromTime: time, complete: cursor === 0n })
        if (!untilDone || this.refreshWanted) break
      }
    } catch (error) {
      const message = describeError(error)
      if (message) this.set({ error: message })
    } finally {
      this.running = false
      this.set({ loadingOlder: false, scanningAll: false })
      if (this.refreshWanted) {
        this.refreshWanted = false
        void this.refresh(true)
      }
    }
  }

  /** Fills in block timestamps for the given rows (the ones on screen), one throttled call per block. */
  async ensureTimes(ids: string[]): Promise<void> {
    if (this.timesRunning) return
    const wanted = new Set(ids)
    const missing = this.state.items.filter((i) => wanted.has(i.id) && i.timestamp === undefined && i.blockNumber !== undefined)
    if (missing.length === 0) return
    this.timesRunning = true
    this.timeAbort = new AbortController()
    try {
      const blocks = [...new Set(missing.map((m) => m.blockNumber as bigint))]
      const found = new Map<bigint, number>()
      for (const block of blocks) {
        const ts = await getBlockTime(this.pool, block, this.timeAbort.signal)
        if (ts !== undefined) found.set(block, ts)
        if (found.size > 0 && (found.size % 4 === 0 || block === blocks[blocks.length - 1])) this.applyTimes(found)
      }
      this.applyTimes(found)
    } catch {
      // Aborted or RPC trouble: rows keep showing "Loading time" and are retried on the next render.
    } finally {
      this.timesRunning = false
    }
  }

  private applyTimes(found: Map<bigint, number>): void {
    if (found.size === 0) return
    const items = this.state.items.map((i) => (i.timestamp === undefined && i.blockNumber !== undefined && found.has(i.blockNumber) ? { ...i, timestamp: found.get(i.blockNumber) } : i))
    this.set({ items })
  }

  /** Scan the full history back to block 0. Pause with stop(). */
  scanAll(): Promise<void> {
    return this.loadOlder(true)
  }

  stop(): void {
    this.abort?.abort()
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const stores = new Map<string, HistoryStore>()

export function getHistoryStore(
  address: Address,
  usdc: Address,
  scale: bigint,
  pool: RpcPool,
): HistoryStore {
  const key = `${usdc.toLowerCase()}:${address.toLowerCase()}`
  let store = stores.get(key)
  if (!store) {
    store = new HistoryStore(address, usdc, scale, pool)
    stores.set(key, store)
  }
  return store
}

/** Asks every live store for this wallet to re-read the chain now (used after a confirmed Send). */
export function requestHistoryRefresh(address: Address): void {
  for (const store of stores.values()) {
    if (store.address.toLowerCase() === address.toLowerCase()) void store.refresh(true)
  }
}
