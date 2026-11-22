import { useCallback, useEffect, useRef, useState } from 'react'
import { useModal } from 'connectkit'
import { toast } from 'sonner'
import { type Address } from 'viem'
import { useAccount } from 'wagmi'
import { arcMainnet } from '@/config'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import type { TransactionHistory } from '@/hooks/useTransactionHistory'
import { parseIntent, type PendingSend } from '@/lib/assistant/parse'
import { respond, type AssistantData, type AssistantTab, type Reply, type ReplyAction } from '@/lib/assistant/respond'
import { settings } from '@/lib/settings'

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  /** Rich content (rows, payment card, buttons). Only kept for this session, never saved. */
  reply?: Reply
}

const MAX_SAVED = 40
const MAX_INPUT = 300

function storageKey(address: Address | undefined): string {
  return `orbitpay:assistant:v1:${(address ?? 'anon').toLowerCase()}`
}

function loadMessages(address: Address | undefined): ChatMessage[] {
  try {
    const raw = localStorage.getItem(storageKey(address))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: ChatMessage[] = []
    for (const m of parsed as Record<string, unknown>[]) {
      if (typeof m?.id === 'number' && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string') {
        out.push({ id: m.id, role: m.role, text: m.text })
      }
    }
    return out
  } catch {
    return []
  }
}

function saveMessages(address: Address | undefined, messages: ChatMessage[]): void {
  try {
    const slim = messages.slice(-MAX_SAVED).map(({ id, role, text }) => ({ id, role, text }))
    localStorage.setItem(storageKey(address), JSON.stringify(slim))
  } catch {
    // Storage can be full or blocked (private mode). The chat still works for this session.
  }
}

export interface UseAssistantOptions {
  history: TransactionHistory
  onPrepared: (to: Address, amount: bigint) => void
  onOpenTab: (tab: AssistantTab) => void
}

/**
 * Chat state for the built-in payment assistant. Everything runs in the browser: messages are parsed
 * and answered from the live balance and the loaded history, and the assistant can only fill in the Send form.
 */
export function useAssistant({ history, onPrepared, onOpenTab }: UseAssistantOptions) {
  const { address, isConnected } = useAccount()
  const { setOpen } = useModal()
  const { balance, isError: balanceError, refetch: refetchBalance } = useUsdcBalance()
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessages(address))
  const [pending, setPending] = useState<PendingSend | null>(null)
  const nextId = useRef(messages.reduce((max, m) => Math.max(max, m.id), 0) + 1)

  useEffect(() => {
    saveMessages(address, messages)
  }, [address, messages])

  const buildData = useCallback(
    (over: Partial<AssistantData> = {}): AssistantData => ({
      chainId: arcMainnet.id,
      connected: isConnected && Boolean(address),
      address,
      balance,
      balanceError,
      items: history.items,
      historyLoading: history.snapshot.loadingLatest || history.snapshot.loadingOlder,
      historyError: history.snapshot.error,
      historyComplete: history.snapshot.complete,
      scannedSince: history.snapshot.scannedFromTime,
      now: Math.floor(Date.now() / 1000),
      usdcAddress: settings.usdcAddress,
      orbitPayAddress: settings.orbitPayAddress,
      ...over,
    }),
    [isConnected, address, balance, balanceError, history.items, history.snapshot],
  )

  const push = useCallback((entries: Omit<ChatMessage, 'id'>[]) => {
    setMessages((prev) => [...prev, ...entries.map((e) => ({ ...e, id: nextId.current++ }))])
  }, [])

  const send = useCallback(
    (input: string) => {
      const text = input.trim().slice(0, MAX_INPUT)
      if (text === '') return
      const data = buildData()
      const intent = parseIntent(text, { now: data.now, pending })
      const reply = respond(intent, data)
      // Period questions need block timestamps, which History loads lazily. Ask for the missing ones now.
      if ((intent.kind === 'recent' || intent.kind === 'totals') && intent.range) {
        const missing = data.items.filter((tx) => tx.timestamp === undefined && tx.createdAt === undefined).map((tx) => tx.id)
        if (missing.length > 0) history.ensureTimes(missing.slice(0, 40))
      }
      if (reply.pending !== undefined) setPending(reply.pending)
      push([
        { role: 'user', text },
        { role: 'assistant', text: reply.text, reply },
      ])
    },
    [buildData, history, pending, push],
  )

  const runAction = useCallback(
    async (action: ReplyAction) => {
      switch (action.kind) {
        case 'connect':
          setOpen(true)
          return
        case 'open-tab':
          onOpenTab(action.tab)
          return
        case 'copy': {
          try {
            await navigator.clipboard.writeText(action.value)
            toast.success('Copied to clipboard')
          } catch {
            toast.error('Could not copy. Select the address and copy it manually.')
          }
          return
        }
        case 'retry-balance': {
          const result = await refetchBalance()
          const data = buildData({ balance: result.data, balanceError: result.isError })
          const reply = respond({ kind: 'balance' }, data)
          push([{ role: 'assistant', text: reply.text, reply }])
          return
        }
        case 'retry-history':
          history.refresh()
          push([{ role: 'assistant', text: 'Retrying the history read from Arc now. Ask me again in a few seconds.' }])
          return
        case 'load-older':
          history.loadOlder()
          push([{ role: 'assistant', text: 'Loading older history from Arc. Ask me again once it has finished and I will include it.' }])
          return
      }
    },
    [buildData, history, onOpenTab, push, refetchBalance, setOpen],
  )

  const prepare = useCallback(
    (to: Address, amount: bigint) => {
      onPrepared(to, amount)
      push([{ role: 'assistant', text: 'The payment is in the Send tab. Review the recipient and amount there, then confirm in your wallet.' }])
    },
    [onPrepared, push],
  )

  const clear = useCallback(() => {
    setMessages([])
    setPending(null)
  }, [])

  return { messages, pending, send, runAction, prepare, clear, maxInput: MAX_INPUT }
}
