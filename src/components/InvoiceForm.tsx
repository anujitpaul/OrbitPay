import { useState, type ReactNode } from 'react'
import { ImagePlus, Loader2, Plus, X } from 'lucide-react'
import type { CreateOutcome } from '@/hooks/useInvoices'
import { safeLink } from '@/lib/invoice/codec'
import { makePreview } from '@/lib/invoice/images'
import { LIMITS, type InvoiceRecord } from '@/lib/invoice/types'
import { parseUsdc } from '@/onchain-money'

const PRESETS = [7, 14, 30, 60] as const
const NAME_KEY = 'orbitpay:issuer-name'

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
          {hint}
        </p>
      )}
    </div>
  )
}

const box = 'field inner rounded-2xl px-4 transition-shadow'
const input = 'h-12 w-full bg-transparent text-sm outline-none placeholder:text-slate-500'

function parseAmount(text: string): bigint | undefined {
  if (!text || text === '.') return undefined
  try {
    return parseUsdc(text)
  } catch {
    return undefined
  }
}

function readIssuerName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

interface InvoiceFormProps {
  onCreate: (input: {
    issuerName?: string
    clientName: string
    clientWallet: string
    project: string
    description: string
    amount: bigint
    deadline: number
    links: { label: string; url: string }[]
    images: string[]
  }) => Promise<CreateOutcome>
  onCreated: (record: InvoiceRecord) => void
  onClose: () => void
}

export function InvoiceForm({ onCreate, onCreated, onClose }: InvoiceFormProps) {
  const [issuerName, setIssuerName] = useState(readIssuerName)
  const [clientName, setClientName] = useState('')
  const [clientWallet, setClientWallet] = useState('')
  const [project, setProject] = useState('')
  const [description, setDescription] = useState('')
  const [amountText, setAmountText] = useState('')
  const [days, setDays] = useState<number | 'custom'>(14)
  const [customDate, setCustomDate] = useState('')
  const [links, setLinks] = useState<{ label: string; url: string }[]>([])
  const [images, setImages] = useState<string[]>([])
  const [imageError, setImageError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [loadingImages, setLoadingImages] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const addImages = async (files: FileList | null) => {
    if (!files?.length) return
    setImageError(undefined)
    setLoadingImages(true)
    try {
      const next = [...images]
      for (const file of Array.from(files)) {
        if (next.length >= LIMITS.images) {
          setImageError(`You can attach up to ${LIMITS.images} images.`)
          break
        }
        next.push(await makePreview(file))
      }
      setImages(next)
    } catch (e) {
      setImageError(e instanceof Error ? e.message : 'That image could not be added.')
    } finally {
      setLoadingImages(false)
    }
  }

  const submit = async () => {
    setError(undefined)
    const amount = parseAmount(amountText)
    if (amount === undefined) return setError('Enter the USDC amount.')
    const now = Math.floor(Date.now() / 1000)
    let deadline: number
    if (days === 'custom') {
      const ms = customDate ? new Date(customDate).getTime() : NaN
      if (!Number.isFinite(ms)) return setError('Pick a payment deadline.')
      deadline = Math.floor(ms / 1000)
    } else {
      deadline = now + days * 86_400
    }
    const cleanLinks: { label: string; url: string }[] = []
    for (const l of links) {
      const raw = l.url.trim()
      if (!raw) continue
      const url = safeLink(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
      if (!url) return setError(`“${raw.slice(0, 40)}” is not a valid https link.`)
      cleanLinks.push({ label: l.label.trim().slice(0, LIMITS.linkLabel), url })
    }
    setBusy(true)
    try {
      localStorage.setItem(NAME_KEY, issuerName.trim())
    } catch {
      // the name is a convenience only
    }
    const outcome = await onCreate({
      issuerName: issuerName.trim() || undefined,
      clientName,
      clientWallet,
      project,
      description,
      amount,
      deadline,
      links: cleanLinks,
      images,
    })
    setBusy(false)
    if (outcome.ok) onCreated(outcome.record)
    else setError(outcome.message)
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      aria-label="Create invoice"
    >
      <div className="flex items-center justify-between">
        <h2 className="display text-lg font-semibold">New invoice</h2>
        <button type="button" onClick={onClose} className="min-h-11 rounded-xl px-3 text-sm font-semibold" style={{ color: 'var(--muted)' }}>
          Cancel
        </button>
      </div>

      <Field id="inv-issuer" label="Your name or business (optional)" hint="Shown as the sender of the invoice.">
        <div className={box}>
          <input id="inv-issuer" value={issuerName} maxLength={LIMITS.name} onChange={(e) => setIssuerName(e.target.value)} placeholder="Ada Freelance" className={input} autoComplete="off" />
        </div>
      </Field>

      <div className="grid grid-cols-1 gap-4">
        <Field id="inv-client" label="Client name">
          <div className={box}>
            <input id="inv-client" value={clientName} maxLength={LIMITS.name} onChange={(e) => setClientName(e.target.value)} placeholder="Acme Ltd" className={input} autoComplete="off" />
          </div>
        </Field>
        <Field id="inv-wallet" label="Client wallet address" hint="Only a payment from this wallet marks the invoice Paid.">
          <div className={box}>
            <input id="inv-wallet" value={clientWallet} onChange={(e) => setClientWallet(e.target.value)} placeholder="0x…" className={`mono ${input}`} autoComplete="off" autoCorrect="off" spellCheck={false} />
          </div>
        </Field>
        <Field id="inv-project" label="Project name">
          <div className={box}>
            <input id="inv-project" value={project} maxLength={LIMITS.project} onChange={(e) => setProject(e.target.value)} placeholder="Marketing site redesign" className={input} autoComplete="off" />
          </div>
        </Field>
        <Field id="inv-desc" label="Work description" hint={`${description.length}/${LIMITS.description}`}>
          <div className="field inner rounded-2xl px-4 py-3 transition-shadow">
            <textarea
              id="inv-desc"
              value={description}
              maxLength={LIMITS.description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="What was delivered, scope, revisions…"
              className="w-full resize-y bg-transparent text-sm outline-none placeholder:text-slate-500"
            />
          </div>
        </Field>
        <Field id="inv-amount" label="Amount (USDC)">
          <div className={`${box} flex items-center gap-2`}>
            <input
              id="inv-amount"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => {
                const v = e.target.value.replace(',', '.')
                if (/^\d*\.?\d{0,6}$/.test(v)) setAmountText(v)
              }}
              placeholder="0.00"
              className={`display ${input} text-2xl font-semibold tabular-nums`}
            />
            <span className="text-sm font-semibold" style={{ color: 'var(--muted)' }}>
              USDC
            </span>
          </div>
        </Field>
      </div>

      <fieldset>
        <legend className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
          Payment deadline
        </legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Payment deadline">
          {PRESETS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={days === d}
              onClick={() => setDays(d)}
              className="min-h-11 rounded-xl px-3.5 text-sm font-semibold"
              style={days === d ? { background: 'var(--accent-fill)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', color: 'var(--muted)' }}
            >
              {d} days
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={days === 'custom'}
            onClick={() => setDays('custom')}
            className="min-h-11 rounded-xl px-3.5 text-sm font-semibold"
            style={days === 'custom' ? { background: 'var(--accent-fill)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', color: 'var(--muted)' }}
          >
            Pick a date
          </button>
        </div>
        {days === 'custom' && (
          <div className={`${box} mt-2`}>
            <input id="inv-date" type="datetime-local" value={customDate} onChange={(e) => setCustomDate(e.target.value)} aria-label="Deadline date and time" className={`${input} [color-scheme:dark]`} />
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
          Delivery links (optional)
        </legend>
        {links.map((l, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className={`${box} w-24 shrink-0 sm:w-32`}>
              <input
                aria-label={`Link ${i + 1} label`}
                value={l.label}
                maxLength={LIMITS.linkLabel}
                onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                placeholder="Label"
                className={input}
              />
            </div>
            <div className={`${box} min-w-0 flex-1`}>
              <input
                aria-label={`Link ${i + 1} URL`}
                value={l.url}
                onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                placeholder="https://…"
                className={`mono ${input}`}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <button type="button" aria-label={`Remove link ${i + 1}`} onClick={() => setLinks(links.filter((_, j) => j !== i))} className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: 'var(--surface-strong)' }}>
              <X className="size-4" />
            </button>
          </div>
        ))}
        {links.length < LIMITS.links && (
          <button type="button" onClick={() => setLinks([...links, { label: '', url: '' }])} className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-xl px-3 text-sm font-semibold" style={{ color: 'var(--accent)' }}>
            <Plus className="size-4" aria-hidden /> Add a link
          </button>
        )}
      </fieldset>

      <fieldset>
        <legend className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
          Work images (optional)
        </legend>
        <div className="flex flex-wrap gap-2">
          {images.map((src, i) => (
            <div key={src.slice(-30) + i} className="relative size-20 overflow-hidden rounded-xl">
              <img src={src} alt={`Attached image ${i + 1}`} className="size-full object-cover" />
              <button type="button" aria-label={`Remove image ${i + 1}`} onClick={() => setImages(images.filter((_, j) => j !== i))} className="absolute right-1 top-1 grid size-6 place-items-center rounded-full" style={{ background: 'rgba(11,22,40,0.8)' }}>
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {images.length < LIMITS.images && (
            <label className="inner grid size-20 cursor-pointer place-items-center rounded-xl text-center text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
              {loadingImages ? <Loader2 className="size-5 animate-spin" aria-label="Processing image" /> : <ImagePlus className="size-5" aria-hidden />}
              <span className="sr-only">Add images</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" disabled={loadingImages} onChange={(e) => { void addImages(e.target.files); e.target.value = '' }} />
            </label>
          )}
        </div>
        <p className="mt-1.5 text-xs" style={{ color: 'var(--subtle)' }}>
          Images are resized and kept on this device. They go into the link only as small previews.
        </p>
        {imageError && (
          <p className="mt-1 text-xs" role="alert" style={{ color: 'var(--danger)' }}>
            {imageError}
          </p>
        )}
      </fieldset>

      {error && (
        <p className="rounded-xl px-3 py-2 text-sm" role="alert" style={{ background: 'rgba(239,91,91,0.12)', color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <p className="text-xs" style={{ color: 'var(--subtle)' }}>
        Your wallet will ask you to sign the invoice. Signing is free and sends no transaction. It proves to your client that you issued it.
      </p>

      <button
        type="submit"
        disabled={busy || loadingImages}
        className="inline-flex h-13 min-h-12 items-center justify-center gap-2 rounded-2xl text-base font-semibold transition-transform disabled:opacity-50"
        style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}
      >
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {busy ? 'Waiting for your signature…' : 'Create and sign invoice'}
      </button>
    </form>
  )
}
