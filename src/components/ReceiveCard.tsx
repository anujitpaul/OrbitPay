import { useEffect, useMemo, useState } from 'react'
import { useModal } from 'connectkit'
import { Check, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
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
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
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

  return (
    <div className="flex flex-col gap-4">
      <section className="glass rounded-3xl p-5" aria-label="Receive USDC">
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-2xl bg-white p-3">
            <QRCodeSVG value={address} size={176} level="M" bgColor="#ffffff" fgColor="#0b1628" />
          </div>
          <div className="w-full text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
              Your {ARC_CHAIN_NAME} address
            </p>
            <p className="mono mt-1.5 break-all text-sm" style={{ color: 'var(--ink)' }}>
              {address}
            </p>
          </div>
          <div className="flex w-full gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl text-sm font-semibold transition-transform active:scale-[0.99]"
              style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? 'Copied' : 'Copy address'}
            </button>
            <a
              href={buildAddressExplorerUrl(ARC_CHAIN_ID, address)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View address on Arc Explorer"
              className="flex size-12 items-center justify-center rounded-2xl"
              style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            >
              <ExternalLink className="size-4" />
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
