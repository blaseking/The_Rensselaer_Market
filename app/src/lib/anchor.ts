import { AnchorProvider, Program, type Idl } from '@coral-xyz/anchor'
import type { AnchorWallet } from '@solana/wallet-adapter-react'
import { type Connection, PublicKey } from '@solana/web3.js'
import { Buffer } from 'buffer'
import idl from '../idl/grademarket.json'

export interface WebsiteBalance {
  totalLamports: number
  rentExemptLamports: number
  availableLamports: number
}

/** A Profile account also doubles as its owner's "website wallet": any lamports above
 * rent-exemption are their spendable/withdrawable balance. */
export async function getWebsiteBalance(
  connection: Connection,
  profileKey: PublicKey,
): Promise<WebsiteBalance> {
  const info = await connection.getAccountInfo(profileKey)
  if (!info) return { totalLamports: 0, rentExemptLamports: 0, availableLamports: 0 }
  const rentExemptLamports = await connection.getMinimumBalanceForRentExemption(info.data.length)
  return {
    totalLamports: info.lamports,
    rentExemptLamports,
    availableLamports: Math.max(0, info.lamports - rentExemptLamports),
  }
}

export const PROGRAM_ID = new PublicKey(import.meta.env.VITE_PROGRAM_ID as string)
export const RPC_URL = (import.meta.env.VITE_RPC_URL as string) ?? 'https://api.devnet.solana.com'

export function getProgram(connection: Connection, wallet: AnchorWallet) {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  })
  return new Program(idl as Idl, provider)
}

/** Read-only wallet stand-in so markets can be listed before a wallet connects. Never used to sign. */
const readonlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: async <T,>(tx: T) => tx,
  signAllTransactions: async <T,>(txs: T[]) => txs,
} as unknown as AnchorWallet

export function getReadonlyProgram(connection: Connection) {
  return getProgram(connection, readonlyWallet)
}

function u64LeBytes(value: bigint): Buffer {
  const bytes = new Uint8Array(8)
  let v = value
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return Buffer.from(bytes)
}

export function marketPda(creator: PublicKey, marketId: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('market'), creator.toBuffer(), u64LeBytes(marketId)],
    PROGRAM_ID,
  )
}

export function vaultPda(market: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), market.toBuffer()], PROGRAM_ID)
}

export function positionPda(market: PublicKey, user: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position'), market.toBuffer(), user.toBuffer()],
    PROGRAM_ID,
  )
}

export function configPda() {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)
}

export function profilePda(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('profile'), owner.toBuffer()], PROGRAM_ID)
}

export function evidencePda(market: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('evidence'), market.toBuffer()], PROGRAM_ID)
}

export type Outcome =
  | { unresolved?: Record<string, never> }
  | { yes?: Record<string, never> }
  | { no?: Record<string, never> }
  | { void?: Record<string, never> }
export type Resolution = { yes: Record<string, never> } | { no: Record<string, never> } | { void: Record<string, never> }
export type Role = { student?: Record<string, never> } | { admin?: Record<string, never> }
export type MarketKind = { examAverage?: Record<string, never> } | { personalGrade?: Record<string, never> }

export interface MarketAccount {
  authority: PublicKey
  marketId: import('@coral-xyz/anchor').BN
  question: string
  closeTs: import('@coral-xyz/anchor').BN
  resolved: boolean
  outcome: Outcome
  yesReserve: import('@coral-xyz/anchor').BN
  noReserve: import('@coral-xyz/anchor').BN
  liquidityPaid: import('@coral-xyz/anchor').BN
  kind: MarketKind
  parentMarket: PublicKey | null
  lpWithdrawn: boolean
  bump: number
  vaultBump: number
}

export interface PositionAccount {
  market: PublicKey
  user: PublicKey
  yesShares: import('@coral-xyz/anchor').BN
  noShares: import('@coral-xyz/anchor').BN
  yesCost: import('@coral-xyz/anchor').BN
  noCost: import('@coral-xyz/anchor').BN
  redeemed: boolean
  bump: number
}

export interface EvidenceAccount {
  market: PublicKey
  submitter: PublicKey
  note: string
  /** A filename (content-hash-based) in the local dev server's /uploads/ store — the image
   * itself lives off-chain since a transaction can't carry more than ~1KB of data. */
  imageRef: string
  bump: number
}

export interface ConfigAccount {
  admin: PublicKey
  bump: number
}

export interface ProfileAccount {
  owner: PublicKey
  role: Role
  studentId: string
  name: string
  bump: number
}

export function outcomeLabel(outcome: Outcome): 'Unresolved' | 'Yes' | 'No' | 'Void' {
  if ('yes' in outcome) return 'Yes'
  if ('no' in outcome) return 'No'
  if ('void' in outcome) return 'Void'
  return 'Unresolved'
}

export function isAdminRole(role: Role): boolean {
  return 'admin' in role
}

export function isExamAverage(kind: MarketKind): boolean {
  return 'examAverage' in kind
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

function isqrtFloor(n: bigint): bigint {
  if (n < 2n) return n
  let x0 = n / 2n
  let x1 = (x0 + n / x0) / 2n
  while (x1 < x0) {
    x0 = x1
    x1 = (x0 + n / x0) / 2n
  }
  return x0
}

function isqrtCeil(n: bigint): bigint {
  const f = isqrtFloor(n)
  return f * f === n ? f : f + 1n
}

/** Marginal price of Yes/No from the AMM's reserves, as rounded percentages summing to 100. */
export function pricesFromReserves(
  yesReserve: import('@coral-xyz/anchor').BN,
  noReserve: import('@coral-xyz/anchor').BN,
): { yesPct: number; noPct: number } {
  const yes = BigInt(yesReserve.toString())
  const no = BigInt(noReserve.toString())
  const total = yes + no
  if (total === 0n) return { yesPct: 50, noPct: 50 }
  const yesPct = Math.round(Number((no * 10000n) / total) / 100)
  return { yesPct, noPct: 100 - yesPct }
}

/** Mirrors the on-chain `buy` instruction's constant-product math exactly (same rounding). */
export function simulateBuy(
  yesReserve: bigint,
  noReserve: bigint,
  outcomeYes: boolean,
  amountIn: bigint,
): { sharesOut: bigint; newYesReserve: bigint; newNoReserve: bigint } {
  if (amountIn <= 0n) return { sharesOut: 0n, newYesReserve: yesReserve, newNoReserve: noReserve }
  const [selfReserve, otherReserve] = outcomeYes ? [yesReserve, noReserve] : [noReserve, yesReserve]
  const k = selfReserve * otherReserve
  const otherNew = otherReserve + amountIn
  const selfNew = ceilDiv(k, otherNew)
  const selfBefore = selfReserve + amountIn
  const sharesOut = selfBefore > selfNew ? selfBefore - selfNew : 0n
  return {
    sharesOut,
    newYesReserve: outcomeYes ? selfNew : otherNew,
    newNoReserve: outcomeYes ? otherNew : selfNew,
  }
}

/** Mirrors the on-chain `sell` instruction's quadratic solve exactly (same rounding). Returns
 * null if the trade isn't valid (e.g. selling more than the pool can support). */
export function simulateSell(
  yesReserve: bigint,
  noReserve: bigint,
  outcomeYes: boolean,
  sharesIn: bigint,
): { amountOut: bigint; newYesReserve: bigint; newNoReserve: bigint } | null {
  if (sharesIn <= 0n) return { amountOut: 0n, newYesReserve: yesReserve, newNoReserve: noReserve }
  const [x, o] = outcomeYes ? [yesReserve, noReserve] : [noReserve, yesReserve]
  const b = x + sharesIn + o
  const fourSO = 4n * sharesIn * o
  const bSq = b * b
  if (bSq < fourSO) return null
  const discriminant = bSq - fourSO
  const sqrtD = isqrtCeil(discriminant)
  if (b < sqrtD) return null
  const amountOut = (b - sqrtD) / 2n
  if (amountOut <= 0n) return null
  const selfFinal = x + sharesIn - amountOut
  const otherFinal = o - amountOut
  return {
    amountOut,
    newYesReserve: outcomeYes ? selfFinal : otherFinal,
    newNoReserve: outcomeYes ? otherFinal : selfFinal,
  }
}
