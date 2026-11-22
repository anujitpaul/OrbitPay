import type { Address, Hex } from 'viem'

/** A send request that still needs an amount or a recipient. */
export interface PendingSend {
  amountText?: string
  to?: string
}

export interface TimeRange {
  label: string
  /** Inclusive lower bound, unix seconds. */
  fromSec: number
}

export type HelpTopic = 'how' | 'receive' | 'network' | 'fees' | 'safety' | 'history'

export type Intent =
  | { kind: 'balance' }
  | { kind: 'address' }
  | { kind: 'recent'; direction?: 'in' | 'out'; count: number; range?: TimeRange; counterparty?: Address }
  | { kind: 'totals'; direction?: 'in' | 'out'; range?: TimeRange; counterparty?: Address }
  | { kind: 'tx'; hash: Hex }
  | { kind: 'send'; amountText?: string; to?: string; badAddress?: string }
  | { kind: 'help'; topic: HelpTopic }
  | { kind: 'cancel' }
  | { kind: 'greeting' }
  | { kind: 'thanks' }
  | { kind: 'unknown' }

export interface ParseContext {
  /** Current unix time in seconds. */
  now: number
  pending?: PendingSend | null
}

const HASH_RE = /0x[a-f0-9]{64}(?![a-f0-9])/i
const ADDRESS_RE = /0x[a-f0-9]{40}(?![a-f0-9])/i
const LOOSE_HEX_RE = /0x[a-f0-9]{6,}/i

const SEND_VERB = /\b(send|pay|transfer|wire|tip|give|prepare a payment|make a payment|new payment)\b/
const RECEIVED_WORDS = /\b(received|receive|incoming|got|earned|income|deposits?|came in)\b/
const SENT_WORDS = /\b(sent|send|outgoing|paid|spent|spend|payments? out)\b/

function stripIdentifiers(text: string): string {
  return text.replace(HASH_RE, ' ').replace(/0x[a-f0-9]{6,}/gi, ' ')
}

/** Largest range word wins. Returns undefined when the message names no period. */
export function parseRange(text: string, now: number): TimeRange | undefined {
  const t = text.toLowerCase()
  const custom = t.match(/\b(?:last|past|previous)\s+(\d{1,3})\s*(hours?|hrs?|h|days?|d|weeks?|w)\b/)
  if (custom) {
    const n = Number(custom[1])
    const unit = custom[2]
    const seconds = unit.startsWith('h') ? 3_600 : unit.startsWith('w') ? 7 * 86_400 : 86_400
    return { label: `the last ${n} ${unit.startsWith('h') ? 'hour' : unit.startsWith('w') ? 'week' : 'day'}${n === 1 ? '' : 's'}`, fromSec: now - n * seconds }
  }
  if (/\b(today|since midnight)\b/.test(t)) {
    const d = new Date(now * 1000)
    d.setHours(0, 0, 0, 0)
    return { label: 'today', fromSec: Math.floor(d.getTime() / 1000) }
  }
  if (/\b(24 hours|past day|last day|yesterday)\b/.test(t)) return { label: 'the last 24 hours', fromSec: now - 86_400 }
  if (/\b(this week|past week|last week|7 days)\b/.test(t)) return { label: 'the last 7 days', fromSec: now - 7 * 86_400 }
  if (/\b(this month|past month|last month|30 days)\b/.test(t)) return { label: 'the last 30 days', fromSec: now - 30 * 86_400 }
  return undefined
}

/** Amount mentioned in a send request, with commas removed. Ignores counts like "last 5". */
export function extractAmount(text: string): string | undefined {
  const cleaned = stripIdentifiers(text.toLowerCase())
    .replace(/\b(?:last|latest|recent|past|previous)\s+\d+\s*\w*/g, ' ')
    .replace(/\b\d+\s*(?:days?|hours?|hrs?|weeks?|months?|transactions?|payments?|transfers?|times)\b/g, ' ')
  const m = cleaned.match(/(?:^|[^\w.])\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?![\w.])/)
  return m ? m[1].replace(/,/g, '') : undefined
}

function extractCount(t: string): number {
  if (/\b(last|latest|most recent|previous) (transaction|payment|transfer|tx)\b/.test(t)) return 1
  const m = t.match(/\b(?:last|latest|recent|past|previous|show(?: me)?)\s+(\d{1,2})\b(?!\s*(?:days?|hours?|hrs?|weeks?|months?|d\b|h\b))/)
  if (m) return Math.min(10, Math.max(1, Number(m[1])))
  return 5
}

function directionOf(t: string, hasCounterparty: boolean): 'in' | 'out' | undefined {
  const asked = RECEIVED_WORDS.test(t) ? 'in' : SENT_WORDS.test(t) ? 'out' : undefined
  if (asked) return asked
  if (hasCounterparty) {
    if (/\bfrom\b/.test(t)) return 'in'
    if (/\bto\b/.test(t)) return 'out'
  }
  return undefined
}

export function parseIntent(input: string, ctx: ParseContext): Intent {
  const raw = input.trim()
  const t = raw.toLowerCase()
  if (t === '') return { kind: 'unknown' }

  if (/^(cancel|never ?mind|stop|reset|clear|start over|forget it)\b/.test(t)) return { kind: 'cancel' }

  const hash = raw.match(HASH_RE)?.[0] as Hex | undefined
  if (hash) return { kind: 'tx', hash }

  const address = raw.match(ADDRESS_RE)?.[0] as Address | undefined
  const looseHex = raw.match(LOOSE_HEX_RE)?.[0]
  const badAddress = !address && looseHex ? looseHex : undefined
  const amountText = extractAmount(raw)
  const range = parseRange(t, ctx.now)

  // "how do I send money" is a question, not a payment request.
  const isHow = /\b(how (do|can|to|does|should)|what is|what's|explain|why)\b/.test(t) && !address && !amountText

  // Sending always takes priority over lookups when a verb and a target are present.
  if (SEND_VERB.test(t) && !isHow && !/\b(how much|what did|did i|have i|history|recent|total)\b/.test(t)) {
    return { kind: 'send', amountText: amountText ?? ctx.pending?.amountText, to: address ?? ctx.pending?.to, badAddress }
  }

  // Answering a follow-up question ("who should receive it?") with just an address or an amount.
  if (ctx.pending && (address || badAddress || amountText) && !/\b(how much|total|balance|history|recent)\b/.test(t)) {
    return { kind: 'send', amountText: amountText ?? ctx.pending.amountText, to: address ?? ctx.pending.to, badAddress }
  }

  if (/\b(how much|total|sum|in total|overall)\b/.test(t) && (RECEIVED_WORDS.test(t) || SENT_WORDS.test(t) || /\bspent|earned\b/.test(t))) {
    return { kind: 'totals', direction: directionOf(t, Boolean(address)), range, counterparty: address }
  }

  if (/\b(balance|how much (usdc|money|do i have|have i got)|what do i have|my funds|funds available|can i afford)\b/.test(t)) return { kind: 'balance' }

  if (/\b(my (wallet )?address|deposit address|where (do|can|should) i receive|receiving address|show (my )?qr|copy (my )?address)\b/.test(t)) return { kind: 'address' }

  // A bare address means "what have I done with this wallet?".
  if (address && !isHow) {
    return { kind: 'recent', direction: directionOf(t, true), count: extractCount(t), range, counterparty: address }
  }

  if (isHow || /\b(help|what can you do|commands|capabilities|tell me about|fees?|gas|network|chain|safe|safety|secure|trust|approve|approval|contract|scam)\b/.test(t)) {
    if (/\b(fees?|gas|cost|price)\b/.test(t)) return { kind: 'help', topic: 'fees' }
    if (/\b(safe|safety|secure|security|trust|scam|approve|approval|contract|risk)\b/.test(t)) return { kind: 'help', topic: 'safety' }
    if (/\b(network|chain|arc|mainnet)\b/.test(t)) return { kind: 'help', topic: 'network' }
    if (/\b(receive|receiving|get paid|request)\b/.test(t)) return { kind: 'help', topic: 'receive' }
    if (/\b(history|activity|transactions?|missing|older)\b/.test(t)) return { kind: 'help', topic: 'history' }
    return { kind: 'help', topic: 'how' }
  }

  if (/\b(recent|latest|last|history|transactions?|payments?|activity|transfers?|show me|what did i|list)\b/.test(t) || (range && !amountText)) {
    return { kind: 'recent', direction: directionOf(t, false), count: extractCount(t), range }
  }

  if (/^(hi|hello|hey|gm|yo|good (morning|afternoon|evening))\b/.test(t)) return { kind: 'greeting' }
  if (/\b(thanks|thank you|thx|cheers)\b/.test(t)) return { kind: 'thanks' }
  return { kind: 'unknown' }
}
