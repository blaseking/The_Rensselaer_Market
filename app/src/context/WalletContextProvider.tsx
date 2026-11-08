import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { useMemo, type ReactNode } from 'react'
import { RPC_URL } from '../lib/anchor'

import '@solana/wallet-adapter-react-ui/styles.css'

export function WalletContextProvider({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => RPC_URL, [])

  return (
    <ConnectionProvider endpoint={endpoint}>
      {/* No explicit wallets: Wallet Standard auto-detects installed wallets (Phantom, Solflare, etc). */}
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
