import { useQuery } from '@tanstack/react-query'
import { type Address, type Hex } from 'viem'
import { useAccount, useConfig } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { arcMainnet } from '@/config'
import { transferEvent } from '@/lib/abi'
import { settings } from '@/lib/settings'

export interface ReceivedPayment {
  txHash: Hex
  logIndex: number
  blockNumber: bigint
  from: Address
  amount: bigint
}

export interface ReceivedPayments {
  payments: ReceivedPayment[]
  scannedBlocks: bigint
  headBlock: bigint
}

// Widest window first; falls back to narrower ones if the RPC rejects a large getLogs range.
const LOOKBACKS = [200_000n, 50_000n, 10_000n, 2_000n]
const MAX_ITEMS = 10

/**
 * Recent USDC Transfer events addressed to the connected wallet.
 * Covers direct transfers and payments made through OrbitPay, over a bounded recent window.
 */
export function useReceivedPayments() {
  const { address } = useAccount()
  const config = useConfig()

  return useQuery<ReceivedPayments>({
    queryKey: ['received-usdc', address, settings.usdcAddress],
    enabled: Boolean(address),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async () => {
      const client = getPublicClient(config, { chainId: arcMainnet.id })
      if (!client || !address) throw new Error('RPC client unavailable')
      const head = await client.getBlockNumber()
      let lastError: unknown
      for (const lookback of LOOKBACKS) {
        const fromBlock = head > lookback ? head - lookback : 0n
        try {
          const logs = await client.getLogs({
            address: settings.usdcAddress,
            event: transferEvent,
            args: { to: address },
            fromBlock,
            toBlock: head,
          })
          const payments = logs
            .filter((log) => log.transactionHash !== null && log.logIndex !== null && log.blockNumber !== null)
            .map((log) => ({
              txHash: log.transactionHash,
              logIndex: log.logIndex,
              blockNumber: log.blockNumber,
              from: log.args.from as Address,
              amount: log.args.value as bigint,
            }))
            .filter((p) => p.amount > 0n)
            .sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1))
            .slice(0, MAX_ITEMS)
          return { payments, scannedBlocks: head - fromBlock, headBlock: head }
        } catch (error) {
          lastError = error
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Could not load payment history')
    },
  })
}
