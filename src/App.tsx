import { useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, History } from 'lucide-react'
import { BalanceCard } from '@/components/BalanceCard'
import { Header } from '@/components/Header'
import { HistoryCard } from '@/components/HistoryCard'
import { NetworkBanner } from '@/components/NetworkBanner'
import { ReceiveCard } from '@/components/ReceiveCard'
import { SendCard } from '@/components/SendCard'
import { SettingsDialog } from '@/components/SettingsDialog'
import { useTransactionHistory } from '@/hooks/useTransactionHistory'

type Tab = 'send' | 'receive' | 'history'

const TABS: { id: Tab; label: string; icon: typeof ArrowUpRight }[] = [
  { id: 'send', label: 'Send', icon: ArrowUpRight },
  { id: 'receive', label: 'Receive', icon: ArrowDownLeft },
  { id: 'history', label: 'History', icon: History },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('send')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const history = useTransactionHistory()

  return (
    <div className="min-h-dvh px-4 pb-24">
      <div className="mx-auto w-full max-w-md">
        <Header onOpenSettings={() => setSettingsOpen(true)} />
        <NetworkBanner />

        <main className="flex flex-col gap-4">
          <BalanceCard />

          <div role="tablist" aria-label="Payment actions" className="glass grid grid-cols-3 gap-1 rounded-2xl p-1">
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = tab === id
              return (
                <button
                  key={id}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={() => setTab(id)}
                  className="flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors"
                  style={active ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : { color: 'var(--muted)' }}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              )
            })}
          </div>

          {/* Panels stay mounted so an in-flight payment keeps its progress while you look at History. */}
          <div role="tabpanel" hidden={tab !== 'send'}>
            <SendCard />
          </div>
          <div role="tabpanel" hidden={tab !== 'receive'}>
            <ReceiveCard history={history} onViewHistory={() => setTab('history')} />
          </div>
          <div role="tabpanel" hidden={tab !== 'history'}>
            <HistoryCard history={history} />
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
