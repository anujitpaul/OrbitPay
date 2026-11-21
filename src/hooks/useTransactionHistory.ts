import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { TransactionNotFoundError, createPublicClient, http, type Address, type PublicClient } from 'viem'
import { useAccount, useConfig } from 'wagmi'
import { getPublicClient, waitForTransactionReceipt } from 'wagmi/actions'
import { arcMainnet } from '@/config'
import { RpcPool } from '@/lib/historyScan'
import { emptySnapshot, getHistoryStore, requestHistoryRefresh, type HistorySnapshot } from '@/lib/historyStore'
import { settings } from '@/lib/settings'
import { resolveStoredTx } from '@/lib/txResolve'
import { getStoredTxs, subscribeStore, updateStoredTx, type HistoryTx, type StoredTx } from '@/lib/txStore'
import { usdcDecimalsFor } from '@/onchain-money'

const NATIVE_SCALE = 10n ** BigInt(arcMainnet.nativeCurrency.decimals - usdcDecimalsFor(arcMainnet.id))
const DROPPED_AFTER_MS = 10 * 60_000
// One pool for the app: the configured endpoint first, then the fallbacks. Each client has its own timeout;
// retries and failover are handled by the pool so a slow endpoint never blocks the others.
const rpcPool = new RpcPool([settings.rpcUrl, ...settings.fallbackRpcUrls], (url) =>
  createPublicClient({ chain: arcMainnet, transport: http(url, { timeout: 10_000, retryCount: 0 }) }),
)
const noopSubscribe = () => () => {}

function localToRow(tx: StoredTx, me: Address): HistoryTx {
  const lower = me.toLowerCase()
  const from = tx.from.toLowerCase()
  const to = tx.to.toLowerCase()
  return {
    id: tx.hash,
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    amount: BigInt(tx.amount),
    dust: false,
    status: tx.status,
    direction: from === lower && to === lower ? 'self' : from === lower ? 'out' : 'in',
    blockNumber: tx.blockNumber ? BigInt(tx.blockNumber) : undefined,
    createdAt: tx.createdAt,
    source: 'local',
    message: tx.message,
  }
}

const sortTime = (row: HistoryTx) => (row.timestamp !== undefined ? row.timestamp * 1000 : (row.createdAt ?? 0))

/**
 * Transaction history for the connected wallet: USDC Transfer logs read from Arc (outgoing and incoming,
 * including previous sessions) merged with locally saved submissions that are still pending or failed.
 */
export function useTransactionHistory() {
  const { address, isConnected } = useAccount()
  const config = useConfig()
  const watching = useRef(new Set<string>())

  const getClient = useCallback(() => getPublicClient(config, { chainId: arcMainnet.id }) as PublicClient | undefined, [config])
  const store = useMemo(() => (address ? getHistoryStore(address, settings.usdcAddress, NATIVE_SCALE, rpcPool) : undefined), [address])
  const snapshot: HistorySnapshot = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? (() => emptySnapshot),
  )
  const local = useSyncExternalStore(subscribeStore, () => getStoredTxs(address))

  // Load on connect / account switch, then keep polling while the app is open.
  useEffect(() => store?.retain(), [store])

  // Resolve locally saved pending submissions from their on-chain receipts.
  const checkPending = useCallback(() => {
    if (!address) return
    for (const tx of getStoredTxs(address)) {
      if (tx.status !== 'pending') continue
      const id = tx.hash.toLowerCase()
      if (watching.current.has(id)) continue
      watching.current.add(id)
      void (async () => {
        try {
          const client = getClient()
          if (!client) return
          let outcome = await resolveStoredTx(client, address, tx.hash)
          if (outcome === 'unknown') {
            try {
              await waitForTransactionReceipt(config, { hash: tx.hash, chainId: arcMainnet.id, timeout: 60_000 })
            } catch {
              // No receipt yet, or the wait helper rejected a reverted tx: the direct lookup below decides.
            }
            outcome = await resolveStoredTx(client, address, tx.hash)
          }
          if (outcome === 'confirmed') requestHistoryRefresh(address)
          if (outcome === 'unknown' && Date.now() - tx.createdAt > DROPPED_AFTER_MS) {
            // The node has no receipt and never saw the transaction: it was dropped, not pending.
            try {
              await client.getTransaction({ hash: tx.hash })
            } catch (lookup) {
              if (lookup instanceof TransactionNotFoundError) {
                updateStoredTx(address, tx.hash, { status: 'failed', message: 'Never included in a block (dropped by the network).' })
              }
            }
          }
        } finally {
          watching.current.delete(id)
        }
      })()
    }
  }, [address, config, getClient])

  useEffect(() => {
    checkPending()
    const timer = setInterval(checkPending, 20_000)
    return () => clearInterval(timer)
  }, [checkPending, local])

  const items = useMemo(() => {
    if (!address) return []
    const chainHashes = new Set(snapshot.items.map((i) => i.hash.toLowerCase()))
    // A chain row is the source of truth: drop the local copy once the transfer is indexed.
    const localRows = local.filter((t) => !chainHashes.has(t.hash.toLowerCase())).map((t) => localToRow(t, address))
    return [...snapshot.items, ...localRows].sort((a, b) => {
      const diff = sortTime(b) - sortTime(a)
      if (diff !== 0) return diff
      const blockA = a.blockNumber ?? 0n
      const blockB = b.blockNumber ?? 0n
      if (blockA !== blockB) return blockA > blockB ? -1 : 1
      return (b.logIndex ?? 0) - (a.logIndex ?? 0)
    })
  }, [address, local, snapshot.items])

  return {
    address,
    isConnected,
    items,
    snapshot,
    refresh: useCallback(() => void store?.refresh(true), [store]),
    loadOlder: useCallback(() => void store?.loadOlder(false), [store]),
    scanAll: useCallback(() => void store?.scanAll(), [store]),
    stop: useCallback(() => store?.stop(), [store]),
    ensureTimes: useCallback((ids: string[]) => void store?.ensureTimes(ids), [store]),
  }
}

export type TransactionHistory = ReturnType<typeof useTransactionHistory>
