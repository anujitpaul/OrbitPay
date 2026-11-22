import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import { parseIntent, extractAmount, parseRange } from '../src/lib/assistant/parse'
import { respond, type AssistantData } from '../src/lib/assistant/respond'
import type { HistoryTx } from '../src/lib/txStore'

const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const BOB = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const NEW = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address
const USDC = '0x3600000000000000000000000000000000000000' as Address
const ORBIT = '0xB9Fe116564f44C1Ba25614AB13F21487C098C4c9' as Address
const NOW = 1_800_000_000

const row = (i: number, dir: 'in' | 'out', amount: bigint, ageSec: number, who: Address = BOB, status: HistoryTx['status'] = 'confirmed'): HistoryTx => ({
  id: `0x${i.toString(16).padStart(64, '0')}:0`,
  hash: `0x${i.toString(16).padStart(64, '0')}` as Hex,
  from: dir === 'in' ? who : ME,
  to: dir === 'in' ? ME : who,
  amount,
  dust: false,
  status,
  direction: dir,
  blockNumber: BigInt(1000 - i),
  logIndex: 0,
  timestamp: NOW - ageSec,
  source: 'chain',
})

const data = (over: Partial<AssistantData> = {}): AssistantData => ({
  chainId: 5042,
  connected: true,
  address: ME,
  balance: 125_500_000n,
  balanceError: false,
  items: [
    row(1, 'in', 10_000_000n, 600),
    row(2, 'out', 4_000_000n, 3_600),
    row(3, 'in', 25_000_000n, 2 * 86_400),
    row(4, 'out', 1_500_000n, 10 * 86_400),
  ],
  historyLoading: false,
  historyComplete: true,
  now: NOW,
  usdcAddress: USDC,
  orbitPayAddress: ORBIT,
  ...over,
})

const ask = (text: string, d = data(), pending?: Parameters<typeof parseIntent>[1]['pending']) => respond(parseIntent(text, { now: NOW, pending }), d)

describe('parseIntent', () => {
  test('balance questions', () => {
    for (const q of ['What is my balance?', 'how much usdc do i have', 'balance']) expect(parseIntent(q, { now: NOW }).kind).toBe('balance')
  })
  test('send with amount and address', () => {
    const i = parseIntent(`send 12.5 USDC to ${BOB}`, { now: NOW })
    expect(i).toMatchObject({ kind: 'send', amountText: '12.5', to: BOB })
  })
  test('amount formats', () => {
    expect(extractAmount('pay $1,250.50 to bob')).toBe('1250.50')
    expect(extractAmount('send .5 usdc')).toBe('.5')
    expect(extractAmount('show my last 5 payments')).toBeUndefined()
    expect(extractAmount('payments in the last 7 days')).toBeUndefined()
  })
  test('a transaction hash is never read as an address or amount', () => {
    const hash = `0x${'ab'.repeat(32)}`
    expect(parseIntent(`status of ${hash}`, { now: NOW })).toEqual({ kind: 'tx', hash })
  })
  test('how-questions are not payment requests', () => {
    expect(parseIntent('how do I send money?', { now: NOW })).toEqual({ kind: 'help', topic: 'how' })
  })
  test('totals, recents and directions', () => {
    expect(parseIntent('how much did I receive this week', { now: NOW })).toMatchObject({ kind: 'totals', direction: 'in' })
    expect(parseIntent('how much have I sent in total', { now: NOW })).toMatchObject({ kind: 'totals', direction: 'out' })
    expect(parseIntent('show my last 3 payments', { now: NOW })).toMatchObject({ kind: 'recent', count: 3 })
    expect(parseIntent('last transaction', { now: NOW })).toMatchObject({ kind: 'recent', count: 1 })
  })
  test('ranges', () => {
    expect(parseRange('today', NOW)?.label).toBe('today')
    expect(parseRange('last 3 days', NOW)).toMatchObject({ label: 'the last 3 days', fromSec: NOW - 3 * 86_400 })
    expect(parseRange('hello', NOW)).toBeUndefined()
  })
  test('bare address means lookup, cancel clears', () => {
    expect(parseIntent(BOB, { now: NOW })).toMatchObject({ kind: 'recent', counterparty: BOB })
    expect(parseIntent('cancel', { now: NOW }).kind).toBe('cancel')
  })
  test('follow-up answers fill a pending payment', () => {
    expect(parseIntent(BOB, { now: NOW, pending: { amountText: '5' } })).toMatchObject({ kind: 'send', amountText: '5', to: BOB })
    expect(parseIntent('7.5', { now: NOW, pending: { to: BOB } })).toMatchObject({ kind: 'send', amountText: '7.5', to: BOB })
  })
})

describe('respond', () => {
  test('balance shows the live amount; failures offer a retry', () => {
    expect(ask('balance').text).toContain('125.50 USDC')
    const failed = ask('balance', data({ balance: undefined, balanceError: true }))
    expect(failed.actions).toEqual([{ kind: 'retry-balance' }])
  })
  test('every wallet question asks to connect first', () => {
    const r = ask('balance', data({ connected: false, address: undefined }))
    expect(r.actions).toEqual([{ kind: 'connect' }])
  })
  test('totals sum confirmed rows by direction and period', () => {
    expect(ask('how much did I receive today').text).toContain('You received 10.00 USDC')
    expect(ask('how much did I receive this week').text).toContain('You received 35.00 USDC')
    expect(ask('how much did I send this week').text).toContain('You sent 4.00 USDC')
    expect(ask('how much did I receive in total').text).toContain('35.00 USDC')
  })
  test('pending and failed rows are not counted', () => {
    const d = data({ items: [row(1, 'in', 9_000_000n, 60, BOB, 'pending'), row(2, 'in', 3_000_000n, 60, BOB, 'failed'), row(3, 'in', 2_000_000n, 60)] })
    const r = ask('how much did I receive today', d)
    expect(r.text).toContain('2.00 USDC')
    expect(r.text).toContain('1 pending')
  })
  test('recent returns real rows, newest first, capped to the request', () => {
    const r = ask('show my last 2 payments')
    expect(r.txs?.map((t) => t.hash)).toEqual([data().items[0].hash, data().items[1].hash])
  })
  test('incomplete history is disclosed with a way to load more', () => {
    const r = ask('how much did I send in total', data({ historyComplete: false, scannedSince: NOW - 5 * 86_400 }))
    expect(r.text).toContain('Older payments may be missing')
    expect(r.actions).toEqual([{ kind: 'load-older' }])
  })
  test('history errors offer a retry instead of an empty answer', () => {
    const r = ask('show my last payments', data({ items: [], historyError: 'The Arc RPC is rate limiting requests.' }))
    expect(r.actions).toEqual([{ kind: 'retry-history' }])
  })
  test('tx lookup finds known hashes and links the explorer', () => {
    const hash = data().items[0].hash
    const r = ask(`status of ${hash}`)
    expect(r.text).toContain('confirmed onchain')
    expect(r.links?.[0].url).toContain(hash)
    expect(ask(`status of 0x${'cd'.repeat(32)}`).txs).toBeUndefined()
  })
  test('send: complete request is prefilled, never sent', () => {
    const r = ask(`send 25 USDC to ${NEW}`)
    expect(r.prefill).toMatchObject({ to: NEW, amount: 25_000_000n })
    expect(r.prefill?.warnings.join(' ')).toContain("haven't paid this address")
    expect(r.text).toContain('Nothing is sent yet')
    expect(r.pending).toBeNull()
  })
  test('send: known recipient has no first-time warning', () => {
    expect(ask(`pay 3 to ${BOB}`).prefill?.warnings ?? []).toEqual([])
  })
  test('send: warns about more than the balance and more than half', () => {
    expect(ask(`send 500 to ${BOB}`).prefill?.warnings.join(' ')).toContain('more than your balance')
    expect(ask(`send 100 to ${BOB}`).prefill?.warnings.join(' ')).toContain('more than half')
  })
  test('send: asks for the missing piece and remembers the rest', () => {
    const a = ask('send 5 USDC')
    expect(a.prefill).toBeUndefined()
    expect(a.pending).toEqual({ amountText: '5', to: undefined })
    const b = ask(NEW, data(), a.pending)
    expect(b.prefill).toMatchObject({ to: NEW, amount: 5_000_000n })
    const c = ask(`send to ${NEW}`)
    expect(c.pending).toEqual({ to: NEW })
    expect(ask('12.5', data(), c.pending).prefill?.amount).toBe(12_500_000n)
  })
  test('send: refuses unsafe recipients', () => {
    expect(ask(`send 5 to ${ME}`).prefill).toBeUndefined()
    expect(ask(`send 5 to ${USDC}`).prefill).toBeUndefined()
    expect(ask(`send 5 to ${ORBIT}`).prefill).toBeUndefined()
    expect(ask('send 5 to 0x0000000000000000000000000000000000000000').prefill).toBeUndefined()
  })
  test('send: rejects malformed addresses and amounts', () => {
    expect(ask('send 5 to 0x1234567890abcdef').text).toContain('not a valid wallet address')
    expect(ask(`send 1.1234567 to ${BOB}`).prefill).toBeUndefined()
    expect(ask(`send 0 to ${BOB}`).prefill).toBeUndefined()
    // wrong checksum (one letter case flipped)
    const bad = BOB.replace('CdD', 'cdD')
    expect(ask(`send 5 to ${bad}`).prefill).toBeUndefined()
  })
  test('send when disconnected asks to connect and keeps the request', () => {
    const r = ask(`send 5 to ${BOB}`, data({ connected: false, address: undefined }))
    expect(r.actions).toEqual([{ kind: 'connect' }])
    expect(r.pending).toMatchObject({ amountText: '5', to: BOB })
  })
  test('help topics and unknown input give guidance', () => {
    expect(ask('what are the fees?').text).toContain('paid in USDC')
    expect(ask('is it safe?').text).toContain('cannot be reversed')
    expect(ask('asdf qwerty').suggestions?.length).toBeGreaterThan(0)
  })
})
