import { formatUsdc } from '@/onchain-money'

export function shortAddress(address: string, head = 6, tail = 4): string {
  return `${address.slice(0, head)}…${address.slice(-tail)}`
}

/** Formats a raw 6-decimal USDC amount for display with thousands separators and 2 to 6 decimals. */
export function displayUsdc(raw: bigint): string {
  const exact = formatUsdc(raw)
  const [whole, frac = ''] = exact.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const trimmed = frac.replace(/0+$/, '')
  const decimals = trimmed.length < 2 ? trimmed.padEnd(2, '0') : trimmed
  return `${grouped}.${decimals}`
}
