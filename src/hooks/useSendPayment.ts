import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { WaitForTransactionReceiptTimeoutError, erc20Abi, parseEventLogs, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { useAccount, useConfig, useWriteContract } from 'wagmi'
import { getPublicClient, readContract, simulateContract, waitForTransactionReceipt } from 'wagmi/actions'
import { arcMainnet } from '@/config'
import { orbitPayAbi } from '@/lib/abi'
import { parseTxError } from '@/lib/errors'
import { requestHistoryRefresh } from '@/lib/historyStore'
import { resolveStoredTx } from '@/lib/txResolve'
import { saveSubmittedTx, updateStoredTx } from '@/lib/txStore'
import { settings } from '@/lib/settings'

export type SendPhase =
  | 'idle'
  | 'checking' // simulating / reading allowance
  | 'approve-wallet' // waiting for the approval signature
  | 'approve-confirming' // approval submitted, waiting for the receipt
  | 'pay-wallet' // waiting for the payment signature
  | 'pay-confirming' // payment submitted, waiting for the receipt
  | 'success'
  | 'pending' // submitted but no receipt within the timeout: outcome unknown
  | 'error'
  | 'cancelled'

export interface SendState {
  phase: SendPhase
  hash?: Hex
  approveHash?: Hex
  message?: string
  to?: Address
  amount?: bigint
  route: 'orbitpay' | 'direct'
}

const RECEIPT_TIMEOUT_MS = 90_000

export function useSendPayment() {
  const config = useConfig()
  const { address } = useAccount()
  const queryClient = useQueryClient()
  const { writeContractAsync } = useWriteContract()
  const route: SendState['route'] = settings.orbitPayAddress ? 'orbitpay' : 'direct'
  const [state, setState] = useState<SendState>({ phase: 'idle', route })

  const reset = useCallback(() => setState({ phase: 'idle', route }), [route])

  const send = useCallback(
    async (to: Address, amount: bigint, memo: Hex = zeroHash) => {
      if (!address) return
      const base = { to, amount, route }
      let currentHash: Hex | undefined
      const payment: { hash?: Hex } = {}
      // Save the payment's hash the instant the wallet returns it, so history shows it as Pending right away.
      const recordSubmitted = (hash: Hex) => {
        payment.hash = hash
        saveSubmittedTx(address, { hash, from: address, to, amount: amount.toString(), createdAt: Date.now(), status: 'pending' })
      }
      setState({ ...base, phase: 'checking' })
      try {
        const orbitPay = settings.orbitPayAddress
        const chainId = arcMainnet.id

        if (orbitPay) {
          const allowance = await readContract(config, {
            address: settings.usdcAddress,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address, orbitPay],
            chainId,
          })

          if (allowance < amount) {
            // Approve exactly the amount being sent, never an unlimited allowance.
            await simulateContract(config, {
              address: settings.usdcAddress,
              abi: erc20Abi,
              functionName: 'approve',
              args: [orbitPay, amount],
              account: address,
              chainId,
            })
            setState({ ...base, phase: 'approve-wallet' })
            const approveHash = await writeContractAsync({
              address: settings.usdcAddress,
              abi: erc20Abi,
              functionName: 'approve',
              args: [orbitPay, amount],
              chainId,
            })
            currentHash = approveHash
            setState({ ...base, phase: 'approve-confirming', approveHash })
            const approval = await waitForTransactionReceipt(config, { hash: approveHash, chainId, timeout: RECEIPT_TIMEOUT_MS })
            if (approval.status !== 'success') throw new Error('The approval transaction reverted')
          }

          await simulateContract(config, {
            address: orbitPay,
            abi: orbitPayAbi,
            functionName: 'pay',
            args: [to, amount, memo],
            account: address,
            chainId,
          })
          setState((s) => ({ ...s, ...base, phase: 'pay-wallet' }))
          const hash = await writeContractAsync({
            address: orbitPay,
            abi: orbitPayAbi,
            functionName: 'pay',
            args: [to, amount, memo],
            chainId,
          })
          currentHash = hash
          recordSubmitted(hash)
          setState((s) => ({ ...s, ...base, phase: 'pay-confirming', hash }))
          const receipt = await waitForTransactionReceipt(config, { hash, chainId, timeout: RECEIPT_TIMEOUT_MS })
          if (receipt.status !== 'success') {
            updateStoredTx(address, hash, { status: 'failed', blockNumber: receipt.blockNumber.toString(), message: 'Reverted onchain. No USDC moved.' })
            throw new Error('The payment transaction reverted')
          }

          // Only report success when the contract's own event proves the payment.
          const events = parseEventLogs({ abi: orbitPayAbi, eventName: 'PaymentSent', logs: receipt.logs })
          const proven = events.some(
            (e) =>
              e.address.toLowerCase() === orbitPay.toLowerCase() &&
              e.args.from.toLowerCase() === address.toLowerCase() &&
              e.args.to.toLowerCase() === to.toLowerCase() &&
              e.args.amount === amount,
          )
          if (!proven) throw new Error('Payment event not found in the receipt')
          updateStoredTx(address, hash, { status: 'confirmed', blockNumber: receipt.blockNumber.toString() })
          setState((s) => ({ ...s, ...base, phase: 'success', hash }))
        } else {
          await simulateContract(config, {
            address: settings.usdcAddress,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [to, amount],
            account: address,
            chainId,
          })
          setState({ ...base, phase: 'pay-wallet' })
          const hash = await writeContractAsync({
            address: settings.usdcAddress,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [to, amount],
            chainId,
          })
          currentHash = hash
          recordSubmitted(hash)
          setState({ ...base, phase: 'pay-confirming', hash })
          const receipt = await waitForTransactionReceipt(config, { hash, chainId, timeout: RECEIPT_TIMEOUT_MS })
          if (receipt.status !== 'success') {
            updateStoredTx(address, hash, { status: 'failed', blockNumber: receipt.blockNumber.toString(), message: 'Reverted onchain. No USDC moved.' })
            throw new Error('The transfer transaction reverted')
          }
          updateStoredTx(address, hash, { status: 'confirmed', blockNumber: receipt.blockNumber.toString() })
          setState({ ...base, phase: 'success', hash })
        }

        void queryClient.invalidateQueries({ queryKey: ['readContract'] })
        requestHistoryRefresh(address)
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) {
          setState((s) => ({
            ...s,
            ...base,
            phase: 'pending',
            hash: s.hash ?? currentHash,
            message: 'The transaction was submitted but is not confirmed yet. Check the explorer before trying again.',
          }))
          return
        }
        const parsed = parseTxError(error)
        if (payment.hash && !parsed.rejected) {
          // The wait helper throws on a reverted tx; the receipt tells us what really happened.
          const client = getPublicClient(config, { chainId: arcMainnet.id }) as PublicClient | undefined
          if (client && (await resolveStoredTx(client, address, payment.hash)) === 'failed') {
            parsed.message = 'The transaction was reverted onchain. No USDC moved.'
          }
        }
        setState((s) => ({
          ...s,
          ...base,
          phase: parsed.rejected ? 'cancelled' : 'error',
          message: parsed.message,
          hash: s.hash ?? currentHash,
        }))
      }
    },
    [address, config, queryClient, route, writeContractAsync],
  )

  return { state, send, reset }
}
