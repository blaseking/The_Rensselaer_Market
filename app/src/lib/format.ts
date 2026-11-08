import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import type { BN } from '@coral-xyz/anchor'

export function lamportsToSol(lamports: BN | number): number {
  const n = typeof lamports === 'number' ? lamports : lamports.toNumber()
  return n / LAMPORTS_PER_SOL
}

export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL)
}

export function formatSol(lamports: BN | number): string {
  return `${lamportsToSol(lamports).toFixed(3)} SOL`
}

export function formatCountdown(closeTsSeconds: number): string {
  const diffMs = closeTsSeconds * 1000 - Date.now()
  if (diffMs <= 0) return 'Betting closed'
  const mins = Math.floor(diffMs / 60000)
  const days = Math.floor(mins / (60 * 24))
  const hours = Math.floor((mins % (60 * 24)) / 60)
  const remMins = mins % 60
  if (days > 0) return `${days}d ${hours}h left`
  if (hours > 0) return `${hours}h ${remMins}m left`
  return `${remMins}m left`
}
