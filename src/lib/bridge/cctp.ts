import { decodeEventLog, getAddress, hexToBigInt, hexToNumber, isAddress, isHex, pad, parseAbiItem, size, slice, type Address, type Hex } from 'viem'

/** CCTP V2 message and burn-message layouts (see Circle's CCTP V2 contract interfaces). */
const MESSAGE_HEADER_BYTES = 148
const BURN_BODY_FIXED_BYTES = 228
export const CCTP_V2_MESSAGE_VERSION = 1

export interface DecodedBurnBody {
  version: number
  burnToken: Hex
  mintRecipient: Hex
  amount: bigint
  messageSender: Hex
  maxFee: bigint
  feeExecuted: bigint
  expirationBlock: bigint
  hookData: Hex
}

export interface DecodedCctpMessage {
  version: number
  sourceDomain: number
  destinationDomain: number
  nonce: Hex
  sender: Hex
  recipient: Hex
  destinationCaller: Hex
  minFinalityThreshold: number
  finalityThresholdExecuted: number
  body: DecodedBurnBody
}

/**
 * Splits a CCTP V2 burn message. Layout: 148-byte header, then a burn body of 228 fixed bytes
 * followed by OPTIONAL hookData. A plain burn has no hook, so the whole message is exactly
 * 148 + 228 = 376 bytes and hookData is empty. Slicing past the end (the original bug) must never happen.
 */
export function decodeCctpV2Message(message: Hex): DecodedCctpMessage {
  if (!isHex(message) || message.length % 2 !== 0) throw new Error('The attestation message is not valid hex.')
  const total = size(message)
  if (total < MESSAGE_HEADER_BYTES + BURN_BODY_FIXED_BYTES) {
    throw new Error(`The attestation message is ${total} bytes; a CCTP V2 burn message is at least ${MESSAGE_HEADER_BYTES + BURN_BODY_FIXED_BYTES}.`)
  }
  const body = slice(message, MESSAGE_HEADER_BYTES, total)
  const hookData: Hex = size(body) > BURN_BODY_FIXED_BYTES ? slice(body, BURN_BODY_FIXED_BYTES, size(body)) : '0x'
  return {
    version: hexToNumber(slice(message, 0, 4)),
    sourceDomain: hexToNumber(slice(message, 4, 8)),
    destinationDomain: hexToNumber(slice(message, 8, 12)),
    nonce: slice(message, 12, 44),
    sender: slice(message, 44, 76),
    recipient: slice(message, 76, 108),
    destinationCaller: slice(message, 108, 140),
    minFinalityThreshold: hexToNumber(slice(message, 140, 144)),
    finalityThresholdExecuted: hexToNumber(slice(message, 144, 148)),
    body: {
      version: hexToNumber(slice(body, 0, 4)),
      burnToken: slice(body, 4, 36),
      mintRecipient: slice(body, 36, 68),
      amount: hexToBigInt(slice(body, 68, 100)),
      messageSender: slice(body, 100, 132),
      maxFee: hexToBigInt(slice(body, 132, 164)),
      feeExecuted: hexToBigInt(slice(body, 164, 196)),
      expirationBlock: hexToBigInt(slice(body, 196, 228)),
      hookData,
    },
  }
}

/** Circle's Forwarding Service hook: magic "cctp-forward" (padded to 24 bytes), version 0, no extra data. */
export const FORWARD_HOOK_DATA: Hex = '0x636374702d666f72776172640000000000000000000000000000000000000000'
const FORWARD_MAGIC: Hex = '0x636374702d666f7277617264' // "cctp-forward"

/** True when hook data starts with the Forwarding Service header (version 0 or 1). */
export function isForwardHook(hookData: Hex): boolean {
  if (size(hookData) < 32 || !hookData.toLowerCase().startsWith(FORWARD_MAGIC)) return false
  const version = hexToNumber(slice(hookData, 24, 28))
  return version === 0 || version === 1
}

export const ZERO_BYTES32: Hex = `0x${'0'.repeat(64)}`

export function addressToBytes32(address: Address): Hex {
  return pad(address.toLowerCase() as Hex, { size: 32 })
}

export function bytes32ToAddress(value: Hex): Address {
  return getAddress(slice(value, 12, 32))
}

/** What the user asked for, taken from the burn the wallet signed. */
export interface AttestationIntent {
  sourceDomain: number
  destinationDomain: number
  sourceTokenMessenger: Address
  destinationTokenMessenger: Address
  burnToken: Address
  mintRecipient: Address
  /** Amount burned, in USDC base units (6 decimals). */
  amount: bigint
  depositor: Address
  /** Circle's Forwarding Service mints this transfer: the hook must request it and the burner may be TokenMessengerWithFees. */
  forwarded?: boolean
  /** Official TokenMessengerWithFees on the source chain. Burns made through it report it as the message sender. */
  messengerWithFees?: Address
}

/**
 * Compares an attested message with the transfer the user actually requested.
 * Returns the list of problems; an empty list means the message matches the request.
 * The signature itself is checked onchain by the destination MessageTransmitter.
 */
export function checkAttestedMessage(decoded: DecodedCctpMessage, intent: AttestationIntent): string[] {
  const problems: string[] = []
  const eq = (a: Hex, b: Address) => a.toLowerCase() === addressToBytes32(b)
  if (decoded.version !== CCTP_V2_MESSAGE_VERSION) problems.push(`Unexpected CCTP message version ${decoded.version}.`)
  if (decoded.sourceDomain !== intent.sourceDomain) problems.push('The message was burned on a different source chain than requested.')
  if (decoded.destinationDomain !== intent.destinationDomain) problems.push('The message targets a different destination chain than requested.')
  if (!eq(decoded.sender, intent.sourceTokenMessenger)) problems.push('The message was not sent by the official source TokenMessengerV2.')
  if (!eq(decoded.recipient, intent.destinationTokenMessenger)) problems.push('The message is not addressed to the official destination TokenMessengerV2.')
  if (!eq(decoded.body.burnToken, intent.burnToken)) problems.push('The burned token is not the official USDC of the source chain.')
  if (!eq(decoded.body.mintRecipient, intent.mintRecipient)) problems.push('The mint recipient differs from the address you entered.')
  if (decoded.body.amount !== intent.amount) problems.push('The burned amount differs from the amount you entered.')
  const senderOk = eq(decoded.body.messageSender, intent.depositor) || (Boolean(intent.forwarded) && Boolean(intent.messengerWithFees) && eq(decoded.body.messageSender, intent.messengerWithFees as Address))
  if (!senderOk) problems.push('The burn was not made by your wallet.')
  if (intent.forwarded && !isForwardHook(decoded.body.hookData)) problems.push('The message does not request Circle’s Forwarding Service.')
  if (decoded.destinationCaller !== ZERO_BYTES32 && !eq(decoded.destinationCaller, intent.depositor) && !eq(decoded.destinationCaller, intent.mintRecipient)) {
    problems.push('Only a third-party contract is allowed to submit this mint.')
  }
  if (decoded.body.feeExecuted > decoded.body.amount) problems.push('The message fee exceeds the burned amount.')
  return problems
}

/** USDC the recipient receives: the burned amount minus the fee taken by CCTP. */
export function receivedAmount(decoded: DecodedCctpMessage): bigint {
  return decoded.body.amount - decoded.body.feeExecuted
}

/**
 * Fast-transfer fee for display. Circle quotes fees in basis points (decimals allowed), rounded up to the next base unit.
 * Everything is integer math: the bps value is scaled by 1000 first.
 */
export function feeFromBps(amount: bigint, bps: number): bigint {
  if (!Number.isFinite(bps) || bps <= 0) return 0n
  const scaled = BigInt(Math.round(bps * 1000))
  const denominator = 10_000_000n
  return (amount * scaled + denominator - 1n) / denominator
}

/**
 * maxFee for depositForBurn. Fast transfers need it to cover Circle's fee at burn time, so a small margin is added;
 * if the fee ends up higher, Circle simply attests at finality instead. Always below the burned amount.
 */
export function maxFeeFor(amount: bigint, bps: number): bigint {
  const fee = feeFromBps(amount, bps)
  if (fee === 0n) return 0n
  const withMargin = fee + fee / 5n + 1n
  return withMargin >= amount ? amount - 1n : withMargin
}

export const FAST_FINALITY_THRESHOLD = 1000
export const STANDARD_FINALITY_THRESHOLD = 2000

export function isEvmAddress(value: string): value is Address {
  return isAddress(value, { strict: true })
}

const depositForBurnEvent = parseAbiItem(
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
)

export interface BurnFromReceipt {
  burnToken: Address
  amount: bigint
  depositor: Address
  mintRecipient: Address
  destinationDomain: number
  destinationCaller: Hex
  maxFee: bigint
  minFinalityThreshold: number
  hookData: Hex
}

/**
 * Reads the DepositForBurn event that the official TokenMessengerV2 emitted in a burn transaction.
 * Only logs from `tokenMessenger` count, so a look-alike contract cannot be imported.
 */
export function burnFromReceiptLogs(logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[], tokenMessenger: Address): BurnFromReceipt {
  const own = logs.filter((l) => l.address.toLowerCase() === tokenMessenger.toLowerCase())
  const found: BurnFromReceipt[] = []
  for (const log of own) {
    try {
      const { eventName, args } = decodeEventLog({ abi: [depositForBurnEvent], data: log.data, topics: log.topics as [Hex, ...Hex[]] })
      if (eventName !== 'DepositForBurn') continue
      const recipientBytes = args.mintRecipient
      if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(recipientBytes)) throw new Error('The mint recipient is not an EVM address.')
      found.push({
        burnToken: getAddress(args.burnToken),
        amount: args.amount,
        depositor: getAddress(args.depositor),
        mintRecipient: bytes32ToAddress(recipientBytes),
        destinationDomain: args.destinationDomain,
        destinationCaller: args.destinationCaller,
        maxFee: args.maxFee,
        minFinalityThreshold: args.minFinalityThreshold,
        hookData: args.hookData,
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('mint recipient')) throw error
    }
  }
  if (found.length !== 1) throw new Error(found.length === 0 ? 'This transaction has no CCTP V2 burn from the official TokenMessengerV2.' : 'This transaction contains several burns, which is not supported.')
  return found[0]
}

/**
 * Duplicate-mint guard. A CCTP message can be received once: MessageTransmitterV2.usedNonces(nonce) is non-zero after that.
 * Returns the reason a mint must NOT be submitted, or undefined when it is safe to ask the wallet.
 */
export function mintBlockReason(status: string, usedNonce: bigint): string | undefined {
  if (usedNonce !== 0n) return 'This transfer was already minted. Its status has been refreshed.'
  if (status === 'completed') return 'This transfer is already marked completed.'
  return undefined
}
