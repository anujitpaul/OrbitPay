import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, FileText, History, Sparkles } from 'lucide-react'
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
import { SwapCard } from '@/components/SwapCard'
import { useTransactionHistory } from '@/hooks/useTransactionHistory'
import { invoiceFromHash } from '@/lib/invoice/codec'
import { formatUsdc } from '@/onchain-money'

type Tab = 'send' | 'receive' | 'history' | 'assistant' | 'invoice' | 'swap'

const TABS: { id: Tab; label: string; icon: typeof ArrowUpRight }[] = [
  { id: 'send', label: 'Send', icon: ArrowUpRight },
  { id: 'receive', label: 'Receive', icon: ArrowDownLeft },
  { id: 'swap', label: 'Swap', icon: ArrowLeftRight },
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
    <div className="min-h-dvh px-4 pb-32 lg:pb-12">
      <div className="mx-auto w-full max-w-6xl">
        <Header onOpenSettings={() => setSettingsOpen(true)} />
        <NetworkBanner />

        <main className="flex flex-col gap-5 lg:gap-6">
          <BalanceCard onNavigate={setTab} />

          <div className="grid gap-0 lg:grid-cols-[16.5rem_minmax(0,1fr)] lg:items-start lg:gap-6">
            <div className="flex flex-col gap-4 lg:sticky lg:top-6">
              <nav
                role="tablist"
                aria-label="Payment actions"
                className="glass fixed inset-x-3 bottom-3 z-30 flex justify-between gap-0.5 rounded-[1.6rem] p-1.5 lg:static lg:z-auto lg:flex-col lg:gap-1.5 lg:rounded-[1.75rem] lg:p-3"
                style={{ background: 'rgba(20, 34, 56, 0.94)', boxShadow: '0 18px 40px -12px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.06)' }}
              >
                {TABS.map(({ id, label, icon: Icon }) => {
                  const active = tab === id
                  return (
                    <button
                      key={id}
                      role="tab"
                      type="button"
                      aria-selected={active}
                      onClick={() => setTab(id)}
                      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2 text-[10px] font-semibold transition-all duration-200 hover:bg-white/5 lg:flex-none lg:flex-row lg:justify-start lg:gap-3 lg:px-3.5 lg:py-3 lg:text-sm"
                      style={active ? { background: 'var(--accent-fill)', color: 'var(--accent-ink)', boxShadow: 'var(--accent-glow)' } : { color: 'var(--muted)' }}
                    >
                      <Icon className="size-5 shrink-0 lg:size-[18px]" />
                      <span className="truncate">{label}</span>
                    </button>
                  )
                })}
              </nav>
              <p className="glass hidden rounded-2xl px-4 py-3 text-xs leading-relaxed lg:block" style={{ color: 'var(--muted)' }}>
                Non-custodial. Every payment is approved in your own wallet.
              </p>
            </div>

            {/* Panels stay mounted so an in-flight payment keeps its progress while you look at History. */}
            <div className="min-w-0">
              <div role="tabpanel" hidden={tab !== 'send'} className="rise mx-auto w-full max-w-xl">
                <SendCard prefill={prefill} />
              </div>
              <div role="tabpanel" hidden={tab !== 'receive'} className="rise mx-auto w-full max-w-xl">
                <ReceiveCard history={history} onViewHistory={() => setTab('history')} />
              </div>
              <div role="tabpanel" hidden={tab !== 'swap'} className="rise mx-auto w-full max-w-xl">
                <SwapCard />
              </div>
              <div role="tabpanel" hidden={tab !== 'history'} className="rise mx-auto w-full max-w-3xl">
                <HistoryCard history={history} />
              </div>
              <div role="tabpanel" hidden={tab !== 'assistant'} className="rise mx-auto w-full max-w-2xl">
                <AssistantCard history={history} onPrepared={onPrepared} onOpenTab={setTab} />
              </div>
              <div role="tabpanel" hidden={tab !== 'invoice'} className="rise mx-auto w-full max-w-3xl">
                <InvoiceCard />
              </div>
            </div>
          </div>
        </main>

        <footer className="mt-8 text-center text-xs lg:hidden" style={{ color: 'var(--subtle)' }}>
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
    <div className="min-h-dvh px-4 pb-12">
      <div className="mx-auto w-full max-w-xl">
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
