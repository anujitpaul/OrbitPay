import { erc20Abi } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { arcMainnet } from '@/config'
import { settings } from '@/lib/settings'

/** Live USDC balance (ERC-20 view, 6 decimals), read from Arc regardless of the wallet's current network. */
export function useUsdcBalance() {
  const { address } = useAccount()
  const query = useReadContract({
    address: settings.usdcAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arcMainnet.id,
    query: { enabled: Boolean(address), refetchInterval: 15_000, staleTime: 10_000 },
  })
  return {
    balance: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: query.refetch,
  }
}
