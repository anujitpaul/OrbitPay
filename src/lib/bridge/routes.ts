import { defineChain, getAddress, type Address, type Chain } from 'viem'
import * as circleChains from '@circle-fin/bridge-kit/chains'

export interface BridgeChain {
  /** Bridge Kit chain identifier, for example "Arc" or "Base". */
  key: string
  title: string
  chainId: number
  /** CCTP domain id from Circle's supported chains list. */
  domain: number
  usdc: Address
  tokenMessenger: Address
  messageTransmitter: Address
  rpcUrls: string[]
  explorerTxTemplate: string
  nativeSymbol: string
  /** Circle's Forwarding Service can submit the destination mint for transfers into this chain. */
  forwarderDestination: boolean
  viem: Chain
}

export const ARC_KEY = 'Arc'
export const ARC_CHAIN_ID = 5042
export const ARC_DOMAIN = 26
export const ARC_USDC: Address = '0x3600000000000000000000000000000000000000'

interface RawChain {
  type?: string
  chain?: string
  title?: string
  name?: string
  chainId?: number
  isTestnet?: boolean
  explorerUrl?: string
  rpcEndpoints?: string[]
  usdcAddress?: string | null
  nativeCurrency?: { name: string; symbol: string; decimals: number }
  cctp?: {
    domain?: number
    contracts?: { v2?: { type?: string; tokenMessenger?: string; messageTransmitter?: string } }
    forwarderSupported?: { source?: boolean; destination?: boolean }
  } | null
}

function toBridgeChain(raw: RawChain): BridgeChain | undefined {
  const v2 = raw.cctp?.contracts?.v2
  if (
    raw.type !== 'evm' ||
    raw.isTestnet ||
    !raw.chain ||
    raw.chainId === undefined ||
    raw.cctp?.domain === undefined ||
    v2?.type !== 'split' ||
    !v2.tokenMessenger ||
    !v2.messageTransmitter ||
    !raw.usdcAddress ||
    !raw.rpcEndpoints?.length ||
    !raw.explorerUrl?.includes('{hash}') ||
    !raw.nativeCurrency
  ) {
    return undefined
  }
  const explorerBase = raw.explorerUrl.split('/tx/')[0]
  const title = raw.title ?? raw.name ?? raw.chain
  return {
    key: raw.chain,
    title,
    chainId: raw.chainId,
    domain: raw.cctp.domain,
    usdc: getAddress(raw.usdcAddress),
    tokenMessenger: getAddress(v2.tokenMessenger),
    messageTransmitter: getAddress(v2.messageTransmitter),
    rpcUrls: raw.rpcEndpoints,
    explorerTxTemplate: raw.explorerUrl,
    nativeSymbol: raw.nativeCurrency.symbol,
    forwarderDestination: Boolean(raw.cctp.forwarderSupported?.destination),
    viem: defineChain({
      id: raw.chainId,
      name: title,
      nativeCurrency: raw.nativeCurrency,
      rpcUrls: { default: { http: raw.rpcEndpoints } },
      blockExplorers: { default: { name: 'Explorer', url: explorerBase } },
    }),
  }
}

let cached: BridgeChain[] | undefined

/**
 * Every EVM mainnet that Circle lists for CCTP V2, read from Circle's published chain definitions
 * (shipped in @circle-fin/bridge-kit/chains) (domain ids, TokenMessengerV2, MessageTransmitterV2, USDC). Nothing is hardcoded here.
 */
export function listBridgeChains(): BridgeChain[] {
  if (!cached) {
    cached = (Object.values(circleChains) as unknown[])
      .filter((v): v is RawChain => typeof v === 'object' && v !== null && 'cctp' in v)
      .map(toBridgeChain)
      .filter((c): c is BridgeChain => c !== undefined)
      .sort((a, b) => (a.key === ARC_KEY ? -1 : b.key === ARC_KEY ? 1 : a.title.localeCompare(b.title)))
  }
  return cached
}

export function getBridgeChain(key: string): BridgeChain | undefined {
  return listBridgeChains().find((c) => c.key === key)
}

export function explorerTxUrl(chain: BridgeChain, hash: string): string {
  return chain.explorerTxTemplate.replace('{hash}', hash)
}

/** Sanity check on the registry data before it is trusted for a transfer. */
export function registryProblems(arc: BridgeChain | undefined): string[] {
  const problems: string[] = []
  if (!arc) return ['Arc Mainnet is missing from Circle’s CCTP chain list.']
  if (arc.chainId !== ARC_CHAIN_ID) problems.push(`Arc chain ID is ${arc.chainId}, expected ${ARC_CHAIN_ID}.`)
  if (arc.domain !== ARC_DOMAIN) problems.push(`Arc CCTP domain is ${arc.domain}, expected ${ARC_DOMAIN}.`)
  if (arc.usdc.toLowerCase() !== ARC_USDC) problems.push('Arc USDC address does not match the official USDC.')
  return problems
}

/**
 * TokenMessengerWithFees on every mainnet source chain (Circle docs, "Contract addresses" > TokenMessengerWithFees).
 * Circle's Quote API reports the contract each quote is bound to; the app requires both to agree before it signs anything.
 */
export const TOKEN_MESSENGER_WITH_FEES: Address = '0x71f54F818671cD0D7ea140Da213e5C8b5C92a408'
