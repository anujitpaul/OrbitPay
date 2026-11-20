import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem'

export interface ParsedError {
  /** True when the user dismissed the wallet prompt: not a failure. */
  rejected: boolean
  message: string
}

const CONTRACT_ERRORS: Record<string, string> = {
  ZeroRecipient: 'The recipient cannot be the zero address.',
  SelfPayment: 'You cannot send USDC to your own wallet.',
  ContractRecipient: 'The recipient cannot be the payment contract or the USDC token contract.',
  ZeroAmount: 'The amount must be greater than zero.',
}

export function parseTxError(error: unknown): ParsedError {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) {
      return { rejected: true, message: 'Request cancelled in your wallet. No funds moved.' }
    }
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName
      if (name && CONTRACT_ERRORS[name]) return { rejected: false, message: CONTRACT_ERRORS[name] }
    }
  }

  const raw = error instanceof Error ? `${error.message} ${(error as { shortMessage?: string }).shortMessage ?? ''}` : String(error)
  const text = raw.toLowerCase()

  if (text.includes('user rejected') || text.includes('user denied') || text.includes('rejected the request')) {
    return { rejected: true, message: 'Request cancelled in your wallet. No funds moved.' }
  }
  if (text.includes('exceeds balance') || text.includes('transfer amount exceeds')) {
    return { rejected: false, message: 'Your USDC balance is too low for this payment.' }
  }
  if (text.includes('allowance')) {
    return { rejected: false, message: 'USDC approval is missing or too low. Try again to approve the amount.' }
  }
  if (text.includes('insufficient funds') || text.includes('gas required exceeds')) {
    return { rejected: false, message: 'Not enough USDC to cover the payment and the network fee.' }
  }
  if (text.includes('blacklist') || text.includes('blocklist') || text.includes('blocked')) {
    return { rejected: false, message: 'USDC rejected this transfer because an address is blocklisted.' }
  }
  if (text.includes('timeout') || text.includes('timed out') || text.includes('network') || text.includes('fetch')) {
    return { rejected: false, message: 'Network issue reaching the Arc RPC. Check your connection and try again.' }
  }
  if (text.includes('reverted')) {
    return { rejected: false, message: 'The transaction was reverted onchain. No payment was made.' }
  }
  return { rejected: false, message: 'Something went wrong. Please try again.' }
}
