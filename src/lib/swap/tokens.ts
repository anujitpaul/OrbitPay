import type { Address } from 'viem'

/**
 * Tokens OrbitPay offers to swap. Addresses come from Circle's published Arc Mainnet contract list
 * (docs.arc.io "Contract addresses"); nothing else can be picked, so a look-alike token can never be selected.
 * A token is only usable against another one when a live pool with liquidity exists between them (checked onchain).
 */
export interface SwapToken {
  symbol: string
  name: string
  address: Address
  /** Expected decimals; the app re-reads decimals() from the token and refuses to trade on a mismatch. */
  decimals: number
}

export const SWAP_TOKENS: readonly SwapToken[] = [
  { symbol: 'USDC', name: 'USD Coin', address: '0x3600000000000000000000000000000000000000', decimals: 6 },
  { symbol: 'EURC', name: 'Euro Coin', address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 },
  { symbol: 'cirBTC', name: 'Circle Bitcoin', address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', decimals: 8 },
]

export const tokenBySymbol = (symbol: string): SwapToken | undefined => SWAP_TOKENS.find((t) => t.symbol === symbol)
export const tokenByAddress = (address: string): SwapToken | undefined => SWAP_TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase())
