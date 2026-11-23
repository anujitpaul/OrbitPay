import { getAddress, isAddress, isHex, keccak256, toBytes, verifyMessage, type Address, type Hex, type PublicClient } from 'viem'
import { INVOICE_CHAIN_ID, INVOICE_ID_PATTERN, LIMITS, type InvoiceData, type SignedInvoice } from './types'

const MAX_ENCODED_CHARS = 400_000
const MAX_DECODED_BYTES = 600_000
const DATA_IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

// ---------- canonical form and signing ----------

/** Deterministic JSON: sorted keys, no whitespace. The signed digest is computed over exactly this string. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function invoiceDigest(data: InvoiceData): Hex {
  return keccak256(toBytes(canonicalize(data)))
}

function formatUsdcPlain(raw: bigint): string {
  const s = raw.toString().padStart(7, '0')
  const whole = s.slice(0, -6)
  const frac = s.slice(-6).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/** The text the issuer's wallet shows when asked to sign. It names the money terms in plain language. */
export function invoiceSigningMessage(data: InvoiceData): string {
  return [
    `OrbitPay invoice ${data.id}`,
    `Pay ${formatUsdcPlain(BigInt(data.amount))} USDC to ${data.to}`,
    `From client wallet ${data.client.wallet}`,
    `Network: Arc Mainnet (chain ${data.chainId})`,
    `Due: ${new Date(data.deadline * 1000).toISOString()}`,
    `Digest: ${invoiceDigest(data)}`,
  ].join('\n')
}

/**
 * True only when `signature` was produced by data.to over this exact invoice. Ordinary wallets are checked locally;
 * when a client is given, smart-contract wallets (ERC-1271) are checked onchain as a second chance.
 */
export async function verifyInvoiceSignature(signed: SignedInvoice, client?: Pick<PublicClient, 'verifyMessage'>): Promise<boolean> {
  const args = { address: signed.data.to, message: invoiceSigningMessage(signed.data), signature: signed.signature }
  try {
    if (await verifyMessage(args)) return true
  } catch {
    // fall through to the onchain check
  }
  if (!client) return false
  try {
    return await client.verifyMessage(args)
  } catch {
    return false
  }
}

export function imageHash(dataUrl: string): Hex {
  return keccak256(toBytes(dataUrl))
}

// ---------- validation ----------

export type ParseResult = { ok: true; signed: SignedInvoice; images: string[] } | { ok: false; error: string }

const fail = (error: string): ParseResult => ({ ok: false, error })
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function cleanText(value: unknown, max: number, label: string, required = true): string | { error: string } {
  if (typeof value !== 'string') return { error: `${label} is missing.` }
  const trimmed = value.trim()
  if (required && !trimmed) return { error: `${label} is empty.` }
  if (trimmed.length > max) return { error: `${label} is too long.` }
  if (CONTROL_CHARS.test(trimmed)) return { error: `${label} has invalid characters.` }
  return trimmed
}

export function safeLink(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (url.username || url.password) return undefined
    return url.href.length <= LIMITS.linkUrl ? url.href : undefined
  } catch {
    return undefined
  }
}

/** Strict, bounded validation of untrusted invoice data (from a link or from storage). Never throws. */
export function parseInvoice(raw: unknown): ParseResult {
  if (!isRecord(raw) || !isRecord(raw.d) || typeof raw.s !== 'string') return fail('This is not an OrbitPay invoice.')
  const d = raw.d
  if (d.v !== 1) return fail('Unsupported invoice version.')
  if (typeof d.id !== 'string' || !INVOICE_ID_PATTERN.test(d.id)) return fail('Invalid invoice ID.')
  if (d.chainId !== INVOICE_CHAIN_ID) return fail('This invoice is not for Arc Mainnet.')
  if (typeof d.usdc !== 'string' || !isAddress(d.usdc, { strict: false })) return fail('Invalid USDC address.')
  if (typeof d.to !== 'string' || !isAddress(d.to, { strict: false })) return fail('Invalid payee address.')
  if (d.orbitPay !== undefined && (typeof d.orbitPay !== 'string' || !isAddress(d.orbitPay, { strict: false }))) return fail('Invalid contract address.')
  if (!isRecord(d.client) || typeof d.client.wallet !== 'string' || !isAddress(d.client.wallet, { strict: false })) return fail('Invalid client wallet.')
  const clientName = cleanText(d.client.name, LIMITS.name, 'Client name')
  if (typeof clientName !== 'string') return fail(clientName.error)
  const project = cleanText(d.project, LIMITS.project, 'Project name')
  if (typeof project !== 'string') return fail(project.error)
  const description = cleanText(d.description, LIMITS.description, 'Description')
  if (typeof description !== 'string') return fail(description.error)
  let issuerName: string | undefined
  if (d.issuerName !== undefined) {
    const n = cleanText(d.issuerName, LIMITS.name, 'Issuer name', false)
    if (typeof n !== 'string') return fail(n.error)
    issuerName = n || undefined
  }
  if (typeof d.amount !== 'string' || !/^[1-9]\d{0,18}$/.test(d.amount) || BigInt(d.amount) > LIMITS.maxAmount) return fail('Invalid amount.')
  if (!Number.isSafeInteger(d.createdAt) || !Number.isSafeInteger(d.deadline)) return fail('Invalid dates.')
  const createdAt = d.createdAt as number
  const deadline = d.deadline as number
  if (deadline <= createdAt || deadline - createdAt > LIMITS.maxWindowSeconds) return fail('Invalid deadline.')
  if (typeof d.createdBlock !== 'string' || !/^\d{1,15}$/.test(d.createdBlock)) return fail('Invalid block height.')
  if (!Array.isArray(d.links) || d.links.length > LIMITS.links) return fail('Too many links.')
  const links: { label: string; url: string }[] = []
  for (const item of d.links) {
    if (!isRecord(item) || typeof item.url !== 'string') return fail('Invalid delivery link.')
    const url = safeLink(item.url)
    const label = cleanText(item.label, LIMITS.linkLabel, 'Link label', false)
    if (!url || typeof label !== 'string') return fail('Invalid delivery link.')
    links.push({ label, url })
  }
  if (!Array.isArray(d.imageHashes) || d.imageHashes.length > LIMITS.images || !d.imageHashes.every((h) => typeof h === 'string' && isHex(h) && h.length === 66)) {
    return fail('Invalid image list.')
  }
  if (typeof raw.s !== 'string' || !isHex(raw.s) || raw.s.length < 132 || raw.s.length > 20_000) return fail('Missing signature.')
  const data: InvoiceData = {
    v: 1,
    id: d.id,
    chainId: INVOICE_CHAIN_ID,
    usdc: getAddress(d.usdc),
    ...(d.orbitPay ? { orbitPay: getAddress(d.orbitPay) } : {}),
    to: getAddress(d.to),
    ...(issuerName ? { issuerName } : {}),
    client: { name: clientName, wallet: getAddress(d.client.wallet) },
    project,
    description,
    amount: d.amount,
    createdAt,
    createdBlock: d.createdBlock,
    deadline,
    links,
    imageHashes: d.imageHashes as Hex[],
  }
  // Attached previews must match the hashes the issuer signed; anything else is dropped.
  let images: string[] = []
  if (raw.im !== undefined) {
    if (!Array.isArray(raw.im) || raw.im.length > LIMITS.images) return fail('Invalid image list.')
    images = raw.im.filter(
      (img): img is string => typeof img === 'string' && img.length <= LIMITS.imageChars && DATA_IMAGE.test(img) && data.imageHashes.includes(imageHash(img)),
    )
  }
  return { ok: true, signed: { data, signature: raw.s }, images }
}

// ---------- link encoding ----------

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

async function pipeAll(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, cap: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter()
  const writing = writer.write(new Uint8Array(bytes)).then(() => writer.close()).catch(() => undefined)
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      await reader.cancel()
      throw new Error('Invoice link is too large.')
    }
    chunks.push(value)
  }
  await writing
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** Packs a signed invoice (and optionally its image previews) into URL-safe text. */
export async function encodeInvoice(signed: SignedInvoice, images: string[] = []): Promise<string> {
  const payload = { d: signed.data, s: signed.signature, ...(images.length ? { im: images } : {}) }
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  if (typeof CompressionStream === 'undefined') return `r.${toBase64Url(bytes)}`
  const packed = await pipeAll(bytes, new CompressionStream('deflate-raw'), MAX_DECODED_BYTES)
  return `z.${toBase64Url(packed)}`
}

export async function decodeInvoice(text: string): Promise<ParseResult> {
  try {
    if (text.length > MAX_ENCODED_CHARS) return fail('This invoice link is too large.')
    const match = /^([zr])\.([A-Za-z0-9_-]+)$/.exec(text)
    if (!match) return fail('This invoice link is damaged.')
    const raw = fromBase64Url(match[2])
    const bytes = match[1] === 'z' ? await pipeAll(raw, new DecompressionStream('deflate-raw'), MAX_DECODED_BYTES) : raw
    if (bytes.length > MAX_DECODED_BYTES) return fail('This invoice link is too large.')
    return parseInvoice(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return fail('This invoice link is damaged.')
  }
}

export const INVOICE_ROUTE_PREFIX = '#/invoice/'

export function invoicePath(encoded: string): string {
  return `/${INVOICE_ROUTE_PREFIX}${encoded}`
}

/** Extracts the encoded invoice from a location hash, if the hash is an invoice route. */
export function invoiceFromHash(hash: string): string | undefined {
  return hash.startsWith(INVOICE_ROUTE_PREFIX) ? hash.slice(INVOICE_ROUTE_PREFIX.length) : undefined
}

export function addressEq(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
