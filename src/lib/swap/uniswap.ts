import {
  BaseError, ContractFunctionRevertedError, encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, keccak256,
  parseAbi, parseAbiParameters, toHex, zeroAddress, type Address, type Hex, type PublicClient,
} from 'viem'

/**
 * Uniswap on Arc Mainnet (chain 5042), called directly through the Universal Router 2.1.2. These are the only
 * contracts the app will ever call for a swap; every address is the one published for Arc, and `verifyDeployment`
 * re-checks that each one is live before a quote is shown.
 */
export const ARC_CHAIN_ID = 5042
export const UNIVERSAL_ROUTER: Address = '0x8702463e73f74d0b6765aBceb314Ef07aCb92650'
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const V3_FACTORY: Address = '0xf0db7b58379503491d857dB50AC9ece64c653918'
export const V3_QUOTER: Address = '0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468'
export const V4_QUOTER: Address = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94'
export const V4_STATE_VIEW: Address = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b'
export const V4_POOL_MANAGER: Address = '0x8366a39CC670B4001A1121B8F6A443A643e40951'

const V3_FEES = [100, 500, 3000, 10000] as const
const V4_KEYS = [[100, 1], [500, 10], [3000, 60], [10000, 200]] as const

export const PRICE_IMPACT_WARN = 0.01
export const PRICE_IMPACT_BLOCK = 0.05
export const SLIPPAGE_DEFAULT_BPS = 50
export const SLIPPAGE_WARN_BPS = 50
export const SLIPPAGE_MAX_BPS = 100
export const DEADLINE_SECONDS = 1200n
/** Arc's base fee never drops below this; a lower maxFeePerGas is rejected or silently dropped. */
export const MIN_GAS_PRICE_GWEI = 20n

export const abi = parseAbi([
  'function getPool(address,address,uint24) view returns (address)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'function poolManager() view returns (address)',
])
const v4QuoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) returns (uint256 amountOut, uint256 gasEstimate)',
])

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export type Route =
  | { version: 'v3'; fee: number; sqrtPriceX96: bigint; feeFraction: number; liquidity: bigint }
  | { version: 'v4'; key: PoolKey; sqrtPriceX96: bigint; feeFraction: number; liquidity: bigint }
export type Quote = { route: Route; amountIn: bigint; amountOut: bigint; priceImpact: number }

export const routeLabel = (route: Route): string => `Uniswap ${route.version} · ${((route.version === 'v3' ? route.fee : route.key.fee) / 10_000).toFixed(2)}% pool`

const isRevert = (error: unknown) => error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError) !== null

const poolId = (k: PoolKey): Hex =>
  keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]))

/** Every contract the swap touches must have code, and the v4 quoter must point at the real PoolManager. */
/** Returns null when every contract answers as expected, otherwise the reason swapping is disabled. (null, not undefined: react-query forbids undefined results.) */
export async function verifyDeployment(client: PublicClient): Promise<string | null> {
  // One multicall asks every contract a role question only the real deployment can answer, so a missing or wrong address fails loudly.
  const roles = parseAbi([
    'function poolManager() view returns (address)',
    'function owner() view returns (address)',
    'function factory() view returns (address)',
    'function DOMAIN_SEPARATOR() view returns (bytes32)',
  ])
  const [router, quoter4, stateView, factory, quoter3, permit2, manager] = await client.multicall({
    allowFailure: true,
    batchSize: 1_000_000,
    contracts: [
      { address: UNIVERSAL_ROUTER, abi: roles, functionName: 'poolManager' },
      { address: V4_QUOTER, abi: roles, functionName: 'poolManager' },
      { address: V4_STATE_VIEW, abi: roles, functionName: 'poolManager' },
      { address: V3_FACTORY, abi: roles, functionName: 'owner' },
      { address: V3_QUOTER, abi: roles, functionName: 'factory' },
      { address: PERMIT2, abi: roles, functionName: 'DOMAIN_SEPARATOR' },
      { address: V4_POOL_MANAGER, abi: roles, functionName: 'owner' },
    ],
  })
  const isManager = (r: { status: string; result?: unknown }) => r.status === 'success' && String(r.result).toLowerCase() === V4_POOL_MANAGER.toLowerCase()
  const problems: string[] = []
  if (!isManager(router)) problems.push('Universal Router')
  if (!isManager(quoter4)) problems.push('v4 quoter')
  if (!isManager(stateView)) problems.push('v4 state view')
  if (factory.status !== 'success') problems.push('v3 factory')
  if (quoter3.status !== 'success' || String(quoter3.result).toLowerCase() !== V3_FACTORY.toLowerCase()) problems.push('v3 quoter')
  if (permit2.status !== 'success') problems.push('Permit2')
  if (manager.status !== 'success') problems.push('v4 pool manager')
  if (problems.length) return `Swap is disabled: ${problems.join(', ')} did not answer as the expected Uniswap contract on Arc. OrbitPay will not route through an unverified address.`
  return null
}

const MULTICALL = { allowFailure: true, batchSize: 1_000_000 } as const

/**
 * Live pools for each pair on v3 and v4, read with two multicalls in total (not dozens of separate requests, which a public RPC rate-limits).
 * Pools that were never initialised, or hold no liquidity, are skipped.
 */
export async function findRoutesMulti(client: PublicClient, pairs: readonly (readonly [Address, Address])[]): Promise<Route[][]> {
  const keys = pairs.map(([a, b]) => {
    const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]
    return V4_KEYS.map(([fee, tickSpacing]): PoolKey => ({ currency0: c0, currency1: c1, fee, tickSpacing, hooks: zeroAddress }))
  })
  const first = await client.multicall({
    ...MULTICALL,
    contracts: [
      ...pairs.flatMap(([a, b]) => V3_FEES.map((fee) => ({ address: V3_FACTORY, abi, functionName: 'getPool' as const, args: [a, b, fee] as const }))),
      ...keys.flatMap((ks) => ks.flatMap((k) => [
        { address: V4_STATE_VIEW, abi, functionName: 'getLiquidity' as const, args: [poolId(k)] as const },
        { address: V4_STATE_VIEW, abi, functionName: 'getSlot0' as const, args: [poolId(k)] as const },
      ])),
    ],
  })
  const v3Count = pairs.length * V3_FEES.length
  const pools = first.slice(0, v3Count).map((r) => (r.status === 'success' ? (r.result as Address) : zeroAddress))
  const live = pools.map((pool, i) => [pool, i] as const).filter(([pool]) => pool !== zeroAddress)
  const second = live.length
    ? await client.multicall({
        ...MULTICALL,
        contracts: live.flatMap(([pool]) => [
          { address: pool, abi, functionName: 'liquidity' as const },
          { address: pool, abi, functionName: 'slot0' as const },
        ]),
      })
    : []
  return pairs.map(([tokenIn], p) => {
    const routes: Route[] = []
    V3_FEES.forEach((fee, f) => {
      const at = live.findIndex(([, i]) => i === p * V3_FEES.length + f)
      if (at < 0) return
      const liquidity = second[at * 2]
      const slot0 = second[at * 2 + 1]
      if (liquidity.status !== 'success' || slot0.status !== 'success') return
      const L = liquidity.result as unknown as bigint
      const sqrt = (slot0.result as unknown as readonly [bigint])[0]
      if (L === 0n || sqrt === 0n) return
      routes.push({ version: 'v3', fee, sqrtPriceX96: sqrt, feeFraction: fee / 1e6, liquidity: L })
    })
    keys[p].forEach((key, k) => {
      const base = v3Count + (p * V4_KEYS.length + k) * 2
      const liquidity = first[base]
      const slot0 = first[base + 1]
      if (liquidity.status !== 'success' || slot0.status !== 'success') return
      const L = liquidity.result as unknown as bigint
      const [sqrt, , protocolFee, lpFee] = slot0.result as unknown as readonly [bigint, number, number, number]
      if (L === 0n || sqrt === 0n) return
      const zeroForOne = tokenIn === key.currency0
      const protocolPips = zeroForOne ? protocolFee & 0xfff : protocolFee >> 12
      const totalPips = protocolPips + lpFee - (protocolPips * lpFee) / 1_000_000
      routes.push({ version: 'v4', key, sqrtPriceX96: sqrt, feeFraction: totalPips / 1e6, liquidity: L })
    })
    return routes
  })
}

export async function findRoutes(client: PublicClient, tokenIn: Address, tokenOut: Address): Promise<Route[]> {
  return (await findRoutesMulti(client, [[tokenIn, tokenOut]]))[0]
}

/** Fee-free price of tokenIn in tokenOut base units, from the pool's sqrt price. */
export function midPrice(route: Route, tokenIn: Address, tokenOut: Address): number {
  const p = (Number(route.sqrtPriceX96) / 2 ** 96) ** 2
  return BigInt(tokenIn) < BigInt(tokenOut) ? p : 1 / p
}

/** Price impact is measured against the fee-free mid price after removing the pool fee, so the fee is never shown as impact. */
export function priceImpactOf(route: Route, tokenIn: Address, tokenOut: Address, amountIn: bigint, amountOut: bigint): number {
  const fair = Number(amountIn) * midPrice(route, tokenIn, tokenOut) * (1 - route.feeFraction)
  if (!(fair > 0)) return 1
  return Math.max(0, 1 - Number(amountOut) / fair)
}

async function quoteRoute(client: PublicClient, route: Route, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
  if (route.version === 'v3') {
    const { result } = await client.simulateContract({
      address: V3_QUOTER, abi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee: route.fee, sqrtPriceLimitX96: 0n }],
    })
    return result[0]
  }
  const { result } = await client.simulateContract({
    address: V4_QUOTER, abi: v4QuoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: route.key, zeroForOne: tokenIn === route.key.currency0, exactAmount: amountIn, hookData: '0x' }],
  })
  return result[0]
}

/** Quotes every live pool for an exact-input swap and returns them best first. A pool that cannot fill the size is dropped; RPC errors are rethrown. */
export async function quoteAll(client: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote[]> {
  const routes = await findRoutes(client, tokenIn, tokenOut)
  const quoted = await Promise.all(routes.map(async (route): Promise<Quote | null> => {
    const amountOut = await quoteRoute(client, route, tokenIn, tokenOut, amountIn).catch((error: unknown) => {
      if (isRevert(error)) return null
      throw error
    })
    if (amountOut === null || amountOut === 0n) return null
    return { route, amountIn, amountOut, priceImpact: priceImpactOf(route, tokenIn, tokenOut, amountIn, amountOut) }
  }))
  const quotes = quoted.filter((q): q is Quote => q !== null)
  quotes.sort((a, b) => (a.amountOut === b.amountOut ? 0 : a.amountOut > b.amountOut ? -1 : 1))
  return quotes
}

export function assertSlippage(slippageBps: number) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > SLIPPAGE_MAX_BPS) {
    throw new Error(`Slippage must be a whole number of basis points from 0 to ${SLIPPAGE_MAX_BPS} (${SLIPPAGE_MAX_BPS / 100}%), got ${slippageBps}`)
  }
}

/** The least the wallet will accept. A bound of 0 is never allowed: a swap with no floor can be sandwiched for the whole amount. */
export const minOut = (amountOut: bigint, slippageBps: number): bigint => {
  assertSlippage(slippageBps)
  const bound = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n
  return bound > 0n ? bound : 1n
}

export type PermitSingle = { details: { token: Address; amount: bigint; expiration: number; nonce: number }; spender: Address; sigDeadline: bigint }

export const PERMIT2_TYPES = {
  PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
} as const
export const PERMIT2_DOMAIN = { name: 'Permit2', chainId: ARC_CHAIN_ID, verifyingContract: PERMIT2 } as const

/** The Permit2 → router grant to sign, or null when an existing one already covers the amount. */
export async function permitNeeded(client: PublicClient, owner: Address, token: Address, amount: bigint, now: bigint): Promise<PermitSingle | null> {
  const [allowed, expiration, nonce] = await client.readContract({ address: PERMIT2, abi, functionName: 'allowance', args: [owner, token, UNIVERSAL_ROUTER] })
  if (allowed >= amount && BigInt(expiration) > now + 60n) return null
  return { details: { token, amount, expiration: Number(now + 30n * 86_400n), nonce: Number(nonce) }, spender: UNIVERSAL_ROUTER, sigDeadline: now + 1_800n }
}

const POOL_KEY = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
const CMD = { V3_SWAP_EXACT_IN: 0x00, PERMIT2_PERMIT: 0x0a, V4_SWAP: 0x10 } as const
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const

/** Encodes `execute(commands, inputs, deadline)` for an exact-input swap with value 0 and a floor on the output. */
export function buildSwap(
  q: Quote, tokenIn: Address, tokenOut: Address, recipient: Address, slippageBps: number, deadline: bigint,
  permit?: { permit: PermitSingle; signature: Hex },
) {
  assertSlippage(slippageBps)
  const commands: number[] = []
  const inputs: Hex[] = []
  if (permit) {
    commands.push(CMD.PERMIT2_PERMIT)
    inputs.push(encodeAbiParameters(
      parseAbiParameters('((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline), bytes'),
      [permit.permit, permit.signature],
    ))
  }
  const limitOut = minOut(q.amountOut, slippageBps)
  if (q.route.version === 'v3') {
    const path = encodePacked(['address', 'uint24', 'address'], [tokenIn, q.route.fee, tokenOut])
    commands.push(CMD.V3_SWAP_EXACT_IN)
    inputs.push(encodeAbiParameters(parseAbiParameters('address,uint256,uint256,bytes,bool,uint256[]'), [recipient, q.amountIn, limitOut, path, true, []]))
  } else {
    const zeroForOne = tokenIn === q.route.key.currency0
    const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL])
    const swap = encodeAbiParameters(
      parseAbiParameters(`(${POOL_KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`),
      [{ poolKey: q.route.key, zeroForOne, amountIn: q.amountIn, amountOutMinimum: limitOut, minHopPriceX36: 0n, hookData: '0x' }],
    )
    const settle = encodeAbiParameters(parseAbiParameters('address,uint256'), [tokenIn, q.amountIn])
    const take = encodeAbiParameters(parseAbiParameters('address,uint256'), [tokenOut, limitOut])
    commands.push(CMD.V4_SWAP)
    inputs.push(encodeAbiParameters(parseAbiParameters('bytes,bytes[]'), [actions, [swap, settle, take]]))
  }
  const data = encodeFunctionData({ abi, functionName: 'execute', args: [toHex(new Uint8Array(commands)), inputs, deadline] })
  return { to: UNIVERSAL_ROUTER, data, value: 0n, limitOut }
}

export { erc20Abi }
