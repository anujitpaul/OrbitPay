import { useState } from 'react'
import { useModal } from 'connectkit'
import { FileText, Loader2, Plus, Wallet } from 'lucide-react'
import { useInvoices } from '@/hooks/useInvoices'
import { displayUsdc } from '@/lib/format'
import { invoiceStatus, type InvoiceRecord, type InvoiceStatus } from '@/lib/invoice/types'
import { InvoiceDetail } from './InvoiceDetail'
import { InvoiceStatusBadge, formatDate } from './InvoiceDocument'
import { InvoiceForm } from './InvoiceForm'

type Filter = 'all' | 'unpaid' | 'paid' | 'cancelled'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unpaid', label: 'Unpaid' },
  { id: 'paid', label: 'Paid' },
  { id: 'cancelled', label: 'Cancelled' },
]

const matches = (filter: Filter, status: InvoiceStatus) =>
  filter === 'all' || (filter === 'unpaid' && (status === 'pending' || status === 'expired')) || (filter === 'paid' && status === 'paid') || (filter === 'cancelled' && status === 'cancelled')

function total(records: InvoiceRecord[]): bigint {
  return records.reduce((sum, r) => sum + BigInt(r.signed.data.amount), 0n)
}

export function InvoiceCard() {
  const api = useInvoices()
  const { setOpen } = useModal()
  const [mode, setMode] = useState<'list' | 'new'>('list')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState<Filter>('all')

  if (!api.address) {
    return (
      <section className="glass flex flex-col items-center gap-4 rounded-3xl p-8 text-center" aria-label="Invoices">
        <div className="grid size-12 place-items-center rounded-2xl" style={{ background: 'var(--surface-strong)' }}>
          <FileText className="size-6" aria-hidden />
        </div>
        <div>
          <h2 className="display text-lg font-semibold">Get paid in USDC</h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            Connect your wallet to create invoices, share them with clients and see when they are paid.
          </p>
        </div>
        <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-12 items-center gap-2 rounded-2xl px-5 font-semibold" style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}>
          <Wallet className="size-4" aria-hidden /> Connect wallet
        </button>
      </section>
    )
  }

  const rows = api.records.map((record) => ({ record, status: invoiceStatus(record, api.now) }))
  const paid = rows.filter((r) => r.status === 'paid').map((r) => r.record)
  const unpaid = rows.filter((r) => r.status === 'pending' || r.status === 'expired').map((r) => r.record)
  const selectedRecord = selected ? api.records.find((r) => r.signed.data.id === selected) : undefined

  if (mode === 'new') {
    return (
      <section className="glass rounded-3xl p-5" aria-label="Create invoice">
        <InvoiceForm
          onCreate={api.create}
          onClose={() => setMode('list')}
          onCreated={(record) => {
            setSelected(record.signed.data.id)
            setMode('list')
          }}
        />
      </section>
    )
  }

  if (selectedRecord) {
    return (
      <InvoiceDetail record={selectedRecord} now={api.now} checking={api.checking} onBack={() => setSelected(undefined)} onCancel={api.cancel} onRecheck={api.recheck} />
    )
  }

  const visible = rows.filter((r) => matches(filter, r.status))

  return (
    <section className="glass flex flex-col gap-4 rounded-3xl p-5" aria-label="Invoices">
      <div className="flex items-center justify-between gap-3">
        <h2 className="display text-lg font-semibold">Invoices</h2>
        <button type="button" onClick={() => setMode('new')} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-4 text-sm font-semibold" style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}>
          <Plus className="size-4" aria-hidden /> New invoice
        </button>
      </div>

      <dl className="grid grid-cols-3 gap-2" aria-label="Invoice totals">
        {[
          { label: 'Created', value: String(api.records.length), sub: `${displayUsdc(total(api.records))} USDC` },
          { label: 'Paid', value: String(paid.length), sub: `${displayUsdc(total(paid))} USDC` },
          { label: 'Unpaid', value: String(unpaid.length), sub: `${displayUsdc(total(unpaid))} USDC` },
        ].map((s) => (
          <div key={s.label} className="inner rounded-2xl p-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--subtle)' }}>
              {s.label}
            </dt>
            <dd className="display mt-0.5 text-xl font-bold tabular-nums">{s.value}</dd>
            <dd className="truncate text-[11px] tabular-nums" style={{ color: 'var(--muted)' }}>
              {s.sub}
            </dd>
          </div>
        ))}
      </dl>

      <div role="group" aria-label="Filter invoices" className="flex gap-1.5 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className="min-h-11 shrink-0 rounded-xl px-3.5 text-sm font-semibold"
            style={filter === f.id ? { background: 'var(--accent-fill)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', color: 'var(--muted)' }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {api.checkError && (
        <p className="text-xs" role="status" style={{ color: 'var(--warn)' }}>
          {api.checkError}
        </p>
      )}

      {visible.length === 0 ? (
        <div className="py-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
          {api.records.length === 0 ? (
            <>
              <p className="font-semibold" style={{ color: 'var(--ink)' }}>
                No invoices yet
              </p>
              <p className="mt-1">Create your first invoice and share the link or QR code with your client.</p>
            </>
          ) : (
            <p>No {filter} invoices.</p>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map(({ record, status }) => {
            const d = record.signed.data
            return (
              <li key={d.id}>
                <button type="button" onClick={() => setSelected(d.id)} className="inner flex w-full min-h-16 flex-col gap-1 rounded-2xl p-3.5 text-left transition-colors hover:bg-white/5" aria-label={`Open invoice ${d.id}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs" style={{ color: 'var(--subtle)' }}>
                      {d.id}
                    </span>
                    <InvoiceStatusBadge status={status} />
                  </span>
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-semibold">
                      {d.client.name} · {d.project}
                    </span>
                    <span className="display shrink-0 text-base font-bold tabular-nums">{displayUsdc(BigInt(d.amount))} USDC</span>
                  </span>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    Due {formatDate(d.deadline)}
                    {record.payment ? ' · paid' : ''}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {api.checking && (
        <p className="flex items-center justify-center gap-1.5 text-xs" style={{ color: 'var(--subtle)' }} role="status">
          <Loader2 className="size-3 animate-spin" aria-hidden /> Checking Arc for payments…
        </p>
      )}
    </section>
  )
}
