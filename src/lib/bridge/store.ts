import type { Address, Hex } from 'viem'

export type BridgeStatus = 'pending' | 'attested' | 'completed' | 'failed'

export interface BridgeRecord {
  /** Unique per transfer. */
  id: string
  account: Address
  /** Bridge Kit chain keys. */
  source: string
  destination: string
  /** Amount burned on the source chain, in USDC base units, as a decimal string. */
  amount: string
  recipient: Address
  speed: 'FAST' | 'SLOW'
  /** True when Circle's Forwarding Service submits the destination mint (no destination gas for the user). */
  forwarder: boolean
  /** How the forwarding/fast fee was paid: on top, in USDC on the source chain (upfront), or deducted from the burned amount. */
  feeMode?: 'upfront' | 'deducted'
  /** Total fee charged, USDC base units, as a decimal string. */
  feeTotal?: string
  status: BridgeStatus
  /** Human-readable detail for the current stage. */
  detail: string
  approveHash?: Hex
  burnHash?: Hex
  mintHash?: Hex
  /** USDC the recipient received, base units, once the attested message was read. */
  received?: string
  error?: string
  createdAt: number
  updatedAt: number
}

const KEY = (account: Address) => `orbitpay:bridge:v1:${account.toLowerCase()}`
const EMPTY: BridgeRecord[] = []
const listeners = new Set<() => void>()
const cache = new Map<string, { raw: string | null; parsed: BridgeRecord[] }>()

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function getBridgeRecords(account: Address | undefined): BridgeRecord[] {
  if (!account) return EMPTY
  const key = KEY(account)
  const raw = safeGet(key)
  const hit = cache.get(key)
  if (hit && hit.raw === raw) return hit.parsed
  let parsed: BridgeRecord[] = EMPTY
  if (raw) {
    try {
      const data = JSON.parse(raw) as BridgeRecord[]
      if (Array.isArray(data)) parsed = data.filter((r) => typeof r?.id === 'string' && typeof r.source === 'string')
    } catch {
      parsed = EMPTY
    }
  }
  cache.set(key, { raw, parsed })
  return parsed
}

function write(account: Address, records: BridgeRecord[]) {
  try {
    localStorage.setItem(KEY(account), JSON.stringify(records.slice(0, 200)))
  } catch {
    // Storage may be unavailable (private mode). Records then live only for this session via the cache below.
  }
  cache.delete(KEY(account))
  for (const l of listeners) l()
}

/** Inserts or updates a record by id. The same transfer is never listed twice. */
export function upsertBridgeRecord(record: BridgeRecord): void {
  const current = getBridgeRecords(record.account)
  const index = current.findIndex((r) => r.id === record.id)
  const next = index === -1 ? [record, ...current] : current.map((r, i) => (i === index ? { ...r, ...record } : r))
  write(record.account, next.sort((a, b) => b.createdAt - a.createdAt))
}

export function patchBridgeRecord(account: Address, id: string, patch: Partial<BridgeRecord>): void {
  const current = getBridgeRecords(account)
  const found = current.find((r) => r.id === id)
  if (!found) return
  upsertBridgeRecord({ ...found, ...patch, updatedAt: Date.now() })
}

export function subscribeBridgeStore(cb: () => void): () => void {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith('orbitpay:bridge:')) cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * A failure that came from reading data (a decoding bug, a timeout, a network error) rather than from a
 * genuine mismatch. These are re-checked automatically. A real mismatch stays failed.
 */
export function isRetryableFailure(r: BridgeRecord): boolean {
  return r.status === 'failed' && Boolean(r.burnHash) && /slice starting|out-of-bounds|could not be read|too short|not valid hex|timed out|timeout|failed to fetch|network|http request failed|circle’s attestation service/i.test(r.error ?? '')
}
