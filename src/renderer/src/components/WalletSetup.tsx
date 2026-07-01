import { useState } from 'react'
import type { WalletInfo } from '../../../shared/types'

interface Props {
  onReady: (wallet: WalletInfo) => void
}

export default function WalletSetup({ onReady }: Props) {
  const [seed, setSeed] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const create = async () => {
    setLoading(true)
    setError('')
    try {
      const info = await window.probable.wallet.createWallet()
      onReady(info)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create wallet')
    } finally {
      setLoading(false)
    }
  }

  const importWallet = async () => {
    setLoading(true)
    setError('')
    try {
      const info = await window.probable.wallet.importSeed(seed)
      onReady(info)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid seed phrase')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem'
      }}
    >
      <div className="card" style={{ maxWidth: 440, width: '100%' }}>
        <h1 style={{ marginTop: 0 }}>Welcome to Probable</h1>
        <p className="muted">
          Self-custodial wallet via WDK. Your keys stay on this device. Demo mode tracks escrow
          locally until testnet USDt is configured.
        </p>

        <button type="button" onClick={create} disabled={loading} style={{ width: '100%', marginTop: '1rem' }}>
          Create new wallet
        </button>

        <p className="muted" style={{ textAlign: 'center', margin: '1rem 0' }}>
          — or import seed —
        </p>

        <label htmlFor="seed">12/24-word seed phrase</label>
        <textarea
          id="seed"
          rows={3}
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder="word1 word2 …"
        />
        <button
          type="button"
          className="secondary"
          onClick={importWallet}
          disabled={loading || !seed.trim()}
          style={{ width: '100%', marginTop: '0.75rem' }}
        >
          Import wallet
        </button>

        {error && <p className="error" style={{ marginTop: '0.75rem' }}>{error}</p>}
      </div>
    </div>
  )
}
