import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toBytes, type Address, type Hex, type TransactionReceipt, erc20Abi } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { orbitPayAbi } from '../src/lib/abi'
import {
  canonicalize,
  decodeInvoice,
  encodeInvoice,
  imageHash,
  invoiceFromHash,
  invoiceSigningMessage,
  parseInvoice,
  safeLink,
  verifyInvoiceSignature,
} from '../src/lib/invoice/codec'
import { INVOICE_ID_PATTERN, generateInvoiceId, invoiceMemo, invoiceStatus, type InvoiceData, type SignedInvoice } from '../src/lib/invoice/types'
import { checkReceipt } from '../src/lib/invoice/verify'
import fixture from './fixtures/arc-usdc-transfer-receipt.json'

const USDC: Address = '0x3600000000000000000000000000000000000000'
const ORBIT: Address = '0xB9Fe116564f44C1Ba25614AB13F21487C098C4c9'
const issuer = privateKeyToAccount(generatePrivateKey())
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='

function sampleData(over: Partial<InvoiceData> = {}): InvoiceData {
  return {
    v: 1,
    id: 'INV-7K2M9QXA',
    chainId: 5042,
    usdc: USDC,
    orbitPay: ORBIT,
    to: issuer.address,
    issuerName: 'Ada Freelance',
    client: { name: 'Acme Ltd', wallet: getAddress('0xf70da97812CB96acDF810712Aa562db8dfA3dbEF') },
    project: 'Brand site',
    description: 'Design and build of the marketing site.\nTwo rounds of revisions.',
    amount: '9992924',
    createdAt: 1_800_000_000,
    createdBlock: '9000000',
    deadline: 1_800_000_000 + 14 * 86_400,
    links: [{ label: 'Figma', url: 'https://example.com/file' }],
    imageHashes: [imageHash(IMG)],
    ...over,
  }
}

async function sign(data: InvoiceData): Promise<SignedInvoice> {
  return { data, signature: await issuer.signMessage({ message: invoiceSigningMessage(data) }) }
}

describe('signature', () => {
  test('a signed invoice verifies against the issuer wallet', async () => {
    expect(await verifyInvoiceSignature(await sign(sampleData()))).toBe(true)
  })
  test('changing the amount, payee, client, deadline or any text breaks the signature', async () => {
    const signed = await sign(sampleData())
    const other = privateKeyToAccount(generatePrivateKey()).address
    for (const patch of [
      { amount: '1' },
      { to: other },
      { client: { name: 'Acme Ltd', wallet: other } },
      { deadline: signed.data.deadline + 1 },
      { description: 'x' },
      { project: 'Other' },
      { id: 'INV-AAAAAAAA' },
      { links: [{ label: 'Figma', url: 'https://evil.example/' }] },
    ]) {
      expect(await verifyInvoiceSignature({ ...signed, data: { ...signed.data, ...patch } })).toBe(false)
    }
  })
  test('a signature from a different wallet is rejected', async () => {
    const data = sampleData()
    const stranger = privateKeyToAccount(generatePrivateKey())
    const signature = await stranger.signMessage({ message: invoiceSigningMessage(data) })
    expect(await verifyInvoiceSignature({ data, signature })).toBe(false)
  })
  test('the signing message states the money terms in plain words', () => {
    const message = invoiceSigningMessage(sampleData())
    expect(message).toContain('Pay 9.992924 USDC to')
    expect(message).toContain('From client wallet 0xf70d')
    expect(message).toContain('Network: Arc Mainnet (chain 5042)')
  })
  test('canonical form ignores key order', () => {
    expect(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalize({ a: [2, { c: 2, d: 1 }], b: 1 }))
  })
})

describe('invoice links', () => {
  test('a compact link round-trips and still verifies', async () => {
    const signed = await sign(sampleData())
    const text = await encodeInvoice(signed)
    const back = await decodeInvoice(text)
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(back.signed.data).toEqual(signed.data)
      expect(back.images).toEqual([])
      expect(await verifyInvoiceSignature(back.signed)).toBe(true)
    }
    expect(text.length).toBeLessThan(1500)
  })
  test('image previews travel in the full link and must match the signed hashes', async () => {
    const signed = await sign(sampleData())
    const back = await decodeInvoice(await encodeInvoice(signed, [IMG]))
    expect(back.ok && back.images).toEqual([IMG])
    const swapped = IMG.replace('AAAAAAAAAAAAA', 'BBBBBBBBBBBBB')
    const tampered = await decodeInvoice(await encodeInvoice(signed, [swapped]))
    expect(tampered.ok && tampered.images).toEqual([])
  })
  test('damaged, oversized and non-invoice links are rejected without throwing', async () => {
    for (const bad of ['', 'z.', 'z.%%%', 'z.AAAA', 'q.AAAA', 'z.' + 'A'.repeat(500_000)]) {
      expect((await decodeInvoice(bad)).ok).toBe(false)
    }
    const junk = btoa(JSON.stringify({ hello: 'world' })).replace(/=+$/, '')
    expect((await decodeInvoice('r.' + junk)).ok).toBe(false)
  })
  test('the invoice route is read from the location hash only', () => {
    expect(invoiceFromHash('#/invoice/z.abc')).toBe('z.abc')
    expect(invoiceFromHash('#/other/z.abc')).toBeUndefined()
    expect(invoiceFromHash('')).toBeUndefined()
  })
})

describe('validation of untrusted invoices', () => {
  const base = async () => {
    const signed = await sign(sampleData())
    return { d: signed.data as unknown as Record<string, unknown>, s: signed.signature }
  }
  test('accepts a valid invoice and normalises addresses', async () => {
    const raw = await base()
    const lower = { ...raw, d: { ...raw.d, to: (raw.d.to as string).toLowerCase() } }
    const parsed = parseInvoice(lower)
    expect(parsed.ok && parsed.signed.data.to).toBe(issuer.address)
  })
  test('rejects wrong chain, bad ids, bad addresses and bad amounts', async () => {
    const raw = await base()
    const cases: Record<string, unknown>[] = [
      { chainId: 1 },
      { id: 'INV-lowercase' },
      { id: 'x' },
      { to: '0x123' },
      { client: { name: 'A', wallet: 'nope' } },
      { amount: '0' },
      { amount: '01' },
      { amount: '-5' },
      { amount: '1.5' },
      { amount: (10n ** 13n).toString() },
      { deadline: 1_800_000_000 },
      { deadline: 1_800_000_000 + 400 * 86_400 },
      { createdBlock: 'abc' },
      { v: 2 },
    ]
    for (const patch of cases) expect(parseInvoice({ ...raw, d: { ...raw.d, ...patch } }).ok).toBe(false)
  })
  test('rejects unsafe links and oversize text', async () => {
    const raw = await base()
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:pw@example.com/', 'ftp://example.com/']) {
      expect(parseInvoice({ ...raw, d: { ...raw.d, links: [{ label: 'x', url }] } }).ok).toBe(false)
    }
    expect(parseInvoice({ ...raw, d: { ...raw.d, description: 'x'.repeat(1201) } }).ok).toBe(false)
    expect(parseInvoice({ ...raw, d: { ...raw.d, project: 'a\u0000b' } }).ok).toBe(false)
    expect(parseInvoice({ ...raw, d: { ...raw.d, links: Array.from({ length: 6 }, () => ({ label: 'a', url: 'https://example.com/' })) } }).ok).toBe(false)
  })
  test('markup in text is kept as plain text, never executed', async () => {
    const raw = await base()
    const parsed = parseInvoice({ ...raw, d: { ...raw.d, project: '<img src=x onerror=alert(1)>' } })
    expect(parsed.ok && parsed.signed.data.project).toBe('<img src=x onerror=alert(1)>')
  })
  test('only https/http links without credentials are shown as links', () => {
    expect(safeLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeLink('javascript:alert(1)')).toBeUndefined()
  })
  test('SVG and other image types are not accepted as previews', async () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
    const signed = await sign(sampleData({ imageHashes: [imageHash(svg)] }))
    const raw = { d: signed.data, s: signed.signature, im: [svg] }
    const parsed = parseInvoice(raw)
    expect(parsed.ok && parsed.images).toEqual([])
  })
})

describe('ids and status', () => {
  test('generated invoice IDs are unique and fit the 32-byte memo', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateInvoiceId()))
    expect(ids.size).toBe(2000)
    for (const id of ids) {
      expect(INVOICE_ID_PATTERN.test(id)).toBe(true)
      expect(invoiceMemo(id)).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })
  test('status: paid beats everything, then cancelled, then expired, else pending', async () => {
    const signed = await sign(sampleData())
    const now = signed.data.createdAt + 100
    const payment = { hash: '0x' + '11'.repeat(32), from: signed.data.client.wallet, to: signed.data.to, amount: signed.data.amount, blockNumber: '1', via: 'transfer' as const, verifiedAt: 1 } as const
    expect(invoiceStatus({ signed }, now)).toBe('pending')
    expect(invoiceStatus({ signed }, signed.data.deadline + 1)).toBe('expired')
    expect(invoiceStatus({ signed, cancelledAt: 5 }, now)).toBe('cancelled')
    expect(invoiceStatus({ signed, cancelledAt: 5, payment }, signed.data.deadline + 1)).toBe('paid')
    expect(invoiceStatus({ signed }, signed.data.deadline)).toBe('pending')
  })
})

// ---- payment verification against a REAL Arc Mainnet receipt (a plain 9.992924 USDC transfer) ----
const real = fixture as unknown as { transactionHash: Hex; blockNumber: string; status: 'success'; from: Address; to: Address; value: string; logs: { address: Address; topics: Hex[]; data: Hex; logIndex: number }[] }
function realReceipt(over: Partial<TransactionReceipt> = {}): TransactionReceipt {
  return {
    transactionHash: real.transactionHash,
    blockNumber: BigInt(real.blockNumber),
    status: 'success',
    logs: real.logs.map((l) => ({ ...l, blockNumber: BigInt(real.blockNumber), transactionHash: real.transactionHash, blockHash: '0x' as Hex, transactionIndex: 0, removed: false })),
    ...over,
  } as unknown as TransactionReceipt
}
function realInvoice(over: Partial<InvoiceData> = {}): InvoiceData {
  return sampleData({ orbitPay: undefined, to: getAddress(real.to), client: { name: 'Payer', wallet: getAddress(real.from) }, amount: real.value, createdBlock: (BigInt(real.blockNumber) - 10n).toString(), ...over })
}

describe('payment verification', () => {
  test('a real onchain transfer of the exact amount from the client wallet is verified', () => {
    const result = checkReceipt(realInvoice(), realReceipt(), 1_800_000_500)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.proof.hash).toBe(real.transactionHash)
      expect(result.proof.via).toBe('transfer')
      expect(result.proof.amount).toBe(real.value)
    }
  })
  test('the wrong amount (underpaid or overpaid) is never accepted', () => {
    for (const amount of [(BigInt(real.value) - 1n).toString(), (BigInt(real.value) + 1n).toString(), '1']) {
      expect(checkReceipt(realInvoice({ amount }), realReceipt()).ok).toBe(false)
    }
  })
  test('a payment from a different wallet, to a different payee, or in another token is never accepted', () => {
    const other = privateKeyToAccount(generatePrivateKey()).address
    expect(checkReceipt(realInvoice({ client: { name: 'x', wallet: other } }), realReceipt()).ok).toBe(false)
    expect(checkReceipt(realInvoice({ to: other }), realReceipt()).ok).toBe(false)
    expect(checkReceipt(realInvoice({ usdc: other }), realReceipt()).ok).toBe(false)
  })
  test('a failed transaction, or one older than the invoice, never counts', () => {
    expect(checkReceipt(realInvoice(), realReceipt({ status: 'reverted' })).ok).toBe(false)
    expect(checkReceipt(realInvoice({ createdBlock: (BigInt(real.blockNumber) + 1n).toString() }), realReceipt()).ok).toBe(false)
  })
  test('a receipt with no Transfer event at all is rejected', () => {
    expect(checkReceipt(realInvoice(), realReceipt({ logs: [] })).ok).toBe(false)
  })

  const memoLog = (memo: Hex, amount: bigint = BigInt(real.value)) => ({
    address: ORBIT,
    topics: encodeEventTopics({ abi: orbitPayAbi, eventName: 'PaymentSent', args: { from: getAddress(real.from), to: getAddress(real.to) } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [amount, memo]),
    logIndex: 9,
    blockNumber: BigInt(real.blockNumber),
    transactionHash: real.transactionHash,
    blockHash: '0x' as Hex,
    transactionIndex: 0,
    removed: false,
  })
  const withMemo = (memo: Hex) => realReceipt({ logs: [...realReceipt().logs, memoLog(memo) as never] })

  test('a payment through OrbitPay carrying this invoice ID is verified and recorded as such', () => {
    const invoice = realInvoice({ orbitPay: ORBIT })
    const result = checkReceipt(invoice, withMemo(invoiceMemo(invoice.id)))
    expect(result.ok && result.proof.via).toBe('orbitpay')
    expect(result.ok && result.memoMatch).toBe(true)
  })
  test('a payment through OrbitPay with an empty memo still counts (client wallet and exact amount)', () => {
    const result = checkReceipt(realInvoice({ orbitPay: ORBIT }), withMemo(('0x' + '00'.repeat(32)) as Hex))
    expect(result.ok && result.memoMatch).toBe(false)
    expect(result.ok).toBe(true)
  })
  test('a payment that carries ANOTHER invoice ID is rejected, so one payment cannot settle two invoices', () => {
    const result = checkReceipt(realInvoice({ orbitPay: ORBIT }), withMemo(invoiceMemo('INV-ZZZZZZZZ')))
    expect(result.ok).toBe(false)
  })
  test('events from an unrelated contract cannot stand in for the real USDC Transfer', () => {
    const fake = { ...realReceipt().logs[0], address: ORBIT }
    expect(checkReceipt(realInvoice(), realReceipt({ logs: [fake as never] })).ok).toBe(false)
  })
  test('the Transfer log in the fixture really is the ERC-20 event (sanity)', () => {
    const topic = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer' })[0]
    expect(real.logs.some((l) => l.topics[0] === topic && l.address.toLowerCase() === USDC)).toBe(true)
    expect(keccak256(toBytes('a'))).toMatch(/^0x/)
  })
})
