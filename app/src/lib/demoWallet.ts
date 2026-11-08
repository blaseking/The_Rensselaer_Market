import { Keypair } from '@solana/web3.js'

const STORAGE_KEY = 'grademarket:demo-keypair'

/** sessionStorage is isolated per browser tab, so each tab that opts into "demo wallet"
 * mode gets its own independent local keypair — exactly what you want to show an admin
 * and a student acting side by side in two tabs of the same browser. */
export function getOrCreateDemoKeypair(): Keypair {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as number[]
      return Keypair.fromSecretKey(Uint8Array.from(arr))
    }
  } catch {
    // fall through to generate a fresh one
  }
  const kp = Keypair.generate()
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(kp.secretKey)))
  } catch {
    // sessionStorage unavailable (private browsing, etc.) — works for this render, just
    // won't survive a reload.
  }
  return kp
}

export function resetDemoKeypair(): Keypair {
  const kp = Keypair.generate()
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(kp.secretKey)))
  } catch {
    // ignore
  }
  return kp
}
