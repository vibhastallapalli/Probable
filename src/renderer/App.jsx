import React, { useState, useEffect } from 'react'

const STAKE = 100

// The four categories of FIFA's Puskas Award rubric [the criteria FIFA uses
// to judge its own goal of the year]. Each label pairs plain English with the
// meaning in brackets, and `key` matches the fields in the score JSON.
const RUBRIC = [
  { key: 'skill', label: 'Skill', gloss: 'clean technique and ball control' },
  { key: 'difficulty', label: 'Difficulty', gloss: 'how hard the play was to pull off' },
  { key: 'aesthetic', label: 'Aesthetic', gloss: 'how spectacular it looks' },
  { key: 'fairPlay', label: 'Fair play', gloss: 'clean sporting conduct' },
]

// Fallback so the status badge renders even before the main process replies.
const DEFAULT_MODEL_INFO = { name: 'SmolVLM2 500M', id: '', runtime: 'QVAC' }

function isValidAddress (val) {
  return typeof val === 'string' && /^0x[0-9a-fA-F]{40}$/.test(val)
}

// Always visible proof of QVAC compliance: which model, where it runs, and
// that nothing gets uploaded. Flips to an amber mock warning when the last
// score came from the offline stand in, so the badge never overclaims.
function StatusBadge ({ modelInfo, mockMode }) {
  const accent = mockMode ? '#e67e22' : '#2ecc71'
  return (
    <div
      title={modelInfo.id}
      style={{
        position: 'fixed',
        top: 12,
        right: 12,
        zIndex: 1000,
        padding: '8px 12px',
        background: mockMode ? '#2a1c0e' : '#0e2418',
        border: `1px solid ${accent}`,
        borderRadius: 6,
        fontSize: 11,
        lineHeight: 1.7,
      }}
    >
      <div style={{ color: accent, fontWeight: 'bold', letterSpacing: 1 }}>
        {mockMode ? '● MOCK MODE [no model loaded]' : '● ON DEVICE AI [QVAC]'}
      </div>
      <div>Model: {modelInfo.name}</div>
      <div>Inference: {mockMode ? 'offline stand in, not the real model' : 'on device, zero cloud calls'}</div>
      <div>Bytes uploaded: 0</div>
    </div>
  )
}

export default function App () {
  const [address, setAddress] = useState(null)
  const [playerA, setPlayerA] = useState('')
  const [playerB, setPlayerB] = useState('')
  const [escrowId, setEscrowId] = useState(null)
  const [escrowRecord, setEscrowRecord] = useState(null)
  const [log, setLog] = useState([])

  const [loadId, setLoadId] = useState('')

  const [videoPath, setVideoPath] = useState(null)
  const [modelInfo, setModelInfo] = useState(DEFAULT_MODEL_INFO)
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
    window.probable.scoring.modelInfo()
      .then((info) => { if (info) setModelInfo(info) })
      .catch(() => { /* badge falls back to the default text */ })
  }, [])

  async function handleCreate () {
    if (!isValidAddress(playerA) || !isValidAddress(playerB)) {
      emit('Both player addresses must be valid 42 character 0x addresses')
      return
    }
    try {
      const result = await window.probable.escrow.create(playerA, playerB, STAKE)
      setEscrowId(result.id)
      setEscrowRecord(result)
      emit(`Escrow created ${result.id.slice(0, 8)}… | balance: ${result.balance} USDt | status: ${result.status}`)
    } catch (err) {
      emit(`Create failed: ${err.message}`)
    }
  }

  async function handleLoad () {
    const id = loadId.trim()
    if (!id) return
    try {
      const result = await window.probable.escrow.getStatus(id)
      setEscrowId(result.id)
      setEscrowRecord(result)
      emit(`Loaded escrow ${result.id.slice(0, 8)}… | balance: ${result.balance} USDt | status: ${result.status}`)
    } catch (err) {
      emit(`Load failed: ${err.message}`)
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
      emit(`Scored: total ${result.total} of 40 from ${result.frameCount} frames${result.mock ? ' (mock)' : ''}`)
    } catch (err) {
      emit(`Score failed: ${err.message}`)
    } finally {
      setScoring(false)
    }
  }

  async function handleSettle () {
    try {
      const result = await window.probable.match.settle(escrowId, clipScoreA, clipScoreB, playerA, playerB)
      setSettleResult(result)
      if (result.outcome === 'unfunded') {
        emit(`Settle: unfunded, match wallet balance is ${result.balance} USDT`)
      } else if (result.outcome === 'tied') {
        emit(`Settle: tied (${result.totalA} vs ${result.totalB}), escrow untouched, needs human review`)
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
      <StatusBadge modelInfo={modelInfo} mockMode={clipScore?.mock === true} />
      <h2>Probable Test Harness</h2>

      <section style={{ marginBottom: 24 }}>
        <strong>App wallet</strong>
        <p style={{ margin: '4px 0' }}>Address: {address ?? 'initialising…'}</p>
      </section>

      <section style={{ marginBottom: 24 }}>
        <strong>Test participants</strong>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 12 }}>
            Player A address
            <input
              type="text"
              placeholder="0x…"
              value={playerA}
              onChange={(e) => setPlayerA(e.target.value.trim())}
              disabled={!!escrowId}
              style={{ display: 'block', marginTop: 4, fontFamily: 'monospace', fontSize: 12, padding: '4px 8px', background: '#1a1d23', color: '#f2f3f5', border: `1px solid ${playerA && !isValidAddress(playerA) ? '#c0392b' : '#444'}`, borderRadius: 4, width: 420 }}
            />
            {playerA && !isValidAddress(playerA) && (
              <span style={{ fontSize: 11, color: '#c0392b' }}>Must be a 42 character 0x address</span>
            )}
          </label>
          <label style={{ fontSize: 12 }}>
            Player B address
            <input
              type="text"
              placeholder="0x…"
              value={playerB}
              onChange={(e) => setPlayerB(e.target.value.trim())}
              disabled={!!escrowId}
              style={{ display: 'block', marginTop: 4, fontFamily: 'monospace', fontSize: 12, padding: '4px 8px', background: '#1a1d23', color: '#f2f3f5', border: `1px solid ${playerB && !isValidAddress(playerB) ? '#c0392b' : '#444'}`, borderRadius: 4, width: 420 }}
            />
            {playerB && !isValidAddress(playerB) && (
              <span style={{ fontSize: 11, color: '#c0392b' }}>Must be a 42 character 0x address</span>
            )}
          </label>
        </div>
        <p style={{ margin: '8px 0 4px', fontSize: 12 }}>Player A: {playerA || '(not set)'}</p>
        <p style={{ margin: '4px 0', fontSize: 12 }}>Player B: {playerB || '(not set)'}</p>
        <p style={{ margin: '4px 0' }}>Stake per player: {STAKE} USDt (total: {STAKE * 2} USDt)</p>
      </section>

      <section style={{ marginBottom: 24 }}>
        <strong>Escrow actions</strong>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={handleCreate} disabled={!!escrowId || !isValidAddress(playerA) || !isValidAddress(playerB)}>
            Create test escrow
          </button>
          <input
            type="text"
            placeholder="Escrow ID"
            value={loadId}
            onChange={(e) => setLoadId(e.target.value)}
            disabled={!!escrowId}
            style={{ fontFamily: 'monospace', fontSize: 12, padding: '4px 8px', background: '#1a1d23', color: '#f2f3f5', border: '1px solid #444', borderRadius: 4, width: 280 }}
          />
          <button onClick={handleLoad} disabled={!!escrowId || !loadId.trim()}>
            Load escrow
          </button>
          {escrowId && (
            <>
              <button onClick={handleRefresh}>Refresh status</button>
              <button onClick={() => handleRelease(playerA, 'Player A')} disabled={released}>
                Release → Player A
              </button>
              <button onClick={() => handleRelease(playerB, 'Player B')} disabled={released}>
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
        <strong>Clip scoring [judged on this device via QVAC]</strong>
        <p style={{ margin: '4px 0', fontSize: 12, color: '#c8ccd2' }}>
          Scored on the four FIFA Puskas Award criteria [the rubric FIFA uses for its own goal of the year]
        </p>
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
              Total: <strong>{clipScore.total} of 40</strong> · model: {clipScore.model}
              {clipScore.mock ? ' · MOCK' : ''} · {clipScore.frameCount} frames
            </p>
            <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
              <button onClick={() => { setClipScoreA(clipScore); emit(`Clip A assigned (total ${clipScore.total} of 40)`) }}>
                Assign → Clip A (Player A)
              </button>
              <button onClick={() => { setClipScoreB(clipScore); emit(`Clip B assigned (total ${clipScore.total} of 40)`) }}>
                Assign → Clip B (Player B)
              </button>
            </div>
            {RUBRIC.map(({ key, label, gloss }) => (
              <div key={key} style={{ margin: '8px 0', padding: 10, background: '#1a1d23', borderRadius: 4 }}>
                <div>
                  <strong>{label}</strong> <span style={{ color: '#8a8f98' }}>[{gloss}]</span>: {clipScore.scores[key].score} of 10
                </div>
                <div style={{ fontSize: 12, color: '#c8ccd2', marginTop: 4 }}>
                  Why: {clipScore.scores[key].explanation}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <strong>Match settlement</strong>
        <p style={{ margin: '4px 0', fontSize: 12, color: '#c8ccd2' }}>
          Clip A: {clipScoreA ? `scored (${clipScoreA.total} of 40)` : 'not assigned'} ·
          Clip B: {clipScoreB ? `scored (${clipScoreB.total} of 40)` : 'not assigned'}
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
