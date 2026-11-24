import { describe, expect, test } from 'bun:test'
import { BaseError, decodeAbiParameters, decodeFunctionData, encodeErrorResult, hexToBytes, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem'
import receipt from './fixtures/arc-ur-swap-receipt.json'
import { explainSwapError, receivedFromReceipt } from '../src/lib/swap/errors'
import { SWAP_TOKENS, tokenByAddress, tokenBySymbol } from '../src/lib/swap/tokens'
import {
  PERMIT2, SLIPPAGE_MAX_BPS, UNIVERSAL_ROUTER, abi, assertSlippage, buildSwap, midPrice, minOut, priceImpactOf, routeLabel, type PoolKey, type Quote, type Route,
} from '../src/lib/swap/uniswap'
import { fmtToken, rateText } from '../src/lib/swap/format'

const USDC = tokenBySymbol('USDC')!.address
const EURC = tokenBySymbol('EURC')!.address
const OWNER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const Q96 = 2n ** 96n

const v3Route: Route = { version: 'v3', fee: 500, sqrtPriceX96: Q96, feeFraction: 0.0005, liquidity: 1n }
const key: PoolKey = { currency0: USDC, currency1: EURC, fee: 500, tickSpacing: 10, hooks: zeroAddress }
const v4Route: Route = { version: 'v4', key, sqrtPriceX96: Q96, feeFraction: 0.0005, liquidity: 1n }
const quoteOf = (route: Route, amountOut = 9_122_919n): Quote => ({ route, amountIn: 10_000_000n, amountOut, priceImpact: 0 })

describe('token list', () => {
  test('only Circle-published Arc tokens are offered, with their real decimals', () => {
    expect(SWAP_TOKENS.map((t) => t.symbol)).toEqual(['USDC', 'EURC', 'cirBTC'])
    expect(tokenBySymbol('USDC')?.address).toBe('0x3600000000000000000000000000000000000000')
    expect(tokenBySymbol('USDC')?.decimals).toBe(6)
    expect(tokenBySymbol('cirBTC')?.decimals).toBe(8)
    expect(tokenByAddress('0x0000000000000000000000000000000000000000')).toBeUndefined()
    expect(new Set(SWAP_TOKENS.map((t) => t.address.toLowerCase())).size).toBe(SWAP_TOKENS.length)
  })
})

describe('slippage', () => {
  test('is a whole number of basis points from 0 to 1%', () => {
    expect(() => assertSlippage(0)).not.toThrow()
    expect(() => assertSlippage(50)).not.toThrow()
    expect(() => assertSlippage(SLIPPAGE_MAX_BPS)).not.toThrow()
    expect(() => assertSlippage(101)).toThrow()
    expect(() => assertSlippage(-1)).toThrow()
    expect(() => assertSlippage(0.5)).toThrow()
    expect(() => assertSlippage(Number.NaN)).toThrow()
  })
  test('the minimum received is quote × (1 − slippage) and is never zero', () => {
    expect(minOut(1_000_000n, 50)).toBe(995_000n)
    expect(minOut(1_000_000n, 100)).toBe(990_000n)
    expect(minOut(1_000_000n, 0)).toBe(1_000_000n)
    expect(minOut(1n, 100)).toBe(1n)
    expect(() => minOut(1_000_000n, 150)).toThrow()
  })
})

describe('price impact', () => {
  test('the pool fee alone is not reported as impact', () => {
    // 1:1 pool, fee 0.05%: a fill of exactly (1 - fee) is zero impact.
    const out = (10_000_000n * 9995n) / 10_000n
    expect(priceImpactOf(v3Route, USDC, EURC, 10_000_000n, out)).toBeLessThan(1e-9)
  })
  test('a worse fill shows up as impact', () => {
    const impact = priceImpactOf(v3Route, USDC, EURC, 10_000_000n, 9_000_000n)
    expect(impact).toBeGreaterThan(0.09)
    expect(impact).toBeLessThan(0.1)
  })
  test('direction of the mid price follows token ordering', () => {
    const sqrt = Q96 * 2n // price 4 for token1/token0
    const r: Route = { ...v3Route, sqrtPriceX96: sqrt }
    const lo = BigInt(USDC) < BigInt(EURC)
    expect(midPrice(r, USDC, EURC)).toBeCloseTo(lo ? 4 : 0.25, 6)
    expect(midPrice(r, EURC, USDC)).toBeCloseTo(lo ? 0.25 : 4, 6)
  })
})

describe('calldata for the Universal Router 2.1.2', () => {
  const deadline = 1_900_000_000n
  const decode = (data: Hex) => {
    const { functionName, args } = decodeFunctionData({ abi, data })
    expect(functionName).toBe('execute')
    return args as [Hex, Hex[], bigint]
  }

  test('v3 exact-input without a permit: one V3_SWAP_EXACT_IN with the slippage floor, value 0, a deadline', () => {
    const tx = buildSwap(quoteOf(v3Route), USDC, EURC, OWNER, 50, deadline)
    expect(tx.to).toBe(UNIVERSAL_ROUTER)
    expect(tx.value).toBe(0n)
    const [commands, inputs, dl] = decode(tx.data)
    expect([...hexToBytes(commands)]).toEqual([0x00])
    expect(dl).toBe(deadline)
    const [recipient, amountIn, amountOutMin, path, payerIsUser, extra] = decodeAbiParameters(parseAbiParameters('address,uint256,uint256,bytes,bool,uint256[]'), inputs[0])
    expect(recipient).toBe(OWNER)
    expect(amountIn).toBe(10_000_000n)
    expect(amountOutMin).toBe(minOut(9_122_919n, 50))
    expect(amountOutMin).toBeGreaterThan(0n)
    expect(payerIsUser).toBe(true)
    expect(extra).toEqual([])
    expect(path.toLowerCase()).toBe(`0x${USDC.slice(2)}${(500).toString(16).padStart(6, '0')}${EURC.slice(2)}`.toLowerCase())
  })

  test('v4 exact-input carries minHopPriceX36 (router 2.1.x format), settles the input and takes at least the floor', () => {
    const tx = buildSwap(quoteOf(v4Route), USDC, EURC, OWNER, 100, deadline)
    const [commands, inputs] = decode(tx.data)
    expect([...hexToBytes(commands)]).toEqual([0x10])
    const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes,bytes[]'), inputs[0])
    expect([...hexToBytes(actions)]).toEqual([0x06, 0x0c, 0x0f])
    const [swap] = decodeAbiParameters(
      parseAbiParameters('((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)'),
      params[0],
    )
    expect(swap.poolKey.currency0).toBe(USDC)
    expect(swap.poolKey.currency1).toBe(EURC)
    expect(swap.poolKey.fee).toBe(500)
    expect(swap.poolKey.hooks).toBe(zeroAddress)
    expect(swap.zeroForOne).toBe(true)
    expect(swap.amountIn).toBe(10_000_000n)
    expect(swap.amountOutMinimum).toBe(minOut(9_122_919n, 100))
    expect(swap.minHopPriceX36).toBe(0n)
    const [token, settleAmount] = decodeAbiParameters(parseAbiParameters('address,uint256'), params[1])
    expect(token).toBe(USDC)
    expect(settleAmount).toBe(10_000_000n)
    const [takeToken, takeMin] = decodeAbiParameters(parseAbiParameters('address,uint256'), params[2])
    expect(takeToken).toBe(EURC)
    expect(takeMin).toBe(minOut(9_122_919n, 100))
  })

  test('with a Permit2 signature the PERMIT2_PERMIT command comes first and names the router as spender', () => {
    const permit = { details: { token: USDC, amount: 10_000_000n, expiration: 1_900_100_000, nonce: 3 }, spender: UNIVERSAL_ROUTER, sigDeadline: deadline }
    const signature = `0x${'11'.repeat(65)}` as Hex
    const tx = buildSwap(quoteOf(v3Route), USDC, EURC, OWNER, 50, deadline, { permit, signature })
    const [commands, inputs] = decode(tx.data)
    expect([...hexToBytes(commands)]).toEqual([0x0a, 0x00])
    const [p, sig] = decodeAbiParameters(parseAbiParameters('((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline), bytes'), inputs[0])
    expect(p.spender).toBe(UNIVERSAL_ROUTER)
    expect(p.details.token).toBe(USDC)
    expect(p.details.amount).toBe(10_000_000n)
    expect(sig).toBe(signature)
    expect(PERMIT2.toLowerCase()).toBe('0x000000000022d473030f116ddee9f6b43ac78ba3')
  })

  test('refuses an out-of-range slippage when building', () => {
    expect(() => buildSwap(quoteOf(v3Route), USDC, EURC, OWNER, 101, deadline)).toThrow()
  })

  test('route labels name the version and fee tier', () => {
    expect(routeLabel(v3Route)).toBe('Uniswap v3 · 0.05% pool')
    expect(routeLabel({ ...v4Route, key: { ...key, fee: 100 } })).toBe('Uniswap v4 · 0.01% pool')
  })
})

describe('failures are explained in plain words', () => {
  const uniErrors = parseAbi(['error V3TooLittleReceived()', 'error TransactionDeadlinePassed()', 'error ExecutionFailed(uint256 commandIndex, bytes message)', 'error AllowanceExpired(uint256 deadline)'])
  const wrap = (data: Hex) => new BaseError('simulation failed', { cause: Object.assign(new Error('reverted'), { data }) })

  test('slippage refusal', () => {
    const e = explainSwapError(wrap(encodeErrorResult({ abi: uniErrors, errorName: 'V3TooLittleReceived' })))
    expect(e.message).toMatch(/price moved/i)
    expect(e.message).toMatch(/nothing was swapped/i)
    expect(e.rejected).toBe(false)
  })
  test('deadline passed', () => {
    expect(explainSwapError(wrap(encodeErrorResult({ abi: uniErrors, errorName: 'TransactionDeadlinePassed' }))).message).toMatch(/deadline passed/i)
  })
  test('an error nested inside ExecutionFailed is unwrapped', () => {
    const inner = encodeErrorResult({ abi: uniErrors, errorName: 'AllowanceExpired', args: [1n] })
    const outer = encodeErrorResult({ abi: uniErrors, errorName: 'ExecutionFailed', args: [0n, inner] })
    expect(explainSwapError(wrap(outer)).message).toMatch(/permission expired/i)
  })
  test('a wallet rejection is reported as cancelled, not as a failure', () => {
    const e = explainSwapError(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
    expect(e.rejected).toBe(true)
    expect(e.message).toMatch(/cancelled/i)
  })
})

describe('what was received comes from the receipt, not from the quote', () => {
  // A real swap through the Universal Router on Arc Mainnet, fetched from the chain.
  const logs = receipt.logs as never
  const transfers = (receipt.logs as { address: string; topics: string[]; data: string }[]).filter((l) => l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
  test('the fixture is a successful swap sent to the Universal Router', () => {
    expect(receipt.status).toBe('success')
    expect(receipt.to.toLowerCase()).toBe(UNIVERSAL_ROUTER.toLowerCase())
  })
  test('the amount credited to the sender is read from the output token Transfer event', () => {
    const toOwner = transfers.filter((t) => `0x${t.topics[2].slice(26)}`.toLowerCase() === receipt.from.toLowerCase())
    expect(toOwner.length).toBeGreaterThan(0)
    const token = toOwner[0].address as Address
    const expected = toOwner.filter((t) => t.address === token).reduce((s, t) => s + BigInt(t.data), 0n)
    expect(receivedFromReceipt({ logs } as never, token, receipt.from as Address)).toBe(expected)
    expect(expected).toBeGreaterThan(0n)
  })
  test('another wallet, or another token, is credited nothing', () => {
    const token = transfers[0].address as Address
    expect(receivedFromReceipt({ logs } as never, token, OWNER)).toBe(0n)
    expect(receivedFromReceipt({ logs } as never, '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', receipt.from as Address)).toBe(0n)
  })
})

describe('display helpers', () => {
  test('token amounts use the token decimals', () => {
    expect(fmtToken(9_122_919n, 6)).toBe('9.122919')
    expect(fmtToken(1_000_000_000n, 6)).toBe('1,000')
    expect(fmtToken(16_322n, 8)).toBe('0.00016322')
  })
  test('rate text', () => {
    expect(rateText(10_000_000n, 6, 9_122_919n, 6)).toBe('0.91229')
    expect(rateText(10_000_000n, 6, 16_322n, 8)).toBe('0.000016322')
  })
})
