import { useEffect, useState } from 'react'
import { useActiveWallet } from '../context/ActiveWalletContext'
import { getHistoryEvents, type HistoryEntry } from '../lib/historyLog'

export function HistoryPage() {
  const wallet = useActiveWallet()
  const [entries, setEntries] = useState<HistoryEntry[]>([])

  useEffect(() => {
    if (!wallet.publicKey) {
      setEntries([])
      return
    }
    setEntries(getHistoryEvents(wallet.publicKey))
  }, [wallet.publicKey])

  if (!wallet.publicKey) {
    return <p className="text-muted">Connect a wallet to see your trade history.</p>
  }

  return (
    <div className="max-w-2xl">
      {entries.length === 0 && <p className="text-muted">No activity yet.</p>}

      <div className="divide-y divide-hairline">
        {entries.map((e, i) => (
          <div key={`${e.timestamp}-${i}`} className="py-3 first:pt-0">
            <p className="text-sm text-ink">{e.summary}</p>
            <p className="text-xs text-muted">{new Date(e.timestamp).toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
