import { formatUnits } from 'viem'

/** Token amount with thousands separators and at most `max` decimals (trailing zeros removed). */
export function fmtToken(raw: bigint, decimals: number, max = decimals): string {
  const [whole, frac = ''] = formatUnits(raw, decimals).split('.')
  const trimmed = frac.slice(0, max).replace(/0+$/, '')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${trimmed ? `.${trimmed}` : ''}`
}

/** Exchange rate "1 FROM = x TO" from raw amounts. */
export function rateText(amountIn: bigint, decimalsIn: number, amountOut: bigint, decimalsOut: number): string {
  const inUnits = Number(amountIn) / 10 ** decimalsIn
  const outUnits = Number(amountOut) / 10 ** decimalsOut
  if (!(inUnits > 0)) return '–'
  const rate = outUnits / inUnits
  if (rate >= 100) return rate.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (rate >= 1) return rate.toLocaleString('en-US', { maximumFractionDigits: 4 })
  // Below 1, keep five significant digits so a tiny rate (such as USDC per BTC unit) is not rounded to zero.
  return Number(rate.toPrecision(5)).toLocaleString('en-US', { maximumFractionDigits: 12 })
}

export const pct = (x: number): string => `${(x * 100).toFixed(x < 0.0001 ? 4 : 2)}%`
