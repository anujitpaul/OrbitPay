import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { WaitForTransactionReceiptTimeoutError, parseGwei, type Address, type Hex, type PublicClient } from 'viem'
import { useAccount, useConfig } from 'wagmi'
import { getPublicClient, sendTransaction, signTypedData, waitForTransactionReceipt, writeContract } from 'wagmi/actions'
import { arcMainnet } from '@/config'
import { explainSwapError, receivedFromReceipt } from '@/lib/swap/errors'
import { SWAP_TOKENS, type SwapToken } from '@/lib/swap/tokens'
import {
  DEADLINE_SECONDS, MIN_GAS_PRICE_GWEI, PERMIT2, PERMIT2_DOMAIN, PERMIT2_TYPES, PRICE_IMPACT_BLOCK, assertSlippage, buildSwap, erc20Abi,
  findRoutesMulti, permitNeeded, quoteAll, verifyDeployment, type Quote,
} from '@/lib/swap/uniswap'
import { Amount, gasTokenDecimalsFor, gasTokenToUsdc, usdcDecimalsFor } from '@/onchain-money'

const CHAIN_ID = arcMainnet.id

function useArcClient(): PublicClient {
  const config = useConfig()
  return getPublicClient(config, { chainId: CHAIN_ID })
}

/** The router, Permit2, factories and quoters must all be live before any quote is shown. */
export function useSwapDeployment() {
  const client = useArcClient()
  const q = useQuery({ queryKey: ['swap-deployment'], queryFn: () => verifyDeployment(client), staleTime: 10 * 60_000, retry: 2 })
  return { checking: q.isLoading, problem: q.data ?? undefined, failed: q.isError, retry: () => void q.refetch() }
}

/** ERC-20 balance of every swap token (USDC read through the ERC-20 view, 6 decimals, never the 18-decimal native view). */
export function useSwapBalances() {
  const { address } = useAccount()
  const client = useArcClient()
  const q = useQuery({
    queryKey: ['swap-balances', address],
    enabled: Boolean(address),
    refetchInterval: 15_000,
    staleTime: 8_000,
    queryFn: async () => {
      const res = await client.multicall({
        allowFailure: false,
        batchSize: 1_000_000,
        contracts: SWAP_TOKENS.flatMap((t) => [
          { address: t.address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [address as Address] as const },
          { address: t.address, abi: erc20Abi, functionName: 'decimals' as const },
        ]),
      })
      const rows = SWAP_TOKENS.map((t, i) => [t.symbol, { balance: res[i * 2] as bigint, decimalsOk: res[i * 2 + 1] === t.decimals }] as const)
      return Object.fromEntries(rows)
    },
  })
  return { balances: q.data, loading: q.isLoading, error: q.isError }
}

/** Which token pairs currently have a live pool with liquidity. A token is only offered against partners it can actually trade with. */
export function usePairLiquidity() {
  const client = useArcClient()
  return useQuery({
    queryKey: ['swap-pairs'],
    staleTime: 60_000,
    refetchInterval: 90_000,
    retry: 1,
    queryFn: async () => {
      const out: Record<string, number> = {}
      const pairs: (readonly [SwapToken, SwapToken])[] = []
      for (let i = 0; i < SWAP_TOKENS.length; i++) for (let j = i + 1; j < SWAP_TOKENS.length; j++) pairs.push([SWAP_TOKENS[i], SWAP_TOKENS[j]])
      const found = await findRoutesMulti(client, pairs.map(([a, b]) => [a.address, b.address] as const))
      pairs.forEach(([a, b], i) => {
        out[`${a.symbol}/${b.symbol}`] = found[i].length
        out[`${b.symbol}/${a.symbol}`] = found[i].length
      })
      return out
    },
  })
}

export const QUOTE_REFRESH_MS = 12_000

/** A live quote for an exact-input swap, re-read every few seconds. Never returns a stale or invented number. */
export function useSwapQuote(tokenIn: SwapToken, tokenOut: SwapToken, amountIn: bigint | undefined, enabled: boolean) {
  const client = useArcClient()
  const q = useQuery({
    queryKey: ['swap-quote', tokenIn.address, tokenOut.address, amountIn?.toString()],
    enabled: enabled && amountIn !== undefined && amountIn > 0n,
    refetchInterval: QUOTE_REFRESH_MS,
    staleTime: 5_000,
    retry: 0, // the quote refreshes every few seconds anyway; failing fast shows the Retry message sooner
    queryFn: async (): Promise<Quote[]> => quoteAll(client, tokenIn.address, tokenOut.address, amountIn as bigint),
  })
  return {
    quotes: q.data,
    best: q.data?.[0],
    loading: q.isFetching && !q.data,
    refreshing: q.isFetching,
    noRoute: q.isSuccess && q.data.length === 0,
    error: q.isError ? 'Could not read live prices from Arc. Check your connection and try again.' : undefined,
    updatedAt: q.dataUpdatedAt,
    refetch: () => void q.refetch(),
  }
}

/** Rough network fee in USDC (the gas token) for the whole flow. The exact figure is shown by the wallet; this preview uses measured gas for the approve and the router call. */
export function useSwapFeePreview(needsApprove: boolean) {
  const client = useArcClient()
  const q = useQuery({
    queryKey: ['swap-fee'],
    staleTime: 20_000,
    queryFn: async () => {
      const fees = await client.estimateFeesPerGas()
      const floor = parseGwei(MIN_GAS_PRICE_GWEI.toString())
      return fees.maxFeePerGas > floor ? fees.maxFeePerGas : floor
    },
  })
  if (!q.data) return undefined
  const gas = 215_000n + (needsApprove ? 60_000n : 0n)
  // Gas is priced in the 18-decimal native view; the app's own converter brings it to the 6-decimal USDC view.
  return gasTokenToUsdc(CHAIN_ID, Amount.fromRaw(gas * q.data, gasTokenDecimalsFor(CHAIN_ID))).raw
}

export type SwapPhase = 'idle' | 'checking' | 'approve-wallet' | 'approve-confirming' | 'permit-wallet' | 'swap-wallet' | 'swap-confirming' | 'success' | 'pending' | 'error' | 'cancelled'

export interface SwapState {
  phase: SwapPhase
  tokenIn?: SwapToken
  tokenOut?: SwapToken
  amountIn?: bigint
  quote?: Quote
  minReceived?: bigint
  approveHash?: Hex
  hash?: Hex
  received?: bigint
  message?: string
}

export interface SwapRequest {
  tokenIn: SwapToken
  tokenOut: SwapToken
  amountIn: bigint
  slippageBps: number
  acceptedLoss: boolean
}

const RECEIPT_TIMEOUT_MS = 90_000

/**
 * Runs one swap: fresh quote, exact approval to Permit2, signed permission, simulation, then the router call.
 * Nothing is reported as done until the swap's receipt says success, and the amount shown as received is read from its Transfer events.
 */
export function useSwapExecute() {
  const config = useConfig()
  const { address } = useAccount()
  const queryClient = useQueryClient()
  const [state, setState] = useState<SwapState>({ phase: 'idle' })
  const reset = useCallback(() => setState({ phase: 'idle' }), [])

  const run = useCallback(
    async (req: SwapRequest) => {
      if (!address) return
      const { tokenIn, tokenOut, amountIn, slippageBps } = req
      const client = getPublicClient(config, { chainId: CHAIN_ID }) as PublicClient
      const base = { tokenIn, tokenOut, amountIn }
      let swapHash: Hex | undefined
      setState({ ...base, phase: 'checking' })
      try {
        assertSlippage(slippageBps)
        const problem = await verifyDeployment(client)
        if (problem) throw new Error(problem)
        const balance = await client.readContract({ address: tokenIn.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] })
        if (amountIn > balance) throw new Error(`Your ${tokenIn.symbol} balance is lower than the amount to swap.`)

        // Always re-quote right before sending: the price you saw a few seconds ago is not the price you get.
        const quotes = await quoteAll(client, tokenIn.address, tokenOut.address, amountIn)
        const quote = quotes[0]
        if (!quote) throw new Error('No route at this size. Try a smaller amount.')
        if (quote.priceImpact > PRICE_IMPACT_BLOCK && !req.acceptedLoss) {
          throw new Error(`Price impact is ${(quote.priceImpact * 100).toFixed(2)}%, above the ${PRICE_IMPACT_BLOCK * 100}% limit. Confirm the loss or use a smaller amount.`)
        }
        const fees = await client.estimateFeesPerGas()
        const floor = parseGwei(MIN_GAS_PRICE_GWEI.toString())
        const maxFeePerGas = fees.maxFeePerGas > floor ? fees.maxFeePerGas : floor
        const maxPriorityFeePerGas = fees.maxPriorityFeePerGas

        const allowance = await client.readContract({ address: tokenIn.address, abi: erc20Abi, functionName: 'allowance', args: [address, PERMIT2] })
        if (allowance < amountIn) {
          setState({ ...base, quote, phase: 'approve-wallet' })
          // Token -> Permit2 allowance for exactly this amount, never unlimited.
          const approveHash = await writeContract(config, {
            address: tokenIn.address, abi: erc20Abi, functionName: 'approve', args: [PERMIT2, amountIn], chainId: CHAIN_ID, maxFeePerGas, maxPriorityFeePerGas,
          })
          setState({ ...base, quote, phase: 'approve-confirming', approveHash })
          const approval = await waitForTransactionReceipt(config, { hash: approveHash, chainId: CHAIN_ID, timeout: RECEIPT_TIMEOUT_MS })
          if (approval.status !== 'success') throw new Error('The approval transaction failed. Nothing was swapped.')
        }

        const block = await client.getBlock()
        const now = block.timestamp
        const permit = await permitNeeded(client, address, tokenIn.address, amountIn, now)
        let signature: Hex | undefined
        if (permit) {
          setState((s) => ({ ...s, ...base, quote, phase: 'permit-wallet' }))
          signature = await signTypedData(config, { domain: PERMIT2_DOMAIN, types: PERMIT2_TYPES, primaryType: 'PermitSingle', message: permit })
        }
        const tx = buildSwap(quote, tokenIn.address, tokenOut.address, address, slippageBps, now + DEADLINE_SECONDS, permit && signature ? { permit, signature } : undefined)
        // A revert here is decoded and shown; nothing is sent.
        await client.call({ account: address, to: tx.to, data: tx.data })
        const gas = await client.estimateGas({ account: address, to: tx.to, data: tx.data })
        setState((s) => ({ ...s, ...base, quote, minReceived: tx.limitOut, phase: 'swap-wallet' }))
        swapHash = await sendTransaction(config, { to: tx.to, data: tx.data, value: 0n, gas: (gas * 12n) / 10n, maxFeePerGas, maxPriorityFeePerGas, chainId: CHAIN_ID })
        setState((s) => ({ ...s, ...base, quote, minReceived: tx.limitOut, phase: 'swap-confirming', hash: swapHash }))
        const receipt = await waitForTransactionReceipt(config, { hash: swapHash, chainId: CHAIN_ID, timeout: RECEIPT_TIMEOUT_MS })
        if (receipt.status !== 'success') throw new Error('The swap transaction reverted onchain. No tokens were swapped.')
        const received = receivedFromReceipt(receipt, tokenOut.address, address)
        setState((s) => ({ ...s, ...base, quote, minReceived: tx.limitOut, phase: 'success', hash: swapHash, received }))
        void queryClient.invalidateQueries({ queryKey: ['swap-balances'] })
        void queryClient.invalidateQueries({ queryKey: ['swap-quote'] })
        void queryClient.invalidateQueries({ queryKey: ['usdc-balance'] })
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError && swapHash) {
          setState((s) => ({ ...s, ...base, phase: 'pending', hash: swapHash, message: 'The swap was sent but is not confirmed yet. Check the transaction on Arc Explorer before trying again.' }))
          return
        }
        const { message, rejected } = explainSwapError(error)
        const plain = error instanceof Error && error.message.length < 200 && !(error as { shortMessage?: string }).shortMessage ? error.message : message
        setState((s) => ({ ...s, ...base, phase: rejected ? 'cancelled' : 'error', message: rejected ? message : plain }))
      }
    },
    [address, config, queryClient],
  )

  return { state, run, reset }
}

/** Debounces the typed amount so a quote is not requested on every keystroke. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export const NATIVE_USDC_DECIMALS = usdcDecimalsFor(CHAIN_ID)
