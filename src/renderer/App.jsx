import React, { useState, useEffect, useRef } from 'react'

const STAKE = 100

// The four categories of FIFA's Puskas Award rubric [the criteria FIFA uses
// to judge its own goal of the year]. Each label pairs plain English with the
// meaning in brackets, and `key` matches the fields in the score JSON.
const RUBRIC = [
  { key: 'skill', label: 'Skill', gloss: 'clean technique and ball control' },
  { key: 'difficulty', label: 'Difficulty', gloss: 'how hard the play was to pull off' },
  { key: 'aesthetic', label: 'Aesthetic', gloss: 'how spectacular it looks' },
  { key: 'placement', label: 'Placement', gloss: 'where in the goal the shot lands' },
]

// Fallback so the status badge renders even before the main process replies.
const DEFAULT_MODEL_INFO = { name: 'SmolVLM2 2.2B', id: '', runtime: 'QVAC' }

function isValidAddress (val) {
  return typeof val === 'string' && /^0x[0-9a-fA-F]{40}$/.test(val)
}

// One decimal is plenty for a frame rate readout [24, 25, or 29.97 style values].
function roundFps (fps) {
  return Math.round(fps * 10) / 10
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
  const [escrowList, setEscrowList] = useState([])
  const [deleteMode, setDeleteMode] = useState(false)
  const [deleteSelected, setDeleteSelected] = useState(new Set())
  const [log, setLog] = useState([])

  const [loadId, setLoadId] = useState('')

  const [videoPath, setVideoPath] = useState(null)
  const [clipProbe, setClipProbe] = useState(null)
  const [modelInfo, setModelInfo] = useState(DEFAULT_MODEL_INFO)
  const [preparingModel, setPreparingModel] = useState(false)
  const [scoring, setScoring] = useState(false)
  const [clipScore, setClipScore] = useState(null)
  const [clipScoreA, setClipScoreA] = useState(null)
  const [clipScoreB, setClipScoreB] = useState(null)
  const [settleResult, setSettleResult] = useState(null)

  const emit = (msg) => setLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev])

  // Last logged download decile, so streaming progress logs at most once per 10%
  // instead of flooding the Log with every percentage tick.
  const lastModelPctRef = useRef(-1)

  useEffect(() => {
    window.probable.wallet.getAddress()
      .then((addr) => { setAddress(addr); emit(`Wallet ready: ${addr}`) })
      .catch((err) => emit(`Wallet error: ${err.message}`))
    window.probable.scoring.modelInfo()
      .then((info) => { if (info) setModelInfo(info) })
      .catch(() => { /* badge falls back to the default text */ })
    refreshEscrowList()
  }, [])

  // Stream the one-time model download/load progress into the Log, throttled to
  // one line per 10% so the user can watch the download instead of a silent wait.
  useEffect(() => {
    const unsubscribe = window.probable.clip.onModelProgress((p) => {
      if (!p || typeof p.percentage !== 'number') return
      const bucket = Math.floor(p.percentage / 10) * 10
      if (bucket !== lastModelPctRef.current) {
        lastModelPctRef.current = bucket
        emit(`Downloading on-device model… ${bucket}%`)
      }
    })
    return unsubscribe
  }, [])

  // Pull every saved escrow from disk, newest first, so the just made one
  // is easy to find at the top of the list.
  async function refreshEscrowList () {
    try {
      const records = await window.probable.escrow.list()
      const sorted = [...records].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      setEscrowList(sorted)
    } catch (err) {
      emit(`Escrow list failed: ${err.message}`)
    }
  }

  // Shared load path used by both the Load button and a saved list row:
  // fetch live status, then set escrowId + escrowRecord for the rest of the view.
  async function loadEscrow (id) {
    try {
      const result = await window.probable.escrow.getStatus(id)
      setEscrowId(result.id)
      setEscrowRecord(result)
      emit(`Loaded escrow ${result.id.slice(0, 8)}… | balance: ${result.balance} USDt | status: ${result.status}`)
    } catch (err) {
      emit(`Load failed: ${err.message}`)
    }
  }

  function toggleDeleteMode () {
    setDeleteMode((prev) => !prev)
    setDeleteSelected(new Set())
  }

  function toggleDeleteSelect (id) {
    setDeleteSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleDeleteSelected () {
    const ids = [...deleteSelected]
    if (ids.length === 0) return
    try {
      await window.probable.escrow.delete(ids)
      emit(`Deleted ${ids.length} escrow${ids.length > 1 ? 's' : ''}`)
      // If the currently loaded escrow was among the deleted ones, clear the view.
      if (ids.includes(escrowId)) {
        setEscrowId(null)
        setEscrowRecord(null)
      }
      setDeleteMode(false)
      setDeleteSelected(new Set())
      refreshEscrowList()
    } catch (err) {
      emit(`Delete failed: ${err.message}`)
    }
  }

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
      refreshEscrowList()
    } catch (err) {
      emit(`Create failed: ${err.message}`)
    }
  }

  async function handleLoad () {
    const id = loadId.trim()
    if (!id) return
    await loadEscrow(id)
  }

  async function handleRelease (winner, label) {
    try {
      const result = await window.probable.escrow.release(escrowId, winner)
      setEscrowRecord((prev) => ({ ...prev, status: result.status, balance: 0, winner: result.winner, txHash: result.txHash, releasedAt: result.releasedAt }))
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
      setClipProbe(null)
      emit(`Picked clip: ${picked}`)
      try {
        const probe = await window.probable.clip.probe(picked)
        setClipProbe(probe)
        if (probe?.lowFps) {
          emit(`Clip is ${roundFps(probe.fps)} fps, under ${probe.minFps} fps, scoring may be less reliable`)
        }
      } catch { /* the probe is advisory only, it never blocks picking or scoring */ }
    } catch (err) {
      emit(`Pick failed: ${err.message}`)
    }
  }

  async function handleScoreClip () {
    if (!videoPath) return
    setScoring(true)
    try {
      // One-time model download / warm-up first, so scoring never races the
      // worker init timeout on first run. A no-op once the model is loaded.
      setPreparingModel(true)
      emit('Preparing on-device model… first run downloads the weights, this can take a few minutes')
      const prep = await window.probable.clip.prepareModel()
      if (!prep.alreadyLoaded && !prep.mock) emit(`Model ready: ${prep.model}`)
      // The badge rendered before the load; re-read which model actually
      // loaded (2.2B, or the 500M fallback when the big download fails).
      window.probable.scoring.modelInfo()
        .then((info) => { if (info) setModelInfo(info) })
        .catch(() => { /* badge keeps its last known value */ })
      setPreparingModel(false)

      emit('Scoring clip locally via QVAC…')
      const result = await window.probable.clip.score(videoPath)
      setClipScore(result)
      emit(`Scored: total ${result.total} of 40 from ${result.frameCount} frames${result.mock ? ' (mock)' : ''}`)
    } catch (err) {
      emit(`Score failed: ${err.message}`)
    } finally {
      setPreparingModel(false)
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
      } else if (result.outcome === 'already_settled') {
        emit(`Settle: already settled, winner ${result.winnerAddress.slice(0, 10)}… | tx: ${result.txHash}`)
      } else {
        emit(`Settle: winner ${result.winner} (${result.winnerAddress.slice(0, 10)}…) | +${result.margin}pts | ${result.payout} USDT | tx: ${result.txHash}`)
      }
      // Pull the post-settlement record so the escrow state area shows the
      // settled status, winner, and payout tx hash.
      if (result.outcome === 'settled' || result.outcome === 'already_settled') {
        const updated = await window.probable.escrow.getStatus(escrowId)
        setEscrowRecord(updated)
      }
    } catch (err) {
      emit(`Settle failed: ${err.message}`)
    }
  }

  // Terminal state once the payout has gone out; disables further release/settle.
  // Accepts the legacy 'released' status so older records stay locked too.
  const settled = escrowRecord?.status === 'settled' || escrowRecord?.status === 'released'

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
              <button onClick={() => handleRelease(playerA, 'Player A')} disabled={settled}>
                Release → Player A
              </button>
              <button onClick={() => handleRelease(playerB, 'Player B')} disabled={settled}>
                Release → Player B
              </button>
            </>
          )}
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong>Saved escrows</strong>
          {escrowList.length > 0 && (
            <button
              onClick={toggleDeleteMode}
              style={{
                fontSize: 11,
                padding: '3px 10px',
                background: deleteMode ? '#2a1c0e' : 'transparent',
                color: deleteMode ? '#e67e22' : '#8a8f98',
                border: `1px solid ${deleteMode ? '#e67e22' : '#444'}`,
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              {deleteMode ? 'Cancel' : 'Delete'}
            </button>
          )}
        </div>

        {deleteMode && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={handleDeleteSelected}
              disabled={deleteSelected.size === 0}
              style={{
                fontSize: 12,
                padding: '4px 14px',
                background: deleteSelected.size > 0 ? '#3d1515' : '#1a1d23',
                color: deleteSelected.size > 0 ? '#e74c3c' : '#555',
                border: `1px solid ${deleteSelected.size > 0 ? '#e74c3c' : '#333'}`,
                borderRadius: 4,
                cursor: deleteSelected.size > 0 ? 'pointer' : 'default',
              }}
            >
              Delete {deleteSelected.size > 0 ? `(${deleteSelected.size})` : ''}
            </button>
            <span style={{ fontSize: 11, color: '#8a8f98' }}>
              {deleteSelected.size === 0 ? 'Select escrows to delete' : `${deleteSelected.size} selected`}
            </span>
          </div>
        )}

        {escrowList.length === 0 ? (
          <p style={{ margin: '8px 0 0', fontSize: 12 }}>(none saved yet)</p>
        ) : (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {escrowList.map((item) => {
              const isLoaded = item.id === escrowId
              const isChecked = deleteSelected.has(item.id)
              return (
                <div
                  key={item.id}
                  onClick={() => deleteMode ? toggleDeleteSelect(item.id) : loadEscrow(item.id)}
                  title={deleteMode ? (isChecked ? 'Deselect' : 'Select for deletion') : `Load ${item.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontFamily: 'monospace',
                    fontSize: 12,
                    padding: '8px 10px',
                    background: isChecked ? '#2a1515' : isLoaded ? '#16241a' : '#1a1d23',
                    color: '#f2f3f5',
                    border: `1px solid ${isChecked ? '#e74c3c' : isLoaded ? '#2ecc71' : '#444'}`,
                    borderRadius: 4,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  {deleteMode && (
                    <div style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      border: `1.5px solid ${isChecked ? '#e74c3c' : '#666'}`,
                      background: isChecked ? '#e74c3c' : 'transparent',
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      {isChecked && <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✓</span>}
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      <strong>{item.id.slice(0, 8)}…</strong> · {item.status}
                      {typeof item.balance === 'number' ? ` · ${item.balance} USDt` : ''}
                    </div>
                    <div style={{ color: '#8a8f98', marginTop: 2 }}>
                      match wallet: {item.matchWalletAddress}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {escrowRecord && (
        <section style={{ marginBottom: 24 }}>
          <strong>Escrow state</strong>
          {settled && (
            <div style={{ margin: '8px 0', padding: 12, background: '#0e2418', border: '1px solid #2ecc71', borderRadius: 4, fontSize: 12 }}>
              <div style={{ color: '#2ecc71', fontWeight: 'bold', letterSpacing: 1, marginBottom: 6 }}>● SETTLED · PAID OUT</div>
              <div>Winner: {escrowRecord.winner ?? '(unknown)'}</div>
              <div style={{ marginTop: 4 }}>
                Payout tx:{' '}
                {escrowRecord.txHash ? (
                  <a
                    href={`https://sepolia.etherscan.io/tx/${escrowRecord.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#5dade2', wordBreak: 'break-all' }}
                  >
                    {escrowRecord.txHash}
                  </a>
                ) : '(not recorded)'}
              </div>
            </div>
          )}
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
        {clipProbe?.lowFps && (
          <p style={{ margin: '4px 0', fontSize: 12, color: '#e67e22' }}>
            ⚠ This clip is {roundFps(clipProbe.fps)} fps, under {clipProbe.minFps} fps, so scoring may be less reliable
          </p>
        )}
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handlePickVideo} disabled={scoring}>Pick video file</button>
          <button onClick={handleScoreClip} disabled={!videoPath || scoring}>
            {scoring ? (preparingModel ? 'Preparing model…' : 'Scoring…') : 'Run scoreClip'}
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
            disabled={!escrowId || !clipScoreA || !clipScoreB || settled}
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
