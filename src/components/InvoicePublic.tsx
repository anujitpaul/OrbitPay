import { useEffect, useRef, useState } from 'react'
import { useModal } from 'connectkit'
import { AlertTriangle, Download, Loader2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { useAccount, useSwitchChain } from 'wagmi'
import { arcMainnet } from '@/config'
import { useInvoiceLookup } from '@/hooks/useInvoiceLookup'
import { useSendPayment } from '@/hooks/useSendPayment'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { displayUsdc, shortAddress } from '@/lib/format'
import { addressEq, decodeInvoice, verifyInvoiceSignature } from '@/lib/invoice/codec'
import { downloadInvoicePdf } from '@/lib/invoice/pdf'
import { rpcPool } from '@/lib/rpcPool'
import { settings } from '@/lib/settings'
import { invoiceMemo, invoiceStatus, type SignedInvoice } from '@/lib/invoice/types'
import { InvoiceDocument, formatDateTime } from './InvoiceDocument'
import { TxStatus } from './TxStatus'

type Loaded = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; signed: SignedInvoice; images: string[] }

function Notice({ tone, children }: { tone: 'warn' | 'danger' | 'info'; children: React.ReactNode }) {
  const color = tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--muted)'
  return (
    <p className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm" role="alert" style={{ background: 'rgba(255,255,255,0.05)', color }}>
      {tone !== 'info' && <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span>{children}</span>
    </p>
  )
}

/** The page a client sees when they open an invoice link or scan its QR code. Viewing needs no wallet. */
export function InvoicePublic({ encoded, onExit }: { encoded: string; onExit: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [signatureValid, setSignatureValid] = useState<boolean | undefined>(undefined)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    let alive = true
    void decodeInvoice(encoded).then(async (result) => {
      if (!alive) return
      if (!result.ok) return setLoaded({ state: 'error', error: result.error })
      setLoaded({ state: 'ok', signed: result.signed, images: result.images })
      const ok = await verifyInvoiceSignature(result.signed, rpcPool.endpoints[0]?.client)
      if (alive) setSignatureValid(ok)
    })
    return () => {
      alive = false
    }
  }, [encoded])

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(t)
  }, [])

  const signed = loaded.state === 'ok' ? loaded.signed : undefined
  // Nothing is looked up on chain for an invoice whose signature failed: it is not trusted.
  const lookup = useInvoiceLookup(signed, signatureValid === true)

  if (loaded.state === 'loading') {
    return (
      <section className="glass flex items-center justify-center gap-2 rounded-3xl p-10 text-sm" style={{ color: 'var(--muted)' }} role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Opening invoice…
      </section>
    )
  }
  if (loaded.state === 'error') {
    return (
      <section className="glass flex flex-col items-center gap-4 rounded-3xl p-8 text-center" role="alert" aria-label="Invoice unavailable">
        <AlertTriangle className="size-8" style={{ color: 'var(--warn)' }} aria-hidden />
        <div>
          <h1 className="display text-lg font-semibold">This invoice can’t be opened</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            {loaded.error} Ask the sender for a fresh link.
          </p>
        </div>
        <button type="button" onClick={onExit} className="min-h-11 rounded-xl px-4 text-sm font-semibold" style={{ background: 'var(--surface-strong)' }}>
          Open OrbitPay
        </button>
      </section>
    )
  }

  const { data } = loaded.signed
  const status = invoiceStatus({ signed: loaded.signed, payment: lookup.payment }, now)
  return (
    <div className="flex flex-col gap-4">
      <InvoiceDocument
        data={data}
        images={loaded.images}
        status={status}
        payment={lookup.payment}
        signatureValid={signatureValid}
        duplicates={lookup.duplicates}
        missingImages={Math.max(0, data.imageHashes.length - loaded.images.length)}
      />
      {signatureValid === false && <Notice tone="danger">This invoice’s signature is invalid, so it may have been altered. Do not pay it. Ask the sender for a fresh link.</Notice>}
      {signatureValid === true && !lookup.payment && status !== 'paid' && <PayPanel signed={loaded.signed} status={status} lookup={lookup} />}
      {lookup.payment && (
        <section className="glass rounded-3xl p-5 text-sm" style={{ color: 'var(--muted)' }} aria-label="Payment received">
          <p className="font-semibold" style={{ color: 'var(--success)' }}>
            This invoice is paid.
          </p>
          <p className="mt-1">Paid {lookup.payment.timestamp ? formatDateTime(lookup.payment.timestamp) : 'onchain'}. Nothing more is due.</p>
        </section>
      )}
      {lookup.error && (
        <p className="text-xs" role="status" style={{ color: 'var(--warn)' }}>
          {lookup.error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold"
          style={{ background: 'var(--surface-strong)' }}
          onClick={() => {
            void downloadInvoicePdf({ data, images: loaded.images, status, payment: lookup.payment, link: window.location.href }).catch(() => toast.error('The PDF could not be created.'))
          }}
        >
          <Download className="size-4" aria-hidden /> Download PDF
        </button>
        <button type="button" onClick={onExit} className="min-h-11 rounded-xl px-3 text-sm font-semibold" style={{ color: 'var(--muted)' }}>
          Open OrbitPay
        </button>
      </div>
    </div>
  )
}

function PayPanel({ signed, status, lookup }: { signed: SignedInvoice; status: ReturnType<typeof invoiceStatus>; lookup: ReturnType<typeof useInvoiceLookup> }) {
  const data = signed.data
  const amount = BigInt(data.amount)
  const { address, isConnected, chainId } = useAccount()
  const { setOpen } = useModal()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { balance } = useUsdcBalance()
  const { state, send, reset } = useSendPayment()
  const [reviewing, setReviewing] = useState(false)
  const confirmedFor = useRef<string | undefined>(undefined)
  const [verifyMessage, setVerifyMessage] = useState<string | undefined>(undefined)
  const busy = state.phase !== 'idle'

  // After a payment succeeds, the invoice is only marked Paid once its receipt has been checked against the invoice.
  useEffect(() => {
    if (state.phase === 'success' && state.hash && confirmedFor.current !== state.hash) {
      confirmedFor.current = state.hash
      void lookup.confirmHash(state.hash).then(setVerifyMessage)
    }
  }, [state.phase, state.hash, lookup])

  const sameToken = addressEq(data.usdc, settings.usdcAddress)
  const wrongWallet = isConnected && address && !addressEq(address, data.client.wallet)
  const wrongNetwork = isConnected && chainId !== arcMainnet.id
  const lowBalance = balance !== undefined && balance < amount
  const memo = invoiceMemo(data.id)

  const pay = () => {
    setReviewing(false)
    setVerifyMessage(undefined)
    void send(data.to, amount, memo)
  }

  let blocker: React.ReactNode
  if (!sameToken) blocker = <Notice tone="danger">This invoice uses a different USDC contract than this app is set to. Do not pay it here.</Notice>
  else if (status === 'expired') blocker = <Notice tone="warn">This invoice expired on {formatDateTime(data.deadline)}. Ask {data.issuerName ?? 'the sender'} for a new one.</Notice>
  else if (wrongWallet) {
    blocker = (
      <Notice tone="warn">
        Connected wallet {shortAddress(address)} is not the client wallet. Switch your wallet to <span className="break-all font-mono">{data.client.wallet}</span> to pay this invoice. Payments from other wallets are not recognised.
      </Notice>
    )
  } else if (lookup.payment) blocker = undefined

  return (
    <section className="glass flex flex-col gap-4 rounded-3xl p-5" aria-label="Pay invoice">
      <h2 className="display text-lg font-semibold">Pay this invoice</h2>
      {blocker}
      {!blocker && (
        <>
          {busy ? (
            <TxStatus state={state} onDone={reset} onEdit={reset} onRetry={pay} />
          ) : reviewing ? (
            <div className="flex flex-col gap-3">
              <dl className="inner flex flex-col gap-2 rounded-2xl p-4 text-sm">
                <div className="flex justify-between gap-3">
                  <dt style={{ color: 'var(--muted)' }}>Amount</dt>
                  <dd className="font-semibold tabular-nums">{displayUsdc(amount)} USDC</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt style={{ color: 'var(--muted)' }}>To</dt>
                  <dd className="break-all text-right font-mono text-xs">{data.to}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt style={{ color: 'var(--muted)' }}>Invoice</dt>
                  <dd className="font-mono text-xs">{data.id}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt style={{ color: 'var(--muted)' }}>Route</dt>
                  <dd className="text-right text-xs">{settings.orbitPayAddress ? 'OrbitPay contract (invoice ID attached)' : 'Direct USDC transfer'}</dd>
                </div>
              </dl>
              <p className="text-xs" style={{ color: 'var(--subtle)' }}>
                Real USDC on Arc Mainnet. Payments cannot be reversed. Your wallet asks you to confirm {settings.orbitPayAddress ? 'an approval (if needed) and then the payment' : 'the payment'}.
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setReviewing(false)} className="min-h-12 flex-1 rounded-2xl font-semibold" style={{ background: 'var(--surface-strong)' }}>
                  Back
                </button>
                <button type="button" onClick={pay} className="min-h-12 flex-[2] rounded-2xl font-semibold" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
                  Confirm in wallet
                </button>
              </div>
            </div>
          ) : !isConnected ? (
            <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl font-semibold" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
              <Wallet className="size-4" aria-hidden /> Connect wallet to pay
            </button>
          ) : wrongNetwork ? (
            <button type="button" disabled={switching} onClick={() => switchChain({ chainId: arcMainnet.id })} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl font-semibold disabled:opacity-60" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
              {switching && <Loader2 className="size-4 animate-spin" aria-hidden />} Switch to Arc Mainnet
            </button>
          ) : (
            <>
              {lowBalance && <Notice tone="warn">Your USDC balance ({displayUsdc(balance ?? 0n)}) is lower than this invoice ({displayUsdc(amount)}).</Notice>}
              <button
                type="button"
                disabled={!lookup.firstCheckDone || lowBalance}
                onClick={() => setReviewing(true)}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl font-semibold disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
              >
                {!lookup.firstCheckDone ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden /> Checking it has not been paid…
                  </>
                ) : (
                  <>Pay {displayUsdc(amount)} USDC</>
                )}
              </button>
              {!lookup.firstCheckDone && (
                <p className="text-xs" style={{ color: 'var(--subtle)' }}>
                  OrbitPay first checks Arc for an earlier payment of this invoice, so you are never charged twice.
                </p>
              )}
            </>
          )}
          {verifyMessage && <Notice tone="warn">{verifyMessage}</Notice>}
        </>
      )}
      <p className="text-xs" style={{ color: 'var(--subtle)' }}>
        The amount and recipient are fixed by the signed invoice. The invoice only shows Paid after a USDC Transfer for exactly this amount, from {shortAddress(data.client.wallet)} to {shortAddress(data.to)}, is verified in its onchain receipt.
      </p>
    </section>
  )
}
