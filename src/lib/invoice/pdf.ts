import { displayUsdc } from '@/lib/format'
import { buildTxExplorerUrl } from '@/onchain-facts'
import type { InvoiceData, InvoiceStatus, PaymentProof } from './types'

/** The built-in PDF fonts only cover Latin-1, so anything else is shown as "?" rather than as garbage. */
export function pdfText(text: string): string {
  return Array.from(text.replace(/[\r\t]/g, ' '))
    .map((ch) => (ch === '\n' || (ch.codePointAt(0) ?? 0) <= 0xff ? ch : '?'))
    .join('')
}

const STATUS_LABEL: Record<InvoiceStatus, string> = { pending: 'PENDING', paid: 'PAID', expired: 'EXPIRED', cancelled: 'CANCELLED' }
const STATUS_RGB: Record<InvoiceStatus, [number, number, number]> = {
  pending: [180, 120, 10],
  paid: [27, 122, 58],
  expired: [100, 110, 125],
  cancelled: [179, 38, 30],
}

export interface PdfInput {
  data: InvoiceData
  images: string[]
  status: InvoiceStatus
  payment?: PaymentProof
  /** The shareable invoice link, shown as a QR code so the PDF can be paid from a phone. */
  link?: string
}

function fmt(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Builds the invoice PDF in the browser (nothing is uploaded) and returns it as a Blob. */
export async function buildInvoicePdf(input: PdfInput): Promise<Blob> {
  const [{ jsPDF }, QR] = await Promise.all([import('jspdf'), import('qrcode')])
  const { data, images, status, payment, link } = input
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 44
  const inner = W - M * 2
  let y = 0

  const ensure = (needed: number) => {
    if (y + needed > H - 54) {
      doc.addPage()
      y = M
    }
  }
  const text = (value: string, x: number, size: number, opts: { bold?: boolean; color?: [number, number, number]; width?: number; gap?: number } = {}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal').setFontSize(size)
    doc.setTextColor(...(opts.color ?? [20, 32, 52]))
    const lines = doc.splitTextToSize(pdfText(value), opts.width ?? inner) as string[]
    for (const line of lines) {
      ensure(size + 4)
      doc.text(line, x, y)
      y += size + 4
    }
    y += opts.gap ?? 0
  }
  const label = (value: string) => {
    ensure(24)
    text(value.toUpperCase(), M, 8, { bold: true, color: [95, 110, 132] })
  }

  // header band
  doc.setFillColor(15, 32, 56)
  doc.rect(0, 0, W, 92, 'F')
  doc.setTextColor(159, 182, 214).setFont('helvetica', 'bold').setFontSize(9)
  doc.text('INVOICE', M, 36)
  doc.setTextColor(232, 238, 248).setFontSize(20)
  doc.text(data.id, M, 62)
  const [r, g, b] = STATUS_RGB[status]
  doc.setFillColor(r, g, b)
  doc.roundedRect(W - M - 96, 30, 96, 26, 6, 6, 'F')
  doc.setTextColor(255, 255, 255).setFontSize(10)
  doc.text(STATUS_LABEL[status], W - M - 48, 47, { align: 'center' })
  y = 128

  // amount
  label('Amount due')
  text(`${displayUsdc(BigInt(data.amount))} USDC`, M, 26, { bold: true, gap: 2 })
  text(`Payable on Arc Mainnet (chain ${data.chainId}) in USDC.   Issued ${fmt(data.createdAt)}   Due ${fmt(data.deadline)}`, M, 9, { color: [95, 110, 132], gap: 14 })

  // parties
  const colW = (inner - 24) / 2
  const startY = y
  label('From')
  text(data.issuerName ?? 'Freelancer', M, 11, { bold: true, width: colW })
  text(data.to, M, 8, { color: [95, 110, 132], width: colW })
  const afterLeft = y
  y = startY
  doc.setTextColor(95, 110, 132)
  const x2 = M + colW + 24
  text('BILLED TO', x2, 8, { bold: true, color: [95, 110, 132], width: colW })
  text(data.client.name, x2, 11, { bold: true, width: colW })
  text(data.client.wallet, x2, 8, { color: [95, 110, 132], width: colW })
  y = Math.max(afterLeft, y) + 12

  label('Project')
  text(data.project, M, 13, { bold: true, gap: 2 })
  text(data.description, M, 10, { color: [38, 54, 77], gap: 10 })

  if (data.links.length) {
    label('Delivery links')
    for (const l of data.links) text(`${l.label ? `${l.label}: ` : ''}${l.url}`, M, 9, { color: [23, 64, 111] })
    y += 8
  }

  if (images.length) {
    label('Work samples')
    const cell = (inner - 12) / 2
    let col = 0
    let rowTop = y
    for (const src of images) {
      const h = cell * 0.72
      if (col === 0) {
        ensure(h + 8)
        rowTop = y
      }
      try {
        doc.addImage(src, 'JPEG', M + col * (cell + 12), rowTop, cell, h, undefined, 'FAST')
      } catch {
        // an unreadable preview is skipped rather than failing the whole PDF
      }
      col += 1
      if (col === 2) {
        col = 0
        y = rowTop + h + 10
      }
    }
    if (col === 1) y = rowTop + cell * 0.72 + 10
    y += 4
  }

  if (payment) {
    ensure(70)
    doc.setFillColor(227, 244, 232)
    doc.roundedRect(M, y, inner, 58, 6, 6, 'F')
    const top = y
    y += 16
    text('Payment verified onchain', M + 12, 10, { bold: true, color: [20, 83, 45], width: inner - 24 })
    text(`${displayUsdc(BigInt(payment.amount))} USDC from ${payment.from}${payment.timestamp ? `  ${fmt(payment.timestamp)}` : ''}`, M + 12, 8, { color: [20, 83, 45], width: inner - 24 })
    text(buildTxExplorerUrl(data.chainId, payment.hash), M + 12, 7, { color: [20, 83, 45], width: inner - 24 })
    y = top + 70
  } else if (link) {
    ensure(120)
    const dataUrl = await QR.toDataURL(link, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
    doc.addImage(dataUrl, 'PNG', M, y, 96, 96)
    const top = y
    y = top + 14
    text('Pay this invoice', M + 112, 11, { bold: true, width: inner - 112 })
    text('Scan the QR code or open the invoice link, connect the wallet named above and pay on Arc Mainnet. Payment is checked against the chain; the invoice only shows Paid after a matching USDC Transfer is verified.', M + 112, 8, { color: [95, 110, 132], width: inner - 112 })
    y = top + 108
  }

  // footer on every page
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(130, 140, 155)
    doc.text(`Issued by OrbitPay on Arc Mainnet   ${data.id}   Page ${p} of ${pages}`, M, H - 28)
  }
  return doc.output('blob')
}

export async function downloadInvoicePdf(input: PdfInput): Promise<void> {
  const blob = await buildInvoicePdf(input)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${input.data.id}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
