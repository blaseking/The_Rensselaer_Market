import { useWallet } from '@solana/wallet-adapter-react'
import { Transaction, VersionedTransaction, type PublicKey } from '@solana/web3.js'
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { getOrCreateDemoKeypair, resetDemoKeypair } from '../lib/demoWallet'

export type WalletMode = 'wallet' | 'demo'

export interface ActiveWallet {
  publicKey: PublicKey | null
  connected: boolean
  mode: WalletMode
  setMode: (mode: WalletMode) => void
  regenerateDemoKeypair: () => void
  signTransaction?: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>
  signAllTransactions?: <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>
}

const ActiveWalletCtx = createContext<ActiveWallet | null>(null)

/** Lets the app run against either the real connected wallet (Phantom etc.) or a local
 * "demo" keypair held in this tab's sessionStorage — so two tabs of the same browser can
 * each act as a different identity (e.g. one admin, one student) for a showcase. */
export function ActiveWalletProvider({ children }: { children: ReactNode }) {
  const realWallet = useWallet()
  const [mode, setMode] = useState<WalletMode>('wallet')
  const [demoVersion, setDemoVersion] = useState(0)

  const value = useMemo<ActiveWallet>(() => {
    if (mode === 'demo') {
      const kp = getOrCreateDemoKeypair()
      return {
        publicKey: kp.publicKey,
        connected: true,
        mode,
        setMode,
        regenerateDemoKeypair: () => {
          resetDemoKeypair()
          setDemoVersion((v) => v + 1)
        },
        signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => {
          if (tx instanceof VersionedTransaction) {
            tx.sign([kp])
          } else {
            tx.partialSign(kp)
          }
          return tx
        },
        signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => {
          for (const tx of txs) {
            if (tx instanceof VersionedTransaction) tx.sign([kp])
            else tx.partialSign(kp)
          }
          return txs
        },
      }
    }
    return {
      publicKey: realWallet.publicKey,
      connected: realWallet.connected,
      mode,
      setMode,
      regenerateDemoKeypair: () => {},
      signTransaction: realWallet.signTransaction,
      signAllTransactions: realWallet.signAllTransactions,
    }
    // demoVersion is a dependency on purpose: bumping it forces a fresh keypair read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, realWallet.publicKey, realWallet.connected, realWallet.signTransaction, realWallet.signAllTransactions, demoVersion])

  return <ActiveWalletCtx.Provider value={value}>{children}</ActiveWalletCtx.Provider>
}

export function useActiveWallet(): ActiveWallet {
  const ctx = useContext(ActiveWalletCtx)
  if (!ctx) throw new Error('useActiveWallet must be used within an ActiveWalletProvider')
  return ctx
}
