import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { arcMainnet } from '@/config'
import { rpcPool } from '@/lib/rpcPool'
import { ARC_CHAIN_ID } from '@/lib/settings'
import { getRememberedPayment, rememberPayment } from '@/lib/invoice/store'
import type { PaymentProof, SignedInvoice } from '@/lib/invoice/types'
import { confirmPaymentTx, scanInvoicePayments } from '@/lib/invoice/verify'
import { usdcDecimalsFor } from '@/onchain-money'

const NATIVE_SCALE = 10n ** BigInt(arcMainnet.nativeCurrency.decimals - usdcDecimalsFor(ARC_CHAIN_ID))
const POLL_MS = 15_000

export interface InvoiceLookup {
  /** True until the first full check of the chain has finished. Paying stays disabled until then, to avoid a double payment. */
  checking: boolean
  firstCheckDone: boolean
  payment?: PaymentProof
  duplicates: Hex[]
  error?: string
  /** Verify a specific transaction (right after the client paid). Returns an explanation when it does not qualify. */
  confirmHash: (hash: Hex) => Promise<string | undefined>
  recheck: () => void
}

/**
 * What the chain says about one invoice, for whoever opened the link (no wallet needed). A payment is only ever shown as
 * paid after its receipt has been fetched and checked now, never because something was stored earlier.
 */
export function useInvoiceLookup(signed: SignedInvoice | undefined, enabled: boolean): InvoiceLookup {
  const [checking, setChecking] = useState(false)
  const [firstCheckDone, setFirstCheckDone] = useState(false)
  const [payment, setPayment] = useState<PaymentProof | undefined>(undefined)
  const [duplicates, setDuplicates] = useState<Hex[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const busy = useRef(false)
  const scannedTo = useRef<bigint | undefined>(undefined)
  const paymentRef = useRef<PaymentProof | undefined>(undefined)
  const data = signed?.data

  const check = useCallback(
    async (signal?: AbortSignal) => {
      if (!data || busy.current) return
      busy.current = true
      setChecking(true)
      try {
        // A remembered payment is re-verified from its receipt before it is trusted.
        const remembered = paymentRef.current ?? getRememberedPayment(data.id)
        if (remembered && !paymentRef.current) {
          const again = await confirmPaymentTx(rpcPool, data, remembered.hash, signal).catch(() => undefined)
          if (again?.ok) {
            paymentRef.current = again.proof
            setPayment(again.proof)
          }
        }
        const exclude = new Set<string>(paymentRef.current ? [paymentRef.current.hash.toLowerCase()] : [])
        const result = await scanInvoicePayments({
          pool: rpcPool,
          invoice: data,
          scale: NATIVE_SCALE,
          fromBlock: scannedTo.current !== undefined ? scannedTo.current + 1n : undefined,
          exclude,
          signal,
        })
        scannedTo.current = result.scannedTo
        const found = result.payment
        if (found && !paymentRef.current) {
          paymentRef.current = found
          rememberPayment(data.id, found)
          setPayment(found)
        }
        const extra = [...(found && paymentRef.current && found.hash !== paymentRef.current.hash ? [found.hash] : []), ...result.duplicates]
        if (extra.length) setDuplicates((prev) => [...new Set([...prev, ...extra])])
        setError(undefined)
        setFirstCheckDone(true)
      } catch (e) {
        if (!signal?.aborted) setError('Could not read Arc right now. Trying again shortly.')
        if (!signal?.aborted && import.meta.env.DEV) console.warn('invoice lookup failed', e)
      } finally {
        busy.current = false
        setChecking(false)
      }
    },
    [data],
  )

  useEffect(() => {
    if (!enabled || !data) return
    const controller = new AbortController()
    void check(controller.signal)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void check(controller.signal)
    }, POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [enabled, data, check])

  const confirmHash = useCallback(
    async (hash: Hex): Promise<string | undefined> => {
      if (!data) return 'No invoice.'
      try {
        const result = await confirmPaymentTx(rpcPool, data, hash)
        if (!result.ok) return result.reason
        if (!paymentRef.current) {
          paymentRef.current = result.proof
          rememberPayment(data.id, result.proof)
          setPayment(result.proof)
        }
        return undefined
      } catch {
        return 'The payment was sent, but Arc could not confirm it yet. OrbitPay keeps checking.'
      }
    },
    [data],
  )

  return { checking, firstCheckDone, payment, duplicates, error, confirmHash, recheck: () => void check() }
}
