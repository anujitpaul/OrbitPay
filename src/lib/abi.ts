import { parseAbiItem } from 'viem'

export const orbitPayAbi = [
  {
    type: 'function',
    name: 'pay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'memo', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'usdc',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'PaymentSent',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'memo', type: 'bytes32', indexed: false },
    ],
    anonymous: false,
  },
  { type: 'error', name: 'ZeroUSDCAddress', inputs: [] },
  { type: 'error', name: 'USDCAddressHasNoCode', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'ZeroRecipient', inputs: [] },
  { type: 'error', name: 'SelfPayment', inputs: [] },
  { type: 'error', name: 'ContractRecipient', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
] as const

export const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
