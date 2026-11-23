import { erc20Abi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem'
import { orbitPayAbi } from '@/lib/abi'
import { getBlockTime, scanBlocks, type RpcPool } from '@/lib/historyScan'
import { addressEq } from './codec'
import { invoiceMemo, type InvoiceData, type PaymentProof } from './types'

export type ConfirmResult = { ok: true; proof: PaymentProof; memoMatch: boolean } | { ok: false; reason: string }

const ZERO_MEMO = `0x${'00'.repeat(32)}`

/**
 * Checks one transaction against one invoice using the chain's own receipt. A payment counts only when ALL hold:
 * the receipt succeeded, it is not older than the invoice, it contains a USDC Transfer event from the client wallet
 * to the issuer for exactly the invoice amount, and (when sent through OrbitPay) its PaymentSent memo is this invoice's
 * ID or empty, never another invoice's.
 */
export function checkReceipt(invoice: InvoiceData, receipt: TransactionReceipt, timestamp?: number): ConfirmResult {
  if (receipt.status !== 'success') return { ok: false, reason: 'The transaction failed onchain.' }
  if (receipt.blockNumber < BigInt(invoice.createdBlock)) return { ok: false, reason: 'The transaction is older than the invoice.' }
  const amount = BigInt(invoice.amount)
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs, strict: false }).filter(
    (log) =>
      addressEq(log.address, invoice.usdc) &&
      log.args.from !== undefined &&
      log.args.to !== undefined &&
      addressEq(log.args.from, invoice.client.wallet) &&
      addressEq(log.args.to, invoice.to) &&
      log.args.value === amount,
  )
  if (transfers.length === 0) return { ok: false, reason: 'No USDC Transfer for the exact invoice amount from the client wallet to the issuer.' }
  let via: PaymentProof['via'] = 'transfer'
  let memoMatch = false
  if (invoice.orbitPay) {
    const sent = parseEventLogs({ abi: orbitPayAbi, eventName: 'PaymentSent', logs: receipt.logs, strict: false }).filter(
      (log) =>
        addressEq(log.address, invoice.orbitPay as Address) &&
        log.args.from !== undefined &&
        log.args.to !== undefined &&
        addressEq(log.args.from, invoice.client.wallet) &&
        addressEq(log.args.to, invoice.to) &&
        log.args.amount === amount,
    )
    if (sent.length > 0) {
      const memo = (sent[0].args.memo ?? ZERO_MEMO) as Hex
      if (memo !== ZERO_MEMO && memo.toLowerCase() !== invoiceMemo(invoice.id).toLowerCase()) {
        return { ok: false, reason: 'This payment carries a different invoice ID.' }
      }
      via = 'orbitpay'
      memoMatch = memo.toLowerCase() === invoiceMemo(invoice.id).toLowerCase()
    }
  }
  return {
    ok: true,
    memoMatch,
    proof: {
      hash: receipt.transactionHash,
      from: invoice.client.wallet,
      to: invoice.to,
      amount: invoice.amount,
      blockNumber: receipt.blockNumber.toString(),
      timestamp,
      via,
      verifiedAt: Date.now(),
    },
  }
}

/**
 * Fetches the receipt for `hash` and verifies it against the invoice. Network problems throw (so a caller never records a
 * "not paid" answer it did not actually get); a receipt that does not match the invoice returns { ok: false }.
 */
export async function confirmPaymentTx(pool: RpcPool, invoice: InvoiceData, hash: Hex, signal?: AbortSignal): Promise<ConfirmResult> {
  const receipt: TransactionReceipt = await pool.run((ep) => ep.client.getTransactionReceipt({ hash }), signal)
  const timestamp = await getBlockTime(pool, receipt.blockNumber, signal).catch(() => undefined)
  return checkReceipt(invoice, receipt, timestamp)
}

export interface ScanResult {
  payment?: PaymentProof
  /** Further verified payments for the same invoice (a double payment). */
  duplicates: Hex[]
  /** Highest block that was covered. */
  scannedTo: bigint
}

/**
 * Looks for payments of this invoice on Arc: every USDC Transfer from the client wallet to the issuer for the exact
 * amount since the invoice was created, each one re-checked against its receipt. `exclude` holds transactions already
 * credited to another invoice, so one payment can never settle two invoices.
 */
export async function scanInvoicePayments(opts: {
  pool: RpcPool
  invoice: InvoiceData
  scale: bigint
  fromBlock?: bigint
  exclude?: Set<string>
  signal?: AbortSignal
}): Promise<ScanResult> {
  const { pool, invoice, scale, signal } = opts
  const head = await pool.run((ep) => ep.client.getBlockNumber(), signal)
  const start = BigInt(invoice.createdBlock)
  const from = opts.fromBlock !== undefined && opts.fromBlock > start ? opts.fromBlock : start
  const amount = BigInt(invoice.amount)
  const candidates = new Map<string, { hash: Hex; block: bigint; index: number }>()
  if (from <= head) {
    await scanBlocks({ pool, address: invoice.to, usdc: invoice.usdc, scale, signal }, from, head, (rows) => {
      for (const row of rows) {
        if (row.amount !== amount || !addressEq(row.from, invoice.client.wallet) || !addressEq(row.to, invoice.to)) continue
        if (opts.exclude?.has(row.hash.toLowerCase())) continue
        candidates.set(row.hash.toLowerCase(), { hash: row.hash, block: row.blockNumber ?? 0n, index: row.logIndex ?? 0 })
      }
    })
  }
  const ordered = [...candidates.values()].sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1))
  const proofs: { proof: PaymentProof; memoMatch: boolean }[] = []
  for (const candidate of ordered) {
    const result = await confirmPaymentTx(pool, invoice, candidate.hash, signal)
    if (result.ok) proofs.push({ proof: result.proof, memoMatch: result.memoMatch })
  }
  // A payment that names this invoice's ID outranks an earlier plain transfer of the same amount.
  const chosen = proofs.find((p) => p.memoMatch) ?? proofs[0]
  return {
    payment: chosen?.proof,
    duplicates: proofs.filter((p) => p !== chosen).map((p) => p.proof.hash),
    scannedTo: head,
  }
}
