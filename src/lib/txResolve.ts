import type { Address, Hex, PublicClient } from 'viem'
import { updateStoredTx } from './txStore'

export type ResolvedTx = 'confirmed' | 'failed' | 'unknown'

/**
 * Reads the on-chain receipt for a saved transaction and records the outcome.
 * Returns 'unknown' while no receipt exists yet (still pending, or never included).
 */
export async function resolveStoredTx(client: PublicClient, address: Address, hash: Hex): Promise<ResolvedTx> {
  try {
    const receipt = await client.getTransactionReceipt({ hash })
    if (receipt.status === 'success') {
      updateStoredTx(address, hash, { status: 'confirmed', blockNumber: receipt.blockNumber.toString(), message: undefined })
      return 'confirmed'
    }
    updateStoredTx(address, hash, { status: 'failed', blockNumber: receipt.blockNumber.toString(), message: 'Reverted onchain. No USDC moved.' })
    return 'failed'
  } catch {
    return 'unknown'
  }
}
