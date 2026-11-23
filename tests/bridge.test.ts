import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import fixture from './fixtures/iris-arc-burn.json'
import { addressToBytes32, bytes32ToAddress, checkAttestedMessage, decodeCctpV2Message, feeFromBps, receivedAmount, type AttestationIntent } from '../src/lib/bridge/cctp'
import { isAttested, type IrisMessage } from '../src/lib/bridge/iris'

// A real Arc Mainnet -> Base burn (0xa4002f41…) and Circle's real attestation for it, captured from the live Iris API.
const iris = fixture.messages[0] as unknown as IrisMessage
const TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as Address
const ARC_USDC = '0x3600000000000000000000000000000000000000' as Address
const intent: AttestationIntent = {
  sourceDomain: 26,
  destinationDomain: 6,
  sourceTokenMessenger: TOKEN_MESSENGER,
  destinationTokenMessenger: TOKEN_MESSENGER,
  burnToken: ARC_USDC,
  mintRecipient: '0x50b4d75c959361c982643d1758e250f43c1b34c6',
  amount: 308_000_000n,
  depositor: '0xd156ffb54871f4562744d6be5d6321b5bffca3b6',
}

describe('decodeCctpV2Message', () => {
  const decoded = decodeCctpV2Message(iris.message)
  test('reads the real message header', () => {
    expect(decoded.version).toBe(1)
    expect(decoded.sourceDomain).toBe(26)
    expect(decoded.destinationDomain).toBe(6)
    expect(decoded.minFinalityThreshold).toBe(2000)
  })
  test('reads the real burn body', () => {
    expect(decoded.body.amount).toBe(308_000_000n)
    expect(bytes32ToAddress(decoded.body.mintRecipient).toLowerCase()).toBe('0x50b4d75c959361c982643d1758e250f43c1b34c6')
    expect(bytes32ToAddress(decoded.body.burnToken)).toBe(ARC_USDC)
    expect(bytes32ToAddress(decoded.body.messageSender).toLowerCase()).toBe('0xd156ffb54871f4562744d6be5d6321b5bffca3b6')
    expect(receivedAmount(decoded)).toBe(308_000_000n - decoded.body.feeExecuted)
  })
  test('Circle marks it complete with a signed attestation', () => {
    expect(isAttested(iris)).toBe(true)
    expect(isAttested({ ...iris, attestation: 'PENDING' })).toBe(false)
    expect(isAttested({ ...iris, status: 'pending_confirmations' })).toBe(false)
    expect(isAttested(undefined)).toBe(false)
  })
  test('rejects truncated or non-hex input', () => {
    expect(() => decodeCctpV2Message('0x1234')).toThrow()
    expect(() => decodeCctpV2Message(iris.message.slice(0, 200) as Hex)).toThrow()
  })
})

describe('checkAttestedMessage', () => {
  const decoded = decodeCctpV2Message(iris.message)
  test('accepts the attestation that matches the request', () => {
    expect(checkAttestedMessage(decoded, intent)).toEqual([])
  })
  test('rejects a different recipient', () => {
    const problems = checkAttestedMessage(decoded, { ...intent, mintRecipient: '0x1111111111111111111111111111111111111111' })
    expect(problems.join(' ')).toContain('mint recipient')
  })
  test('rejects a different amount', () => {
    expect(checkAttestedMessage(decoded, { ...intent, amount: 1_000_000n }).join(' ')).toContain('amount')
  })
  test('rejects the wrong source or destination chain', () => {
    expect(checkAttestedMessage(decoded, { ...intent, sourceDomain: 0 }).join(' ')).toContain('source chain')
    expect(checkAttestedMessage(decoded, { ...intent, destinationDomain: 3 }).join(' ')).toContain('destination chain')
  })
  test('rejects a message not sent by the official TokenMessenger or burning other tokens', () => {
    expect(checkAttestedMessage(decoded, { ...intent, sourceTokenMessenger: '0x2222222222222222222222222222222222222222' }).join(' ')).toContain('TokenMessengerV2')
    expect(checkAttestedMessage(decoded, { ...intent, burnToken: '0x2222222222222222222222222222222222222222' }).join(' ')).toContain('USDC')
  })
  test('rejects a burn that was not made by this wallet', () => {
    expect(checkAttestedMessage(decoded, { ...intent, depositor: '0x3333333333333333333333333333333333333333' }).join(' ')).toContain('not made by your wallet')
  })
  test('rejects a tampered message body', () => {
    const tampered = (iris.message.slice(0, -2) + 'ff') as Hex
    const t = decodeCctpV2Message(tampered)
    expect(t.body.hookData).not.toBe(decoded.body.hookData)
    const bumped = decodeCctpV2Message((iris.message.slice(0, 2 + (148 + 68) * 2) + '00'.repeat(31) + 'ff' + iris.message.slice(2 + (148 + 100) * 2)) as Hex)
    expect(checkAttestedMessage(bumped, intent).join(' ')).toContain('amount')
  })
})

describe('helpers', () => {
  test('address <-> bytes32 round trip', () => {
    const a = '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6' as Address
    expect(bytes32ToAddress(addressToBytes32(a)).toLowerCase()).toBe(a.toLowerCase())
    expect(addressToBytes32(a)).toHaveLength(66)
  })
  test('fast fee in basis points rounds up in integer math', () => {
    expect(feeFromBps(100_000_000n, 0)).toBe(0n)
    expect(feeFromBps(100_000_000n, 1)).toBe(10_000n) // 1 bp of 100 USDC = 0.01 USDC
    expect(feeFromBps(100_000_000n, 0.325)).toBe(3_250n)
    expect(feeFromBps(1n, 1)).toBe(1n)
    expect(feeFromBps(1_000_000n, Number.NaN)).toBe(0n)
    expect(feeFromBps(1_000_000n, -2)).toBe(0n)
  })
})

// ---------- the "Slice starting at offset 228 is out-of-bounds (size: 228)" bug ----------
// A plain burn has NO hook data, so the whole message is exactly 148 + 228 = 376 bytes. The old decoder sliced hookData
// from offset 228 of a 228-byte body and viem threw. This fixture is Circle's real attestation for a real no-hook burn.
import noHook from './fixtures/iris-arc-burn-nohook.json'
import receiptFixture from './fixtures/arc-burn-receipt-logs.json'
import { burnFromReceiptLogs, mintBlockReason } from '../src/lib/bridge/cctp'
import { isRetryableFailure, type BridgeRecord } from '../src/lib/bridge/store'

const noHookMsg = (noHook as unknown as { messages: IrisMessage[] }).messages[0]
const byteLen = (hex: string) => (hex.length - 2) / 2
const USER = '0x0D29B10a4cdCeAe1c2aAA76A459D31b032fb3300' as Address

describe('message length handling (the offset-228 bug)', () => {
  test('the real recovered message is exactly 376 bytes with empty hook data', () => {
    expect(byteLen(noHookMsg.message)).toBe(376)
    const d = decodeCctpV2Message(noHookMsg.message)
    expect(d.body.hookData).toBe('0x')
    expect(d.sourceDomain).toBe(26)
    expect(d.destinationDomain).toBe(6)
    expect(d.body.amount).toBe(10_000n)
    expect(bytes32ToAddress(d.body.mintRecipient).toLowerCase()).toBe(USER.toLowerCase())
    expect(bytes32ToAddress(d.body.messageSender).toLowerCase()).toBe(USER.toLowerCase())
    expect(d.minFinalityThreshold).toBe(1000)
    expect(d.body.feeExecuted).toBe(0n)
  })
  test('hook data after the fixed body is preserved', () => {
    const withHook = (noHookMsg.message + 'cafebabe') as Hex
    expect(decodeCctpV2Message(withHook).body.hookData).toBe('0xcafebabe')
    expect(decodeCctpV2Message((noHookMsg.message + 'ff') as Hex).body.hookData).toBe('0xff') // the old fixture shape: 1 byte
  })
  test('rejects every length below 376 bytes without slicing past the end', () => {
    for (const len of [0, 1, 4, 147, 148, 149, 227 + 148, 375]) {
      const short = ('0x' + noHookMsg.message.slice(2, 2 + len * 2)) as Hex
      expect(() => decodeCctpV2Message(short)).toThrow(/bytes|valid hex/)
    }
  })
  test('rejects odd-length and non-hex input', () => {
    expect(() => decodeCctpV2Message((noHookMsg.message + 'a') as Hex)).toThrow('not valid hex')
    expect(() => decodeCctpV2Message('not hex' as Hex)).toThrow('not valid hex')
    expect(() => decodeCctpV2Message('0x' as Hex)).toThrow()
  })
  test('never throws an out-of-bounds slice error for any length from 0 to 400 bytes', () => {
    for (let len = 0; len <= 400; len++) {
      const hex = ('0x' + noHookMsg.message.slice(2, 2 + len * 2).padEnd(len * 2, '0')) as Hex
      try {
        decodeCctpV2Message(hex)
      } catch (error) {
        expect(String(error)).not.toMatch(/Slice starting|out-of-bounds/)
      }
    }
  })
})

describe('real attestation for the recovered transfer', () => {
  const decoded = decodeCctpV2Message(noHookMsg.message)
  const intent: AttestationIntent = {
    sourceDomain: 26,
    destinationDomain: 6,
    sourceTokenMessenger: TOKEN_MESSENGER,
    destinationTokenMessenger: TOKEN_MESSENGER,
    burnToken: ARC_USDC,
    mintRecipient: USER,
    amount: 10_000n,
    depositor: USER,
  }
  test('Circle reports it complete and the message matches the wallet request', () => {
    expect(isAttested(noHookMsg)).toBe(true)
    expect(checkAttestedMessage(decoded, intent)).toEqual([])
  })
  test('is rejected for another wallet, amount or chain', () => {
    expect(checkAttestedMessage(decoded, { ...intent, mintRecipient: '0x1111111111111111111111111111111111111111' }).join(' ')).toContain('mint recipient')
    expect(checkAttestedMessage(decoded, { ...intent, amount: 20_000n }).join(' ')).toContain('amount')
    expect(checkAttestedMessage(decoded, { ...intent, destinationDomain: 3 }).join(' ')).toContain('destination chain')
    expect(checkAttestedMessage(decoded, { ...intent, depositor: '0x3333333333333333333333333333333333333333' }).join(' ')).toContain('not made by your wallet')
  })
  test('an attestation that is not complete is never usable', () => {
    expect(isAttested({ ...noHookMsg, status: 'pending_confirmations' })).toBe(false)
    expect(isAttested({ ...noHookMsg, attestation: 'PENDING' })).toBe(false)
    expect(isAttested({ ...noHookMsg, attestation: '0x' as Hex })).toBe(false)
  })
})

describe('recovery from the burn transaction', () => {
  test('reads the burn from the official TokenMessengerV2 event, not from user input', () => {
    const burn = burnFromReceiptLogs(receiptFixture.logs as never, TOKEN_MESSENGER)
    expect(burn.amount).toBe(10_000n)
    expect(burn.destinationDomain).toBe(6)
    expect(burn.depositor.toLowerCase()).toBe(USER.toLowerCase())
    expect(burn.mintRecipient.toLowerCase()).toBe(USER.toLowerCase())
    expect(burn.burnToken.toLowerCase()).toBe(ARC_USDC.toLowerCase())
    expect(burn.minFinalityThreshold).toBe(1000)
    expect(burn.hookData).toBe('0x')
  })
  test('ignores look-alike contracts and transactions without a burn', () => {
    expect(() => burnFromReceiptLogs(receiptFixture.logs as never, '0x2222222222222222222222222222222222222222')).toThrow('no CCTP V2 burn')
    expect(() => burnFromReceiptLogs([], TOKEN_MESSENGER)).toThrow('no CCTP V2 burn')
  })
  test('burn event agrees with Circle’s attested message', () => {
    const burn = burnFromReceiptLogs(receiptFixture.logs as never, TOKEN_MESSENGER)
    const d = decodeCctpV2Message(noHookMsg.message)
    expect(d.body.amount).toBe(burn.amount)
    expect(d.destinationDomain).toBe(burn.destinationDomain)
    expect(bytes32ToAddress(d.body.mintRecipient).toLowerCase()).toBe(burn.mintRecipient.toLowerCase())
  })
})

describe('duplicate mint prevention and retry rules', () => {
  test('a consumed nonce blocks the mint before the wallet is asked', () => {
    expect(mintBlockReason('attested', 1n)).toContain('already minted')
    expect(mintBlockReason('pending', 5n)).toContain('already minted')
  })
  test('a completed transfer cannot be minted again', () => {
    expect(mintBlockReason('completed', 0n)).toContain('already marked completed')
  })
  test('an unused nonce on an attested transfer is mintable', () => {
    expect(mintBlockReason('attested', 0n)).toBeUndefined()
  })
  const rec = (status: BridgeRecord['status'], error?: string, burnHash = '0x' + 'ab'.repeat(32)): BridgeRecord => ({
    id: 'x', account: USER, source: 'Arc', destination: 'Base', amount: '10000', recipient: USER, speed: 'FAST', forwarder: false,
    status, detail: '', burnHash: burnHash as Hex, error, createdAt: 0, updatedAt: 0,
  })
  test('read errors are retried automatically, real mismatches are not', () => {
    expect(isRetryableFailure(rec('failed', 'Slice starting at offset 228 is out-of-bounds (size: 228).'))).toBe(true)
    expect(isRetryableFailure(rec('failed', 'The request timed out.'))).toBe(true)
    expect(isRetryableFailure(rec('failed', 'mint recipient differs from the address you entered.'))).toBe(false)
    expect(isRetryableFailure(rec('completed', 'timeout'))).toBe(false)
    expect(isRetryableFailure(rec('failed', 'Slice starting at offset 228 is out-of-bounds', undefined as never))).toBe(true)
  })
})

// ---------- Circle Forwarding Service + upfront fees (real Circle fixtures) ----------
import fwdFixture from './fixtures/iris-arc-forwarded.json'
import fwdReceipt from './fixtures/arc-forwarded-receipt.json'
import quoteArcBase from './fixtures/quote-arc-base-forward.json'
import quoteBaseArc from './fixtures/quote-base-arc-fast.json'
import { FORWARD_HOOK_DATA, isForwardHook } from '../src/lib/bridge/cctp'
import { parseQuote, QuoteUnavailableError } from '../src/lib/bridge/iris'

const WITH_FEES = '0x71f54F818671cD0D7ea140Da213e5C8b5C92a408' as Address
const fwdMsg = (fwdFixture as unknown as { messages: IrisMessage[] }).messages[0]

describe('forwarding hook data', () => {
  test('the documented static hook is the 32-byte cctp-forward header', () => {
    expect(byteLen(FORWARD_HOOK_DATA)).toBe(32)
    expect(Buffer.from(FORWARD_HOOK_DATA.slice(2, 26), 'hex').toString()).toBe('cctp-forward')
    expect(isForwardHook(FORWARD_HOOK_DATA)).toBe(true)
  })
  test('rejects hook data without the header, with another name or an unknown version', () => {
    expect(isForwardHook('0x')).toBe(false)
    expect(isForwardHook('0x00' as Hex)).toBe(false)
    expect(isForwardHook(('0x' + '00'.repeat(32)) as Hex)).toBe(false)
    expect(isForwardHook(FORWARD_HOOK_DATA.replace('636374702d', '636374702e') as Hex)).toBe(false)
    expect(isForwardHook((FORWARD_HOOK_DATA.slice(0, 50) + '00000009' + FORWARD_HOOK_DATA.slice(58)) as Hex)).toBe(false) // version 9
  })
})

describe('a real Arc → Base transfer forwarded by Circle with upfront fees', () => {
  const d = decodeCctpV2Message(fwdMsg.message)
  const mintRecipient = bytes32ToAddress(d.body.mintRecipient)
  const user = fwdReceipt.from as Address
  const intent: AttestationIntent = {
    sourceDomain: 26, destinationDomain: 6,
    sourceTokenMessenger: TOKEN_MESSENGER, destinationTokenMessenger: TOKEN_MESSENGER,
    burnToken: ARC_USDC, mintRecipient, amount: d.body.amount, depositor: user,
    forwarded: true, messengerWithFees: WITH_FEES,
  }
  test('Circle reports it complete and forwarded with a destination mint hash', () => {
    expect(isAttested(fwdMsg)).toBe(true)
    expect(fwdMsg.forwardState).toBe('COMPLETE')
    expect(fwdMsg.forwardTxHash).toMatch(/^0x[0-9a-f]{64}$/)
  })
  test('the burn message carries the forward hook, no fee deducted, sent by TokenMessengerWithFees', () => {
    expect(isForwardHook(d.body.hookData)).toBe(true)
    expect(d.body.feeExecuted).toBe(0n)
    expect(bytes32ToAddress(d.body.messageSender).toLowerCase()).toBe(WITH_FEES.toLowerCase())
    expect(d.destinationCaller).toBe(ZERO_BYTES32_TEST)
  })
  test('is accepted as a forwarded transfer, and refused as a plain one', () => {
    expect(checkAttestedMessage(d, intent)).toEqual([])
    expect(checkAttestedMessage(d, { ...intent, messengerWithFees: undefined }).join(' ')).toContain('not made by your wallet')
    expect(checkAttestedMessage(d, { ...intent, forwarded: false }).join(' ')).toContain('not made by your wallet')
  })
  test('a forwarded transfer whose message does not request forwarding is rejected', () => {
    const plain = decodeCctpV2Message(noHookMsg.message)
    const problems = checkAttestedMessage(plain, { ...intent, sourceDomain: 26, destinationDomain: 6, mintRecipient: USER, amount: 10_000n, depositor: USER })
    expect(problems.join(' ')).toContain('Forwarding Service')
  })
  test('recovery reads the forwarded burn from the receipt: depositor is TokenMessengerWithFees, forward hook, zero destination caller', () => {
    const burn = burnFromReceiptLogs(fwdReceipt.logs as never, TOKEN_MESSENGER)
    expect(burn.depositor.toLowerCase()).toBe(WITH_FEES.toLowerCase())
    expect(isForwardHook(burn.hookData)).toBe(true)
    expect(burn.destinationDomain).toBe(6)
    expect(burn.amount).toBe(d.body.amount)
    expect(burn.mintRecipient.toLowerCase()).toBe(mintRecipient.toLowerCase())
  })
})
const ZERO_BYTES32_TEST = ('0x' + '00'.repeat(32)) as Hex

describe('Circle upfront fee quotes (real Quote API responses)', () => {
  test('Arc → Base: a FORWARD fee paid in Arc USDC, bound to the documented TokenMessengerWithFees', () => {
    const q = parseQuote(quoteArcBase as unknown as Record<string, unknown>, 10_000_000n)
    expect(q.messenger.toLowerCase()).toBe(WITH_FEES.toLowerCase())
    expect(q.feeToken.toLowerCase()).toBe(ARC_USDC.toLowerCase())
    expect(q.items.map((i) => i.type)).toEqual(['FORWARD'])
    expect(q.feeTotal).toBe(q.items[0].amount)
    expect(q.feeTotal > 0n && q.feeTotal < 1_000_000n).toBe(true)
    expect(q.signedQuote.length).toBeGreaterThan(200)
    expect(q.expiresAt).toBeGreaterThan(q.issuedAt)
  })
  test('Base → Arc: forwarding plus Fast Transfer (pre-finality) fees add up', () => {
    const q = parseQuote(quoteBaseArc as unknown as Record<string, unknown>, 10_000_000n)
    expect(q.items.map((i) => i.type).sort()).toEqual(['FORWARD', 'PRE_FINALITY'])
    expect(q.items.reduce((a, i) => a + i.amount, 0n)).toBe(q.feeTotal)
  })
  test('a quote for another amount, with a broken signature or inconsistent fees is refused', () => {
    const base = quoteArcBase as unknown as Record<string, unknown>
    expect(() => parseQuote(base, 9_000_000n)).toThrow('burn amount')
    expect(() => parseQuote({ ...base, signedQuote: '0xzz' }, 10_000_000n)).toThrow('signature')
    expect(() => parseQuote({ ...base, feeTotalAmount: '1' }, 10_000_000n)).toThrow('do not add up')
    expect(() => parseQuote({ ...base, expiry: {} }, 10_000_000n)).toThrow('expiry')
    expect(() => parseQuote({ ...base, items: [] }, 10_000_000n)).toThrow()
  })
  test('QuoteUnavailableError carries Circle’s error code (used to detect sources without Fast Transfer)', () => {
    const e = new QuoteUnavailableError('USDC pre-finality fee is unavailable for this route', 'PRE_FINALITY_UNAVAILABLE')
    expect(e.errorCode).toBe('PRE_FINALITY_UNAVAILABLE')
    expect(e).toBeInstanceOf(Error)
  })
})
