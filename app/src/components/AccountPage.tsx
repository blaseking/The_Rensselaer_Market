import { BN } from '@coral-xyz/anchor'
import { useConnection } from '@solana/wallet-adapter-react'
import { SystemProgram } from '@solana/web3.js'
import { useCallback, useEffect, useState } from 'react'
import { useActiveWallet } from '../context/ActiveWalletContext'
import {
  configPda,
  getProgram,
  getReadonlyProgram,
  getWebsiteBalance,
  isAdminRole,
  profilePda,
  type ConfigAccount,
  type ProfileAccount,
  type WebsiteBalance,
} from '../lib/anchor'
import { formatSol, solToLamports } from '../lib/format'
import { logHistoryEvent } from '../lib/historyLog'
import { PositionsTable } from './PositionsTable'

export function AccountPage({ onAccountChanged }: { onAccountChanged: () => void }) {
  const { connection } = useConnection()
  const wallet = useActiveWallet()
  const [config, setConfig] = useState<ConfigAccount | null>(null)
  const [profile, setProfile] = useState<ProfileAccount | null>(null)
  const [balance, setBalance] = useState<WebsiteBalance | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [studentId, setStudentId] = useState('')
  const [name, setName] = useState('')
  const [depositAmount, setDepositAmount] = useState('1')
  const [withdrawAmount, setWithdrawAmount] = useState('1')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const program = getReadonlyProgram(connection)
      const [configKey] = configPda()
      const configAcc = await (
        program.account as Record<string, { fetchNullable: (k: typeof configKey) => Promise<unknown> }>
      ).config.fetchNullable(configKey)
      setConfig(configAcc as ConfigAccount | null)

      if (wallet.publicKey) {
        const [profileKey] = profilePda(wallet.publicKey)
        const profileAcc = await (
          program.account as Record<string, { fetchNullable: (k: typeof profileKey) => Promise<unknown> }>
        ).profile.fetchNullable(profileKey)
        setProfile(profileAcc as ProfileAccount | null)
        if (profileAcc) {
          setBalance(await getWebsiteBalance(connection, profileKey))
        } else {
          setBalance(null)
        }
      } else {
        setProfile(null)
        setBalance(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load account state.')
    } finally {
      setLoading(false)
    }
  }, [connection, wallet.publicKey])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function initializePlatform() {
    if (!wallet.publicKey) return
    setBusy(true)
    setError(null)
    try {
      const program = getProgram(connection, wallet as never)
      const [config] = configPda()
      await program.methods
        .initializeConfig()
        .accounts({ initializer: wallet.publicKey, config, systemProgram: SystemProgram.programId })
        .rpc()
      logHistoryEvent(wallet.publicKey, 'Initialized the platform (became admin)')
      await refresh()
      onAccountChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to initialize platform.')
    } finally {
      setBusy(false)
    }
  }

  async function registerAsAdmin() {
    if (!wallet.publicKey) return
    setBusy(true)
    setError(null)
    try {
      const program = getProgram(connection, wallet as never)
      const [config] = configPda()
      const [profileKey] = profilePda(wallet.publicKey)
      await program.methods
        .registerAdmin(name.trim())
        .accounts({ owner: wallet.publicKey, config, profile: profileKey, systemProgram: SystemProgram.programId })
        .rpc()
      logHistoryEvent(wallet.publicKey, `Registered as admin "${name.trim()}"`)
      await refresh()
      onAccountChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to register as admin.')
    } finally {
      setBusy(false)
    }
  }

  async function registerAsStudent() {
    if (!wallet.publicKey) return
    if (!studentId.trim() || !name.trim()) {
      setError('Student ID and name are both required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const program = getProgram(connection, wallet as never)
      const [profileKey] = profilePda(wallet.publicKey)
      await program.methods
        .registerStudent(studentId.trim(), name.trim())
        .accounts({ owner: wallet.publicKey, profile: profileKey, systemProgram: SystemProgram.programId })
        .rpc()
      logHistoryEvent(wallet.publicKey, `Registered as student "${name.trim()}" (${studentId.trim()})`)
      await refresh()
      onAccountChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to register as student.')
    } finally {
      setBusy(false)
    }
  }

  async function deposit() {
    if (!wallet.publicKey) return
    const sol = Number(depositAmount)
    if (!(sol > 0)) {
      setError('Enter a deposit amount greater than 0.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const program = getProgram(connection, wallet as never)
      const [profileKey] = profilePda(wallet.publicKey)
      await program.methods
        .deposit(new BN(solToLamports(sol)))
        .accounts({ owner: wallet.publicKey, profile: profileKey, systemProgram: SystemProgram.programId })
        .rpc()
      logHistoryEvent(wallet.publicKey, `Deposited ${sol} SOL`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deposit failed.')
    } finally {
      setBusy(false)
    }
  }

  async function withdraw() {
    if (!wallet.publicKey) return
    const sol = Number(withdrawAmount)
    if (!(sol > 0)) {
      setError('Enter a withdraw amount greater than 0.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const program = getProgram(connection, wallet as never)
      const [profileKey] = profilePda(wallet.publicKey)
      await program.methods
        .withdraw(new BN(solToLamports(sol)))
        .accounts({ owner: wallet.publicKey, profile: profileKey })
        .rpc()
      logHistoryEvent(wallet.publicKey, `Withdrew ${sol} SOL`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Withdraw failed.')
    } finally {
      setBusy(false)
    }
  }

  if (!wallet.publicKey) {
    return <p className="text-muted">Connect a wallet to view or create your account.</p>
  }

  if (loading) {
    return <p className="text-muted">Loading account…</p>
  }

  const isDesignatedAdmin = config !== null && config.admin.equals(wallet.publicKey)

  let registrationPanel = null
  if (!profile) {
    if (config === null) {
      registrationPanel = (
        <div className="rounded-lg bg-surface p-5">
          <p className="mb-3 text-sm text-ink">
            This platform hasn't been initialized yet. The first wallet to initialize it becomes
            the permanent admin.
          </p>
          <button
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
            onClick={initializePlatform}
            disabled={busy}
          >
            {busy ? 'Initializing…' : 'Initialize platform (become admin)'}
          </button>
        </div>
      )
    } else if (isDesignatedAdmin) {
      registrationPanel = (
        <div className="rounded-lg bg-surface p-5">
          <p className="mb-3 text-sm text-ink">
            This wallet is the platform admin. Register your display name to finish setting up.
          </p>
          <label className="mb-1 block text-sm text-muted">Name</label>
          <input
            className="mb-3 w-full rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Professor Smith"
          />
          <button
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
            onClick={registerAsAdmin}
            disabled={busy}
          >
            {busy ? 'Registering…' : 'Register as admin'}
          </button>
        </div>
      )
    } else {
      registrationPanel = (
        <div className="rounded-lg bg-surface p-5">
          <p className="mb-3 text-sm text-ink">
            Verify your identity to create and bet on markets. This binds your student ID and name
            to this wallet permanently.
          </p>
          <label className="mb-1 block text-sm text-muted">Student ID</label>
          <input
            className="mb-3 w-full rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            placeholder="RIN123456"
            maxLength={32}
          />
          <label className="mb-1 block text-sm text-muted">Name</label>
          <input
            className="mb-3 w-full rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alice Johnson"
            maxLength={64}
          />
          <button
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
            onClick={registerAsStudent}
            disabled={busy}
          >
            {busy ? 'Registering…' : 'Register as student'}
          </button>
        </div>
      )
    }
  }

  return (
    <div className="grid max-w-4xl grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        {error && <p className="rounded-lg bg-brand-light p-3 text-sm text-brand-dark">{error}</p>}

        {profile ? (
          <div className="rounded-lg bg-surface p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              {isAdminRole(profile.role) ? 'Admin account' : 'Student account'}
            </p>
            <p className="mt-1 text-xl font-semibold text-ink">{profile.name}</p>
            {!isAdminRole(profile.role) && (
              <p className="mt-1 text-sm text-muted">Student ID: {profile.studentId}</p>
            )}
            <p className="mt-3 break-all text-xs text-muted">{wallet.publicKey.toBase58()}</p>
          </div>
        ) : null}

        {profile && balance && (
          <div className="rounded-lg bg-surface p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Website balance</p>
            <p className="mt-1 text-2xl font-semibold text-ink">
              {formatSol(balance.availableLamports)}
            </p>

            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm text-muted">Deposit</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    className="w-full rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
                  />
                  <button
                    className="shrink-0 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
                    onClick={deposit}
                    disabled={busy}
                  >
                    {busy ? '…' : 'Deposit'}
                  </button>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm text-muted">Withdraw</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    className="w-full rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
                  />
                  <button
                    className="shrink-0 rounded-lg bg-field px-3 py-2 text-sm font-medium text-ink ring-1 ring-hairline hover:bg-surface disabled:opacity-50"
                    onClick={withdraw}
                    disabled={busy}
                  >
                    {busy ? '…' : 'Withdraw'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {registrationPanel}
      </div>

      {profile && <PositionsTable onChanged={refresh} />}
    </div>
  )
}
