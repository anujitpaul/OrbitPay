import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { rpcPool } from '@/lib/rpcPool'
import { settings, ARC_CHAIN_ID } from '@/lib/settings'
import { arcMainnet } from '@/config'
import { parseTxError } from '@/lib/errors'
import { buildInvoice, validateCreateInput, type CreateInput } from '@/lib/invoice/create'
import { getInvoices, saveInvoice, subscribeInvoices, updateInvoice } from '@/lib/invoice/store'
import type { InvoiceRecord } from '@/lib/invoice/types'
import { needsCheck, refreshInvoice } from '@/lib/invoice/watch'
import { usdcDecimalsFor } from '@/onchain-money'

const NATIVE_SCALE = 10n ** BigInt(arcMainnet.nativeCurrency.decimals - usdcDecimalsFor(ARC_CHAIN_ID))
const POLL_MS = 20_000

export type CreateOutcome = { ok: true; record: InvoiceRecord } | { ok: false; message: string }

/** The connected wallet's invoices: stored on this device, re-checked against Arc Mainnet every few seconds. */
export function useInvoices() {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const records = useSyncExternalStore(subscribeInvoices, () => getInvoices(address))
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const busy = useRef(false)

  const check = useCallback(
    async (signal?: AbortSignal) => {
      if (!address || busy.current) return
      busy.current = true
      setChecking(true)
      try {
        // Unpaid invoices first, oldest first: when a payment could belong to an unpaid invoice or be a repeat payment
        // on one that is already settled, the unpaid invoice gets it and only a genuine extra is flagged as a double payment.
        const due = getInvoices(address)
          .filter((r) => needsCheck(r))
          .sort((a, b) => Number(Boolean(a.payment)) - Number(Boolean(b.payment)) || a.signed.data.createdAt - b.signed.data.createdAt)
        for (const record of due) {
          await refreshInvoice({ account: address, record, pool: rpcPool, scale: NATIVE_SCALE, signal })
        }
        setCheckError(undefined)
      } catch (error) {
        if (!signal?.aborted) setCheckError('Could not check Arc right now. OrbitPay will try again.')
        if (!signal?.aborted && import.meta.env.DEV) console.warn('invoice check failed', error)
      } finally {
        busy.current = false
        setChecking(false)
        setNow(Math.floor(Date.now() / 1000))
      }
    },
    [address],
  )

  useEffect(() => {
    if (!address) return
    const controller = new AbortController()
    const first = setTimeout(() => void check(controller.signal), 0)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void check(controller.signal)
    }, POLL_MS)
    return () => {
      controller.abort()
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [address, check])

  const create = useCallback(
    async (input: Omit<CreateInput, 'issuer' | 'usdc' | 'orbitPay'>): Promise<CreateOutcome> => {
      if (!address) return { ok: false, message: 'Connect your wallet first.' }
      const full: CreateInput = { ...input, issuer: address, usdc: settings.usdcAddress, orbitPay: settings.orbitPayAddress }
      const blocked = [settings.usdcAddress, ...(settings.orbitPayAddress ? [settings.orbitPayAddress] : [])]
      const problem = validateCreateInput(full, Math.floor(Date.now() / 1000), blocked)
      if (problem) return { ok: false, message: problem }
      try {
        const record = await buildInvoice(full, {
          headBlock: () => rpcPool.run((ep) => ep.client.getBlockNumber()),
          sign: (message) => signMessageAsync({ message }),
          now: () => Math.floor(Date.now() / 1000),
          existingIds: new Set(getInvoices(address).map((r) => r.signed.data.id)),
          verifyClient: rpcPool.endpoints[0]?.client,
        })
        if (!saveInvoice(address, record)) {
          return { ok: false, message: 'Your browser storage is full. Remove an old invoice or an image and try again.' }
        }
        return { ok: true, record }
      } catch (error) {
        const parsed = parseTxError(error)
        return { ok: false, message: parsed.rejected ? 'Signature cancelled in your wallet. No invoice was created.' : error instanceof Error && error.message.length < 200 ? error.message : parsed.message }
      }
    },
    [address, signMessageAsync],
  )

  const cancel = useCallback(
    (id: string) => {
      if (address) updateInvoice(address, id, { cancelledAt: Date.now() })
    },
    [address],
  )

  return { address, records, now, checking, checkError, create, cancel, recheck: () => void check() }
}

export type InvoicesApi = ReturnType<typeof useInvoices>
