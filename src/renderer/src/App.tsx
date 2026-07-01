import { useEffect, useState } from 'react'
import type { WalletInfo } from '../../shared/types'
import Home from './pages/Home'
import PredictMode from './pages/PredictMode'
import JudgeMode from './pages/JudgeMode'
import WalletSetup from './components/WalletSetup'

export type View = 'home' | 'predict' | 'judge'

export default function App() {
  const [view, setView] = useState<View>('home')
  const [wallet, setWallet] = useState<WalletInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.probable.wallet
      .getInfo()
      .then((info) => setWallet(info.address ? info : null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p className="muted">Loading Probable…</p>
      </div>
    )
  }

  if (!wallet?.address) {
    return (
      <WalletSetup
        onReady={(info) => {
          setWallet(info)
        }}
      />
    )
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '1.5rem' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '1rem'
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: '1.75rem' }}>
            Probable <span style={{ fontSize: '1.25rem' }}>🏆</span>
          </h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Predict with friends · Judge clips with on-device AI
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className="badge">WDK · QVAC</span>
          <p className="muted" style={{ margin: '0.35rem 0 0', fontSize: '0.75rem' }}>
            {wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}
            {wallet.isDemo && ' · demo escrow'}
          </p>
        </div>
      </header>

      <nav
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.5rem',
          borderBottom: '1px solid var(--border)',
          paddingBottom: '0.75rem'
        }}
      >
        {(['home', 'predict', 'judge'] as View[]).map((v) => (
          <button
            key={v}
            type="button"
            className={view === v ? '' : 'secondary'}
            onClick={() => setView(v)}
            style={{ textTransform: 'capitalize' }}
          >
            {v === 'home' ? 'Home' : v === 'predict' ? 'Way One: Predict' : 'Way Two: Judge'}
          </button>
        ))}
      </nav>

      {view === 'home' && <Home onNavigate={setView} wallet={wallet} />}
      {view === 'predict' && <PredictMode />}
      {view === 'judge' && <JudgeMode />}
    </div>
  )
}
