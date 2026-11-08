import type { PublicKey } from '@solana/web3.js'

export interface HistoryEntry {
  timestamp: number
  summary: string
}

const MAX_ENTRIES = 200

function storageKey(owner: PublicKey): string {
  return `grademarket:history:${owner.toBase58()}`
}

/** Records an action to this browser's local history log for the given wallet, the moment
 * it succeeds. This sidesteps relying on RPC transaction-history lookups, which aren't
 * retained by a local test validator (and may be limited on other RPC providers too). */
export function logHistoryEvent(owner: PublicKey, summary: string): void {
  try {
    const next: HistoryEntry[] = [{ timestamp: Date.now(), summary }, ...getHistoryEvents(owner)].slice(
      0,
      MAX_ENTRIES,
    )
    localStorage.setItem(storageKey(owner), JSON.stringify(next))
  } catch {
    // localStorage unavailable (private browsing, blocked storage, etc.) — non-critical, skip.
  }
}

export function getHistoryEvents(owner: PublicKey): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(owner))
    if (!raw) return []
    return JSON.parse(raw) as HistoryEntry[]
  } catch {
    return []
  }
}
