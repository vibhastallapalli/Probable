import { useEffect, useState } from 'react'
import type { WalletInfo } from '../../../shared/types'
import type { View } from '../App'

interface Props {
  onNavigate: (view: View) => void
  wallet: WalletInfo
}

export default function Home({ onNavigate, wallet }: Props) {
  const [dataPath, setDataPath] = useState('')

  useEffect(() => {
    window.probable.app.getDataPath().then(setDataPath)
  }, [])

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Tether Developers Cup</h2>
        <p>
          One app, two ways to play football with friends. <strong>Predict</strong> locks a shared
          pot with WDK escrow. <strong>Judge</strong> compares highlight clips with QVAC on your
          machine — no cloud, no API keys.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
          <button type="button" onClick={() => onNavigate('predict')}>
            Start Predict session
          </button>
          <button type="button" className="secondary" onClick={() => onNavigate('judge')}>
            Judge two clips
          </button>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Way One: Predict</h3>
          <ul className="muted" style={{ paddingLeft: '1.2rem' }}>
            <li>Pick who will play best before the match</li>
            <li>Poker-style raises fill the pot</li>
            <li>WDK escrow address holds USDt until settlement</li>
            <li>Winner +2 pts, second +1, losers −1</li>
          </ul>
        </section>
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Way Two: Judge</h3>
          <ul className="muted" style={{ paddingLeft: '1.2rem' }}>
            <li>Upload two short clips after the game</li>
            <li>QVAC classifies shot type and scores rubric</li>
            <li>AI picks a winner like Goal of the Year</li>
            <li>Chat asks &quot;why did you pick this?&quot;</li>
          </ul>
        </section>
      </div>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Wallet</h3>
        <p className="muted" style={{ wordBreak: 'break-all' }}>
          Chain: {wallet.chain}
          <br />
          Address: {wallet.address}
        </p>
        {dataPath && (
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Session data: {dataPath}
          </p>
        )}
      </section>
    </div>
  )
}
