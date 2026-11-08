import { useConnection } from '@solana/wallet-adapter-react'
import type { PublicKey } from '@solana/web3.js'
import { useCallback, useEffect, useState } from 'react'
import { AccountPage } from './components/AccountPage'
import { CreateMarketModal } from './components/CreateMarketModal'
import { Header, type Tab } from './components/Header'
import { HistoryPage } from './components/HistoryPage'
import { MarketCard } from './components/MarketCard'
import { useActiveWallet } from './context/ActiveWalletContext'
import {
  configPda,
  getReadonlyProgram,
  isExamAverage,
  profilePda,
  type ConfigAccount,
  type MarketAccount,
  type ProfileAccount,
} from './lib/anchor'

type MarketEntry = { publicKey: PublicKey; account: MarketAccount }
type ProfileEntry = { publicKey: PublicKey; account: ProfileAccount }

function App() {
  const { connection } = useConnection()
  const wallet = useActiveWallet()
  const [tab, setTab] = useState<Tab>('markets')
  const [markets, setMarkets] = useState<MarketEntry[]>([])
  const [profiles, setProfiles] = useState<ProfileEntry[]>([])
  const [myProfile, setMyProfile] = useState<ProfileAccount | null>(null)
  const [config, setConfig] = useState<ConfigAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const program = getReadonlyProgram(connection)
      const accounts = program.account as Record<
        string,
        { all: () => Promise<unknown>; fetchNullable: (k: PublicKey) => Promise<unknown> }
      >

      const allMarkets = (await accounts.market.all()) as unknown as MarketEntry[]
      allMarkets.sort((a, b) => b.account.closeTs.toNumber() - a.account.closeTs.toNumber())
      setMarkets(allMarkets)

      const allProfiles = (await accounts.profile.all()) as unknown as ProfileEntry[]
      setProfiles(allProfiles)

      const [configKey] = configPda()
      const configAcc = await accounts.config.fetchNullable(configKey)
      setConfig(configAcc as ConfigAccount | null)

      if (wallet.publicKey) {
        const [profileKey] = profilePda(wallet.publicKey)
        const mine = await accounts.profile.fetchNullable(profileKey)
        setMyProfile(mine as ProfileAccount | null)
      } else {
        setMyProfile(null)
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load markets.')
    } finally {
      setLoading(false)
    }
  }, [connection, wallet.publicKey])

  const isAdmin = config !== null && wallet.publicKey !== null && config.admin.equals(wallet.publicKey)

  useEffect(() => {
    refresh()
  }, [refresh, tab])

  const nameFor = (owner: PublicKey) =>
    profiles.find((p) => p.account.owner.equals(owner))?.account.name

  const examMarkets = markets.filter((m) => isExamAverage(m.account.kind))
  const childrenOf = (examMarketKey: PublicKey) =>
    markets.filter((m) => !isExamAverage(m.account.kind) && m.account.parentMarket?.equals(examMarketKey))

  return (
    <div className="app-shell min-h-screen">
      <Header tab={tab} onTabChange={setTab} />

      <main className="mx-auto max-w-5xl px-6 py-8">
        {tab === 'account' ? (
          <AccountPage onAccountChanged={refresh} />
        ) : tab === 'history' ? (
          <HistoryPage />
        ) : (
          <>
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">Open markets</h2>
              <button
                className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-40"
                onClick={() => setShowCreate(true)}
                disabled={!myProfile}
                title={!myProfile ? 'Register an account first' : undefined}
              >
                + New market
              </button>
            </div>

            {!myProfile && wallet.publicKey && (
              <p className="mb-4 rounded-lg bg-brand-light p-3 text-sm text-brand-dark">
                Register as a student or admin on the Account tab to create markets or bet.
              </p>
            )}

            {loading && <p className="text-muted">Loading markets…</p>}
            {loadError && (
              <p className="rounded-lg bg-brand-light p-3 text-sm text-brand-dark">{loadError}</p>
            )}
            {!loading && !loadError && markets.length === 0 && (
              <p className="text-muted">No markets yet. Be the first to open one.</p>
            )}

            <div className="divide-y divide-hairline">
              {examMarkets.map(({ publicKey, account }) => {
                const children = childrenOf(publicKey)
                return (
                  <div
                    key={publicKey.toBase58()}
                    className="group relative -mx-4 rounded-lg px-4 py-6 transition-colors first:pt-0 hover:bg-surface/60"
                  >
                    <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-brand" />
                    <MarketCard
                      publicKey={publicKey}
                      account={account}
                      creatorName={nameFor(account.authority)}
                      hasProfile={myProfile !== null}
                      isAdmin={isAdmin}
                      onChanged={refresh}
                    />
                    {children.length > 0 && (
                      <div className="mt-4 ml-5 space-y-4 border-l-2 border-hairline pl-5">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted">
                          Personal grade bets under this exam
                        </p>
                        {children.map((c) => (
                          <MarketCard
                            key={c.publicKey.toBase58()}
                            publicKey={c.publicKey}
                            account={c.account}
                            creatorName={nameFor(c.account.authority)}
                            hasProfile={myProfile !== null}
                            isAdmin={isAdmin}
                            onChanged={refresh}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </main>

      {showCreate && myProfile && (
        <CreateMarketModal
          profile={myProfile}
          examMarkets={examMarkets}
          onClose={() => setShowCreate(false)}
          onCreated={refresh}
        />
      )}
    </div>
  )
}

export default App
