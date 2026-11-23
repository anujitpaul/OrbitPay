import { stringToHex, type Address, type Hex } from 'viem'

export const INVOICE_CHAIN_ID = 5042

export const LIMITS = {
  name: 80,
  project: 80,
  description: 1200,
  linkLabel: 40,
  linkUrl: 300,
  links: 5,
  images: 4,
  /** Largest single image preview that may travel inside a link (data URL characters). */
  imageChars: 70_000,
  /** Largest invoice, in USDC base units (1,000,000 USDC). */
  maxAmount: 1_000_000n * 1_000_000n,
  /** Longest allowed payment window. */
  maxWindowSeconds: 366 * 24 * 3600,
  minWindowSeconds: 3600,
} as const

/** Everything the client must be able to trust. The issuer's wallet signs a digest of exactly this object. */
export interface InvoiceData {
  v: 1
  /** Unique invoice ID, e.g. INV-7K2M9QXA. Also the memo attached to payments sent through OrbitPay. */
  id: string
  chainId: number
  usdc: Address
  /** OrbitPay payment contract of the issuer, when payments should carry the invoice ID as their memo. */
  orbitPay?: Address
  /** The issuer's wallet: the payee, and the signer of this invoice. */
  to: Address
  issuerName?: string
  client: { name: string; wallet: Address }
  project: string
  description: string
  /** Amount in USDC base units (6 decimals), as a decimal string. */
  amount: string
  createdAt: number
  /** Block height when the invoice was created: payments before it never count. */
  createdBlock: string
  deadline: number
  links: { label: string; url: string }[]
  /** keccak256 of each attached image preview, so images in a link are tamper-evident. */
  imageHashes: Hex[]
}

export interface SignedInvoice {
  data: InvoiceData
  signature: Hex
}

export type InvoiceStatus = 'pending' | 'paid' | 'expired' | 'cancelled'

/** A payment that was checked against the chain: receipt status, USDC Transfer event and (optionally) the PaymentSent memo. */
export interface PaymentProof {
  hash: Hex
  from: Address
  to: Address
  amount: string
  blockNumber: string
  timestamp?: number
  via: 'orbitpay' | 'transfer'
  verifiedAt: number
}

export interface InvoiceRecord {
  signed: SignedInvoice
  /** Image previews kept on this device (and optionally placed in the link). */
  images: string[]
  cancelledAt?: number
  payment?: PaymentProof
  /** Further matching payments after the first one, reported so a double payment is never missed. */
  duplicates?: Hex[]
  /** Highest block already searched for payments, so each check only reads new blocks. */
  scannedTo?: string
}

/** The 32-byte memo OrbitPay's pay() stores in its PaymentSent event. */
export function invoiceMemo(id: string): Hex {
  return stringToHex(id, { size: 32 })
}

export function invoiceStatus(record: { signed: SignedInvoice; cancelledAt?: number; payment?: PaymentProof }, nowSeconds: number): InvoiceStatus {
  if (record.payment) return 'paid'
  if (record.cancelledAt) return 'cancelled'
  if (nowSeconds > record.signed.data.deadline) return 'expired'
  return 'pending'
}

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateInvoiceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `INV-${Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')}`
}

export const INVOICE_ID_PATTERN = /^INV-[A-Z2-9]{8}$/
