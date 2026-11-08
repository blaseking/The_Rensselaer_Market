import { BN } from '@coral-xyz/anchor'
import { useConnection } from '@solana/wallet-adapter-react'
import { SystemProgram, type PublicKey } from '@solana/web3.js'
import { useEffect, useState } from 'react'
import { useActiveWallet } from '../context/ActiveWalletContext'
import {
  configPda,
  evidencePda,
  getProgram,
  getReadonlyProgram,
  getWebsiteBalance,
  outcomeLabel,
  positionPda,
  pricesFromReserves,
  profilePda,
  simulateBuy,
  simulateSell,
  vaultPda,
  type EvidenceAccount,
  type MarketAccount,
  type PositionAccount,
  type WebsiteBalance,
} from '../lib/anchor'
import { formatCountdown, formatSol, solToLamports } from '../lib/format'
import { logHistoryEvent } from '../lib/historyLog'

const MAX_EVIDENCE_IMAGE_BYTES = 5 * 1024 * 1024

export function MarketCard({
  publicKey,
  account,
  creatorName,
  hasProfile,
  isAdmin,
  onChanged,
}: {
  publicKey: PublicKey
  account: MarketAccount
  creatorName?: string
  hasProfile: boolean
  isAdmin: boolean
  onChanged: () => void
}) {
  const { connection } = useConnection()
  const wallet = useActiveWallet()
  const [position, setPosition] = useState<PositionAccount | null>(null)
  const [balance, setBalance] = useState<WebsiteBalance | null>(null)
  const [evidence, setEvidence] = useState<EvidenceAccount | null>(null)
  const [buyAmount, setBuyAmount] = useState('0.1')
  const [sellYesAmount, setSellYesAmount] = useState('')
  const [sellNoAmount, setSellNoAmount] = useState('')
  const [evidenceNote, setEvidenceNote] = useState('')
  const [evidenceImageRef, setEvidenceImageRef] = useState<string | null>(null)
  const [evidenceImageName, setEvidenceImageName] = useState('')
  const [uploadingImage, setUploadingImage] = useState(false)
  const [busy, setBusy] = useState<
    | 'buy-yes'
    | 'buy-no'
    | 'sell-yes'
    | 'sell-no'
    | 'resolve-yes'
    | 'resolve-no'
    | 'resolve-void'
    | 'redeem'
    | 'withdraw-lp'
    | 'evidence'
    | null
  >(null)
  const [error, setError] = useState<string | null>(null)

  const closed = Date.now() >= account.closeTs.toNumber() * 1000
  const isAuthority = wallet.publicKey?.equals(account.authority) ?? false
  const { yesPct, noPct } = pricesFromReserves(account.yesReserve, account.noReserve)

  const yesReserveBig = BigInt(account.yesReserve.toString())
  const noReserveBig = BigInt(account.noReserve.toString())
  const buyLamports = Number(buyAmount) > 0 ? BigInt(solToLamports(Number(buyAmount))) : 0n
  const previewBuyYes = simulateBuy(yesReserveBig, noReserveBig, true, buyLamports)
  const previewBuyNo = simulateBuy(yesReserveBig, noReserveBig, false, buyLamports)
  const previewOddsIfYes = pricesFromReserves(
    new BN(previewBuyYes.newYesReserve.toString()),
    new BN(previewBuyYes.newNoReserve.toString()),
  )
  const previewOddsIfNo = pricesFromReserves(
    new BN(previewBuyNo.newYesReserve.toString()),
    new BN(previewBuyNo.newNoReserve.toString()),
  )

  async function refresh() {
    if (!wallet.publicKey) {
      setPosition(null)
      setBalance(null)
    } else {
      try {
        const program = getProgram(connection, wallet as never)
        const [posKey] = positionPda(publicKey, wallet.publicKey)
        const acc = await (
          program.account as Record<string, { fetchNullable: (k: typeof posKey) => Promise<unknown> }>
        ).position.fetchNullable(posKey)
        setPosition(acc as PositionAccount | null)
        const [profileKey] = profilePda(wallet.publicKey)
        setBalance(await getWebsiteBalance(connection, profileKey))
      } catch {
        setPosition(null)
      }
    }

    if (isAdmin || isAuthority) {
      try {
        const readProgram = getReadonlyProgram(connection)
        const [evidenceKey] = evidencePda(publicKey)
        const acc = (await (
          readProgram.account as Record<string, { fetchNullable: (k: typeof evidenceKey) => Promise<unknown> }>
        ).evidence.fetchNullable(evidenceKey)) as EvidenceAccount | null
        setEvidence(acc)
        setEvidenceNote((current) => (current === '' && acc?.note ? acc.note : current))
        setEvidenceImageRef((current) => (current === null && acc?.imageRef ? acc.imageRef : current))
      } catch {
        setEvidence(null)
      }
    } else {
      setEvidence(null)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.publicKey, publicKey, isAdmin, isAuthority])

  async function buy(outcomeYes: boolean) {
    if (!wallet.publicKey) return
    const sol = Number(buyAmount)
    if (!(sol > 0)) {
      setError('Enter a buy amount greater than 0.')
      return
    }
    setError(null)
    setBusy(outcomeYes ? 'buy-yes' : 'buy-no')
    try {
      const program = getProgram(connection, wallet as never)
      const [vault] = vaultPda(publicKey)
      const [position] = positionPda(publicKey, wallet.publicKey)
      const [profile] = profilePda(wallet.publicKey)
      await program.methods
        .buy(outcomeYes, new BN(solToLamports(sol)))
        .accounts({
          user: wallet.publicKey,
          profile,
          market: publicKey,
          vault,
          position,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
      logHistoryEvent(
        wallet.publicKey,
        `Bought ${outcomeYes ? 'Yes' : 'No'} with ${sol} SOL — "${account.question}"`,
      )
      await refresh()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Buy failed.')
    } finally {
      setBusy(null)
    }
  }

  async function sell(outcomeYes: boolean) {
    if (!wallet.publicKey) return
    const sharesStr = outcomeYes ? sellYesAmount : sellNoAmount
    const sol = Number(sharesStr)
    if (!(sol > 0)) {
      setError('Enter a share amount greater than 0 to sell.')
      return
    }
    setError(null)
    setBusy(outcomeYes ? 'sell-yes' : 'sell-no')
    try {
      const program = getProgram(connection, wallet as never)
      const [vault] = vaultPda(publicKey)
      const [position] = positionPda(publicKey, wallet.publicKey)
      const [profile] = profilePda(wallet.publicKey)
      await program.methods
        .sell(outcomeYes, new BN(solToLamports(sol)))
        .accounts({
          user: wallet.publicKey,
          profile,
          market: publicKey,
          vault,
          position,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
      logHistoryEvent(
        wallet.publicKey,
        `Sold ${sol} shares of ${outcomeYes ? 'Yes' : 'No'} — "${account.question}"`,
      )
      await refresh()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sell failed.')
    } finally {
      setBusy(null)
    }
  }

  async function resolve(resolution: 'yes' | 'no' | 'void') {
    if (!wallet.publicKey) return
    setError(null)
    setBusy(resolution === 'yes' ? 'resolve-yes' : resolution === 'no' ? 'resolve-no' : 'resolve-void')
    try {
      const program = getProgram(connection, wallet as never)
      const [config] = configPda()
      const resolutionArg =
        resolution === 'yes' ? { yes: {} } : resolution === 'no' ? { no: {} } : { void: {} }
      await program.methods
        .resolveMarket(resolutionArg)
        .accounts({ market: publicKey, config, admin: wallet.publicKey })
        .rpc()
      logHistoryEvent(wallet.publicKey, `Resolved "${account.question}" as ${resolution}`)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resolve failed.')
    } finally {
      setBusy(null)
    }
  }

  async function submitEvidence() {
    if (!wallet.publicKey) return
    if (!evidenceNote.trim() && !evidenceImageRef) {
      setError('Type a note or choose an image before submitting.')
      return
    }
    setError(null)
    setBusy('evidence')
    try {
      const program = getProgram(connection, wallet as never)
      const [evidenceKey] = evidencePda(publicKey)
      await program.methods
        .submitEvidence(evidenceNote, evidenceImageRef ?? '')
        .accounts({ submitter: wallet.publicKey, market: publicKey, evidence: evidenceKey, systemProgram: SystemProgram.programId })
        .rpc()
      logHistoryEvent(wallet.publicKey, `Submitted evidence — "${account.question}"`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Submitting evidence failed.')
    } finally {
      setBusy(null)
    }
  }

  async function onEvidenceImageSelected(file: File | undefined) {
    if (!file) {
      setEvidenceImageRef(null)
      setEvidenceImageName('')
      return
    }
    if (file.size > MAX_EVIDENCE_IMAGE_BYTES) {
      setError(`Image must be ${(MAX_EVIDENCE_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB or smaller (this one is ${(file.size / (1024 * 1024)).toFixed(2)}MB).`)
      return
    }
    setError(null)
    setUploadingImage(true)
    try {
      const ext = file.name.includes('.') ? file.name.split('.').pop() : 'bin'
      const buf = await file.arrayBuffer()
      const res = await fetch(`/api/evidence-upload?ext=${encodeURIComponent(ext ?? 'bin')}`, {
        method: 'POST',
        body: buf,
      })
      if (!res.ok) throw new Error(await res.text())
      const { ref } = (await res.json()) as { ref: string }
      setEvidenceImageRef(ref)
      setEvidenceImageName(file.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Uploading image failed.')
    } finally {
      setUploadingImage(false)
    }
  }

  async function redeem() {
    if (!wallet.publicKey) return
    setError(null)
    setBusy('redeem')
    try {
      const program = getProgram(connection, wallet as never)
      const [vault] = vaultPda(publicKey)
      const [position] = positionPda(publicKey, wallet.publicKey)
      const [profile] = profilePda(wallet.publicKey)
      await program.methods
        .redeem()
        .accounts({
          user: wallet.publicKey,
          profile,
          market: publicKey,
          vault,
          position,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
      logHistoryEvent(wallet.publicKey, `Redeemed ${formatSol(winningShares)} — "${account.question}"`)
      await refresh()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Redeem failed.')
    } finally {
      setBusy(null)
    }
  }

  async function withdrawLiquidity() {
    if (!wallet.publicKey) return
    setError(null)
    setBusy('withdraw-lp')
    try {
      const program = getProgram(connection, wallet as never)
      const [vault] = vaultPda(publicKey)
      const [profile] = profilePda(wallet.publicKey)
      await program.methods
        .withdrawLiquidity()
        .accounts({
          authority: wallet.publicKey,
          profile,
          market: publicKey,
          vault,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
      logHistoryEvent(wallet.publicKey, `Withdrew liquidity — "${account.question}"`)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Liquidity withdrawal failed.')
    } finally {
      setBusy(null)
    }
  }

  const outcome = outcomeLabel(account.outcome)
  const heldYes = position?.yesShares ?? new BN(0)
  const heldNo = position?.noShares ?? new BN(0)
  const heldYesCost = position?.yesCost ?? new BN(0)
  const heldNoCost = position?.noCost ?? new BN(0)
  const winningShares = account.resolved
    ? outcome === 'Yes'
      ? heldYes
      : outcome === 'No'
        ? heldNo
        : outcome === 'Void'
          ? heldYesCost.add(heldNoCost)
          : new BN(0)
    : new BN(0)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-ink">{account.question}</p>
          {creatorName && <p className="text-xs text-muted">by {creatorName}</p>}
        </div>
        {account.resolved ? (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
              outcome === 'Yes'
                ? 'bg-green-light text-green-dark'
                : outcome === 'No'
                  ? 'bg-brand-light text-brand-dark'
                  : 'bg-surface text-muted'
            }`}
          >
            {outcome}
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-muted">
            {formatCountdown(account.closeTs.toNumber())}
          </span>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-bold leading-none text-green">{yesPct}%</span>
            <span className="text-xs text-muted">Yes</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-bold leading-none text-brand">{noPct}%</span>
            <span className="text-xs text-muted">No</span>
          </div>
        </div>
        <div className="flex h-2 rounded-full bg-surface">
          <div
            className="rounded-l-full bg-green shadow-[0_0_10px_2px_rgba(71,160,37,0.7)]"
            style={{ width: `${yesPct}%` }}
          />
          <div
            className="rounded-r-full bg-brand shadow-[0_0_10px_2px_rgba(186,59,70,0.7)]"
            style={{ width: `${noPct}%` }}
          />
        </div>
      </div>

      {position && (heldYes.gtn(0) || heldNo.gtn(0)) && (
        <p className="text-xs text-muted">
          Your shares: {formatSol(heldYes)} Yes / {formatSol(heldNo)} No
          {position.redeemed ? ' · redeemed' : ''}
        </p>
      )}

      {error && <p className="text-xs text-brand">{error}</p>}

      {!account.resolved && !closed && (
        <>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="0.01"
              value={buyAmount}
              onChange={(e) => setBuyAmount(e.target.value)}
              className="w-24 rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
              disabled={!wallet.publicKey || !hasProfile}
            />
            <span className="text-xs text-muted">SOL</span>
            {hasProfile && balance && (
              <span className="text-xs text-muted">balance: {formatSol(balance.availableLamports)}</span>
            )}
            <button
              className="ml-auto rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
              onClick={() => buy(true)}
              disabled={busy !== null || !wallet.publicKey || !hasProfile}
            >
              {busy === 'buy-yes' ? '…' : 'Buy Yes'}
            </button>
            <button
              className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
              onClick={() => buy(false)}
              disabled={busy !== null || !wallet.publicKey || !hasProfile}
            >
              {busy === 'buy-no' ? '…' : 'Buy No'}
            </button>
          </div>

          {wallet.publicKey && !hasProfile && (
            <p className="text-xs text-brand-dark">Register an account on the Account tab to trade.</p>
          )}

          {buyLamports > 0n && (
            <p className="text-xs text-muted">
              Buy Yes: {formatSol(Number(previewBuyYes.sharesOut))} shares, odds move to {previewOddsIfYes.yesPct}¢
              / {previewOddsIfYes.noPct}¢ · Buy No: {formatSol(Number(previewBuyNo.sharesOut))} shares, odds move
              to {previewOddsIfNo.yesPct}¢ / {previewOddsIfNo.noPct}¢
            </p>
          )}

          {hasProfile && heldYes.gtn(0) && (
            <SellRow
              label="Sell Yes"
              max={heldYes}
              value={sellYesAmount}
              onChange={setSellYesAmount}
              onSell={() => sell(true)}
              busy={busy === 'sell-yes'}
              disabled={busy !== null}
              yesReserve={yesReserveBig}
              noReserve={noReserveBig}
              outcomeYes={true}
            />
          )}
          {hasProfile && heldNo.gtn(0) && (
            <SellRow
              label="Sell No"
              max={heldNo}
              value={sellNoAmount}
              onChange={setSellNoAmount}
              onSell={() => sell(false)}
              busy={busy === 'sell-no'}
              disabled={busy !== null}
              yesReserve={yesReserveBig}
              noReserve={noReserveBig}
              outcomeYes={false}
            />
          )}
        </>
      )}

      {!account.resolved && isAuthority && (
        <div className="rounded-lg bg-surface p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Evidence for the admin
          </p>
          <textarea
            className="mb-2 w-full rounded-lg border border-hairline bg-field p-2 text-xs text-ink outline-none focus:border-brand"
            rows={2}
            placeholder="e.g. Got a B+ on the midterm, see attached screenshot."
            value={evidenceNote}
            onChange={(e) => setEvidenceNote(e.target.value)}
            maxLength={280}
          />
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept="image/*"
              className="text-xs text-muted"
              onChange={(e) => onEvidenceImageSelected(e.target.files?.[0])}
              disabled={uploadingImage}
            />
            {uploadingImage ? (
              <span className="text-xs text-muted">uploading…</span>
            ) : (
              evidenceImageName && <span className="text-xs text-muted">{evidenceImageName}</span>
            )}
            <button
              className="ml-auto rounded-lg bg-field px-3 py-1.5 text-xs font-medium text-ink ring-1 ring-hairline hover:bg-surface disabled:opacity-50"
              onClick={submitEvidence}
              disabled={busy !== null || uploadingImage}
            >
              {busy === 'evidence' ? '…' : evidence ? 'Update evidence' : 'Submit evidence'}
            </button>
          </div>
        </div>
      )}

      {isAdmin && evidence && (
        <div className="rounded-lg bg-brand-light p-3">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-dark">Evidence (admin only)</p>
          <p className="text-sm text-ink">{evidence.note}</p>
          {evidence.imageRef && (
            <img
              className="mt-2 max-h-40 rounded-lg"
              src={`/uploads/${evidence.imageRef}`}
              alt="Submitted evidence"
            />
          )}
        </div>
      )}

      {!account.resolved && closed && isAdmin && (
        <div className="flex gap-2">
          <button
            className="flex-1 rounded-lg bg-green-light px-3 py-2 text-sm font-medium text-green-dark hover:bg-green-light/70 disabled:opacity-50"
            onClick={() => resolve('yes')}
            disabled={busy !== null}
          >
            {busy === 'resolve-yes' ? '…' : 'Resolve: Yes'}
          </button>
          <button
            className="flex-1 rounded-lg bg-brand-light px-3 py-2 text-sm font-medium text-brand-dark hover:bg-brand-light/70 disabled:opacity-50"
            onClick={() => resolve('no')}
            disabled={busy !== null}
          >
            {busy === 'resolve-no' ? '…' : 'Resolve: No'}
          </button>
          <button
            className="flex-1 rounded-lg bg-surface px-3 py-2 text-sm font-medium text-muted hover:bg-hairline disabled:opacity-50"
            onClick={() => resolve('void')}
            disabled={busy !== null}
          >
            {busy === 'resolve-void' ? '…' : 'No resolution (refund)'}
          </button>
        </div>
      )}

      {!account.resolved && closed && !isAdmin && (
        <p className="text-xs text-muted">Waiting for the admin to resolve the outcome.</p>
      )}

      {account.resolved && position && !position.redeemed && winningShares.gtn(0) && (
        <button
          className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
          onClick={redeem}
          disabled={busy !== null}
        >
          {busy === 'redeem' ? 'Redeeming…' : `Redeem ${formatSol(winningShares)}`}
        </button>
      )}

      {account.resolved && isAuthority && !account.lpWithdrawn && (
        <button
          className="rounded-lg bg-field px-3 py-2 text-sm font-medium text-ink ring-1 ring-hairline hover:bg-surface disabled:opacity-50"
          onClick={withdrawLiquidity}
          disabled={busy !== null}
        >
          {busy === 'withdraw-lp' ? 'Withdrawing…' : 'Withdraw your liquidity'}
        </button>
      )}
    </div>
  )
}

function SellRow({
  label,
  max,
  value,
  onChange,
  onSell,
  busy,
  disabled,
  yesReserve,
  noReserve,
  outcomeYes,
}: {
  label: string
  max: BN
  value: string
  onChange: (v: string) => void
  onSell: () => void
  busy: boolean
  disabled: boolean
  yesReserve: bigint
  noReserve: bigint
  outcomeYes: boolean
}) {
  const sharesIn = Number(value) > 0 ? BigInt(solToLamports(Number(value))) : 0n
  const preview = sharesIn > 0n ? simulateSell(yesReserve, noReserve, outcomeYes, sharesIn) : null
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`up to ${formatSol(max)}`}
        className="w-28 rounded-lg border border-hairline bg-field p-2 text-sm text-ink outline-none focus:border-brand"
      />
      <span className="text-xs text-muted">shares</span>
      {preview && <span className="text-xs text-muted">≈ {formatSol(Number(preview.amountOut))}</span>}
      <button
        className="ml-auto rounded-lg bg-field px-3 py-2 text-sm font-medium text-ink ring-1 ring-hairline hover:bg-surface disabled:opacity-50"
        onClick={onSell}
        disabled={disabled}
      >
        {busy ? '…' : label}
      </button>
    </div>
  )
}
