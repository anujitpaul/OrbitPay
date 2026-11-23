import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { ArrowDownLeft, ArrowUpRight, FileText, History, Sparkles } from 'lucide-react'
import { AssistantCard } from '@/components/AssistantCard'
import { BalanceCard } from '@/components/BalanceCard'
import { Header } from '@/components/Header'
import { HistoryCard } from '@/components/HistoryCard'
import { InvoiceCard } from '@/components/InvoiceCard'
import { InvoicePublic } from '@/components/InvoicePublic'
import { NetworkBanner } from '@/components/NetworkBanner'
import { ReceiveCard } from '@/components/ReceiveCard'
import { SendCard, type SendPrefill } from '@/components/SendCard'
import { SettingsDialog } from '@/components/SettingsDialog'
import { useTransactionHistory } from '@/hooks/useTransactionHistory'
import { invoiceFromHash } from '@/lib/invoice/codec'
import { formatUsdc } from '@/onchain-money'

type Tab = 'send' | 'receive' | 'history' | 'assistant' | 'invoice'

const TABS: { id: Tab; label: string; icon: typeof ArrowUpRight }[] = [
  { id: 'send', label: 'Send', icon: ArrowUpRight },
  { id: 'receive', label: 'Receive', icon: ArrowDownLeft },
  { id: 'history', label: 'History', icon: History },
  { id: 'assistant', label: 'Assistant', icon: Sparkles },
  { id: 'invoice', label: 'Invoice', icon: FileText },
]

function Dashboard() {
  const [tab, setTab] = useState<Tab>('send')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const history = useTransactionHistory()
  const [prefill, setPrefill] = useState<SendPrefill | undefined>(undefined)

  // The assistant only fills in the Send form. The payment itself is still reviewed and confirmed in the wallet.
  const onPrepared = useCallback((to: Address, amount: bigint) => {
    const amountText = formatUsdc(amount).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    setPrefill((prev) => ({ id: (prev?.id ?? 0) + 1, to, amountText }))
    setTab('send')
  }, [])

  return (
    <div className="min-h-dvh px-4 pb-24">
      <div className="mx-auto w-full max-w-md">
        <Header onOpenSettings={() => setSettingsOpen(true)} />
        <NetworkBanner />

        <main className="flex flex-col gap-4">
          <BalanceCard />

          <div role="tablist" aria-label="Payment actions" className="glass grid grid-cols-5 gap-0.5 rounded-2xl p-1">
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = tab === id
              return (
                <button
                  key={id}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={() => setTab(id)}
                  className="flex h-11 items-center justify-center gap-1.5 rounded-xl text-[12px] font-semibold transition-colors sm:gap-2 sm:text-sm"
                  style={active ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : { color: 'var(--muted)' }}
                >
                  <Icon className="hidden size-4 sm:block" />
                  {label}
                </button>
              )
            })}
          </div>

          {/* Panels stay mounted so an in-flight payment keeps its progress while you look at History. */}
          <div role="tabpanel" hidden={tab !== 'send'}>
            <SendCard prefill={prefill} />
          </div>
          <div role="tabpanel" hidden={tab !== 'receive'}>
            <ReceiveCard history={history} onViewHistory={() => setTab('history')} />
          </div>
          <div role="tabpanel" hidden={tab !== 'history'}>
            <HistoryCard history={history} />
          </div>
          <div role="tabpanel" hidden={tab !== 'assistant'}>
            <AssistantCard history={history} onPrepared={onPrepared} onOpenTab={setTab} />
          </div>
          <div role="tabpanel" hidden={tab !== 'invoice'}>
            <InvoiceCard />
          </div>
        </main>

        <footer className="mt-8 text-center text-xs" style={{ color: 'var(--subtle)' }}>
          Non-custodial. Every payment is approved in your own wallet.
        </footer>
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

/** Opening an invoice link (#/invoice/…) shows the client's view; anything else is the dashboard. */
export default function App() {
  const [invoice, setInvoice] = useState(() => invoiceFromHash(window.location.hash))
  useEffect(() => {
    const onHash = () => setInvoice(invoiceFromHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!invoice) return <Dashboard />
  return (
    <div className="min-h-dvh px-4 pb-24">
      <div className="mx-auto w-full max-w-md">
        <Header />
        <NetworkBanner />
        <main>
          <InvoicePublic
            key={invoice}
            encoded={invoice}
            onExit={() => {
              window.history.replaceState(null, '', window.location.pathname + window.location.search)
              setInvoice(undefined)
            }}
          />
        </main>
        <footer className="mt-8 text-center text-xs" style={{ color: 'var(--subtle)' }}>
          Non-custodial. Every payment is approved in your own wallet.
        </footer>
      </div>
    </div>
  )
}
