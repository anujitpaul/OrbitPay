/**
 * Local transaction records, saved the moment a wallet returns a hash.
 * Keyed per chain and wallet, kept in localStorage, and observable from React.
 * Chain data (see historyStore.ts) stays the source of truth once a tx is indexed.
 */

import type { Address, Hex } from 'viem'
import { ARC_CHAIN_ID } from './settings'

export type TxStatus = 'pending' | 'confirmed' | 'failed'

export interface HistoryTx {
  /** Unique per row: `${hash}:${logIndex}` for chain rows, the hash for local rows. */
  id: string
  hash: Hex
  from: Address
  to: Address
  /** USDC in 6-decimal base units (ERC-20 view). */
  amount: bigint
  /** True when a native transfer was worth less than 0.000001 USDC and rounds to zero. */
  dust: boolean
  status: TxStatus
  direction: 'in' | 'out' | 'self'
  blockNumber?: bigint
  logIndex?: number
  /** Block timestamp in seconds (chain rows). */
  timestamp?: number
  /** When this app saw the submission, in ms (local rows). */
  createdAt?: number
  source: 'chain' | 'local'
  message?: string
}

export interface StoredTx {
  hash: Hex
  from: Address
  to: Address
  amount: string
  createdAt: number
  status: TxStatus
  blockNumber?: string
  message?: string
}

const EMPTY: StoredTx[] = []
const cache = new Map<string, { raw: string | null; parsed: StoredTx[] }>()
const listeners = new Set<() => void>()
const MAX_STORED = 200

const keyFor = (address: Address) => `orbitpay:txs:v1:${ARC_CHAIN_ID}:${address.toLowerCase()}`

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function parse(raw: string | null): StoredTx[] {
  if (!raw) return EMPTY
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return EMPTY
    return value.filter(
      (v): v is StoredTx =>
        typeof v === 'object' && v !== null && typeof (v as StoredTx).hash === 'string' && typeof (v as StoredTx).amount === 'string',
    )
  } catch {
    return EMPTY
  }
}

/** Stable reference while the stored JSON is unchanged (required by useSyncExternalStore). */
export function getStoredTxs(address: Address | undefined): StoredTx[] {
  if (!address) return EMPTY
  const key = keyFor(address)
  const raw = safeGet(key)
  const hit = cache.get(key)
  if (hit && hit.raw === raw) return hit.parsed
  const parsed = parse(raw)
  cache.set(key, { raw, parsed })
  return parsed
}

function write(address: Address, list: StoredTx[]): void {
  const key = keyFor(address)
  const trimmed = [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_STORED)
  try {
    localStorage.setItem(key, JSON.stringify(trimmed))
  } catch {
    // Storage may be unavailable (private mode, sandboxed iframe): history still works from chain data.
  }
  listeners.forEach((fn) => fn())
}

/** Saves a submitted transaction immediately. A repeated hash updates the existing record, never duplicates it. */
export function saveSubmittedTx(address: Address, tx: StoredTx): void {
  const list = getStoredTxs(address)
  const existing = list.find((t) => t.hash.toLowerCase() === tx.hash.toLowerCase())
  if (existing) {
    write(address, list.map((t) => (t === existing ? { ...existing, ...tx, createdAt: existing.createdAt } : t)))
    return
  }
  write(address, [tx, ...list])
}

export function updateStoredTx(address: Address, hash: Hex, patch: Partial<StoredTx>): void {
  const list = getStoredTxs(address)
  if (!list.some((t) => t.hash.toLowerCase() === hash.toLowerCase())) return
  write(address, list.map((t) => (t.hash.toLowerCase() === hash.toLowerCase() ? { ...t, ...patch } : t)))
}

export function subscribeStore(callback: () => void): () => void {
  listeners.add(callback)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith('orbitpay:txs:')) callback()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('storage', onStorage)
  }
}

// ---------------------------------------------------------------------------
// Scan cache: what has already been read from the chain for a wallet.
// ---------------------------------------------------------------------------

interface CachedItem {
  hash: Hex
  blockNumber: string
  logIndex: number
  from: Address
  to: Address
  amount: string
  dust: boolean
  timestamp?: number
}

export interface ScanCache {
  /** Highest block fully scanned. */
  head: string
  /** Lowest block fully scanned. */
  scannedFrom: string
  items: CachedItem[]
}

const scanKey = (address: Address, usdc: Address) => `orbitpay:scan:v1:${ARC_CHAIN_ID}:${usdc.toLowerCase()}:${address.toLowerCase()}`

export function loadScanCache(address: Address, usdc: Address): { head: bigint; scannedFrom: bigint; items: HistoryTx[] } | undefined {
  const raw = safeGet(scanKey(address, usdc))
  if (!raw) return undefined
  try {
    const c = JSON.parse(raw) as ScanCache
    if (typeof c.head !== 'string' || typeof c.scannedFrom !== 'string' || !Array.isArray(c.items)) return undefined
    const lower = address.toLowerCase()
    const items: HistoryTx[] = c.items.map((i) => ({
      id: `${i.hash}:${i.logIndex}`,
      hash: i.hash,
      from: i.from,
      to: i.to,
      amount: BigInt(i.amount),
      dust: i.dust,
      status: 'confirmed',
      direction: i.from.toLowerCase() === lower && i.to.toLowerCase() === lower ? 'self' : i.from.toLowerCase() === lower ? 'out' : 'in',
      blockNumber: BigInt(i.blockNumber),
      logIndex: i.logIndex,
      timestamp: i.timestamp,
      source: 'chain',
    }))
    return { head: BigInt(c.head), scannedFrom: BigInt(c.scannedFrom), items }
  } catch {
    return undefined
  }
}

export function saveScanCache(address: Address, usdc: Address, head: bigint, scannedFrom: bigint, items: HistoryTx[]): void {
  const kept = items.filter((i) => i.blockNumber !== undefined && i.logIndex !== undefined).slice(0, 1000)
  const payload: ScanCache = {
    head: head.toString(),
    scannedFrom: (kept.length < items.length && kept.length > 0 ? (kept[kept.length - 1].blockNumber ?? scannedFrom) : scannedFrom).toString(),
    items: kept.map((i) => ({
      hash: i.hash,
      blockNumber: (i.blockNumber ?? 0n).toString(),
      logIndex: i.logIndex ?? 0,
      from: i.from,
      to: i.to,
      amount: i.amount.toString(),
      dust: i.dust,
      timestamp: i.timestamp,
    })),
  }
  try {
    localStorage.setItem(scanKey(address, usdc), JSON.stringify(payload))
  } catch {
    // Cache is an optimisation only.
  }
}
