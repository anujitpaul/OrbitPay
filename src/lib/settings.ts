/**
 * Runtime settings: RPC URL, USDC token address and the OrbitPay contract address.
 * Priority: values saved in this browser (Settings dialog) > VITE_* env vars > defaults.
 * Chain facts (id, default RPC, USDC) come from the generated @/onchain-facts module.
 */

import { getAddress, isAddress, type Address } from 'viem'
import { getUsdc, requireChain } from '@/onchain-facts'

export const ARC_CHAIN_ID = 5042 as const

const arc = requireChain(ARC_CHAIN_ID)
const arcUsdc = getUsdc(ARC_CHAIN_ID)
if (!arcUsdc) throw new Error('USDC is missing from the Arc chain facts')

export const ARC_CHAIN_NAME = arc.name
export const ARC_EXPLORER_BASE = arc.explorerBase
export const ARC_NATIVE_DECIMALS = arc.nativeCurrency.decimals
export const DEFAULT_RPC_URL = arc.rpcUrls[0]
export const DEFAULT_USDC_ADDRESS = getAddress(arcUsdc.address)

const STORAGE_KEY = 'orbitpay:settings:v1'

export interface SettingsOverrides {
  rpcUrl?: string
  usdcAddress?: Address
  orbitPayAddress?: Address
}

export interface ResolvedSettings {
  rpcUrl: string
  usdcAddress: Address
  orbitPayAddress: Address | undefined
  walletConnectProjectId: string | undefined
}

export function cleanUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString().replace(/\/$/, '') : undefined
  } catch {
    return undefined
  }
}

export function cleanAddress(value: unknown): Address | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!isAddress(trimmed, { strict: false })) return undefined
  return getAddress(trimmed.toLowerCase())
}

export function readOverrides(): SettingsOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    return {
      rpcUrl: cleanUrl(record.rpcUrl),
      usdcAddress: cleanAddress(record.usdcAddress),
      orbitPayAddress: cleanAddress(record.orbitPayAddress),
    }
  } catch {
    return {}
  }
}

export function saveOverrides(next: SettingsOverrides): void {
  const cleaned: SettingsOverrides = {}
  if (next.rpcUrl) cleaned.rpcUrl = next.rpcUrl
  if (next.usdcAddress) cleaned.usdcAddress = next.usdcAddress
  if (next.orbitPayAddress) cleaned.orbitPayAddress = next.orbitPayAddress
  if (Object.keys(cleaned).length === 0) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned))
}

function resolve(): ResolvedSettings {
  const saved = readOverrides()
  const env = import.meta.env
  const projectId = typeof env.VITE_WALLETCONNECT_PROJECT_ID === 'string' ? env.VITE_WALLETCONNECT_PROJECT_ID.trim() : ''
  return {
    rpcUrl: saved.rpcUrl ?? cleanUrl(env.VITE_ARC_RPC_URL) ?? DEFAULT_RPC_URL,
    usdcAddress: saved.usdcAddress ?? cleanAddress(env.VITE_USDC_ADDRESS) ?? DEFAULT_USDC_ADDRESS,
    orbitPayAddress: saved.orbitPayAddress ?? cleanAddress(env.VITE_ORBITPAY_ADDRESS),
    walletConnectProjectId: projectId === '' ? undefined : projectId,
  }
}

export const settings: ResolvedSettings = resolve()
