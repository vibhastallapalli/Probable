import React, { useState, useEffect } from 'react'

const PLAYER_A = '0xAAAA000000000000000000000000000000000001'
const PLAYER_B = '0xBBBB000000000000000000000000000000000002'
const STAKE = 100

export default function App () {
  const [address, setAddress] = useState(null)
  const [escrowId, setEscrowId] = useState(null)
  const [escrowRecord, setEscrowRecord] = useState(null)
  const [log, setLog] = useState([])

  const emit = (msg) => setLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev])

  useEffect(() => {
    window.probable.wallet.getAddress()
      .then((addr) => { setAddress(addr); emit(`Wallet ready: ${addr}`) })
      .catch((err) => emit(`Wallet error: ${err.message}`))
  }, [])

  async function handleCreate () {
    try {
      const result = await window.probable.escrow.create(PLAYER_A, PLAYER_B, STAKE)
      setEscrowId(result.id)
      setEscrowRecord(result)
      emit(`Escrow created ${result.id.slice(0, 8)}… | balance: ${result.balance} USDt | status: ${result.status}`)
    } catch (err) {
      emit(`Create failed: ${err.message}`)
    }
  }

  async function handleRelease (winner, label) {
    try {
      const result = await window.probable.escrow.release(escrowId, winner)
      setEscrowRecord((prev) => ({ ...prev, status: 'released', balance: 0, winner: result.winner, releasedAt: result.releasedAt }))
      emit(`Released ${result.payout} USDt to ${label} | id: ${result.id.slice(0, 8)}…`)
    } catch (err) {
      emit(`Release failed: ${err.message}`)
    }
  }

  async function handleRefresh () {
    try {
      const result = await window.probable.escrow.getStatus(escrowId)
      setEscrowRecord(result)
      emit(`Refreshed: status=${result.status} balance=${result.balance}`)
    } catch (err) {
      emit(`Refresh failed: ${err.message}`)
    }
  }

  const released = escrowRecord?.status === 'released'

  return (
    <div style={{ fontFamily: 'monospace', padding: 24, background: '#0f1115', color: '#f2f3f5', minHeight: '100vh' }}>
      <h2>Probable — Escrow Test Harness</h2>

      <section style={{ marginBottom: 24 }}>
        <strong>App wallet</strong>
        <p style={{ margin: '4px 0' }}>Address: {address ?? 'initialising…'}</p>
      </section>

      <section style={{ marginBottom: 24 }}>
        <strong>Test participants (hardcoded)</strong>
        <p style={{ margin: '4px 0' }}>Player A: {PLAYER_A}</p>
        <p style={{ margin: '4px 0' }}>Player B: {PLAYER_B}</p>
        <p style={{ margin: '4px 0' }}>Stake per player: {STAKE} USDt (total: {STAKE * 2} USDt)</p>
      </section>

      <section style={{ marginBottom: 24 }}>
        <strong>Escrow actions</strong>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handleCreate} disabled={!!escrowId}>
            Create test escrow
          </button>
          {escrowId && (
            <>
              <button onClick={handleRefresh}>Refresh status</button>
              <button onClick={() => handleRelease(PLAYER_A, 'Player A')} disabled={released}>
                Release → Player A
              </button>
              <button onClick={() => handleRelease(PLAYER_B, 'Player B')} disabled={released}>
                Release → Player B
              </button>
            </>
          )}
        </div>
      </section>

      {escrowRecord && (
        <section style={{ marginBottom: 24 }}>
          <strong>Escrow state</strong>
          <pre style={{ margin: '8px 0', padding: 12, background: '#1a1d23', borderRadius: 4, fontSize: 12 }}>
            {JSON.stringify(escrowRecord, null, 2)}
          </pre>
        </section>
      )}

      <section>
        <strong>Log</strong>
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
          {log.map((entry, i) => <div key={i}>{entry}</div>)}
        </div>
      </section>
    </div>
  )
}
