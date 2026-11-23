import type { Address, Hex } from 'viem'
import type { RpcPool } from '@/lib/historyScan'
import { getInvoices, updateInvoice } from './store'
import type { InvoiceRecord } from './types'
import { scanInvoicePayments } from './verify'

const DUPLICATE_WATCH_MS = 7 * 24 * 3600 * 1000

/** Does this invoice still need chain checks? Unpaid ones always; paid ones for a week, to catch a double payment. */
export function needsCheck(record: InvoiceRecord, now = Date.now()): boolean {
  if (record.payment) return now - record.payment.verifiedAt < DUPLICATE_WATCH_MS
  // A cancelled invoice is still watched for a week, so a payment that arrives anyway is never lost.
  if (record.cancelledAt) return now - record.cancelledAt < DUPLICATE_WATCH_MS
  return true
}

/**
 * Reads only the blocks since the last check, verifies any matching payment against its receipt and saves the result.
 * If anything goes wrong it throws and records nothing, so a failed check can never be mistaken for "not paid".
 */
export async function refreshInvoice(opts: { account: Address; record: InvoiceRecord; pool: RpcPool; scale: bigint; signal?: AbortSignal }): Promise<void> {
  const { account, record, pool, scale, signal } = opts
  const id = record.signed.data.id
  // Transactions already credited to another invoice can never settle this one.
  const exclude = new Set<string>()
  for (const other of getInvoices(account)) {
    if (other.signed.data.id === id) continue
    if (other.payment) exclude.add(other.payment.hash.toLowerCase())
    for (const h of other.duplicates ?? []) exclude.add(h.toLowerCase())
  }
  if (record.payment) exclude.add(record.payment.hash.toLowerCase())
  const result = await scanInvoicePayments({
    pool,
    invoice: record.signed.data,
    scale,
    fromBlock: record.scannedTo ? BigInt(record.scannedTo) + 1n : undefined,
    exclude,
    signal,
  })
  const found: Hex[] = [...(record.duplicates ?? [])]
  const extra = [...(result.payment && record.payment ? [result.payment.hash] : []), ...result.duplicates]
  for (const h of extra) if (!found.some((x) => x.toLowerCase() === h.toLowerCase())) found.push(h)
  updateInvoice(account, id, {
    payment: record.payment ?? result.payment,
    duplicates: found.length ? found : undefined,
    scannedTo: result.scannedTo.toString(),
  })
}
