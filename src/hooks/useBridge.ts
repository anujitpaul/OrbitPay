import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address, EIP1193Provider, Hex } from 'viem'
import { useAccount } from 'wagmi'
import { approveExact, burnForwardedDeducted, burnForwardedUpfront, burnUsdc, claimMint, importBurn, isFinal, isRetryableFailure, readUsdcBalance, refreshBridgeRecord, switchWalletChain, withAddChainFallback } from '@/lib/bridge/actions'
import { FAST_FINALITY_THRESHOLD, STANDARD_FINALITY_THRESHOLD, maxFeeFor } from '@/lib/bridge/cctp'
import { buildForwardPlan, type ForwardPlanResult } from '@/lib/bridge/forwarding'
import { fetchIrisFees } from '@/lib/bridge/iris'
import { getBridgeChain, listBridgeChains, TOKEN_MESSENGER_WITH_FEES, type BridgeChain } from '@/lib/bridge/routes'
import { getBridgeRecords, patchBridgeRecord, subscribeBridgeStore, upsertBridgeRecord, type BridgeRecord } from '@/lib/bridge/store'
import { parseTxError, type ParsedError } from '@/lib/errors'

/** Our own errors carry a precise, user-ready message; keep it instead of the generic fallback. */
function parseBridgeError(error: unknown): ParsedError {
  const parsed = parseTxError(error)
  if (!parsed.rejected && parsed.message.startsWith('Something went wrong') && error instanceof Error && error.message.length > 0 && error.message.length < 300 && !error.message.includes('\n')) {
    return { ...parsed, message: error.message }
  }
  return parsed
}

export type BridgeSpeed = 'FAST' | 'SLOW'

export interface BridgeParams {
  source: BridgeChain
  destination: BridgeChain
  /** Base units (6 decimals). */
  amount: bigint
  recipient: Address
  speed: BridgeSpeed
  /** forwarded: Circle's Forwarding Service mints on the destination (no destination gas). self: the wallet mints. */
  delivery: 'forwarded' | 'self'
}

async function getWalletProvider(connector: { getProvider: () => Promise<unknown> } | undefined): Promise<EIP1193Provider> {
  if (!connector) throw new Error('Connect a wallet first.')
  const provider = (await connector.getProvider()) as EIP1193Provider | undefined
  if (!provider) throw new Error('Your wallet did not provide a connection. Reconnect and try again.')
  return withAddChainFallback(
    provider,
    listBridgeChains().map((c) => c.viem),
  )
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** USDC balance on any bridge chain, read through that chain's own RPCs. */
export function useBridgeBalance(chain: BridgeChain | undefined) {
  const { address } = useAccount()
  return useQuery({
    queryKey: ['bridge-balance', chain?.chainId, address],
    enabled: Boolean(chain && address),
    refetchInterval: 20_000,
    staleTime: 10_000,
    retry: 2,
    queryFn: () => readUsdcBalance(chain as BridgeChain, address as Address),
  })
}

export interface FeeView {
  /** Fast-transfer fee in basis points quoted by Circle for this route. */
  fastBps: number | undefined
  standardBps: number | undefined
}

/** Circle's published fee schedule for the route. */
export function useBridgeFees(source: BridgeChain | undefined, destination: BridgeChain | undefined) {
  return useQuery({
    queryKey: ['bridge-fees', source?.domain, destination?.domain],
    enabled: Boolean(source && destination),
    staleTime: 60_000,
    retry: 2,
    queryFn: async (): Promise<FeeView> => {
      const fees = await fetchIrisFees((source as BridgeChain).domain, (destination as BridgeChain).domain)
      return {
        fastBps: fees.find((f) => f.finalityThreshold <= FAST_FINALITY_THRESHOLD)?.minimumFee,
        standardBps: fees.find((f) => f.finalityThreshold >= STANDARD_FINALITY_THRESHOLD)?.minimumFee,
      }
    },
  })
}

/** Live, Circle-verified forwarding plan for the form: route support, fees and what the recipient receives. */
export function useForwardPlan(source: BridgeChain | undefined, destination: BridgeChain | undefined, amount: bigint | undefined, wantFast: boolean, enabled: boolean) {
  return useQuery({
    queryKey: ['bridge-forward-plan', source?.domain, destination?.domain, amount?.toString(), wantFast],
    enabled: Boolean(enabled && source && destination && amount && amount > 0n),
    staleTime: 30_000,
    refetchInterval: 45_000,
    retry: 1,
    queryFn: ({ signal }): Promise<ForwardPlanResult> => buildForwardPlan(source as BridgeChain, destination as BridgeChain, amount as bigint, wantFast, signal),
  })
}

export type BridgeStage = 'approve' | 'burn' | 'attestation' | 'mint'

export interface RunState {
  phase: 'idle' | 'switching' | 'running' | 'error'
  stage?: BridgeStage
  recordId?: string
  /** Why the last run stopped, when it did not produce a record. */
  message?: string
}

const ATTESTATION_WAIT_MS = 30 * 60_000

/**
 * Runs one CCTP V2 transfer: approve exactly the amount, burn through Circle's TokenMessengerV2, wait for Circle's
 * attestation, check it against the request, then mint on the destination chain. Every transaction is confirmed in the wallet.
 */
export function useBridgeRun() {
  const { address, connector } = useAccount()
  const [state, setState] = useState<RunState>({ phase: 'idle' })
  const busy = useRef(false)

  useEffect(() => {
    if (state.phase !== 'running' && state.phase !== 'switching') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [state.phase])

  const run = useCallback(
    async (p: BridgeParams) => {
      if (busy.current || !address) return
      busy.current = true
      const id = crypto.randomUUID()
      const track = { created: false }
      const record = (patch: Partial<BridgeRecord>) => {
        if (!track.created) {
          track.created = true
          upsertBridgeRecord({
            id,
            account: address,
            source: p.source.key,
            destination: p.destination.key,
            amount: p.amount.toString(),
            recipient: p.recipient,
            speed: p.speed,
            forwarder: false,
            status: 'pending',
            detail: 'Transfer started.',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...patch,
          })
        } else {
          patchBridgeRecord(address, id, patch)
        }
      }
      const current = () => getBridgeRecords(address).find((r) => r.id === id)

      try {
        setState({ phase: 'switching' })
        const provider = await getWalletProvider(connector)
        await switchWalletChain(provider, p.source)

        let burnHash: Hex
        if (p.delivery === 'forwarded') {
          // Circle's Forwarding Service: Circle attests and submits the destination mint. No destination gas, no mint transaction from the wallet.
          const first = await buildForwardPlan(p.source, p.destination, p.amount, p.speed === 'FAST')
          if (!first.ok) throw new Error(first.reason)
          const forwardPatch = (plan: typeof first.plan): Partial<BridgeRecord> => ({
            forwarder: true,
            feeMode: plan.mode,
            feeTotal: plan.feeTotal.toString(),
            amount: plan.burnAmount.toString(),
            speed: plan.fast ? 'FAST' : 'SLOW',
          })
          const base = { source: p.source, destination: p.destination, account: address, recipient: p.recipient, maxFee: 0n, minFinalityThreshold: first.plan.threshold }
          const spender = first.plan.mode === 'upfront' ? TOKEN_MESSENGER_WITH_FEES : undefined

          setState({ phase: 'running', stage: 'approve' })
          await approveExact({ ...base, amount: first.plan.burnAmount, spender, approveAmount: first.plan.totalDebit }, provider, (hash) =>
            record({ ...forwardPatch(first.plan), approveHash: hash, detail: 'Approval submitted. Waiting for confirmation…' }),
          )
          if (current()?.approveHash) record({ detail: 'USDC approved. Confirm the burn in your wallet (Circle’s fee quote is valid for about 2 minutes).' })

          // Circle's quote is bound to the exact transfer and short-lived, so a fresh one is requested right before the burn.
          const fresh = await buildForwardPlan(p.source, p.destination, p.amount, p.speed === 'FAST')
          if (!fresh.ok) throw new Error(fresh.reason)
          const plan = fresh.plan
          await approveExact({ ...base, amount: plan.burnAmount, spender, approveAmount: plan.totalDebit }, provider, (hash) => record({ ...forwardPatch(plan), approveHash: hash }))

          setState({ phase: 'running', stage: 'burn', recordId: track.created ? id : undefined })
          const onSubmitted = (hash: Hex) => {
            record({ ...forwardPatch(plan), burnHash: hash, status: 'pending', detail: 'Burn submitted. Waiting for confirmation…' })
            setState({ phase: 'running', stage: 'burn', recordId: id })
          }
          burnHash =
            plan.mode === 'upfront' && plan.quote
              ? await burnForwardedUpfront({ source: p.source, destination: p.destination, account: address, recipient: p.recipient, amount: plan.burnAmount, quote: plan.quote }, provider, onSubmitted)
              : await burnForwardedDeducted(
                  { source: p.source, destination: p.destination, account: address, recipient: p.recipient, totalAmount: plan.burnAmount, maxFee: plan.maxFee ?? 0n, minFinalityThreshold: plan.threshold },
                  provider,
                  onSubmitted,
                )
        } else {
          // Fee quote at burn time, so the maximum fee matches Circle's current schedule.
          const fees = await fetchIrisFees(p.source.domain, p.destination.domain)
          const fast = p.speed === 'FAST'
          const bps = fees.find((f) => (fast ? f.finalityThreshold <= FAST_FINALITY_THRESHOLD : f.finalityThreshold >= STANDARD_FINALITY_THRESHOLD))?.minimumFee
          if (bps === undefined) throw new Error(`Circle has no ${fast ? 'fast' : 'standard'} fee quote for this route right now. Try Standard or retry shortly.`)
          const req = {
            source: p.source,
            destination: p.destination,
            account: address,
            recipient: p.recipient,
            amount: p.amount,
            maxFee: fast ? maxFeeFor(p.amount, bps) : 0n,
            minFinalityThreshold: fast ? FAST_FINALITY_THRESHOLD : STANDARD_FINALITY_THRESHOLD,
          }

          setState({ phase: 'running', stage: 'approve' })
          await approveExact(req, provider, (hash) => record({ approveHash: hash, detail: 'Approval submitted. Waiting for confirmation…' }))
          const approved = current()?.approveHash
          if (approved) record({ detail: 'USDC approved. Confirm the burn in your wallet.' })

          setState({ phase: 'running', stage: 'burn', recordId: track.created ? id : undefined })
          burnHash = await burnUsdc(req, provider, (hash) => {
            record({ burnHash: hash, status: 'pending', detail: 'Burn submitted. Waiting for confirmation…' })
            setState({ phase: 'running', stage: 'burn', recordId: id })
          })
        }
        record({ burnHash, detail: 'Burn confirmed. Waiting for Circle’s attestation…' })

        // Circle signs the burn; the record updates itself. The mint only follows a verified, matching attestation.
        setState({ phase: 'running', stage: 'attestation', recordId: id })
        const deadline = Date.now() + ATTESTATION_WAIT_MS
        for (;;) {
          const rec = current()
          if (!rec) break
          await refreshBridgeRecord(rec).catch(() => undefined)
          const status = current()?.status
          const forwarded = current()?.forwarder === true
          if (status === 'completed' || status === 'failed' || (status === 'attested' && !forwarded)) break
          if (status === 'attested' && forwarded) setState({ phase: 'running', stage: 'mint', recordId: id })
          if (Date.now() > deadline) {
            record({ detail: 'Still waiting for Circle’s attestation. It is tracked in the history below and finishes on its own.' })
            break
          }
          await sleep(4_000)
        }

        const rec = current()
        if (rec?.status === 'attested' && !rec.mintHash && !rec.forwarder) {
          setState({ phase: 'running', stage: 'mint', recordId: id })
          await claimMint(rec, provider)
        }
        setState({ phase: 'idle', recordId: id })
      } catch (error) {
        const parsed = parseBridgeError(error)
        const rec = current()
        const burned = Boolean(rec?.burnHash)
        if (rec) {
          record({
            // After the burn the USDC is committed: keep the transfer open so it can be finished from the history.
            status: burned ? (rec.status === 'attested' ? 'attested' : 'pending') : 'failed',
            detail: burned
              ? 'Interrupted after the burn. Your USDC is safe: finish the mint from the history below.'
              : parsed.rejected
                ? 'Cancelled in your wallet. No USDC was burned.'
                : 'The transfer stopped before the burn. No USDC was burned.',
            error: parsed.message,
          })
        }
        setState({ phase: 'error', recordId: rec ? id : undefined, message: parsed.message })
      } finally {
        busy.current = false
        setState((s) => (s.phase === 'running' || s.phase === 'switching' ? { phase: 'idle', recordId: s.recordId } : s))
      }
    },
    [address, connector],
  )

  const reset = useCallback(() => setState({ phase: 'idle' }), [])
  return { state, run, reset }
}

/** All transfers for the connected wallet, refreshed automatically against Circle and the chains. */
export function useBridgeRecords(activeId: string | undefined) {
  const { address, connector } = useAccount()
  const records = useSyncExternalStore(subscribeBridgeStore, () => getBridgeRecords(address))
  const [claiming, setClaiming] = useState<string | undefined>(undefined)
  const [retrying, setRetrying] = useState<string | undefined>(undefined)
  const [claimError, setClaimError] = useState<{ id: string; message: string } | undefined>(undefined)
  const [refreshError, setRefreshError] = useState<string | undefined>(undefined)
  const checking = useRef(false)

  const refreshAll = useCallback(async () => {
    if (!address || checking.current) return
    checking.current = true
    try {
      for (const r of getBridgeRecords(address)) {
        if ((isFinal(r) && !isRetryableFailure(r)) || !r.burnHash || r.id === activeId) continue
        await refreshBridgeRecord(r)
      }
      setRefreshError(undefined)
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : 'Could not refresh transfers.')
    } finally {
      checking.current = false
    }
  }, [address, activeId])

  useEffect(() => {
    const first = setTimeout(() => void refreshAll(), 0)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAll()
    }, 10_000)
    const onOnline = () => void refreshAll()
    window.addEventListener('online', onOnline)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [refreshAll])

  const complete = useCallback(
    async (record: BridgeRecord) => {
      setClaiming(record.id)
      setClaimError(undefined)
      try {
        await claimMint(record, await getWalletProvider(connector))
      } catch (error) {
        setClaimError({ id: record.id, message: parseBridgeError(error).message })
      } finally {
        setClaiming(undefined)
      }
    },
    [connector],
  )

  /** Re-reads Circle's attestation for one transfer. Read-only: it never approves, burns or mints. */
  const retryAttestation = useCallback(async (record: BridgeRecord) => {
    setRetrying(record.id)
    setClaimError(undefined)
    try {
      await refreshBridgeRecord(record, undefined, true)
    } catch (error) {
      setClaimError({ id: record.id, message: parseBridgeError(error).message })
    } finally {
      setRetrying(undefined)
    }
  }, [])

  /** Adds a past transfer from its burn transaction hash (read-only). */
  const recover = useCallback(
    async (sourceKey: string, hash: string): Promise<{ ok: true; record: BridgeRecord } | { ok: false; message: string }> => {
      if (!address) return { ok: false, message: 'Connect the wallet that sent the burn first.' }
      try {
        const record = await importBurn(address, sourceKey, hash.trim() as Hex)
        return { ok: true, record }
      } catch (error) {
        return { ok: false, message: parseBridgeError(error).message }
      }
    },
    [address],
  )

  return { records, claiming, retrying, claimError, refreshError, refresh: refreshAll, complete, retryAttestation, recover, getChain: getBridgeChain }
}
