import { BN } from '@coral-xyz/anchor'
import { useConnection } from '@solana/wallet-adapter-react'
import { SystemProgram, type PublicKey } from '@solana/web3.js'
import { useCallback, useEffect, useState } from 'react'
import { useActiveWallet } from '../context/ActiveWalletContext'
import {
  getProgram,
  getReadonlyProgram,
  outcomeLabel,
  positionPda,
  pricesFromReserves,
  profilePda,
  simulateSell,
  vaultPda,
  type MarketAccount,
  type PositionAccount,
} from '../lib/anchor'
import { formatSol, solToLamports } from '../lib/format'
import { logHistoryEvent } from '../lib/historyLog'

type Row = {
  positionKey: PublicKey
  marketKey: PublicKey
  position: PositionAccount
  market: MarketAccount
  side: 'yes' | 'no'
  shares: InstanceType<typeof BN>
}

export function PositionsTable({ onChanged }: { onChanged: () => void }) {
  const { connection } = useConnection()
  const wallet = useActiveWallet()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sellInputs, setSellInputs] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!wallet.publicKey) {
      setRows([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const program = getReadonlyProgram(connection)
      const accounts = program.account as unknown as Record<
        string,
        {
          all: (filters?: unknown[]) => Promise<{ publicKey: PublicKey; account: PositionAccount }[]>
          fetch: (k: PublicKey) => Promise<MarketAccount>
        }
      >
      const positions = await accounts.position.all([
        { memcmp: { offset: 8 + 32, bytes: wallet.publicKey.toBase58() } },
      ])

      const nextRows: Row[] = []
      for (const { publicKey, account } of positions) {
        if (account.yesShares.eqn(0) && account.noShares.eqn(0)) continue
        const market = await accounts.market.fetch(account.market)
        if (account.yesShares.gtn(0)) {
          nextRows.push({ positionKey: publicKey, marketKey: account.market, position: account, market, side: 'yes', shares: account.yesShares })
        }
        if (account.noShares.gtn(0)) {
          nextRows.push({ positionKey: publicKey, marketKey: account.market, position: account, market, side: 'no', shares: account.noShares })
        }
      }
      nextRows.sort((a, b) => b.market.closeTs.toNumber() - a.market.closeTs.toNumber())
      setRows(nextRows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load your positions.')
    } finally {
      setLoading(false)
    }
  }, [connection, wallet.publicKey])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function sell(row: Row) {
    if (!wallet.publicKey) return
    const key = row.positionKey.toBase58() + row.side
    const sol = Number(sellInputs[key] ?? '')
    if (!(sol > 0)) {
      setError('Enter a share amount greater than 0 to sell.')
      return
    }
    setError(null)
    setBusyKey(key)
    try {
      const program = getProgram(connection, wallet as never)
      const [vault] = vaultPda(row.marketKey)
      const [position] = positionPda(row.marketKey, wallet.publicKey)
      const [profile] = profilePda(wallet.publicKey)
      await program.methods
        .sell(row.side === 'yes', new BN(solToLamports(sol)))
        .accounts({
          user: wallet.publicKey,
          profile,
          market: row.marketKey,
          vault,
          position,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
      logHistoryEvent(
        wallet.publicKey,
        `Sold ${sol} shares of ${row.side === 'yes' ? 'Yes' : 'No'} — "${row.market.question}"`,
      )
      await refresh()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sell failed.')
    } finally {
      setBusyKey(null)
    }
  }

  async function redeem(row: Row) {
    if (!wallet.publicKey) return
    const key = row.positionKey.toBase58() + row.side
    setError(null)
    setBusyKey(key)
    try {
      const program = getProgram(connection, wallet as never)
      const [vault] = vaultPda(row.marketKey)
      const [position] = positionPda(row.marketKey, wallet.publicKey)
      const [profile] = profilePda(wallet.publicKey)
      await program.methods
        .redeem()
        .accounts({
          user: wallet.publicKey,
          profile,
          market: row.marketKey,
          vault,
          position,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
      const isVoid = outcomeLabel(row.market.outcome) === 'Void'
      const amount = isVoid ? row.position.yesCost.add(row.position.noCost) : row.shares
      logHistoryEvent(wallet.publicKey, `Redeemed ${formatSol(amount)} — "${row.market.question}"`)
      await refresh()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Redeem failed.')
    } finally {
      setBusyKey(null)
    }
  }

  if (!wallet.publicKey) return null
  if (loading) return <p className="text-muted">Loading your positions…</p>

  return (
    <div className="rounded-lg bg-surface p-5">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">Your positions</p>

      {error && <p className="mb-3 rounded-lg bg-brand-light p-2 text-xs text-brand-dark">{error}</p>}

      {rows.length === 0 ? (
        <p className="text-sm text-muted">No open or redeemable positions yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-hairline text-xs font-medium uppercase text-muted">
                <th className="py-2 pr-3">Market</th>
                <th className="py-2 pr-3">Side</th>
                <th className="py-2 pr-3">Shares</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const key = row.positionKey.toBase58() + row.side
                const closed = Date.now() >= row.market.closeTs.toNumber() * 1000
                const outcome = outcomeLabel(row.market.outcome)
                const isVoid = outcome === 'Void'
                const won = row.market.resolved && outcome === (row.side === 'yes' ? 'Yes' : 'No')
                const redeemable = row.market.resolved && (won || isVoid)
                const redeemAmount = isVoid ? row.position.yesCost.add(row.position.noCost) : row.shares
                const lost = row.market.resolved && !isVoid && !won
                const { yesPct, noPct } = pricesFromReserves(row.market.yesReserve, row.market.noReserve)
                const price = row.side === 'yes' ? yesPct : noPct

                const sharesIn =
                  Number(sellInputs[key]) > 0 ? BigInt(solToLamports(Number(sellInputs[key]))) : 0n
                const preview = sharesIn > 0n
                  ? simulateSell(
                      BigInt(row.market.yesReserve.toString()),
                      BigInt(row.market.noReserve.toString()),
                      row.side === 'yes',
                      sharesIn,
                    )
                  : null

                return (
                  <tr key={key} className="border-b border-hairline align-top">
                    <td className="max-w-[220px] py-2 pr-3 text-ink">{row.market.question}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          row.side === 'yes' ? 'bg-green-light text-green-dark' : 'bg-brand-light text-brand-dark'
                        }`}
                      >
                        {row.side === 'yes' ? 'Yes' : 'No'}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-ink">{formatSol(row.shares)}</td>
                    <td className="py-2 pr-3 text-muted">
                      {row.market.resolved
                        ? `Resolved: ${outcome}`
                        : closed
                          ? 'Closed, awaiting resolution'
                          : `Open · ${price}¢`}
                    </td>
                    <td className="py-2">
                      {!row.market.resolved && !closed && (
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={sellInputs[key] ?? ''}
                            onChange={(e) => setSellInputs((s) => ({ ...s, [key]: e.target.value }))}
                            placeholder="shares"
                            className="w-20 rounded-lg border border-hairline bg-field p-1.5 text-xs text-ink outline-none focus:border-brand"
                          />
                          <button
                            className="rounded-lg bg-field px-2 py-1.5 text-xs font-medium text-ink ring-1 ring-hairline hover:bg-surface disabled:opacity-50"
                            onClick={() => sell(row)}
                            disabled={busyKey !== null}
                          >
                            {busyKey === key ? '…' : 'Sell'}
                          </button>
                          {preview && (
                            <span className="text-[11px] text-muted">≈ {formatSol(Number(preview.amountOut))}</span>
                          )}
                        </div>
                      )}
                      {!row.market.resolved && closed && (
                        <span className="text-xs text-muted">Waiting for resolution</span>
                      )}
                      {redeemable && !row.position.redeemed && (
                        <button
                          className="rounded-lg bg-brand px-2 py-1.5 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-50"
                          onClick={() => redeem(row)}
                          disabled={busyKey !== null}
                        >
                          {busyKey === key ? '…' : `Redeem ${formatSol(redeemAmount)}`}
                        </button>
                      )}
                      {lost && <span className="text-xs text-muted">Lost</span>}
                      {row.position.redeemed && <span className="text-xs text-muted">Redeemed</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
