import { useState } from 'react'
import { useModal } from 'connectkit'
import { ArrowDownLeft, Check, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { useAccount } from 'wagmi'
import { useReceivedPayments } from '@/hooks/useReceivedPayments'
import { displayUsdc, shortAddress } from '@/lib/format'
import { ARC_CHAIN_ID, ARC_CHAIN_NAME } from '@/lib/settings'
import { buildAddressExplorerUrl, buildTxExplorerUrl } from '@/onchain-facts'

export function ReceiveCard() {
  const { address, isConnected } = useAccount()
  const { setOpen } = useModal()
  const [copied, setCopied] = useState(false)
  const received = useReceivedPayments()

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
            onClick={() => void received.refetch()}
            aria-label="Refresh received payments"
            className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-white/10"
            style={{ color: 'var(--subtle)' }}
          >
            {received.isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </button>
        </div>

        {received.isLoading ? (
          <div className="flex flex-col gap-2" aria-label="Loading payments">
            {[0, 1].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-2xl bg-white/10" />
            ))}
          </div>
        ) : received.isError ? (
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            Could not load payment history from the Arc RPC. Tap refresh to retry.
          </p>
        ) : received.data && received.data.payments.length > 0 ? (
          <>
            <ul className="flex flex-col gap-2">
              {received.data.payments.map((p) => (
                <li key={`${p.txHash}-${p.logIndex}`}>
                  <a
                    href={buildTxExplorerUrl(ARC_CHAIN_ID, p.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inner flex min-h-14 items-center justify-between gap-3 rounded-2xl px-3 py-2 transition-colors hover:bg-white/10"
                  >
                    <span className="flex items-center gap-3">
                      <span className="flex size-9 items-center justify-center rounded-full" style={{ background: 'rgba(141,216,159,0.12)' }}>
                        <ArrowDownLeft className="size-4" style={{ color: 'var(--success)' }} />
                      </span>
                      <span>
                        <span className="block text-sm font-semibold tabular-nums">+{displayUsdc(p.amount)} USDC</span>
                        <span className="mono block text-xs" style={{ color: 'var(--subtle)' }}>
                          from {shortAddress(p.from)}
                        </span>
                      </span>
                    </span>
                    <span className="flex items-center gap-1 text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
                      #{p.blockNumber.toString()}
                      <ExternalLink className="size-3" />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <ScanNote scanned={received.data.scannedBlocks} />
          </>
        ) : (
          <>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              No USDC payments received in the scanned range.
            </p>
            {received.data && <ScanNote scanned={received.data.scannedBlocks} />}
          </>
        )}
      </section>
    </div>
  )
}

function ScanNote({ scanned }: { scanned: bigint }) {
  return (
    <p className="mt-3 text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
      Read from onchain USDC transfer events over the latest {scanned.toLocaleString('en-US')} blocks. Older payments are on the explorer.
    </p>
  )
}
