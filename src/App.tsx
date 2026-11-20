import { useState } from 'react'
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { BalanceCard } from '@/components/BalanceCard'
import { Header } from '@/components/Header'
import { NetworkBanner } from '@/components/NetworkBanner'
import { ReceiveCard } from '@/components/ReceiveCard'
import { SendCard } from '@/components/SendCard'
import { SettingsDialog } from '@/components/SettingsDialog'

type Tab = 'send' | 'receive'

const TABS: { id: Tab; label: string; icon: typeof ArrowUpRight }[] = [
  { id: 'send', label: 'Send', icon: ArrowUpRight },
  { id: 'receive', label: 'Receive', icon: ArrowDownLeft },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('send')
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className="min-h-dvh px-4 pb-24">
      <div className="mx-auto w-full max-w-md">
        <Header onOpenSettings={() => setSettingsOpen(true)} />
        <NetworkBanner />

        <main className="flex flex-col gap-4">
          <BalanceCard />

          <div role="tablist" aria-label="Payment actions" className="glass grid grid-cols-2 gap-1 rounded-2xl p-1">
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

          <div role="tabpanel">{tab === 'send' ? <SendCard /> : <ReceiveCard />}</div>
        </main>

        <footer className="mt-8 text-center text-xs" style={{ color: 'var(--subtle)' }}>
          Non-custodial. Every payment is approved in your own wallet.
        </footer>
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
