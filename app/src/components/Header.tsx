import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { useConnection } from '@solana/wallet-adapter-react'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { useEffect, useState } from 'react'
import { useActiveWallet } from '../context/ActiveWalletContext'
import { getWebsiteBalance, profilePda } from '../lib/anchor'

export type Tab = 'markets' | 'account' | 'history'

const TABS: { id: Tab; label: string }[] = [
  { id: 'markets', label: 'Markets' },
  { id: 'account', label: 'Account' },
  { id: 'history', label: 'History' },
]

export function Header({ tab, onTabChange }: { tab: Tab; onTabChange: (tab: Tab) => void }) {
  const { connection } = useConnection()
  const wallet = useActiveWallet()
  const { publicKey, mode, setMode, regenerateDemoKeypair } = wallet
  const [balance, setBalance] = useState<number | null>(null)
  const [airdropping, setAirdropping] = useState(false)
  const [airdropError, setAirdropError] = useState<string | null>(null)
  const [logoSrc, setLogoSrc] = useState('/logo.png')

  useEffect(() => {
    const img = new Image()
    img.src = '/logo.png'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const px = data.data
      // The source logo is black line art on a white background with no alpha channel.
      // Make the near-white background transparent so a drop-shadow glow hugs just the artwork.
      for (let i = 0; i < px.length; i += 4) {
        const luminance = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
        px[i + 3] = 255 - luminance
      }
      ctx.putImageData(data, 0, 0)
      setLogoSrc(canvas.toDataURL('image/png'))
    }
  }, [])

  useEffect(() => {
    if (!publicKey) {
      setBalance(null)
      return
    }
    let cancelled = false
    const [profileKey] = profilePda(publicKey)
    const load = () =>
      getWebsiteBalance(connection, profileKey).then(({ availableLamports }) => {
        if (!cancelled) setBalance(availableLamports / 1e9)
      })
    load()
    const id = setInterval(load, 10000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [connection, publicKey])

  async function airdrop() {
    if (!publicKey) return
    setAirdropError(null)
    setAirdropping(true)
    try {
      const sig = await connection.requestAirdrop(publicKey, 10 * LAMPORTS_PER_SOL)
      await connection.confirmTransaction(sig, 'confirmed')
    } catch (e) {
      setAirdropError(e instanceof Error ? e.message : 'Airdrop failed (only works on a local validator).')
    } finally {
      setAirdropping(false)
    }
  }

  return (
    <header className="border-b border-hairline bg-page">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-8 gap-y-2 px-6 py-3">
        <div className="flex shrink-0 flex-col items-center">
          <img
            src={logoSrc}
            alt=""
            className="h-16 w-16"
            style={{
              filter:
                'invert(1) drop-shadow(0 0 4px rgba(255,59,70,0.95)) drop-shadow(0 0 14px rgba(255,59,70,0.8))',
            }}
          />
          <p className="mt-1 whitespace-nowrap text-sm font-bold leading-tight text-ink [text-shadow:0_0_6px_rgba(245,245,247,0.8),0_0_16px_rgba(186,59,70,0.6)]">
            The Rensselaer Market
          </p>
        </div>

        <nav className="flex gap-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`border-b-2 py-1 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'border-brand text-brand'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
              onClick={() => onTabChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {publicKey && (
            <span
              className="rounded-full bg-surface px-3 py-1 text-sm text-muted"
              title="Your website balance — deposit on the Account tab to top this up"
            >
              {balance === null ? '…' : balance.toFixed(3)} SOL
            </span>
          )}

          <div className="flex rounded-full bg-surface p-0.5 text-xs">
            <button
              className={`rounded-full px-2.5 py-1 font-medium ${mode === 'wallet' ? 'bg-brand text-white' : 'text-muted hover:text-ink'}`}
              onClick={() => setMode('wallet')}
            >
              Wallet
            </button>
            <button
              className={`rounded-full px-2.5 py-1 font-medium ${mode === 'demo' ? 'bg-brand text-white' : 'text-muted hover:text-ink'}`}
              onClick={() => setMode('demo')}
              title="Use a local keypair just for this browser tab — handy for showing an admin and a student side by side in two tabs"
            >
              Demo
            </button>
          </div>

          {mode === 'demo' ? (
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-surface px-3 py-1 font-mono text-xs text-muted">
                {publicKey?.toBase58().slice(0, 4)}…{publicKey?.toBase58().slice(-4)}
              </span>
              <button
                className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white shadow-[0_6px_16px_-4px_rgba(0,0,0,0.45)] hover:bg-brand-dark disabled:opacity-50"
                onClick={airdrop}
                disabled={airdropping}
              >
                {airdropping ? '…' : 'Airdrop 10 SOL'}
              </button>
              <button
                className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white shadow-[0_6px_16px_-4px_rgba(0,0,0,0.45)] hover:bg-brand-dark"
                onClick={regenerateDemoKeypair}
                title="Replace this tab's demo identity with a brand new one"
              >
                New identity
              </button>
            </div>
          ) : (
            <WalletMultiButton />
          )}
        </div>
      </div>
      {mode === 'demo' && airdropError && <p className="px-6 pb-2 text-xs text-brand">{airdropError}</p>}
    </header>
  )
}
