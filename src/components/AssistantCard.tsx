import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, ExternalLink, RotateCcw, SendHorizontal, Sparkles } from 'lucide-react'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { useAssistant, type ChatMessage } from '@/hooks/useAssistant'
import type { TransactionHistory } from '@/hooks/useTransactionHistory'
import type { AssistantTab, ReplyAction } from '@/lib/assistant/respond'
import { displayUsdc } from '@/lib/format'
import { ActivityList } from './ActivityList'

const INTRO_SUGGESTIONS = ['What is my balance?', 'Show my last 5 payments', 'How much did I receive this week?', 'Send 5 USDC to 0x…']

interface AssistantCardProps {
  history: TransactionHistory
  onPrepared: (to: Address, amount: bigint) => void
  onOpenTab: (tab: AssistantTab) => void
}

/** A new conversation per wallet: switching accounts remounts the chat with that wallet's saved messages. */
export function AssistantCard(props: AssistantCardProps) {
  const { address } = useAccount()
  return <AssistantChat key={address ?? 'anon'} {...props} />
}

function AssistantChat({ history, onPrepared, onOpenTab }: AssistantCardProps) {
  const { messages, send, runAction, prepare, clear, maxInput } = useAssistant({ history, onPrepared, onOpenTab })
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (input.trim() === '') return
    send(input)
    setInput('')
  }

  const last = messages[messages.length - 1]
  const suggestions = messages.length === 0 ? INTRO_SUGGESTIONS : last?.role === 'assistant' ? last.reply?.suggestions : undefined

  return (
    <section className="glass flex flex-col rounded-3xl p-5" aria-label="Payment assistant">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5" style={{ color: 'var(--accent)' }} />
          <div>
            <h2 className="display text-lg font-semibold leading-tight">Payment assistant</h2>
            <p className="text-xs" style={{ color: 'var(--subtle)' }}>
              Runs in your browser. It never sends anything: you confirm every payment.
            </p>
          </div>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear conversation"
            className="inner flex size-9 shrink-0 items-center justify-center rounded-xl"
            style={{ color: 'var(--muted)' }}
          >
            <RotateCcw className="size-4" />
          </button>
        )}
      </div>

      <div role="log" aria-live="polite" aria-label="Conversation" className="inner flex max-h-[52dvh] min-h-[220px] flex-col gap-3 overflow-y-auto rounded-2xl p-3">
        <Bubble role="assistant">
          Hi! Ask about your balance or payments, or tell me to send USDC and I will prepare it for you to review.
        </Bubble>
        {messages.map((m) => (
          <MessageView key={m.id} message={m} onAction={runAction} onPrepare={prepare} />
        ))}
        <div ref={endRef} />
      </div>

      {suggestions && suggestions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggestions">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => (s.includes('0x…') ? setInput(s.replace('0x…', '')) : send(s))}
              className="min-h-9 rounded-full px-3 text-xs font-semibold"
              style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="mt-3 flex items-center gap-2">
        <label htmlFor="assistant-input" className="sr-only">
          Message the assistant
        </label>
        <input
          id="assistant-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={maxInput}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Ask about your balance or payments"
          className="field h-12 min-w-0 flex-1 rounded-2xl px-4 text-sm outline-none placeholder:text-slate-500"
        />
        <button
          type="submit"
          disabled={input.trim() === ''}
          aria-label="Send message"
          className="flex size-12 shrink-0 items-center justify-center rounded-2xl disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}
        >
          <SendHorizontal className="size-5" />
        </button>
      </form>
    </section>
  )
}

function Bubble({ role, children }: { role: ChatMessage['role']; children: React.ReactNode }) {
  const mine = role === 'user'
  return (
    <div
      className={`max-w-[92%] break-words rounded-2xl px-3.5 py-2.5 text-sm text-pretty ${mine ? 'self-end' : 'self-start'}`}
      style={mine ? { background: 'var(--accent-fill)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
    >
      {children}
    </div>
  )
}

function MessageView({
  message,
  onAction,
  onPrepare,
}: {
  message: ChatMessage
  onAction: (action: ReplyAction) => Promise<void>
  onPrepare: (to: Address, amount: bigint) => void
}) {
  const { role, text, reply } = message
  if (role === 'user') return <Bubble role="user">{text}</Bubble>
  return (
    <div className="flex flex-col gap-2 self-start" style={{ maxWidth: '100%' }}>
      <Bubble role="assistant">{text}</Bubble>

      {reply?.txs && reply.txs.length > 0 && <ActivityList items={reply.txs} />}

      {reply?.prefill && (
        <div className="inner rounded-2xl p-3" aria-label="Prepared payment">
          <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
            Prepared payment
          </p>
          <p className="display mt-1 text-2xl font-bold tabular-nums">
            {displayUsdc(reply.prefill.amount)} <span className="text-sm font-medium" style={{ color: 'var(--subtle)' }}>USDC</span>
          </p>
          <p className="mono mt-1 break-all text-xs" style={{ color: 'var(--muted)' }}>
            To {reply.prefill.to}
          </p>
          {reply.prefill.warnings.map((w) => (
            <p key={w} className="mt-2 flex items-start gap-1.5 text-xs text-pretty" style={{ color: 'var(--warn)' }}>
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {w}
            </p>
          ))}
          <button
            type="button"
            onClick={() => reply.prefill && onPrepare(reply.prefill.to, reply.prefill.amount)}
            className="mt-3 flex h-11 w-full items-center justify-center rounded-xl text-sm font-semibold"
            style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}
          >
            Review in Send
          </button>
        </div>
      )}

      {reply?.links?.map((l) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-9 items-center gap-1.5 self-start text-xs font-semibold underline-offset-4 hover:underline"
          style={{ color: 'var(--accent)' }}
        >
          {l.label} <ExternalLink className="size-3" />
        </a>
      ))}

      {reply?.actions && reply.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {reply.actions.map((a, i) => (
            <button
              key={`${a.kind}-${i}`}
              type="button"
              onClick={() => void onAction(a)}
              className="min-h-9 rounded-full px-3 text-xs font-semibold"
              style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            >
              {actionLabel(a)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function actionLabel(a: ReplyAction): string {
  switch (a.kind) {
    case 'connect':
      return 'Connect wallet'
    case 'retry-balance':
      return 'Try again'
    case 'retry-history':
      return 'Retry history'
    case 'load-older':
      return 'Load older history'
    case 'open-tab':
    case 'copy':
      return a.label
  }
}
