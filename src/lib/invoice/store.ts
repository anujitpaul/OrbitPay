import type { Address, Hex } from 'viem'
import { parseInvoice } from './codec'
import type { InvoiceRecord, PaymentProof } from './types'

const key = (account: Address) => `orbitpay:invoices:v1:${account.toLowerCase()}`
const PAID_PREFIX = 'orbitpay:invoice-paid:v1:'
const EMPTY: InvoiceRecord[] = []
const listeners = new Set<() => void>()
const cache = new Map<string, { raw: string | null; parsed: InvoiceRecord[] }>()

interface StoredRecord {
  d: unknown
  s: string
  im?: string[]
  cancelledAt?: number
  payment?: PaymentProof
  duplicates?: Hex[]
  scannedTo?: string
}

function parseRecords(raw: string | null): InvoiceRecord[] {
  if (!raw) return EMPTY
  try {
    const list = JSON.parse(raw) as StoredRecord[]
    if (!Array.isArray(list)) return EMPTY
    const out: InvoiceRecord[] = []
    for (const item of list) {
      const parsed = parseInvoice({ d: item.d, s: item.s, im: item.im })
      if (!parsed.ok) continue
      out.push({ signed: parsed.signed, images: parsed.images, cancelledAt: item.cancelledAt, payment: item.payment, duplicates: item.duplicates, scannedTo: item.scannedTo })
    }
    return out
  } catch {
    return EMPTY
  }
}

/** Invoices created by this wallet on this device, newest first. The returned array is stable until the data changes. */
export function getInvoices(account: Address | undefined): InvoiceRecord[] {
  if (!account || typeof localStorage === 'undefined') return EMPTY
  const k = key(account)
  let raw: string | null = null
  try {
    raw = localStorage.getItem(k)
  } catch {
    return EMPTY
  }
  const hit = cache.get(k)
  if (hit && hit.raw === raw) return hit.parsed
  const parsed = parseRecords(raw)
  cache.set(k, { raw, parsed })
  return parsed
}

function write(account: Address, records: InvoiceRecord[]): boolean {
  const serial: StoredRecord[] = records.map((r) => ({
    d: r.signed.data,
    s: r.signed.signature,
    im: r.images.length ? r.images : undefined,
    cancelledAt: r.cancelledAt,
    payment: r.payment,
    duplicates: r.duplicates?.length ? r.duplicates : undefined,
    scannedTo: r.scannedTo,
  }))
  try {
    localStorage.setItem(key(account), JSON.stringify(serial))
  } catch {
    return false // storage full or unavailable: the caller tells the user
  }
  for (const cb of listeners) cb()
  return true
}

export function saveInvoice(account: Address, record: InvoiceRecord): boolean {
  const others = getInvoices(account).filter((r) => r.signed.data.id !== record.signed.data.id)
  return write(account, [record, ...others])
}

export function updateInvoice(account: Address, id: string, patch: Partial<Pick<InvoiceRecord, 'cancelledAt' | 'payment' | 'duplicates' | 'scannedTo'>>): void {
  const list = getInvoices(account)
  if (!list.some((r) => r.signed.data.id === id)) return
  write(account, list.map((r) => (r.signed.data.id === id ? { ...r, ...patch } : r)))
}

export function subscribeInvoices(callback: () => void): () => void {
  listeners.add(callback)
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith('orbitpay:invoices:v1:')) callback()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('storage', onStorage)
  }
}

/** A verified payment remembered for the invoice viewer (it is re-verified against the chain on every visit). */
export function getRememberedPayment(id: string): PaymentProof | undefined {
  try {
    const raw = localStorage.getItem(PAID_PREFIX + id)
    return raw ? (JSON.parse(raw) as PaymentProof) : undefined
  } catch {
    return undefined
  }
}

export function rememberPayment(id: string, payment: PaymentProof): void {
  try {
    localStorage.setItem(PAID_PREFIX + id, JSON.stringify(payment))
  } catch {
    // Not critical: the chain is the source of truth.
  }
}
