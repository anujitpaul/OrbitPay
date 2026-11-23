import { createPublicClient, createWalletClient, custom, erc20Abi, fallback, http, numberToHex, parseAbi, size, type Address, type Chain, type EIP1193Provider, type Hex, type PublicClient } from 'viem'
import { addressToBytes32, burnFromReceiptLogs, checkAttestedMessage, decodeCctpV2Message, FORWARD_HOOK_DATA, isForwardHook, mintBlockReason, receivedAmount, ZERO_BYTES32, type AttestationIntent } from './cctp'
import { fetchIrisMessage, isAttested, type UpfrontQuote } from './iris'
import { getBridgeChain, listBridgeChains, TOKEN_MESSENGER_WITH_FEES, type BridgeChain } from './routes'
import { getBridgeRecords, isRetryableFailure, patchBridgeRecord, upsertBridgeRecord, type BridgeRecord } from './store'

export { isRetryableFailure }
import { settings } from '@/lib/settings'

const clients = new Map<number, PublicClient>()

/** Read-only client per chain with a request timeout and retries, spread over every RPC Circle lists for the chain. */
export function bridgePublicClient(chain: BridgeChain): PublicClient {
  let client = clients.get(chain.chainId)
  if (!client) {
    // Arc also uses the RPC configured for the rest of OrbitPay and its backups, so one provider outage does not stall a transfer.
    const urls = chain.chainId === 5042 ? [...new Set([settings.rpcUrl, ...settings.fallbackRpcUrls, ...chain.rpcUrls])] : chain.rpcUrls
    client = createPublicClient({
      chain: chain.viem,
      transport: fallback(urls.map((url) => http(url, { timeout: 10_000, retryCount: 2, retryDelay: 400, batch: true }))),
    })
    clients.set(chain.chainId, client)
  }
  return client
}

export async function readUsdcBalance(chain: BridgeChain, account: Address): Promise<bigint> {
  return bridgePublicClient(chain).readContract({ address: chain.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] })
}

const isUnrecognizedChain = (error: unknown) => {
  const e = error as { code?: number; data?: { originalError?: { code?: number } } }
  return e?.code === 4902 || e?.data?.originalError?.code === 4902
}

/**
 * Wallet provider that adds a missing chain (from Circle's chain list) when the wallet reports it does not know it.
 * Wallet providers are class instances, hence the Proxy.
 */
export function withAddChainFallback(provider: EIP1193Provider, chains: readonly Chain[]): EIP1193Provider {
  const send = provider.request.bind(provider) as (args: { method: string; params?: unknown }) => Promise<unknown>
  const request = (async (args: { method: string; params?: unknown }) => {
    try {
      return await send(args)
    } catch (error) {
      if (args.method !== 'wallet_switchEthereumChain' || !isUnrecognizedChain(error)) throw error
      const [{ chainId }] = args.params as [{ chainId: string }]
      const chain = chains.find((c) => numberToHex(c.id) === chainId.toLowerCase())
      if (!chain) throw error
      await send({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: numberToHex(chain.id),
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: [...chain.rpcUrls.default.http],
            blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
          },
        ],
      })
      return send(args)
    }
  }) as EIP1193Provider['request']
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === 'request') return request
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** Moves the wallet to a chain, adding it first when the wallet does not know it. */
export async function switchWalletChain(provider: EIP1193Provider, chain: BridgeChain): Promise<void> {
  const current = (await provider.request({ method: 'eth_chainId' })) as string
  if (parseInt(current, 16) === chain.chainId) return
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chain.chainId) }] })
}

/** Waits for a transaction receipt and returns whether it succeeded. Never throws for a plain "not found yet". */
export async function waitForReceiptStatus(chain: BridgeChain, hash: Hex, timeoutMs = 120_000): Promise<'success' | 'reverted'> {
  const receipt = await bridgePublicClient(chain).waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 2_000 })
  return receipt.status
}

export function intentFor(record: BridgeRecord, source: BridgeChain, destination: BridgeChain): AttestationIntent & { forwarded: boolean } {
  return {
    sourceDomain: source.domain,
    destinationDomain: destination.domain,
    sourceTokenMessenger: source.tokenMessenger,
    destinationTokenMessenger: destination.tokenMessenger,
    burnToken: source.usdc,
    mintRecipient: record.recipient,
    amount: BigInt(record.amount),
    depositor: record.account,
    forwarded: record.forwarder,
    messengerWithFees: record.feeMode === 'upfront' ? TOKEN_MESSENGER_WITH_FEES : undefined,
  }
}

/** Checks the attested message against what the user requested. Forwarded transfers skip the destination-caller rule. */
export function problemsFor(record: BridgeRecord, source: BridgeChain, destination: BridgeChain, message: Hex): string[] {
  try {
    const decoded = decodeCctpV2Message(message)
    const intent = intentFor(record, source, destination)
    const problems = checkAttestedMessage(decoded, intent)
    return intent.forwarded ? problems.filter((p) => !p.startsWith('Only a third-party')) : problems
  } catch (error) {
    return [error instanceof Error ? error.message : 'The attestation message could not be read.']
  }
}

const finalStates = new Set<BridgeRecord['status']>(['completed', 'failed'])
export const isFinal = (r: BridgeRecord) => finalStates.has(r.status)

/**
 * Reads Circle's attestation service and the chains, then updates the stored record.
 * Used for the automatic status updates and for transfers that were interrupted (closed tab, network loss).
 * A transfer is only marked completed after the destination mint receipt shows success.
 */
export async function refreshBridgeRecord(record: BridgeRecord, signal?: AbortSignal, force = false): Promise<void> {
  if (!record.burnHash || record.status === 'completed') return
  // Failed transfers are only re-checked on request (force) or when the failure was a read error. This never touches approval or burn.
  if (record.status === 'failed' && !force && !isRetryableFailure(record)) return
  const source = getBridgeChain(record.source)
  const destination = getBridgeChain(record.destination)
  if (!source || !destination) return
  const patch = (p: Partial<BridgeRecord>) => patchBridgeRecord(record.account, record.id, p)

  const message = await fetchIrisMessage(source.domain, record.burnHash, signal)
  if (!message) {
    // Circle has not seen the burn. If the burn transaction itself reverted, nothing was burned.
    if (Date.now() - record.createdAt > 60_000) {
      const receipt = await bridgePublicClient(source).getTransactionReceipt({ hash: record.burnHash }).catch(() => undefined)
      if (receipt?.status === 'reverted') {
        return patch({ status: 'failed', detail: 'The burn transaction failed onchain. No USDC was burned.', error: 'Burn transaction reverted.' })
      }
    }
    return patch({ status: 'pending', detail: 'Burn submitted. Waiting for Circle to index it…', error: undefined })
  }
  if (!isAttested(message)) {
    return patch({ status: 'pending', detail: 'Pending attestation: waiting for source-chain confirmations and Circle’s signature…', error: undefined })
  }

  const problems = problemsFor(record, source, destination, message.message)
  if (problems.length > 0) {
    return patch({ status: 'failed', detail: 'Circle’s attestation does not match your request, so the mint was blocked.', error: problems.join(' ') })
  }
  const decoded = decodeCctpV2Message(message.message)
  const received = receivedAmount(decoded).toString()

  if (record.forwarder && message.forwardState && /fail|error/i.test(message.forwardState)) {
    return patch({ status: 'attested', detail: 'Circle’s Forwarding Service reported a problem with the destination mint. Check back shortly; Circle retries.', error: `Forwarding state: ${message.forwardState}` })
  }
  const mintTx = message.forwardTxHash ?? message.destinationMintTxHash
  if (mintTx) {
    const mintHash = mintTx
    const status = await waitForReceiptStatus(destination, mintHash, 30_000).catch(() => undefined)
    if (status === 'success') return patch({ status: 'completed', detail: `Minted on ${destination.title}.`, mintHash, received, error: undefined })
    return patch({ status: 'attested', detail: 'Mint seen, waiting for confirmation on the destination chain…', mintHash, received, error: undefined })
  }
  return patch({
    status: 'attested',
    received,
    error: undefined,
    detail: record.forwarder
      ? 'Attestation received. Circle’s Forwarding Service is minting on the destination chain: nothing more is needed from you, and no destination gas is required.'
      : `Ready to mint: Circle’s attestation is verified. Confirm the mint on ${destination.title} in your wallet.`,
  })
}

const transmitterAbi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool success)',
  'function usedNonces(bytes32 nonce) view returns (uint256)',
])

/**
 * Submits the destination mint with the wallet. The attestation is re-fetched from Circle and checked against the
 * original request, simulated first, and the wallet asks for confirmation. Completed only after a successful receipt.
 */
export async function claimMint(record: BridgeRecord, provider: EIP1193Provider): Promise<void> {
  const source = getBridgeChain(record.source)
  const destination = getBridgeChain(record.destination)
  if (!source || !destination || !record.burnHash) throw new Error('This transfer cannot be completed: its route is missing.')
  const message = await fetchIrisMessage(source.domain, record.burnHash)
  if (!isAttested(message)) throw new Error('Circle has not attested this burn yet. Try again in a moment.')
  const problems = problemsFor(record, source, destination, message.message)
  if (problems.length > 0) throw new Error(`Attestation rejected: ${problems.join(' ')}`)

  const client = bridgePublicClient(destination)
  const used = await client.readContract({ address: destination.messageTransmitter, abi: transmitterAbi, functionName: 'usedNonces', args: [message.eventNonce] })
  if (mintBlockReason(record.status, used) !== undefined) {
    if (used !== 0n) await refreshBridgeRecord(record, undefined, true)
    throw new Error(mintBlockReason(record.status, used))
  }

  const wrapped = withAddChainFallback(provider, [destination.viem])
  await switchWalletChain(wrapped, destination)
  const wallet = createWalletClient({ account: record.account, chain: destination.viem, transport: custom(wrapped) })
  const request = { address: destination.messageTransmitter, abi: transmitterAbi, functionName: 'receiveMessage', args: [message.message, message.attestation], account: record.account } as const
  await client.simulateContract(request)
  const hash = await wallet.writeContract({ ...request, chain: destination.viem })
  patchBridgeRecord(record.account, record.id, { mintHash: hash, detail: 'Mint submitted. Waiting for confirmation…' })
  const status = await waitForReceiptStatus(destination, hash)
  if (status !== 'success') {
    patchBridgeRecord(record.account, record.id, { status: 'attested', detail: 'The mint transaction failed. Your USDC is still safe: try again.', error: 'Mint transaction reverted.' })
    throw new Error('The mint transaction reverted. Nothing was lost; try again.')
  }
  const decoded = decodeCctpV2Message(message.message)
  patchBridgeRecord(record.account, record.id, { status: 'completed', detail: `Minted on ${destination.title}.`, mintHash: hash, received: receivedAmount(decoded).toString(), error: undefined })
}

const tokenMessengerAbi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
])

export interface BurnRequest {
  source: BridgeChain
  destination: BridgeChain
  account: Address
  recipient: Address
  amount: bigint
  maxFee: bigint
  minFinalityThreshold: number
  /** Contract that pulls the USDC. Defaults to the source TokenMessengerV2. */
  spender?: Address
  /** USDC to approve. Defaults to `amount`. */
  approveAmount?: bigint
}

/** Approves exactly `amount` for the source TokenMessengerV2 when the current allowance is lower. Returns the approval hash, if one was needed. */
export async function approveExact(
  req: BurnRequest,
  provider: EIP1193Provider,
  onSubmitted: (hash: Hex) => void,
): Promise<Hex | undefined> {
  const client = bridgePublicClient(req.source)
  const spender = req.spender ?? req.source.tokenMessenger
  const needed = req.approveAmount ?? req.amount
  const allowance = await client.readContract({ address: req.source.usdc, abi: erc20Abi, functionName: 'allowance', args: [req.account, spender] })
  if (allowance >= needed) return undefined
  const wallet = createWalletClient({ account: req.account, chain: req.source.viem, transport: custom(provider) })
  const call = { address: req.source.usdc, abi: erc20Abi, functionName: 'approve', args: [spender, needed], account: req.account } as const
  await client.simulateContract(call)
  const hash = await wallet.writeContract({ ...call, chain: req.source.viem })
  onSubmitted(hash)
  if ((await waitForReceiptStatus(req.source, hash)) !== 'success') throw new Error('The USDC approval failed onchain. Nothing was burned.')
  return hash
}

/** Burns USDC through Circle's TokenMessengerV2 (CCTP V2). Simulated first; the wallet asks for confirmation. */
export async function burnUsdc(req: BurnRequest, provider: EIP1193Provider, onSubmitted: (hash: Hex) => void): Promise<Hex> {
  const client = bridgePublicClient(req.source)
  const wallet = createWalletClient({ account: req.account, chain: req.source.viem, transport: custom(provider) })
  const call = {
    address: req.source.tokenMessenger,
    abi: tokenMessengerAbi,
    functionName: 'depositForBurn',
    args: [req.amount, req.destination.domain, addressToBytes32(req.recipient), req.source.usdc, ZERO_BYTES32, req.maxFee, req.minFinalityThreshold],
    account: req.account,
  } as const
  await client.simulateContract(call)
  const hash = await wallet.writeContract({ ...call, chain: req.source.viem })
  onSubmitted(hash)
  if ((await waitForReceiptStatus(req.source, hash)) !== 'success') throw new Error('The burn transaction failed onchain. No USDC was burned.')
  return hash
}


/**
 * Adds a transfer to the history from its burn transaction hash alone. Everything about the transfer
 * (amount, recipient, destination, speed) is read from the DepositForBurn event of the official TokenMessengerV2,
 * never typed in, so the attestation is later checked against what the chain says was burned.
 * It only reads. It never approves, burns or mints.
 */
export async function importBurn(account: Address, sourceKey: string, burnHash: Hex): Promise<BridgeRecord> {
  const source = getBridgeChain(sourceKey)
  if (!source) throw new Error('Pick the chain where the burn happened.')
  if (!/^0x[0-9a-fA-F]{64}$/.test(burnHash)) throw new Error('Enter a full transaction hash (0x followed by 64 characters).')

  const existing = getBridgeRecords(account).find((r) => r.burnHash?.toLowerCase() === burnHash.toLowerCase())
  if (existing) return existing

  const receipt = await bridgePublicClient(source).getTransactionReceipt({ hash: burnHash }).catch(() => undefined)
  if (!receipt) throw new Error(`That transaction was not found on ${source.title}. Check the hash and the chain.`)
  if (receipt.status !== 'success') throw new Error('That transaction failed onchain, so no USDC was burned.')

  const burn = burnFromReceiptLogs(receipt.logs, source.tokenMessenger)
  // A burn made through TokenMessengerWithFees (upfront fees) reports that contract as the depositor: the wallet is then the transaction sender.
  const viaFees = burn.depositor.toLowerCase() === TOKEN_MESSENGER_WITH_FEES.toLowerCase()
  const madeByWallet = viaFees ? receipt.from.toLowerCase() === account.toLowerCase() : burn.depositor.toLowerCase() === account.toLowerCase()
  if (!madeByWallet) throw new Error('This burn was not made by the connected wallet. Connect the wallet that sent it.')
  if (burn.burnToken.toLowerCase() !== source.usdc.toLowerCase()) throw new Error('This burn is not official USDC.')
  const forwarded = isForwardHook(burn.hookData)
  if (!/^0x0+$/.test(burn.destinationCaller) || (!forwarded && size(burn.hookData) > 1)) throw new Error('This transfer uses a destination caller or hook that OrbitPay does not support.')
  const destination = listBridgeChains().find((c) => c.domain === burn.destinationDomain && c.key !== source.key)
  if (!destination) throw new Error(`Destination domain ${burn.destinationDomain} is not an EVM chain supported here.`)

  const now = Date.now()
  const record: BridgeRecord = {
    id: burnHash.toLowerCase(),
    account,
    source: source.key,
    destination: destination.key,
    amount: burn.amount.toString(),
    recipient: burn.mintRecipient,
    speed: burn.minFinalityThreshold <= 1000 ? 'FAST' : 'SLOW',
    forwarder: forwarded,
    feeMode: forwarded ? (viaFees ? 'upfront' : 'deducted') : undefined,
    status: 'pending',
    detail: 'Recovered from the burn transaction. Checking Circle’s attestation…',
    burnHash,
    createdAt: now,
    updatedAt: now,
  }
  upsertBridgeRecord(record)
  await refreshBridgeRecord(record, undefined, true)
  return getBridgeRecords(account).find((r) => r.id === record.id) ?? record
}

const forwardedBurnAbi = parseAbi([
  'function depositForBurnWithFees(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, (bytes signedQuote, address refundAddress) claim) payable',
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
])

/**
 * Burns with Circle's Forwarding Service and upfront fees. USDC `amount` is burned in full and the quoted fee is
 * collected separately in USDC, so the recipient receives exactly `amount`. The quote Circle signed is submitted unchanged.
 */
export async function burnForwardedUpfront(
  req: { source: BridgeChain; destination: BridgeChain; account: Address; recipient: Address; amount: bigint; quote: UpfrontQuote },
  provider: EIP1193Provider,
  onSubmitted: (hash: Hex) => void,
): Promise<Hex> {
  if (req.quote.messenger.toLowerCase() !== TOKEN_MESSENGER_WITH_FEES.toLowerCase()) throw new Error('Circle’s quote points at an unexpected contract. Nothing was sent.')
  if (req.quote.burnAmount !== req.amount) throw new Error('Circle’s quote does not match the amount. Nothing was sent.')
  if (req.quote.feeToken.toLowerCase() !== req.source.usdc.toLowerCase()) throw new Error('The fee quote is not priced in USDC. Nothing was sent.')
  const client = bridgePublicClient(req.source)
  const wallet = createWalletClient({ account: req.account, chain: req.source.viem, transport: custom(provider) })
  const call = {
    address: TOKEN_MESSENGER_WITH_FEES,
    abi: forwardedBurnAbi,
    functionName: 'depositForBurnWithFees',
    args: [req.amount, req.destination.domain, addressToBytes32(req.recipient), req.source.usdc, ZERO_BYTES32, { signedQuote: req.quote.signedQuote, refundAddress: req.account }],
    account: req.account,
    value: 0n,
  } as const
  await client.simulateContract(call)
  const hash = await wallet.writeContract({ ...call, chain: req.source.viem })
  onSubmitted(hash)
  if ((await waitForReceiptStatus(req.source, hash)) !== 'success') throw new Error('The burn transaction failed onchain. No USDC was burned.')
  return hash
}

/** Forwarding with the fee deducted from the burned amount (`maxFee` covers protocol and forwarding fees). */
export async function burnForwardedDeducted(
  req: { source: BridgeChain; destination: BridgeChain; account: Address; recipient: Address; totalAmount: bigint; maxFee: bigint; minFinalityThreshold: number },
  provider: EIP1193Provider,
  onSubmitted: (hash: Hex) => void,
): Promise<Hex> {
  const client = bridgePublicClient(req.source)
  const wallet = createWalletClient({ account: req.account, chain: req.source.viem, transport: custom(provider) })
  const call = {
    address: req.source.tokenMessenger,
    abi: forwardedBurnAbi,
    functionName: 'depositForBurnWithHook',
    args: [req.totalAmount, req.destination.domain, addressToBytes32(req.recipient), req.source.usdc, ZERO_BYTES32, req.maxFee, req.minFinalityThreshold, FORWARD_HOOK_DATA],
    account: req.account,
  } as const
  await client.simulateContract(call)
  const hash = await wallet.writeContract({ ...call, chain: req.source.viem })
  onSubmitted(hash)
  if ((await waitForReceiptStatus(req.source, hash)) !== 'success') throw new Error('The burn transaction failed onchain. No USDC was burned.')
  return hash
}

export { isForwardHook }
