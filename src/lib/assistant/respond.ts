import { isAddress, type Address } from 'viem'
import { displayUsdc, shortAddress } from '@/lib/format'
import type { HistoryTx } from '@/lib/txStore'
import { buildAddressExplorerUrl, buildTxExplorerUrl } from '@/onchain-facts'
import { parseUsdc } from '@/onchain-money'
import type { HelpTopic, Intent, PendingSend, TimeRange } from './parse'

export type AssistantTab = 'send' | 'receive' | 'history'

export type ReplyAction =
  | { kind: 'connect' }
  | { kind: 'retry-balance' }
  | { kind: 'retry-history' }
  | { kind: 'load-older' }
  | { kind: 'open-tab'; tab: AssistantTab; label: string }
  | { kind: 'copy'; value: string; label: string }

export interface Prefill {
  to: Address
  amount: bigint
  warnings: string[]
}

export interface Reply {
  text: string
  txs?: HistoryTx[]
  prefill?: Prefill
  actions?: ReplyAction[]
  links?: { label: string; url: string }[]
  /** `null` clears a half-finished payment request, `undefined` leaves it as is. */
  pending?: PendingSend | null
  suggestions?: string[]
}

export interface AssistantData {
  chainId: number
  connected: boolean
  address?: Address
  /** Live USDC balance in 6-decimal base units. */
  balance?: bigint
  balanceError: boolean
  /** Newest first, as shown on the History tab. */
  items: HistoryTx[]
  historyLoading: boolean
  historyError?: string
  historyComplete: boolean
  /** Unix seconds of the oldest scanned block, when known. */
  scannedSince?: number
  now: number
  usdcAddress: Address
  orbitPayAddress?: Address
}

const DEFAULT_SUGGESTIONS = ['What is my balance?', 'Show my last 5 payments', 'How much did I receive this week?', 'Send 5 USDC to 0x…']

const HELP: Record<HelpTopic, (d: AssistantData) => string> = {
  how: () =>
    'I can read your USDC balance, summarize your payments, look up a transaction, and prepare a payment for you to review. Try "What is my balance?", "Show my last 5 payments", "How much did I send this week?", "Status of 0x… (a transaction hash)" or "Send 25 USDC to 0x…". I never sign or send anything myself: you always review the payment and confirm in your wallet.',
  receive: () =>
    'Open the Receive tab to copy your wallet address or show a QR code. Anyone can send USDC on Arc Mainnet to that address, and the payment appears in your History after it confirms. Ask me "What is my address?" and I will show it here.',
  network: () =>
    'OrbitPay runs on Arc Mainnet (chain ID 5042). USDC is the native gas token on Arc, so one USDC balance pays both for payments and for network fees. If your wallet is on another network, a banner offers a one-tap switch.',
  fees: (d) =>
    d.orbitPayAddress
      ? 'Network fees on Arc are paid in USDC, so keep a little USDC beyond the amount you send. Payments go through your OrbitPay contract: the first time you send a given amount, your wallet asks for two confirmations, an approval for exactly that amount and then the payment.'
      : 'Network fees on Arc are paid in USDC, so keep a little USDC beyond the amount you send. Without an OrbitPay contract set, payments are plain USDC transfers with a single wallet confirmation.',
  safety: () =>
    'Payments on mainnet use real USDC and cannot be reversed. I never send anything: I only fill in the Send form, and you check the recipient and amount, then confirm in your wallet. Always compare the full recipient address, and be careful with addresses you have not paid before. Approvals are limited to the exact amount you send, never unlimited.',
  history: () =>
    'History reads USDC transfers straight from Arc Mainnet. The public RPC limits how far back each request can look, so older transfers load in steps: open History and press Load older or Scan full history. My totals only cover the history that has been loaded so far.',
}

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function historyNote(d: AssistantData): string {
  if (d.historyError && d.items.length > 0) return 'The latest refresh from Arc failed, so the newest payments may be missing. Try again in a moment.'
  if (d.historyComplete) return ''
  if (d.historyLoading && d.items.length === 0) return 'History is still loading, so this may be incomplete.'
  const since = d.scannedSince ? ` back to ${formatDate(d.scannedSince)}` : ''
  return `This only covers the history loaded so far${since}. Older payments may be missing.`
}

interface Filter {
  direction?: 'in' | 'out'
  range?: TimeRange
  counterparty?: Address
}

function applyFilter(items: HistoryTx[], f: Filter, d: AssistantData): { rows: HistoryTx[]; undated: number } {
  let undated = 0
  const rows = items.filter((tx) => {
    if (f.direction && tx.direction !== f.direction) return false
    if (f.counterparty) {
      const c = f.counterparty.toLowerCase()
      if (tx.from.toLowerCase() !== c && tx.to.toLowerCase() !== c) return false
    }
    if (f.range) {
      const when = tx.timestamp ?? (tx.createdAt !== undefined ? Math.floor(tx.createdAt / 1000) : undefined)
      if (when === undefined) {
        undated++
        return false
      }
      if (when < f.range.fromSec || when > d.now + 300) return false
    }
    return true
  })
  return { rows, undated }
}

function describeFilter(f: Filter, kind: 'payments' | 'transfers' = 'payments'): string {
  const dir = f.direction === 'in' ? 'received ' : f.direction === 'out' ? 'sent ' : ''
  const who = f.counterparty ? ` ${f.direction === 'in' ? 'from' : f.direction === 'out' ? 'to' : 'with'} ${shortAddress(f.counterparty)}` : ''
  const when = f.range ? ` in ${f.range.label}` : ''
  return `${dir}${kind}${who}${when}`
}

function needsWallet(d: AssistantData, then?: Reply['pending']): Reply | undefined {
  if (d.connected && d.address) return undefined
  return {
    text: 'Connect your wallet first so I can look at your USDC on Arc Mainnet.',
    actions: [{ kind: 'connect' }],
    ...(then ? { pending: then } : {}),
  }
}

function historyProblem(d: AssistantData): Reply | undefined {
  if (d.historyError && d.items.length === 0) {
    return {
      text: `I couldn't read your payment history from Arc right now. ${d.historyError}`,
      actions: [{ kind: 'retry-history' }],
    }
  }
  return undefined
}

function respondSend(intent: Extract<Intent, { kind: 'send' }>, d: AssistantData): Reply {
  const pendingBase: PendingSend = { amountText: intent.amountText, to: intent.to }
  const gate = needsWallet(d, pendingBase)
  if (gate) return gate

  if (intent.badAddress) {
    return {
      text: `"${shortAddress(intent.badAddress, 10, 6)}" is not a valid wallet address. An address starts with 0x and has 42 characters in total. Paste it again and I will check it.`,
      pending: { amountText: intent.amountText },
    }
  }

  let amount: bigint | undefined
  if (intent.amountText !== undefined) {
    try {
      amount = parseUsdc(intent.amountText)
    } catch {
      return {
        text: `I can't use "${intent.amountText}" as a USDC amount. Use a number with up to 6 decimals, like 25 or 12.5.`,
        pending: { to: intent.to },
      }
    }
    if (amount <= 0n) return { text: 'The amount must be greater than zero. How much USDC should I prepare?', pending: { to: intent.to } }
  }

  let to: Address | undefined
  if (intent.to !== undefined) {
    if (!isAddress(intent.to)) {
      return { text: 'That recipient address has a typo (the checksum does not match). Paste it again from the original source.', pending: { amountText: intent.amountText } }
    }
    const lower = intent.to.toLowerCase()
    if (lower === '0x0000000000000000000000000000000000000000') return { text: 'The zero address cannot receive payments. Who should I send it to?', pending: null }
    if (d.address && lower === d.address.toLowerCase()) return { text: 'That is your own wallet address, so there is nobody to pay. Who should receive it?', pending: { amountText: intent.amountText } }
    if (lower === d.usdcAddress.toLowerCase() || lower === d.orbitPayAddress?.toLowerCase()) {
      return { text: 'That is a contract address, not a wallet. Sending USDC there could lock it. Who should receive it?', pending: { amountText: intent.amountText } }
    }
    to = intent.to
  }

  if (amount === undefined && to === undefined) {
    return { text: 'Sure. How much USDC, and to which wallet address?', pending: {} }
  }
  if (to === undefined && amount !== undefined) {
    return { text: `OK, ${displayUsdc(amount)} USDC. Who should receive it? Paste their wallet address.`, pending: { amountText: intent.amountText } }
  }
  if (amount === undefined && to !== undefined) {
    return { text: `Got it, the recipient is ${shortAddress(to, 8, 6)}. How much USDC should I send?`, pending: { to } }
  }
  if (amount === undefined || to === undefined) return { text: 'Tell me the amount and the recipient address.', pending: {} }

  const warnings: string[] = []
  const known = d.items.some((tx) => tx.from.toLowerCase() === to.toLowerCase() || tx.to.toLowerCase() === to.toLowerCase())
  if (!known) warnings.push("You haven't paid this address in the history I can see. Double-check every character.")
  if (d.balance !== undefined) {
    if (amount > d.balance) warnings.push(`This is more than your balance of ${displayUsdc(d.balance)} USDC, so the payment would fail.`)
    else if (amount * 2n > d.balance) warnings.push('This is more than half of your balance. Network fees are paid in USDC too.')
  }
  return {
    text: `I've prepared a payment of ${displayUsdc(amount)} USDC. Nothing is sent yet: open it in Send, check the details, then confirm in your wallet.`,
    prefill: { to, amount, warnings },
    pending: null,
  }
}

export function respond(intent: Intent, d: AssistantData): Reply {
  switch (intent.kind) {
    case 'cancel':
      return { text: 'Cancelled. Nothing was prepared or sent.', pending: null, suggestions: DEFAULT_SUGGESTIONS }
    case 'greeting':
      return { text: 'Hi! I can check your balance, summarize your payments, and prepare a payment for you to review. What would you like to do?', suggestions: DEFAULT_SUGGESTIONS }
    case 'thanks':
      return { text: "You're welcome. Ask me anything else about your balance or payments.", suggestions: DEFAULT_SUGGESTIONS }
    case 'help':
      return { text: HELP[intent.topic](d), suggestions: DEFAULT_SUGGESTIONS }
    case 'unknown':
      return {
        text: "I didn't catch that. I can answer questions about your balance and payments, look up a transaction hash, and prepare a payment to review. For example:",
        suggestions: DEFAULT_SUGGESTIONS,
        pending: undefined,
      }
    case 'send':
      return respondSend(intent, d)
    case 'balance': {
      const gate = needsWallet(d)
      if (gate) return gate
      if (d.balance === undefined) {
        return {
          text: d.balanceError ? "I couldn't read your balance from Arc right now. The RPC may be busy." : 'Your balance is still loading from Arc.',
          actions: [{ kind: 'retry-balance' }],
        }
      }
      return { text: `You have ${displayUsdc(d.balance)} USDC on Arc Mainnet. On Arc the same USDC also pays network fees.` }
    }
    case 'address': {
      const gate = needsWallet(d)
      if (gate || !d.address) return gate ?? { text: 'Connect your wallet first.', actions: [{ kind: 'connect' }] }
      return {
        text: `Your Arc Mainnet address is ${d.address}. Only send USDC on Arc Mainnet to it.`,
        actions: [
          { kind: 'copy', value: d.address, label: 'Copy address' },
          { kind: 'open-tab', tab: 'receive', label: 'Show QR code' },
        ],
      }
    }
    case 'tx': {
      const gate = needsWallet(d)
      if (gate) return gate
      const hash = intent.hash.toLowerCase()
      const found = d.items.filter((tx) => tx.hash.toLowerCase() === hash)
      const link = { label: 'Open on Arc Explorer', url: buildTxExplorerUrl(d.chainId, intent.hash) }
      if (found.length === 0) {
        return {
          text: `I can't find that transaction in your loaded history. It may not involve your wallet, or it may be older than what has been scanned. You can check it directly on the explorer.${historyNote(d) ? ' ' + historyNote(d) : ''}`,
          links: [link],
          actions: d.historyComplete ? undefined : [{ kind: 'load-older' }],
        }
      }
      const status = found[0].status
      const word = status === 'confirmed' ? 'confirmed onchain' : status === 'pending' ? 'still pending' : 'failed'
      return { text: `That transaction is ${word}.`, txs: found, links: [link] }
    }
    case 'recent': {
      const gate = needsWallet(d)
      if (gate) return gate
      const problem = historyProblem(d)
      if (problem) return problem
      const filter: Filter = { direction: intent.direction, range: intent.range, counterparty: intent.counterparty }
      const { rows, undated } = applyFilter(d.items, filter, d)
      const note = historyNote(d)
      const links = intent.counterparty ? [{ label: `View ${shortAddress(intent.counterparty)} on Arc Explorer`, url: buildAddressExplorerUrl(d.chainId, intent.counterparty) }] : undefined
      if (rows.length === 0) {
        return {
          text: `I don't see any ${describeFilter(filter)} in the history loaded so far.${note ? ' ' + note : ''}`,
          links,
          actions: d.historyComplete ? undefined : [{ kind: 'load-older' }],
        }
      }
      const shown = rows.slice(0, intent.count)
      const more = rows.length > shown.length ? ` I found ${rows.length} in total; open History to see all of them.` : ''
      const skipped = undated > 0 ? ` ${undated} transaction${undated === 1 ? ' has' : 's have'} no timestamp yet and ${undated === 1 ? 'was' : 'were'} left out. I'm loading ${undated === 1 ? 'it' : 'them'} now, so ask again in a few seconds.` : ''
      return {
        text: `Here ${shown.length === 1 ? 'is your most recent' : `are your ${shown.length} most recent`} ${describeFilter(filter, 'transfers')}.${more}${skipped}${note ? ' ' + note : ''}`,
        txs: shown,
        links,
        actions: [{ kind: 'open-tab', tab: 'history', label: 'Open History' }],
      }
    }
    case 'totals': {
      const gate = needsWallet(d)
      if (gate) return gate
      const problem = historyProblem(d)
      if (problem) return problem
      const filter: Filter = { direction: intent.direction, range: intent.range, counterparty: intent.counterparty }
      const { rows, undated } = applyFilter(d.items, filter, d)
      const confirmed = rows.filter((tx) => tx.status === 'confirmed')
      const pending = rows.filter((tx) => tx.status === 'pending').length
      const sum = (dir: 'in' | 'out') => confirmed.filter((tx) => tx.direction === dir).reduce((acc, tx) => acc + tx.amount, 0n)
      const count = (dir: 'in' | 'out') => confirmed.filter((tx) => tx.direction === dir).length
      const incoming = sum('in')
      const outgoing = sum('out')
      const note = historyNote(d)
      const extras = [
        pending > 0 ? `${pending} pending transaction${pending === 1 ? ' is' : 's are'} not counted yet.` : '',
        undated > 0 ? `${undated} transaction${undated === 1 ? ' has' : 's have'} no timestamp yet and ${undated === 1 ? 'is' : 'are'} not counted yet. I'm loading ${undated === 1 ? 'it' : 'them'} now, so ask again in a few seconds.` : '',
        note,
      ]
        .filter(Boolean)
        .join(' ')
      let text: string
      if (confirmed.length === 0) text = `I found no confirmed ${describeFilter(filter)} in the loaded history.`
      else if (intent.direction === 'in') text = `You received ${displayUsdc(incoming)} USDC across ${count('in')} payment${count('in') === 1 ? '' : 's'}${filter.range ? ` in ${filter.range.label}` : ''}${filter.counterparty ? ` from ${shortAddress(filter.counterparty)}` : ''}.`
      else if (intent.direction === 'out') text = `You sent ${displayUsdc(outgoing)} USDC across ${count('out')} payment${count('out') === 1 ? '' : 's'}${filter.range ? ` in ${filter.range.label}` : ''}${filter.counterparty ? ` to ${shortAddress(filter.counterparty)}` : ''}.`
      else text = `${filter.range ? `In ${filter.range.label}` : 'So far'} you received ${displayUsdc(incoming)} USDC (${count('in')}) and sent ${displayUsdc(outgoing)} USDC (${count('out')}).`
      return {
        text: `${text}${extras ? ' ' + extras : ''}`,
        actions: d.historyComplete ? undefined : [{ kind: 'load-older' }],
      }
    }
  }
}

