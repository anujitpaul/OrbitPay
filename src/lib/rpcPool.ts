import { createPublicClient, http } from 'viem'
import { arcMainnet } from '@/config'
import { RpcPool } from './historyScan'
import { settings } from './settings'

// One pool for the app: the configured endpoint first, then the fallbacks. Each client has its own timeout;
// retries and failover are handled by the pool so a slow endpoint never blocks the others.
export const rpcPool = new RpcPool([settings.rpcUrl, ...settings.fallbackRpcUrls], (url) =>
  createPublicClient({ chain: arcMainnet, transport: http(url, { timeout: 10_000, retryCount: 0 }) }),
)
