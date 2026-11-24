import { useEffect, useMemo, useRef, useState } from 'react'
import { useModal } from 'connectkit'
import { Check, Copy, Download, ExternalLink, Loader2, RefreshCw, Share2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { useAccount } from 'wagmi'
import type { TransactionHistory } from '@/hooks/useTransactionHistory'
import { ARC_CHAIN_ID, ARC_CHAIN_NAME } from '@/lib/settings'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ActivityList } from './ActivityList'

interface ReceiveCardProps {
  history: TransactionHistory
  onViewHistory: () => void
}

export function ReceiveCard({ history, onViewHistory }: ReceiveCardProps) {
  const { address, isConnected } = useAccount()
  const { setOpen } = useModal()
  const [copied, setCopied] = useState(false)
  const [requestText, setRequestText] = useState('')
  const qrRef = useRef<HTMLDivElement>(null)
  const incoming = useMemo(() => history.items.filter((i) => i.direction === 'in'), [history.items])
  const { ensureTimes } = history
  useEffect(() => {
    ensureTimes(incoming.slice(0, 5).map((r) => r.id))
  }, [incoming, ensureTimes])

  if (!isConnected || !address) {
    return (
      <section className="glass rounded-3xl p-6 text-center" aria-label="Receive USDC">
        <p className="display text-lg font-semibold">Receive USDC</p>
        <p className="mx-auto mt-1 max-w-xs text-sm text-pretty" style={{ color: 'var(--muted)' }}>
          Connect your wallet to show your address and QR code.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 h-12 w-full rounded-2xl text-sm font-semibold"
          style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}
        >
          Connect wallet
        </button>
      </section>
    )
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      toast.success('Address copied')
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('Could not copy. Select the address and copy it manually.')
    }
  }

  const shareText = `Please send ${requestText && Number(requestText) > 0 ? `${Number(requestText)} ` : ''}USDC on ${ARC_CHAIN_NAME} Mainnet (chain ${ARC_CHAIN_ID}) to ${address}`

  const share = async () => {
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'OrbitPay payment request', text: shareText })
        return
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
    }
    try {
      await navigator.clipboard.writeText(shareText)
      toast.success('Payment request copied. Paste it into any chat.')
    } catch {
      toast.error('Could not share or copy the request.')
    }
  }

  // Saves the QR as a PNG with a white margin so it scans reliably from a screenshot or print.
  const downloadQr = async () => {
    const svg = qrRef.current?.querySelector('svg')
    if (!svg) return
    try {
      const xml = new XMLSerializer().serializeToString(svg)
      const img = new Image()
      const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('qr'))
        img.src = url
      })
      const size = 1024
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, size, size)
      ctx.drawImage(img, 64, 64, size - 128, size - 128)
      URL.revokeObjectURL(url)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('png')
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `orbitpay-${address.slice(0, 8)}.png`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(link.href), 4000)
    } catch {
      toast.error('Could not save the QR code.')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="glass relative overflow-hidden rounded-[1.75rem] p-5 sm:p-6" aria-label="Receive USDC">
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 size-60 rounded-full" style={{ background: 'radial-gradient(circle, rgba(242,138,69,0.25), rgba(242,138,69,0) 68%)' }} />
        <div className="relative flex flex-col items-center gap-5">
          <div className="text-center">
            <h2 className="display text-xl font-semibold">Payment request</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              Scan or share your address to receive USDC on {ARC_CHAIN_NAME} Mainnet.
            </p>
          </div>
          <div className="rounded-[1.6rem] p-[3px]" style={{ background: 'linear-gradient(135deg, #f28a45, #c87942 55%, #e8a66d)', boxShadow: '0 20px 44px -18px rgba(242,138,69,0.55)' }}>
            <div ref={qrRef} className="rounded-[1.45rem] bg-white p-4">
              <QRCodeSVG value={address} size={192} level="M" bgColor="#ffffff" fgColor="#101827" />
            </div>
          </div>
          <div className="inner w-full rounded-2xl px-4 py-3 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--subtle)' }}>
              Your {ARC_CHAIN_NAME} address
            </p>
            <p className="mono mt-1.5 break-all text-sm" style={{ color: 'var(--ink)' }}>
              {address}
            </p>
          </div>

          <div className="w-full">
            <label htmlFor="request-amount" className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
              Request an amount (optional)
            </label>
            <div className="field inner flex items-center gap-2 rounded-2xl px-4">
              <input
                id="request-amount"
                inputMode="decimal"
                value={requestText}
                onChange={(e) => {
                  const v = e.target.value.replace(',', '.')
                  if (/^\d*\.?\d{0,6}$/.test(v)) setRequestText(v)
                }}
                placeholder="0.00"
                autoComplete="off"
                className="display h-12 min-w-0 flex-1 bg-transparent text-lg font-semibold tabular-nums outline-none placeholder:text-slate-600"
              />
              <span className="text-sm font-semibold" style={{ color: 'var(--muted)' }}>USDC</span>
            </div>
          </div>

          <div className="grid w-full grid-cols-[1fr_auto_auto_auto] gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="flex h-12 items-center justify-center gap-2 rounded-2xl text-sm font-semibold"
              style={{ background: 'var(--accent-fill)', color: 'var(--accent-ink)' }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? 'Copied' : 'Copy address'}
            </button>
            <button
              type="button"
              onClick={() => void share()}
              aria-label="Share payment request"
              title="Share payment request"
              className="flex size-12 items-center justify-center rounded-2xl transition-colors hover:bg-white/10"
              style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            >
              <Share2 className="size-[18px]" />
            </button>
            <button
              type="button"
              onClick={() => void downloadQr()}
              aria-label="Download QR code"
              title="Download QR code"
              className="flex size-12 items-center justify-center rounded-2xl transition-colors hover:bg-white/10"
              style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            >
              <Download className="size-[18px]" />
            </button>
            <a
              href={buildAddressExplorerUrl(ARC_CHAIN_ID, address)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View address on Arc Explorer"
              title="View on Arc Explorer"
              className="flex size-12 items-center justify-center rounded-2xl transition-colors hover:bg-white/10"
              style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            >
              <ExternalLink className="size-[18px]" />
            </a>
          </div>
          <p className="text-center text-xs text-pretty" style={{ color: 'var(--muted)' }}>
            Only send USDC on Arc Mainnet to this address. Funds sent on other networks may be lost.
          </p>
        </div>
      </section>

      <section className="glass rounded-3xl p-5" aria-label="Received payments">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="display text-base font-semibold">Recent payments received</h2>
          <button
            type="button"
            onClick={history.refresh}
            aria-label="Refresh received payments"
            className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-white/10"
            style={{ color: 'var(--subtle)' }}
          >
            {history.snapshot.loadingLatest ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </button>
        </div>

        {history.snapshot.error && (
          <p className="mb-3 text-sm" role="alert" style={{ color: 'var(--danger)' }}>
            {history.snapshot.error}{' '}
            <button type="button" onClick={history.refresh} className="font-semibold underline underline-offset-4">
              Retry
            </button>
          </p>
        )}

        {!history.snapshot.hasLoaded && incoming.length === 0 ? (
          <div className="flex flex-col gap-2" aria-label="Loading payments">
            {[0, 1].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-white/10" />
            ))}
          </div>
        ) : incoming.length > 0 ? (
          <ActivityList items={incoming.slice(0, 5)} />
        ) : (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            No USDC payments received in the scanned range yet.
          </p>
        )}

        <button
          type="button"
          onClick={onViewHistory}
          className="mt-3 h-11 w-full rounded-2xl text-sm font-semibold"
          style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
        >
          View full history
        </button>
      </section>
    </div>
  )
}
