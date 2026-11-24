import { useQuery } from '@tanstack/react-query'
import { parseGwei, type PublicClient } from 'viem'
import { useConfig } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { arcMainnet } from '@/config'
import { ARC_CHAIN_ID } from '@/lib/settings'
import { Amount, gasTokenDecimalsFor, gasTokenToUsdc } from '@/onchain-money'

const FEE_FLOOR = parseGwei('20') // Arc never prices gas below 20 gwei

/** What `gas` units cost right now, in 6-decimal USDC base units (Arc pays gas in USDC). Undefined while loading or on an RPC error. */
export function useNetworkFee(gas: bigint): bigint | undefined {
  const config = useConfig()
  const q = useQuery({
    queryKey: ['network-fee-price'],
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async () => {
      const client = getPublicClient(config, { chainId: arcMainnet.id }) as PublicClient
      const fees = await client.estimateFeesPerGas()
      return fees.maxFeePerGas > FEE_FLOOR ? fees.maxFeePerGas : FEE_FLOOR
    },
  })
  if (q.data === undefined) return undefined
  return gasTokenToUsdc(ARC_CHAIN_ID, Amount.fromRaw(gas * q.data, gasTokenDecimalsFor(ARC_CHAIN_ID))).raw
}

/** "≈ 0.0024 USDC", or "< 0.0001 USDC" for a negligible fee. */
export function formatFee(raw: bigint): string {
  if (raw < 100n) return '< 0.0001 USDC'
  const whole = raw / 1_000_000n
  const frac = (raw % 1_000_000n).toString().padStart(6, '0').slice(0, 4)
  return `≈ ${whole}.${frac} USDC`
}
