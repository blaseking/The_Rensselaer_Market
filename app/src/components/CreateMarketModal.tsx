import { BN } from '@coral-xyz/anchor'
import { useConnection } from '@solana/wallet-adapter-react'
import { SystemProgram, type PublicKey } from '@solana/web3.js'
import { useState } from 'react'
import { useActiveWallet } from '../context/ActiveWalletContext'
import {
  getProgram,
  isAdminRole,
  marketPda,
  profilePda,
  vaultPda,
  type MarketAccount,
  type ProfileAccount,
} from '../lib/anchor'
import { solToLamports } from '../lib/format'
import { logHistoryEvent } from '../lib/historyLog'

type MarketEntry = { publicKey: PublicKey; account: MarketAccount }

export function CreateMarketModal({
  profile,
  examMarkets,
  onClose,
  onCreated,
}: {
  profile: ProfileAccount
  examMarkets: MarketEntry[]
  onClose: () => void
  onCreated: () => void
}) {
  const { connection } = useConnection()
  const wallet = useActiveWallet()
  const isAdmin = isAdminRole(profile.role)
  const [question, setQuestion] = useState('')
  const [closeDate, setCloseDate] = useState('')
  const [parentMarket, setParentMarket] = useState(examMarkets[0]?.publicKey.toBase58() ?? '')
  const [liquidity, setLiquidity] = useState('1')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedParent = examMarkets.find((m) => m.publicKey.toBase58() === parentMarket)

  async function handleSubmit() {
    if (!wallet.publicKey || !wallet.signTransaction) return
    setError(null)

    const trimmed = question.trim()
    if (trimmed.length === 0 || trimmed.length > 200) {
      setError('Question must be 1-200 characters.')
      return
    }
    if (!isAdmin && !selectedParent) {
      setError('Pick which exam-average market this grade market belongs under.')
      return
    }
    const liquiditySol = Number(liquidity)
    if (!(liquiditySol > 0)) {
      setError('Enter starting liquidity greater than 0 — it seeds the market at 50/50.')
      return
    }

    let closeTs: number
    if (isAdmin) {
      const closeTsMs = new Date(closeDate).getTime()
      if (!closeDate || Number.isNaN(closeTsMs) || closeTsMs <= Date.now()) {
        setError('Pick a close time in the future.')
        return
      }
      closeTs = Math.floor(closeTsMs / 1000)
    } else {
      // Personal-grade markets must close at exactly the same time as their parent exam.
      closeTs = selectedParent!.account.closeTs.toNumber()
    }

    setSubmitting(true)
    try {
      const program = getProgram(connection, wallet as never)
      const marketId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))
      const [market] = marketPda(wallet.publicKey, marketId)
      const [vault] = vaultPda(market)
      const [profileKey] = profilePda(wallet.publicKey)

      await program.methods
        .createMarket(
          new BN(marketId.toString()),
          trimmed,
          new BN(closeTs),
          isAdmin ? { examAverage: {} } : { personalGrade: {} },
          new BN(solToLamports(liquiditySol)),
        )
        .accounts({
          creator: wallet.publicKey,
          profile: profileKey,
          market,
          vault,
          parentMarket: isAdmin ? null : parentMarket,
          systemProgram: SystemProgram.programId,
        } as never)
        .rpc()

      logHistoryEvent(
        wallet.publicKey,
        `Created ${isAdmin ? 'exam-average' : 'personal-grade'} market "${trimmed}" (liquidity ${liquiditySol} SOL)`,
      )
      onCreated()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create market.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-xl bg-surface p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-ink">
          {isAdmin ? 'Open an exam-average market' : 'Open your personal grade market'}
        </h2>
        <p className="mb-4 text-xs text-muted">
          {isAdmin
            ? 'Admins can only create exam-average markets.'
            : 'Students can only create personal markets, nested under an existing exam-average market.'}
        </p>

        {!isAdmin && (
          <>
            <label className="mb-1 block text-sm text-muted">Exam-average market</label>
            {examMarkets.length === 0 ? (
              <p className="mb-3 rounded-lg bg-brand-light p-2 text-xs text-brand-dark">
                No exam-average markets exist yet. Ask the admin to open one first.
              </p>
            ) : (
              <select
                className="mb-3 w-full rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
                value={parentMarket}
                onChange={(e) => setParentMarket(e.target.value)}
              >
                {examMarkets.map(({ publicKey, account }) => (
                  <option key={publicKey.toBase58()} value={publicKey.toBase58()}>
                    {account.question}
                  </option>
                ))}
              </select>
            )}
          </>
        )}

        <label className="mb-1 block text-sm text-muted">
          {isAdmin ? 'Question (yes/no)' : 'Your personal question (yes/no)'}
        </label>
        <textarea
          className="mb-3 w-full rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
          rows={3}
          placeholder={
            isAdmin
              ? 'Will the CSCI-4430 midterm average be above 75%?'
              : 'Will I beat the CSCI-4430 midterm average?'
          }
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={200}
        />

        <label className="mb-1 block text-sm text-muted">Betting closes at</label>
        {isAdmin ? (
          <input
            type="datetime-local"
            className="mb-4 w-full rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
            value={closeDate}
            onChange={(e) => setCloseDate(e.target.value)}
          />
        ) : (
          <div className="mb-4 w-full rounded-lg bg-field p-2 text-sm text-muted">
            {selectedParent
              ? `${new Date(selectedParent.account.closeTs.toNumber() * 1000).toLocaleString()} (same as the exam market)`
              : 'Pick an exam-average market above first'}
          </div>
        )}

        <label className="mb-1 block text-sm text-muted">Starting liquidity</label>
        <input
          type="number"
          min="0"
          step="0.01"
          className="mb-1 w-full rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
          value={liquidity}
          onChange={(e) => setLiquidity(e.target.value)}
        />
        <p className="mb-4 text-xs text-muted">
          Seeds the market at an even 50¢/50¢ price, paid from your website balance. You can
          withdraw your share of this back out after the market resolves.
        </p>

        {error && <p className="mb-3 text-sm text-brand">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            className="rounded-lg px-4 py-2 text-sm text-muted hover:text-ink"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
            onClick={handleSubmit}
            disabled={submitting || !wallet.publicKey || (!isAdmin && !selectedParent)}
          >
            {submitting ? 'Creating…' : 'Create market'}
          </button>
        </div>
      </div>
    </div>
  )
}
