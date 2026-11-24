import { BaseError, decodeErrorResult, erc20Abi, parseAbi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem'
import { parseTxError } from '@/lib/errors'

const UNISWAP_ERRORS = parseAbi([
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error TransactionDeadlinePassed()',
  'error SliceOutOfBounds()',
  'error V3TooLittleReceived()',
  'error V3TooMuchRequested()',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
])

const MEANING: Record<string, string> = {
  TransactionDeadlinePassed: 'The swap took too long and its deadline passed. Nothing was swapped. Get a new quote and try again.',
  V3TooLittleReceived: 'The price moved against you by more than your slippage setting, so the swap was refused. Nothing was swapped. Get a new quote.',
  V4TooLittleReceived: 'The price moved against you by more than your slippage setting, so the swap was refused. Nothing was swapped. Get a new quote.',
  V3TooMuchRequested: 'The swap would have cost more than your limit, so it was refused.',
  V4TooMuchRequested: 'The swap would have cost more than your limit, so it was refused.',
  AllowanceExpired: 'The spending permission expired. Start the swap again to sign a new one.',
  InsufficientAllowance: 'The spending permission is too small. Start the swap again to sign a new one.',
  SliceOutOfBounds: 'The swap was built in a format the router does not accept. Nothing was sent.',
}

/** Explains a failed swap simulation or transaction in plain words. Returns the wallet-rejection wording for a cancelled signature. */
export function explainSwapError(error: unknown): { message: string; rejected: boolean } {
  const parsed = parseTxError(error)
  if (parsed.rejected) return { message: 'You cancelled in your wallet. Nothing was sent.', rejected: true }
  if (error instanceof BaseError) {
    let revert: Hex | undefined
    error.walk((e) => {
      const data = (e as { data?: unknown }).data
      if (!revert && typeof data === 'string' && data.startsWith('0x') && data.length >= 10) revert = data as Hex
      return false
    })
    if (revert) {
      try {
        let decoded = decodeErrorResult({ abi: UNISWAP_ERRORS, data: revert })
        if (decoded.errorName === 'ExecutionFailed') {
          const inner = decodeErrorResult({ abi: UNISWAP_ERRORS, data: decoded.args[1] })
          decoded = inner
        }
        const text = MEANING[decoded.errorName]
        if (text) return { message: text, rejected: false }
      } catch {
        // not one of ours: fall through
      }
    }
    const text = `${error.shortMessage} ${error.details ?? ''}`.toLowerCase()
    if (text.includes('transfer_from_failed') || text.includes('transfer amount exceeds') || text.includes('insufficient allowance')) {
      return { message: 'The token approval or your balance is too low for this swap. Nothing was swapped.', rejected: false }
    }
    if (text.includes('underpriced')) return { message: 'The network fee was below Arc’s minimum. Try again.', rejected: false }
  }
  return { message: parsed.message, rejected: false }
}

/** What the wallet really received: the sum of the output token's Transfer events to the owner in this receipt. */
export function receivedFromReceipt(receipt: Pick<TransactionReceipt, 'logs'>, token: Address, owner: Address): bigint {
  const events = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs.filter((l) => l.address.toLowerCase() === token.toLowerCase()) })
  return events.filter((e) => e.args.to.toLowerCase() === owner.toLowerCase()).reduce((sum, e) => sum + e.args.value, 0n)
}
