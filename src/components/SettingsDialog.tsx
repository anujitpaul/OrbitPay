import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import {
  DEFAULT_RPC_URL,
  DEFAULT_USDC_ADDRESS,
  cleanAddress,
  cleanUrl,
  readOverrides,
  saveOverrides,
  settings,
} from '@/lib/settings'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  return <AnimatePresence>{open && <SettingsPanel onClose={onClose} />}</AnimatePresence>
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [initial] = useState(readOverrides)
  const [rpc, setRpc] = useState(initial.rpcUrl ?? '')
  const [usdc, setUsdc] = useState(initial.usdcAddress ?? '')
  const [orbitPay, setOrbitPay] = useState(initial.orbitPayAddress ?? '')
  const [error, setError] = useState<string>()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = () => {
    const next = { rpcUrl: rpc.trim(), usdcAddress: usdc.trim(), orbitPayAddress: orbitPay.trim() }
    if (next.rpcUrl && !cleanUrl(next.rpcUrl)) return setError('RPC URL must start with https:// (or http://).')
    if (next.usdcAddress && !cleanAddress(next.usdcAddress)) return setError('USDC address is not a valid address.')
    if (next.orbitPayAddress && !cleanAddress(next.orbitPayAddress)) return setError('OrbitPay contract address is not a valid address.')
    saveOverrides({
      rpcUrl: cleanUrl(next.rpcUrl),
      usdcAddress: cleanAddress(next.usdcAddress),
      orbitPayAddress: cleanAddress(next.orbitPayAddress),
    })
    window.location.reload() // chain config is read once at startup
  }

  const reset = () => {
    saveOverrides({})
    window.location.reload()
  }

  return (
    <>
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            className="relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl p-5 sm:rounded-3xl"
            style={{ background: '#0f1f36', border: '1px solid var(--border)' }}
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="display text-lg font-semibold">Settings</h2>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close settings"
                className="flex size-11 items-center justify-center rounded-full hover:bg-white/10"
              >
                <X className="size-5" />
              </button>
            </div>

            <div className="flex flex-col gap-4">
              <Field
                id="s-orbitpay"
                label="OrbitPay contract address"
                hint="Your deployed OrbitPay.sol. Leave empty to send direct USDC transfers."
                value={orbitPay}
                onChange={setOrbitPay}
                placeholder={settings.orbitPayAddress ?? '0x… (optional)'}
              />
              <Field
                id="s-usdc"
                label="USDC contract address"
                hint={`Default: ${DEFAULT_USDC_ADDRESS}`}
                value={usdc}
                onChange={setUsdc}
                placeholder={settings.usdcAddress}
              />
              <Field
                id="s-rpc"
                label="Arc RPC URL"
                hint={`Default: ${DEFAULT_RPC_URL}`}
                value={rpc}
                onChange={setRpc}
                placeholder={settings.rpcUrl}
                mono={false}
              />
              <p className="text-xs text-pretty" style={{ color: settings.walletConnectProjectId ? 'var(--success)' : 'var(--warn)' }}>
                {settings.walletConnectProjectId
                  ? 'WalletConnect is on: mobile wallets can connect by QR code or deep link.'
                  : 'WalletConnect is off: set VITE_WALLETCONNECT_PROJECT_ID to let mobile wallets connect by QR code. Browser extensions work without it.'}
              </p>
              {usdc.trim() !== '' && cleanAddress(usdc)?.toLowerCase() !== DEFAULT_USDC_ADDRESS.toLowerCase() && (
                <p className="text-xs text-pretty" style={{ color: 'var(--warn)' }}>
                  This is not the official Arc USDC address. Only continue if you know what you are doing.
                </p>
              )}
              {error && (
                <p className="text-xs" role="alert" style={{ color: 'var(--danger)' }}>
                  {error}
                </p>
              )}
              <p className="text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
                Saved in this browser only. Saving reloads the app. Defaults can also be set with VITE_ environment variables.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={reset}
                  className="h-12 flex-1 rounded-2xl text-sm font-semibold"
                  style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={save}
                  className="h-12 flex-[2] rounded-2xl text-sm font-semibold"
                  style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
                >
                  Save and reload
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
    </>
  )
}

interface FieldProps {
  id: string
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  mono?: boolean
}

function Field({ id, label, hint, value, onChange, placeholder, mono = true }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
        {label}
      </label>
      <div className="field inner rounded-2xl px-4 transition-shadow">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className={`h-12 w-full bg-transparent text-xs outline-none placeholder:text-slate-600 ${mono ? 'mono' : ''}`}
        />
      </div>
      <p className="mono mt-1 break-all text-[11px]" style={{ color: 'var(--subtle)' }}>
        {hint}
      </p>
    </div>
  )
}
