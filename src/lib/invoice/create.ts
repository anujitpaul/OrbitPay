import { isAddress, type Address, type Hex, type PublicClient } from 'viem'
import { imageHash, invoiceSigningMessage, parseInvoice, verifyInvoiceSignature } from './codec'
import { INVOICE_CHAIN_ID, LIMITS, generateInvoiceId, type InvoiceData, type InvoiceRecord } from './types'

export interface CreateInput {
  issuer: Address
  issuerName?: string
  clientName: string
  clientWallet: string
  project: string
  description: string
  amount: bigint
  deadline: number
  links: { label: string; url: string }[]
  images: string[]
  usdc: Address
  orbitPay?: Address
}

export interface CreateDeps {
  headBlock: () => Promise<bigint>
  sign: (message: string) => Promise<Hex>
  now: () => number
  existingIds: Set<string>
  verifyClient?: Pick<PublicClient, 'verifyMessage'>
}

/** The first problem with the form, in plain words, or undefined when it can be created. */
export function validateCreateInput(input: CreateInput, nowSeconds: number, blocked: Address[]): string | undefined {
  if (!input.clientName.trim()) return 'Enter the client name.'
  if (input.clientName.trim().length > LIMITS.name) return `Client name is limited to ${LIMITS.name} characters.`
  if (!isAddress(input.clientWallet.trim())) return 'Enter a valid client wallet address (0x…, 42 characters).'
  const wallet = input.clientWallet.trim().toLowerCase()
  if (wallet === input.issuer.toLowerCase()) return 'The client wallet must be different from your own wallet.'
  if (/^0x0{40}$/.test(wallet)) return 'The zero address cannot pay an invoice.'
  if (blocked.some((b) => b.toLowerCase() === wallet)) return 'That address is a contract used by OrbitPay and cannot be a client.'
  if (!input.project.trim()) return 'Enter the project name.'
  if (input.project.trim().length > LIMITS.project) return `Project name is limited to ${LIMITS.project} characters.`
  if (!input.description.trim()) return 'Describe the work.'
  if (input.description.trim().length > LIMITS.description) return `The description is limited to ${LIMITS.description} characters.`
  if (input.amount <= 0n) return 'Enter an amount above 0.'
  if (input.amount > LIMITS.maxAmount) return 'That amount is above the 1,000,000 USDC invoice limit.'
  if (input.deadline < nowSeconds + LIMITS.minWindowSeconds) return 'Choose a deadline at least one hour from now.'
  if (input.deadline > nowSeconds + LIMITS.maxWindowSeconds) return 'Choose a deadline within one year.'
  if (input.links.length > LIMITS.links) return `Add at most ${LIMITS.links} links.`
  if (input.images.length > LIMITS.images) return `Attach at most ${LIMITS.images} images.`
  return undefined
}

/**
 * Builds, signs and self-checks an invoice. The issuer's wallet signs a plain-language summary plus a digest of every
 * term, so any later change to the link is detectable. Nothing is saved or sent here.
 */
export async function buildInvoice(input: CreateInput, deps: CreateDeps): Promise<InvoiceRecord> {
  let id = generateInvoiceId()
  while (deps.existingIds.has(id)) id = generateInvoiceId()
  const createdBlock = await deps.headBlock()
  const data: InvoiceData = {
    v: 1,
    id,
    chainId: INVOICE_CHAIN_ID,
    usdc: input.usdc,
    ...(input.orbitPay ? { orbitPay: input.orbitPay } : {}),
    to: input.issuer,
    ...(input.issuerName?.trim() ? { issuerName: input.issuerName.trim() } : {}),
    client: { name: input.clientName.trim(), wallet: input.clientWallet.trim() as Address },
    project: input.project.trim(),
    description: input.description.trim(),
    amount: input.amount.toString(),
    createdAt: deps.now(),
    createdBlock: createdBlock.toString(),
    deadline: input.deadline,
    links: input.links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
    imageHashes: input.images.map(imageHash),
  }
  // Normalises addresses to checksum form and re-applies every bound before anything is signed.
  const checked = parseInvoice({ d: data, s: `0x${'00'.repeat(65)}`, im: input.images })
  if (!checked.ok) throw new Error(checked.error)
  const signature = await deps.sign(invoiceSigningMessage(checked.signed.data))
  const signed = { data: checked.signed.data, signature }
  if (!(await verifyInvoiceSignature(signed, deps.verifyClient))) throw new Error('Your wallet’s signature did not match this invoice. Nothing was created.')
  return { signed, images: checked.images }
}
