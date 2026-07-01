import React, { useState, useEffect } from 'react'

const PLAYER_A = '0xAAAA000000000000000000000000000000000001'
const PLAYER_B = '0xBBBB000000000000000000000000000000000002'
const STAKE = 100

export default function App () {
  const [address, setAddress] = useState(null)
  const [escrowId, setEscrowId] = useState(null)
  const [escrowRecord, setEscrowRecord] = useState(null)
  const [log, setLog] = useState([])

  const [videoPath, setVideoPath] = useState(null)
  const [scoring, setScoring] = useState(false)
  const [clipScore, setClipScore] = useState(null)
  const [clipScoreA, setClipScoreA] = useState(null)
  const [clipScoreB, setClipScoreB] = useState(null)
  const [settleResult, setSettleResult] = useState(null)

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

  async function handlePickVideo () {
    try {
      const picked = await window.probable.clip.pickVideo()
      if (!picked) { emit('Video pick cancelled'); return }
      setVideoPath(picked)
      setClipScore(null)
      emit(`Picked clip: ${picked}`)
    } catch (err) {
      emit(`Pick failed: ${err.message}`)
    }
  }

  async function handleScoreClip () {
    if (!videoPath) return
    setScoring(true)
    emit('Scoring clip locally via QVAC… (first run downloads the model)')
    try {
      const result = await window.probable.clip.score(videoPath)
      setClipScore(result)
      emit(`Scored: total ${result.total}/40 from ${result.frameCount} frames${result.mock ? ' (mock)' : ''}`)
    } catch (err) {
      emit(`Score failed: ${err.message}`)
    } finally {
      setScoring(false)
    }
  }

  async function handleSettle () {
    try {
      const result = await window.probable.match.settle(escrowId, clipScoreA, clipScoreB, PLAYER_A, PLAYER_B)
      setSettleResult(result)
      if (result.outcome === 'unfunded') {
        emit(`Settle: unfunded — match wallet balance is ${result.balance} USDT`)
      } else if (result.outcome === 'tied') {
        emit(`Settle: tied (${result.totalA} vs ${result.totalB}) — escrow untouched, needs human review`)
      } else {
        emit(`Settle: winner ${result.winner} (${result.winnerAddress.slice(0, 10)}…) | +${result.margin}pts | ${result.payout} USDT | tx: ${result.txHash}`)
      }
    } catch (err) {
      emit(`Settle failed: ${err.message}`)
    }
  }

  const released = escrowRecord?.status === 'released'

  return (
    <div style={{ fontFamily: 'monospace', padding: 24, background: '#0f1115', color: '#f2f3f5', minHeight: '100vh' }}>
      <h2>Probable — Test Harness</h2>

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

      <section style={{ marginBottom: 24 }}>
        <strong>Clip scoring (QVAC — local, on-device)</strong>
        <p style={{ margin: '4px 0' }}>Clip: {videoPath ?? '(none selected)'}</p>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handlePickVideo} disabled={scoring}>Pick video file</button>
          <button onClick={handleScoreClip} disabled={!videoPath || scoring}>
            {scoring ? 'Scoring…' : 'Run scoreClip'}
          </button>
        </div>

        {clipScore && (
          <div style={{ marginTop: 12 }}>
            <p style={{ margin: '4px 0' }}>
              Total: <strong>{clipScore.total}/40</strong> · model: {clipScore.model}
              {clipScore.mock ? ' · MOCK' : ''} · {clipScore.frameCount} frames
            </p>
            <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
              <button onClick={() => { setClipScoreA(clipScore); emit(`Clip A assigned (total ${clipScore.total}/40)`) }}>
                Assign → Clip A (Player A)
              </button>
              <button onClick={() => { setClipScoreB(clipScore); emit(`Clip B assigned (total ${clipScore.total}/40)`) }}>
                Assign → Clip B (Player B)
              </button>
            </div>
            {['skill', 'difficulty', 'aesthetic', 'fairPlay'].map((field) => (
              <div key={field} style={{ margin: '8px 0', padding: 10, background: '#1a1d23', borderRadius: 4 }}>
                <div><strong>{field}</strong>: {clipScore.scores[field].score}/10</div>
                <div style={{ fontSize: 12, color: '#c8ccd2', marginTop: 4 }}>
                  {clipScore.scores[field].explanation}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <strong>Match settlement</strong>
        <p style={{ margin: '4px 0', fontSize: 12, color: '#c8ccd2' }}>
          Clip A: {clipScoreA ? `scored (${clipScoreA.total}/40)` : 'not assigned'} ·
          Clip B: {clipScoreB ? `scored (${clipScoreB.total}/40)` : 'not assigned'}
        </p>
        <div style={{ marginTop: 8 }}>
          <button
            onClick={handleSettle}
            disabled={!escrowId || !clipScoreA || !clipScoreB || released}
          >
            Settle match
          </button>
        </div>
        {settleResult && (
          <pre style={{ margin: '8px 0', padding: 12, background: '#1a1d23', borderRadius: 4, fontSize: 12 }}>
            {JSON.stringify(settleResult, null, 2)}
          </pre>
        )}
      </section>

      <section>
        <strong>Log</strong>
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
          {log.map((entry, i) => <div key={i}>{entry}</div>)}
        </div>
      </section>
    </div>
  )
}
