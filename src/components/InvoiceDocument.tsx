import { CheckCircle2, Clock, ExternalLink, Link2, ShieldCheck, ShieldAlert, XCircle } from 'lucide-react'
import { displayUsdc, shortAddress } from '@/lib/format'
import { addressEq } from '@/lib/invoice/codec'
import type { InvoiceData, InvoiceStatus, PaymentProof } from '@/lib/invoice/types'
import { buildAddressExplorerUrl, buildTxExplorerUrl } from '@/onchain-facts'

export const STATUS_COPY: Record<InvoiceStatus, { label: string; color: string; Icon: typeof Clock }> = {
  pending: { label: 'Pending', color: 'var(--warn)', Icon: Clock },
  paid: { label: 'Paid', color: 'var(--success)', Icon: CheckCircle2 },
  expired: { label: 'Expired', color: 'var(--subtle)', Icon: Clock },
  cancelled: { label: 'Cancelled', color: 'var(--danger)', Icon: XCircle },
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const { label, color, Icon } = STATUS_COPY[status]
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ color, background: 'color-mix(in srgb, currentColor 14%, transparent)' }}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  )
}

export function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatDateTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const paper = { background: '#f6f8fc', color: '#0b1628' }
const quiet = { color: '#5b6b82' }

function Label({ children }: { children: string }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider" style={quiet}>
      {children}
    </p>
  )
}

interface InvoiceDocumentProps {
  data: InvoiceData
  images: string[]
  status: InvoiceStatus
  payment?: PaymentProof
  /** undefined while the issuer signature is still being checked. */
  signatureValid?: boolean
  duplicates?: string[]
  /** How many attached images exist but are not inside this link. */
  missingImages?: number
}

/** The invoice as the client sees it. Always a light "paper" card so it reads like a document and matches the PDF. */
export function InvoiceDocument({ data, images, status, payment, signatureValid, duplicates = [], missingImages = 0 }: InvoiceDocumentProps) {
  const isIssuer = (a: string) => addressEq(a as `0x${string}`, data.to)
  return (
    <article className="overflow-hidden rounded-3xl shadow-lg" style={paper} aria-label={`Invoice ${data.id}`}>
      <header className="flex items-start justify-between gap-3 px-5 pb-4 pt-5" style={{ background: '#0f2038', color: '#e8eef8' }}>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: '#9fb6d6' }}>
            Invoice
          </p>
          <p className="mt-0.5 break-all font-mono text-lg font-semibold">{data.id}</p>
        </div>
        <InvoiceStatusBadge status={status} />
      </header>

      <div className="flex flex-col gap-5 px-5 py-5">
        <div className="flex flex-col gap-1">
          <Label>Amount due</Label>
          <p className="display text-4xl font-bold tabular-nums">
            {displayUsdc(BigInt(data.amount))} <span className="text-lg font-semibold" style={quiet}>USDC</span>
          </p>
          <p className="text-xs" style={quiet}>
            Payable on Arc Mainnet. Issued {formatDate(data.createdAt)} · Due {formatDate(data.deadline)}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <Label>From</Label>
            <p className="mt-1 break-words text-sm font-semibold">{data.issuerName ?? 'Freelancer'}</p>
            <a href={buildAddressExplorerUrl(data.chainId, data.to)} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-xs underline-offset-2 hover:underline" style={quiet}>
              {data.to}
            </a>
          </div>
          <div className="min-w-0">
            <Label>Billed to</Label>
            <p className="mt-1 break-words text-sm font-semibold">{data.client.name}</p>
            <a href={buildAddressExplorerUrl(data.chainId, data.client.wallet)} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-xs underline-offset-2 hover:underline" style={quiet}>
              {data.client.wallet}
            </a>
          </div>
        </div>

        <div className="min-w-0">
          <Label>Project</Label>
          <p className="mt-1 break-words text-base font-semibold">{data.project}</p>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed" style={{ color: '#26364d' }}>
            {data.description}
          </p>
        </div>

        {data.links.length > 0 && (
          <div>
            <Label>Delivery links</Label>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {data.links.map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold"
                    style={{ background: '#e4ebf6', color: '#17406f' }}
                  >
                    <Link2 className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{link.label || new URL(link.url).hostname}</span>
                    <span className="hidden truncate text-xs font-normal sm:inline" style={quiet}>
                      {new URL(link.url).hostname}
                    </span>
                    <ExternalLink className="size-3 shrink-0" aria-hidden />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(images.length > 0 || missingImages > 0) && (
          <div>
            <Label>Work samples</Label>
            {images.length > 0 && (
              <ul className="mt-1.5 grid grid-cols-2 gap-2">
                {images.map((src, i) => (
                  <li key={src.slice(-40) + i} className="overflow-hidden rounded-xl" style={{ background: '#e4ebf6' }}>
                    <img src={src} alt={`Work sample ${i + 1}`} className="aspect-[4/3] w-full object-cover" loading="lazy" />
                  </li>
                ))}
              </ul>
            )}
            {missingImages > 0 && (
              <p className="mt-1.5 text-xs" style={quiet}>
                {missingImages} more image{missingImages === 1 ? ' is' : 's are'} attached to this invoice but not included in this link. Ask {data.issuerName ?? 'the issuer'} for the version with images.
              </p>
            )}
          </div>
        )}

        {payment && (
          <div className="rounded-2xl p-3.5" style={{ background: '#e3f4e8', color: '#14532d' }}>
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <CheckCircle2 className="size-4" aria-hidden /> Payment verified onchain
            </p>
            <p className="mt-1 text-xs">
              {displayUsdc(BigInt(payment.amount))} USDC from {shortAddress(payment.from)} · {payment.via === 'orbitpay' ? 'through OrbitPay' : 'direct transfer'}
              {payment.timestamp ? ` · ${formatDateTime(payment.timestamp)}` : ''}
            </p>
            <a href={buildTxExplorerUrl(data.chainId, payment.hash)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-9 items-center gap-1 break-all font-mono text-xs font-semibold underline-offset-2 hover:underline">
              {payment.hash}
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
          </div>
        )}

        {duplicates.length > 0 && (
          <div className="rounded-2xl p-3.5 text-xs" style={{ background: '#fdf0d5', color: '#6b4a07' }} role="alert">
            <p className="font-semibold">Possible double payment</p>
            <p className="mt-0.5">
              {duplicates.length} more payment{duplicates.length === 1 ? '' : 's'} of the same amount from the client wallet {duplicates.length === 1 ? 'was' : 'were'} found:
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {duplicates.map((h) => (
                <li key={h}>
                  <a href={buildTxExplorerUrl(data.chainId, h)} target="_blank" rel="noopener noreferrer" className="break-all font-mono underline">
                    {h}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <footer className="flex items-start gap-2 border-t pt-3 text-xs" style={{ ...quiet, borderColor: '#d5deec' }}>
          {signatureValid === false ? (
            <ShieldAlert className="mt-0.5 size-4 shrink-0" style={{ color: '#b3261e' }} aria-hidden />
          ) : (
            <ShieldCheck className="mt-0.5 size-4 shrink-0" style={{ color: signatureValid ? '#1b7a3a' : '#5b6b82' }} aria-hidden />
          )}
          <p>
            {signatureValid === undefined && 'Checking the issuer’s signature…'}
            {signatureValid === true && (
              <>
                Signed by the issuer’s wallet {isIssuer(data.to) ? shortAddress(data.to) : ''}. The amount, payee and dates cannot be changed without breaking this signature.
              </>
            )}
            {signatureValid === false && 'The issuer’s signature does not match this invoice. Do not pay it.'}
          </p>
        </footer>
      </div>
    </article>
  )
}
