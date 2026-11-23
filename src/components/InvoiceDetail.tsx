import { useEffect, useState } from 'react'
import { ArrowLeft, Copy, Download, ExternalLink, Image as ImageIcon, Loader2, RefreshCw, Share2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { useInvoiceLinks } from '@/hooks/useInvoiceLinks'
import { rpcPool } from '@/lib/rpcPool'
import { verifyInvoiceSignature } from '@/lib/invoice/codec'
import { copyText } from '@/lib/invoice/clipboard'
import { downloadInvoicePdf } from '@/lib/invoice/pdf'
import { invoiceStatus, type InvoiceRecord } from '@/lib/invoice/types'
import { InvoiceDocument } from './InvoiceDocument'

interface InvoiceDetailProps {
  record: InvoiceRecord
  now: number
  checking: boolean
  onBack: () => void
  onCancel: (id: string) => void
  onRecheck: () => void
}

const actionBtn = 'inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors disabled:opacity-50'

export function InvoiceDetail({ record, now, checking, onBack, onCancel, onRecheck }: InvoiceDetailProps) {
  const { signed, images } = record
  const data = signed.data
  const status = invoiceStatus(record, now)
  const links = useInvoiceLinks(signed, images)
  const [signatureValid, setSignatureValid] = useState<boolean | undefined>(undefined)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void verifyInvoiceSignature(signed, rpcPool.endpoints[0]?.client).then((ok) => {
      if (alive) setSignatureValid(ok)
    })
    return () => {
      alive = false
    }
  }, [signed])

  const copy = async (text: string | undefined, done: string) => {
    if (!text) return
    const ok = await copyText(text)
    if (ok) toast.success(done)
    else toast.error('Could not copy. Select the link and copy it manually.')
  }

  const share = async (url: string | undefined) => {
    if (!url) return
    const payload = { title: `Invoice ${data.id}`, text: `Invoice ${data.id} for ${data.project}`, url }
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(payload)
        return
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
      }
    }
    const ok = await copyText(url)
    if (ok) toast.success('Sharing is not available here, so the link was copied instead.')
    else toast.error('Could not share or copy the link.')
  }

  const pdf = async () => {
    setPdfBusy(true)
    try {
      await downloadInvoicePdf({ data, images, status, payment: record.payment, link: links.compact })
    } catch {
      toast.error('The PDF could not be created. Please try again.')
    } finally {
      setPdfBusy(false)
    }
  }

  const live = status === 'pending' || status === 'expired'
  const imageKb = Math.round(links.fullChars / 1024)

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-xl px-2 text-sm font-semibold" style={{ color: 'var(--muted)' }}>
        <ArrowLeft className="size-4" aria-hidden /> All invoices
      </button>

      <InvoiceDocument data={data} images={images} status={status} payment={record.payment} signatureValid={signatureValid} duplicates={record.duplicates} missingImages={Math.max(0, data.imageHashes.length - images.length)} />

      {status !== 'cancelled' && (
        <section className="glass flex flex-col gap-4 rounded-3xl p-5" aria-label="Share invoice">
          <h3 className="display text-base font-semibold">Share with your client</h3>
          {links.error && (
            <p className="text-sm" role="alert" style={{ color: 'var(--danger)' }}>
              The link could not be created.
            </p>
          )}
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <div className="rounded-2xl bg-white p-3" aria-label="Invoice QR code">
              {links.compact ? <QRCodeSVG value={links.compact} size={148} level="M" /> : <div className="grid size-[148px] place-items-center"><Loader2 className="size-6 animate-spin" style={{ color: '#0b1628' }} aria-label="Creating link" /></div>}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 self-stretch">
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                The QR code opens this invoice. Your client views it without a wallet and connects only to pay.
              </p>
              <p className="inner break-all rounded-xl px-3 py-2 font-mono text-[11px]" style={{ color: 'var(--subtle)' }} aria-label="Invoice link">
                {links.compact ? `${links.compact.slice(0, 64)}…` : 'Creating link…'}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={actionBtn} style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }} disabled={!links.compact} onClick={() => void copy(links.compact, 'Invoice link copied')}>
                  <Copy className="size-4" aria-hidden /> Copy link
                </button>
                <button type="button" className={actionBtn} style={{ background: 'var(--surface-strong)' }} disabled={!links.compact} onClick={() => void share(links.full ?? links.compact)}>
                  <Share2 className="size-4" aria-hidden /> Share invoice
                </button>
              </div>
              {links.full && (
                <button type="button" className={`${actionBtn} flex-none`} style={{ background: 'var(--surface-strong)' }} onClick={() => void copy(links.full, 'Link with images copied')}>
                  <ImageIcon className="size-4" aria-hidden /> Copy link with images ({imageKb} KB)
                </button>
              )}
              {links.full && imageKb > 100 && (
                <p className="text-xs" style={{ color: 'var(--warn)' }}>
                  The link with images is long. Some chat apps cut very long links, so send it by email or file if it does not open.
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={actionBtn} style={{ background: 'var(--surface-strong)' }} disabled={pdfBusy} onClick={() => void pdf()}>
              {pdfBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />} Download PDF
            </button>
            {links.compact && (
              <a href={links.compact} target="_blank" rel="noopener noreferrer" className={actionBtn} style={{ background: 'var(--surface-strong)' }}>
                <ExternalLink className="size-4" aria-hidden /> Preview as client
              </a>
            )}
          </div>
        </section>
      )}

      <section className="glass flex flex-col gap-3 rounded-3xl p-5" aria-label="Payment status">
        <div className="flex items-center justify-between gap-3">
          <h3 className="display text-base font-semibold">Payment</h3>
          <button type="button" onClick={onRecheck} disabled={checking} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold disabled:opacity-60" style={{ color: 'var(--accent)' }}>
            <RefreshCw className={`size-4 ${checking ? 'animate-spin' : ''}`} aria-hidden /> {checking ? 'Checking Arc…' : 'Check now'}
          </button>
        </div>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {record.payment
            ? 'A matching payment was found and verified from its onchain receipt.'
            : status === 'cancelled'
              ? 'This invoice is cancelled on this device. Links you already sent still open and can still be paid, so tell your client.'
              : 'Waiting for a USDC payment of the exact amount from the client wallet. OrbitPay checks Arc Mainnet automatically and marks it Paid only after verifying the receipt.'}
        </p>
        {live && !confirmCancel && (
          <button type="button" onClick={() => setConfirmCancel(true)} className="min-h-11 self-start rounded-xl px-3 text-sm font-semibold" style={{ color: 'var(--danger)' }}>
            Cancel invoice
          </button>
        )}
        {live && confirmCancel && (
          <div className="inner flex flex-col gap-2 rounded-2xl p-3" role="alert">
            <p className="text-sm">Cancel {data.id}? It stays in your list as Cancelled. A payment that still arrives is detected and shown, never ignored.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => { onCancel(data.id); setConfirmCancel(false) }} className={actionBtn} style={{ background: 'var(--danger)', color: '#2a0a10' }}>
                Yes, cancel it
              </button>
              <button type="button" onClick={() => setConfirmCancel(false)} className={actionBtn} style={{ background: 'var(--surface-strong)' }}>
                Keep invoice
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
