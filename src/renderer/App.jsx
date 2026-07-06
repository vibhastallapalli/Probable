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

// The four head-to-head dimensions the match verdict is decided on, in
// display order. Keys match the `dimensions` field of the verdict; distance,
// speed, and technique come from the side-by-side comparison call, placement
// from the two clips' zone verdicts.
const VERDICT_DIMENSIONS = [
  { key: 'distance', label: 'Distance', gloss: 'who shot from further out' },
  { key: 'speed', label: 'Shot speed', gloss: 'whose shot flew faster' },
  { key: 'technique', label: 'Strike', gloss: 'who caught it cleaner' },
  { key: 'placement', label: 'Placement', gloss: 'who found the better spot' },
]

// Plain-words labels for the 9 goal-mouth zones the placement criterion is
// classified into (3 rows x 3 columns, split by the crossbar and goalposts).
// Keys match the `zone` field the scorer returns; the score is derived from
// the zone in the main process, so showing both makes any mismatch obvious.
const ZONE_LABELS = {
  top_left: 'top left corner',
  top_center: 'top center',
  top_right: 'top right corner',
  mid_left: 'mid-height left',
  mid_center: 'dead center',
  mid_right: 'mid-height right',
  bottom_left: 'bottom left corner',
  bottom_center: 'bottom center',
  bottom_right: 'bottom right corner',
}

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
  const [tab, setTab] = useState('judge')
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
  const [verdict, setVerdict] = useState(null)
  const [comparing, setComparing] = useState(false)
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

  // The head-to-head call: both clips' key frames judged side by side on
  // this device. Its verdict is the headline result and what settles the
  // match; the per-clip scorecards stay visible as supporting detail.
  async function handleCompare () {
    if (!clipScoreA || !clipScoreB) return
    setComparing(true)
    try {
      emit('Judging both clips side by side on this device…')
      const result = await window.probable.match.compare(clipScoreA, clipScoreB)
      setVerdict(result)
      emit(result.winner === 'tie'
        ? 'Head-to-head verdict: dead even'
        : `Head-to-head verdict: Player ${result.winner} wins`)
    } catch (err) {
      emit(`Head-to-head failed: ${err.message}`)
    } finally {
      setComparing(false)
    }
  }

  async function handleSettle () {
    try {
      // Pass the verdict already shown to the players, so settlement pays out
      // exactly the result they saw and never re-runs the model.
      const result = await window.probable.match.settle(escrowId, clipScoreA, clipScoreB, playerA, playerB, verdict)
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
      <h2>Probable</h2>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24 }}>
        {['judge', 'predict'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '10px 28px',
              fontFamily: 'monospace',
              fontSize: 13,
              fontWeight: tab === t ? 'bold' : 'normal',
              letterSpacing: 1,
              textTransform: 'uppercase',
              background: tab === t ? '#1a1d23' : 'transparent',
              color: tab === t ? '#f2f3f5' : '#8a8f98',
              border: tab === t ? '1px solid #444' : '1px solid transparent',
              borderBottom: tab === t ? '2px solid #2ecc71' : '2px solid transparent',
              borderRadius: '6px 6px 0 0',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            {t === 'judge' ? '⚖ Judge' : '🎯 Predict'}
          </button>
        ))}
      </div>

      {tab === 'judge' && (<>
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
              {/* Assigning a clip invalidates any verdict computed from the old pair. */}
              <button onClick={() => { setClipScoreA(clipScore); setVerdict(null); emit(`Clip A assigned (total ${clipScore.total} of 40)`) }}>
                Assign → Clip A (Player A)
              </button>
              <button onClick={() => { setClipScoreB(clipScore); setVerdict(null); emit(`Clip B assigned (total ${clipScore.total} of 40)`) }}>
                Assign → Clip B (Player B)
              </button>
            </div>
            {RUBRIC.map(({ key, label, gloss }) => (
              <div key={key} style={{ margin: '8px 0', padding: 10, background: '#1a1d23', borderRadius: 4 }}>
                <div>
                  <strong>{label}</strong> <span style={{ color: '#8a8f98' }}>[{gloss}]</span>: {clipScore.scores[key].score} of 10
                  {key === 'placement' && clipScore.scores[key].zone && (
                    <span style={{ color: '#5dade2' }}>
                      {' '}· zone: {ZONE_LABELS[clipScore.scores[key].zone] ?? clipScore.scores[key].zone}
                    </span>
                  )}
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
        <strong>Head-to-head verdict [decides the match]</strong>
        <p style={{ margin: '4px 0', fontSize: 12, color: '#c8ccd2' }}>
          Both clips judged side by side in one on-device call — who shot from further out,
          whose shot flew faster, who struck it cleaner — plus placement from each clip's goal zone
        </p>
        <div style={{ marginTop: 8 }}>
          <button onClick={handleCompare} disabled={!clipScoreA || !clipScoreB || comparing}>
            {comparing ? 'Judging head-to-head…' : 'Run head-to-head'}
          </button>
        </div>

        {verdict && (
          <div style={{ marginTop: 12 }}>
            <div style={{
              padding: 16,
              background: verdict.winner === 'tie' ? '#2a1c0e' : '#0e2418',
              border: `2px solid ${verdict.winner === 'tie' ? '#e67e22' : '#2ecc71'}`,
              borderRadius: 6,
            }}>
              <div style={{
                fontSize: 22,
                fontWeight: 'bold',
                letterSpacing: 1,
                color: verdict.winner === 'tie' ? '#e67e22' : '#2ecc71',
              }}>
                {verdict.winner === 'tie' ? 'DEAD EVEN' : `PLAYER ${verdict.winner} WINS`}
                {verdict.winner !== 'tie' && (
                  <span style={{ fontSize: 13, fontWeight: 'normal', color: '#c8ccd2' }}>
                    {' '}· {verdict.points.a}–{verdict.points.b} on the four measures
                    {verdict.tiebreak ? ` · settled by ${verdict.tiebreak === 'spectacle' ? 'the better finish' : 'the scorecards'}` : ''}
                    {verdict.mock ? ' · MOCK' : ''}
                  </span>
                )}
              </div>
              <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.6 }}>
                {verdict.summary}
              </p>
            </div>

            {VERDICT_DIMENSIONS.map(({ key, label, gloss }) => (
              <div key={key} style={{ margin: '8px 0', padding: 10, background: '#1a1d23', borderRadius: 4 }}>
                <div>
                  <strong>{label}</strong> <span style={{ color: '#8a8f98' }}>[{gloss}]</span>:{' '}
                  <span style={{ color: verdict.dimensions[key].winner === 'equal' ? '#8a8f98' : '#2ecc71' }}>
                    {verdict.dimensions[key].winner === 'equal' ? 'even' : `Player ${verdict.dimensions[key].winner}`}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#c8ccd2', marginTop: 4 }}>
                  Why: {verdict.dimensions[key].reason}
                </div>
              </div>
            ))}
            <div style={{ margin: '8px 0', padding: 10, background: '#1a1d23', borderRadius: 4 }}>
              <div>
                <strong>Spectacle</strong> <span style={{ color: '#8a8f98' }}>[tiebreaker only]</span>:{' '}
                <span style={{ color: verdict.spectacle.pick === 'equal' ? '#8a8f98' : '#2ecc71' }}>
                  {verdict.spectacle.pick === 'equal' ? 'even' : `Player ${verdict.spectacle.pick}`}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#c8ccd2', marginTop: 4 }}>
                Why: {verdict.spectacle.reason}
              </div>
            </div>
          </div>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <strong>Match settlement</strong>
        <p style={{ margin: '4px 0', fontSize: 12, color: '#c8ccd2' }}>
          Clip A: {clipScoreA ? `scored (${clipScoreA.total} of 40)` : 'not assigned'} ·
          Clip B: {clipScoreB ? `scored (${clipScoreB.total} of 40)` : 'not assigned'} ·
          Verdict: {verdict ? (verdict.winner === 'tie' ? 'dead even' : `Player ${verdict.winner}`) : 'not run yet'}
        </p>
        <div style={{ marginTop: 8 }}>
          {/* Settlement pays out the head-to-head verdict, so it requires one. */}
          <button
            onClick={handleSettle}
            disabled={!escrowId || !clipScoreA || !clipScoreB || !verdict || settled}
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
      </>)}

      {tab === 'predict' && (
        <PredictTab address={address} modelInfo={modelInfo} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Predict tab — goal bet: two friends each pick a different real World Cup
// player, the cooler goal wins the pot, judged by the same comparison
// pipeline Judge mode already uses.
// ---------------------------------------------------------------------------

function PlayerPicker ({ label, scorers, selected, onSelect, exclude, disabled }) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  // Close the dropdown when clicking outside.
  useEffect(() => {
    function handleClick (e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const filtered = scorers.filter((p) => {
    // Exclude the player already picked by the other side.
    if (exclude && exclude.name === p.name && exclude.team === p.team) return false
    if (!search) return true
    const s = search.toLowerCase()
    return p.name.toLowerCase().includes(s) || p.team.toLowerCase().includes(s)
  })

  if (selected) {
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: '#8a8f98', marginBottom: 4 }}>{label}</div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px', background: '#16241a', border: '1px solid #2ecc71',
          borderRadius: 6,
        }}>
          <span style={{ fontWeight: 'bold' }}>{selected.name}</span>
          <span style={{ color: '#8a8f98' }}>· {selected.team}</span>
          <span style={{ color: '#5dade2', fontSize: 12 }}>{selected.goals} goal{selected.goals !== 1 ? 's' : ''}</span>
          {!disabled && (
            <button
              onClick={() => onSelect(null)}
              style={{
                marginLeft: 'auto', padding: '2px 10px', fontSize: 11,
                background: 'transparent', color: '#c0392b', border: '1px solid #c0392b',
                borderRadius: 4, cursor: 'pointer',
              }}
            >
              Change
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: '#8a8f98', marginBottom: 4 }}>{label}</div>
      <input
        type="text"
        placeholder="Search by player name or team…"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        disabled={disabled}
        style={{
          width: '100%', maxWidth: 420, fontFamily: 'monospace', fontSize: 12,
          padding: '8px 12px', background: '#1a1d23', color: '#f2f3f5',
          border: '1px solid #444', borderRadius: 6, boxSizing: 'border-box',
        }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, maxWidth: 420,
          maxHeight: 220, overflowY: 'auto', background: '#1a1d23',
          border: '1px solid #444', borderRadius: '0 0 6px 6px', zIndex: 100,
        }}>
          {filtered.slice(0, 50).map((p) => (
            <div
              key={`${p.name}|${p.team}`}
              onClick={() => { onSelect(p); setSearch(''); setOpen(false) }}
              style={{
                padding: '8px 12px', cursor: 'pointer', fontSize: 12,
                borderBottom: '1px solid #2a2d33',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#252830' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{ fontWeight: 'bold' }}>{p.name}</span>
              <span style={{ color: '#8a8f98' }}> · {p.team}</span>
              <span style={{ color: '#5dade2', marginLeft: 8 }}>{p.goals} goal{p.goals !== 1 ? 's' : ''}</span>
            </div>
          ))}
        </div>
      )}
      {open && filtered.length === 0 && search && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, maxWidth: 420,
          padding: '10px 12px', background: '#1a1d23', border: '1px solid #444',
          borderRadius: '0 0 6px 6px', fontSize: 12, color: '#8a8f98', zIndex: 100,
        }}>
          No players match "{search}"
        </div>
      )}
    </div>
  )
}

function OddsBar ({ oddsResult }) {
  if (!oddsResult) return null
  const { playerA, playerB, note } = oddsResult
  const pctA = playerA.percent
  const pctB = playerB.percent
  return (
    <div style={{ margin: '16px 0', padding: 16, background: '#1a1d23', borderRadius: 6, border: '1px solid #333' }}>
      <div style={{ fontSize: 12, color: '#8a8f98', marginBottom: 10 }}>
        Pre-match odds based on tournament stats — not a guarantee, does not affect payout
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 'bold', minWidth: 40, textAlign: 'right' }}>{pctA}%</span>
        <div style={{ flex: 1, height: 18, borderRadius: 9, overflow: 'hidden', display: 'flex', background: '#333' }}>
          <div style={{
            width: `${pctA}%`, background: 'linear-gradient(90deg, #2ecc71, #27ae60)',
            transition: 'width 0.3s ease',
          }} />
          <div style={{
            width: `${pctB}%`, background: 'linear-gradient(90deg, #e67e22, #d35400)',
            transition: 'width 0.3s ease',
          }} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 'bold', minWidth: 40 }}>{pctB}%</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <span style={{ color: '#2ecc71' }}>{playerA.player} · {playerA.goals} goals</span>
        <span style={{ color: '#e67e22' }}>{playerB.player} · {playerB.goals} goals</span>
      </div>
      <div style={{ fontSize: 11, color: '#666', marginTop: 8 }}>{note}</div>
    </div>
  )
}

function PredictTab ({ address }) {
  // --- Setup state ---
  const [scorers, setScorers] = useState([])
  const [scorersLoading, setScorersLoading] = useState(false)
  const [pickA, setPickA] = useState(null)
  const [pickB, setPickB] = useState(null)
  const [oddsResult, setOddsResult] = useState(null)
  const [addrA, setAddrA] = useState('')
  const [addrB, setAddrB] = useState('')
  const [stake, setStake] = useState('100')
  const [creating, setCreating] = useState(false)

  // --- Saved bets ---
  const [betList, setBetList] = useState([])
  const [betDeleteMode, setBetDeleteMode] = useState(false)
  const [betDeleteSelected, setBetDeleteSelected] = useState(new Set())

  // --- Active bet ---
  const [activeBet, setActiveBet] = useState(null)

  // --- Clip scoring (reuses the same clip pipeline as Judge mode) ---
  const [pVideoPath, setPVideoPath] = useState(null)
  const [pScoring, setPScoring] = useState(false)
  const [pPreparingModel, setPPreparingModel] = useState(false)
  const [pClipScore, setPClipScore] = useState(null)

  // --- Settlement ---
  const [settling, setSettling] = useState(false)
  const [settleResult, setSettleResult] = useState(null)

  // --- Log ---
  const [pLog, setPLog] = useState([])
  const pEmit = (msg) => setPLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev])

  // Load the roster on first mount.
  useEffect(() => {
    setScorersLoading(true)
    window.probable.predict.getScorers()
      .then((list) => { setScorers(list); pEmit(`Loaded ${list.length} goal scorers from tournament data`) })
      .catch((err) => pEmit(`Failed to load scorers: ${err.message}`))
      .finally(() => setScorersLoading(false))
    refreshBetList()
  }, [])

  // Auto-compute odds when both players are picked.
  useEffect(() => {
    if (!pickA || !pickB) { setOddsResult(null); return }
    window.probable.predict.computeOdds(
      { name: pickA.name, team: pickA.team },
      { name: pickB.name, team: pickB.team }
    )
      .then((r) => { setOddsResult(r); pEmit(`Odds: ${r.playerA.percent}% – ${r.playerB.percent}%`) })
      .catch((err) => pEmit(`Odds failed: ${err.message}`))
  }, [pickA, pickB])

  async function refreshBetList () {
    try {
      const bets = await window.probable.predict.listBets()
      setBetList([...bets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)))
    } catch (err) { pEmit(`Bet list failed: ${err.message}`) }
  }

  async function handleCreateBet () {
    if (!pickA || !pickB) return
    if (!isValidAddress(addrA) || !isValidAddress(addrB)) {
      pEmit('Both wallet addresses must be valid 0x addresses')
      return
    }
    const amt = parseFloat(stake)
    if (isNaN(amt) || amt <= 0) { pEmit('Stake must be a positive number'); return }
    setCreating(true)
    try {
      const bet = await window.probable.predict.createBet({
        playerAChoice: { name: pickA.name, team: pickA.team },
        playerBChoice: { name: pickB.name, team: pickB.team },
        participantA: addrA,
        participantB: addrB,
        stakeAmount: amt,
      })
      setActiveBet(bet)
      pEmit(`Bet created ${bet.id.slice(0, 8)}… | ${bet.playerAChoice.name} vs ${bet.playerBChoice.name}`)
      refreshBetList()
    } catch (err) { pEmit(`Create failed: ${err.message}`) }
    finally { setCreating(false) }
  }

  async function loadBet (betId) {
    try {
      const bet = await window.probable.predict.getBetStatus(betId)
      setActiveBet(bet)
      setSettleResult(null)
      setPClipScore(null)
      setPVideoPath(null)
      pEmit(`Loaded bet ${bet.id.slice(0, 8)}… | balance: ${bet.escrowBalance} USDt | ${bet.status}`)
    } catch (err) { pEmit(`Load bet failed: ${err.message}`) }
  }

  async function handleRefreshBet () {
    if (!activeBet) return
    await loadBet(activeBet.id)
  }

  async function handleDeleteBets () {
    const ids = [...betDeleteSelected]
    if (ids.length === 0) return
    try {
      await window.probable.predict.deleteBets(ids)
      pEmit(`Deleted ${ids.length} bet${ids.length > 1 ? 's' : ''}`)
      if (activeBet && ids.includes(activeBet.id)) setActiveBet(null)
      setBetDeleteMode(false)
      setBetDeleteSelected(new Set())
      refreshBetList()
    } catch (err) { pEmit(`Delete failed: ${err.message}`) }
  }

  // --- Clip scoring (same pipeline as Judge mode) ---

  async function handlePickClip () {
    try {
      const picked = await window.probable.clip.pickVideo()
      if (!picked) { pEmit('Video pick cancelled'); return }
      setPVideoPath(picked)
      setPClipScore(null)
      pEmit(`Picked clip: ${picked}`)
    } catch (err) { pEmit(`Pick failed: ${err.message}`) }
  }

  async function handleScoreClip () {
    if (!pVideoPath) return
    setPScoring(true)
    try {
      setPPreparingModel(true)
      pEmit('Preparing on-device model…')
      const prep = await window.probable.clip.prepareModel()
      if (!prep.alreadyLoaded && !prep.mock) pEmit(`Model ready: ${prep.model}`)
      setPPreparingModel(false)

      pEmit('Scoring clip locally…')
      const result = await window.probable.clip.score(pVideoPath)
      setPClipScore(result)
      pEmit(`Scored: total ${result.total} of 40 from ${result.frameCount} frames${result.mock ? ' (mock)' : ''}`)
    } catch (err) { pEmit(`Score failed: ${err.message}`) }
    finally { setPPreparingModel(false); setPScoring(false) }
  }

  async function handleSubmitClip (side) {
    if (!activeBet || !pClipScore) return
    try {
      const updated = await window.probable.predict.submitClip(activeBet.id, side, pClipScore)
      setActiveBet(updated)
      const playerName = side === 'A' ? updated.playerAChoice.name : updated.playerBChoice.name
      pEmit(`Clip submitted for ${playerName} (side ${side}) — total ${pClipScore.total}/40`)
      setPClipScore(null)
      setPVideoPath(null)
    } catch (err) { pEmit(`Submit failed: ${err.message}`) }
  }

  // --- Settlement ---

  async function handleSettle () {
    if (!activeBet) return
    setSettling(true)
    try {
      const result = await window.probable.predict.settleBet(activeBet.id)
      setSettleResult(result)
      if (result.outcome === 'settled') {
        pEmit(`Settled: ${result.winner} wins | ${result.payout} USDT | tx: ${result.txHash}`)
      } else if (result.outcome === 'forfeited') {
        pEmit(`Forfeited: side ${result.forfeitedSide} had no clip, pot → ${result.winner} | tx: ${result.txHash}`)
      } else if (result.outcome === 'unresolved') {
        pEmit(`Unresolved: ${result.reason}`)
      } else if (result.outcome === 'unfunded') {
        pEmit(`Settle: unfunded, balance is ${result.balance} USDT`)
      } else if (result.outcome === 'tied') {
        pEmit('Settle: tied, escrow untouched')
      } else if (result.outcome === 'already_settled') {
        pEmit(`Already settled: winner ${result.winnerAddress?.slice(0, 10)}…`)
      }
      await loadBet(activeBet.id)
    } catch (err) { pEmit(`Settle failed: ${err.message}`) }
    finally { setSettling(false) }
  }

  async function handleForfeit () {
    // Forfeit is just a settle call — the backend detects one-sided clips
    // and releases directly without comparison.
    await handleSettle()
  }

  async function handleMarkUnresolved () {
    // Same call — backend detects zero clips and marks as unresolved.
    await handleSettle()
  }

  const betSettled = activeBet?.status === 'settled' || activeBet?.status === 'forfeited'
  const betUnresolved = activeBet?.status === 'unresolved'
  const bothClips = activeBet?.clipA !== null && activeBet?.clipB !== null
  const oneClip = (activeBet?.clipA !== null) !== (activeBet?.clipB !== null)
  const noClips = activeBet?.clipA === null && activeBet?.clipB === null

  return (
    <div>
      {/* --- Player selection --- */}
      <section style={{ marginBottom: 24 }}>
        <strong>Pick your players</strong>
        <p style={{ margin: '4px 0 12px', fontSize: 12, color: '#8a8f98' }}>
          Each side picks a different World Cup player who has scored at least one goal.
          {scorersLoading && ' Loading roster…'}
        </p>
        <PlayerPicker
          label="Person A's player"
          scorers={scorers}
          selected={pickA}
          onSelect={setPickA}
          exclude={pickB}
          disabled={!!activeBet}
        />
        <PlayerPicker
          label="Person B's player"
          scorers={scorers}
          selected={pickB}
          onSelect={setPickB}
          exclude={pickA}
          disabled={!!activeBet}
        />
        <OddsBar oddsResult={oddsResult} />
      </section>

      {/* --- Staking --- */}
      <section style={{ marginBottom: 24 }}>
        <strong>Stake and wallets</strong>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 12 }}>
            Person A wallet address
            <input
              type="text" placeholder="0x…" value={addrA}
              onChange={(e) => setAddrA(e.target.value.trim())}
              disabled={!!activeBet}
              style={{
                display: 'block', marginTop: 4, fontFamily: 'monospace', fontSize: 12,
                padding: '4px 8px', background: '#1a1d23', color: '#f2f3f5',
                border: `1px solid ${addrA && !isValidAddress(addrA) ? '#c0392b' : '#444'}`,
                borderRadius: 4, width: 420,
              }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            Person B wallet address
            <input
              type="text" placeholder="0x…" value={addrB}
              onChange={(e) => setAddrB(e.target.value.trim())}
              disabled={!!activeBet}
              style={{
                display: 'block', marginTop: 4, fontFamily: 'monospace', fontSize: 12,
                padding: '4px 8px', background: '#1a1d23', color: '#f2f3f5',
                border: `1px solid ${addrB && !isValidAddress(addrB) ? '#c0392b' : '#444'}`,
                borderRadius: 4, width: 420,
              }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            Stake per person (USDt)
            <input
              type="number" min="1" step="any" value={stake}
              onChange={(e) => setStake(e.target.value)}
              disabled={!!activeBet}
              style={{
                display: 'block', marginTop: 4, fontFamily: 'monospace', fontSize: 12,
                padding: '4px 8px', background: '#1a1d23', color: '#f2f3f5',
                border: '1px solid #444', borderRadius: 4, width: 140,
              }}
            />
          </label>
          {stake && parseFloat(stake) > 0 && (
            <p style={{ margin: '4px 0', fontSize: 12, color: '#8a8f98' }}>
              Total pot: {(parseFloat(stake) * 2).toFixed(2)} USDt ({stake} per person)
            </p>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            onClick={handleCreateBet}
            disabled={!!activeBet || !pickA || !pickB || !isValidAddress(addrA) || !isValidAddress(addrB) || creating}
          >
            {creating ? 'Creating…' : 'Create bet'}
          </button>
          {activeBet && (
            <button
              onClick={() => { setActiveBet(null); setSettleResult(null); setPClipScore(null); setPVideoPath(null) }}
              style={{ marginLeft: 8 }}
            >
              New bet
            </button>
          )}
        </div>
      </section>

      {/* --- Saved bets list --- */}
      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong>Saved bets</strong>
          {betList.length > 0 && (
            <button
              onClick={() => { setBetDeleteMode((p) => !p); setBetDeleteSelected(new Set()) }}
              style={{
                fontSize: 11, padding: '3px 10px',
                background: betDeleteMode ? '#2a1c0e' : 'transparent',
                color: betDeleteMode ? '#e67e22' : '#8a8f98',
                border: `1px solid ${betDeleteMode ? '#e67e22' : '#444'}`,
                borderRadius: 4, cursor: 'pointer',
              }}
            >
              {betDeleteMode ? 'Cancel' : 'Delete'}
            </button>
          )}
        </div>

        {betDeleteMode && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={handleDeleteBets}
              disabled={betDeleteSelected.size === 0}
              style={{
                fontSize: 12, padding: '4px 14px',
                background: betDeleteSelected.size > 0 ? '#3d1515' : '#1a1d23',
                color: betDeleteSelected.size > 0 ? '#e74c3c' : '#555',
                border: `1px solid ${betDeleteSelected.size > 0 ? '#e74c3c' : '#333'}`,
                borderRadius: 4, cursor: betDeleteSelected.size > 0 ? 'pointer' : 'default',
              }}
            >
              Delete {betDeleteSelected.size > 0 ? `(${betDeleteSelected.size})` : ''}
            </button>
          </div>
        )}

        {betList.length === 0 ? (
          <p style={{ margin: '8px 0 0', fontSize: 12 }}>(no bets yet)</p>
        ) : (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {betList.map((bet) => {
              const isLoaded = activeBet?.id === bet.id
              const isChecked = betDeleteSelected.has(bet.id)
              return (
                <div
                  key={bet.id}
                  onClick={() => {
                    if (betDeleteMode) {
                      setBetDeleteSelected((prev) => {
                        const next = new Set(prev)
                        next.has(bet.id) ? next.delete(bet.id) : next.add(bet.id)
                        return next
                      })
                    } else {
                      loadBet(bet.id)
                    }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    fontFamily: 'monospace', fontSize: 12, padding: '8px 10px',
                    background: isChecked ? '#2a1515' : isLoaded ? '#16241a' : '#1a1d23',
                    color: '#f2f3f5',
                    border: `1px solid ${isChecked ? '#e74c3c' : isLoaded ? '#2ecc71' : '#444'}`,
                    borderRadius: 4, cursor: 'pointer', userSelect: 'none',
                  }}
                >
                  {betDeleteMode && (
                    <div style={{
                      width: 14, height: 14, borderRadius: 3,
                      border: `1.5px solid ${isChecked ? '#e74c3c' : '#666'}`,
                      background: isChecked ? '#e74c3c' : 'transparent',
                      flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {isChecked && <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✓</span>}
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      <strong>{bet.id.slice(0, 8)}…</strong>
                      {' · '}
                      <span style={{ color: '#2ecc71' }}>{bet.playerAChoice?.name}</span>
                      {' vs '}
                      <span style={{ color: '#e67e22' }}>{bet.playerBChoice?.name}</span>
                      {' · '}
                      <span style={{
                        color: bet.status === 'settled' ? '#2ecc71'
                          : bet.status === 'forfeited' ? '#e67e22'
                          : bet.status === 'unresolved' ? '#c0392b'
                          : '#8a8f98'
                      }}>{bet.status}</span>
                    </div>
                    <div style={{ color: '#8a8f98', marginTop: 2 }}>
                      {bet.stakeAmount} USDt/side · wallet: {bet.matchWalletAddress}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* --- Active bet details --- */}
      {activeBet && (
        <section style={{ marginBottom: 24 }}>
          <strong>Active bet</strong>
          <div style={{ marginTop: 8, padding: 14, background: '#1a1d23', borderRadius: 6, border: '1px solid #333' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div>
                <span style={{ color: '#2ecc71', fontWeight: 'bold' }}>{activeBet.playerAChoice?.name}</span>
                <span style={{ color: '#8a8f98' }}> ({activeBet.playerAChoice?.team})</span>
                <span style={{ color: '#8a8f98' }}> vs </span>
                <span style={{ color: '#e67e22', fontWeight: 'bold' }}>{activeBet.playerBChoice?.name}</span>
                <span style={{ color: '#8a8f98' }}> ({activeBet.playerBChoice?.team})</span>
              </div>
              <button onClick={handleRefreshBet} style={{ fontSize: 11, padding: '3px 10px' }}>
                Refresh
              </button>
            </div>

            <div style={{ fontSize: 12, color: '#c8ccd2' }}>
              <div>Status: <strong style={{
                color: activeBet.status === 'settled' ? '#2ecc71'
                  : activeBet.status === 'forfeited' ? '#e67e22'
                  : activeBet.status === 'unresolved' ? '#c0392b'
                  : '#f2f3f5'
              }}>{activeBet.status}</strong></div>
              <div>Escrow balance: {activeBet.escrowBalance ?? '(refresh to check)'} USDt</div>
              <div>Stake: {activeBet.stakeAmount} USDt per side · Total pot: {activeBet.stakeAmount * 2} USDt</div>
              <div>Match wallet: <span style={{ color: '#5dade2' }}>{activeBet.matchWalletAddress}</span></div>
              {activeBet.txHash && (
                <div style={{ marginTop: 4 }}>
                  Payout tx:{' '}
                  <a
                    href={`https://sepolia.etherscan.io/tx/${activeBet.txHash}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{ color: '#5dade2', wordBreak: 'break-all' }}
                  >
                    {activeBet.txHash}
                  </a>
                </div>
              )}
            </div>

            {activeBet.odds && !betSettled && !betUnresolved && (
              <OddsBar oddsResult={activeBet.odds} />
            )}
          </div>

          {/* --- Settled / forfeited / unresolved banner --- */}
          {betSettled && (
            <div style={{
              margin: '12px 0', padding: 14, borderRadius: 6,
              background: activeBet.status === 'forfeited' ? '#2a1c0e' : '#0e2418',
              border: `1px solid ${activeBet.status === 'forfeited' ? '#e67e22' : '#2ecc71'}`,
            }}>
              <div style={{
                fontWeight: 'bold', letterSpacing: 1, marginBottom: 6,
                color: activeBet.status === 'forfeited' ? '#e67e22' : '#2ecc71',
              }}>
                {activeBet.status === 'forfeited'
                  ? `● FORFEITED — PERSON ${activeBet.winner} WINS`
                  : `● SETTLED — PERSON ${activeBet.winner} WINS`}
              </div>
              <div style={{ fontSize: 12 }}>
                Winner: {activeBet.winner === 'A' ? activeBet.playerAChoice?.name : activeBet.playerBChoice?.name}
              </div>
            </div>
          )}

          {betUnresolved && (
            <div style={{
              margin: '12px 0', padding: 14, borderRadius: 6,
              background: '#2a1515', border: '1px solid #c0392b',
            }}>
              <div style={{ fontWeight: 'bold', letterSpacing: 1, color: '#c0392b', marginBottom: 6 }}>
                ● UNRESOLVED
              </div>
              <div style={{ fontSize: 12 }}>
                No refund path exists. This bet cannot be settled with the current clips.
              </div>
            </div>
          )}

          {/* --- Clip submission --- */}
          {!betSettled && !betUnresolved && (
            <div style={{ marginTop: 16 }}>
              <strong>Submit goal clips</strong>
              <p style={{ margin: '4px 0 12px', fontSize: 12, color: '#8a8f98' }}>
                Each side submits a real goal clip for their chosen player. Same scoring pipeline as Judge mode.
              </p>

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {/* Side A clip */}
                <div style={{
                  flex: '1 1 200px', padding: 12, background: '#1a1d23',
                  borderRadius: 6, border: `1px solid ${activeBet.clipA ? '#2ecc71' : '#333'}`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 'bold', color: '#2ecc71', marginBottom: 6 }}>
                    Person A — {activeBet.playerAChoice?.name}
                  </div>
                  {activeBet.clipA ? (
                    <div style={{ fontSize: 12 }}>
                      ✓ Clip submitted · Total: <strong>{activeBet.clipA.total}/40</strong>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#8a8f98' }}>No clip submitted yet</div>
                  )}
                </div>

                {/* Side B clip */}
                <div style={{
                  flex: '1 1 200px', padding: 12, background: '#1a1d23',
                  borderRadius: 6, border: `1px solid ${activeBet.clipB ? '#e67e22' : '#333'}`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 'bold', color: '#e67e22', marginBottom: 6 }}>
                    Person B — {activeBet.playerBChoice?.name}
                  </div>
                  {activeBet.clipB ? (
                    <div style={{ fontSize: 12 }}>
                      ✓ Clip submitted · Total: <strong>{activeBet.clipB.total}/40</strong>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#8a8f98' }}>No clip submitted yet</div>
                  )}
                </div>
              </div>

              {/* Clip picker and scorer */}
              <div style={{ marginTop: 12, padding: 12, background: '#151820', borderRadius: 6, border: '1px solid #2a2d33' }}>
                <div style={{ fontSize: 12, color: '#8a8f98', marginBottom: 8 }}>
                  Pick and score a goal clip, then assign it to a side
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={handlePickClip} disabled={pScoring}>Pick video file</button>
                  <button onClick={handleScoreClip} disabled={!pVideoPath || pScoring}>
                    {pScoring ? (pPreparingModel ? 'Preparing model…' : 'Scoring…') : 'Score clip'}
                  </button>
                  {pVideoPath && (
                    <span style={{ fontSize: 11, color: '#8a8f98' }}>
                      {pVideoPath.split(/[\\/]/).pop()}
                    </span>
                  )}
                </div>
                {pClipScore && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12, marginBottom: 8 }}>
                      Score: <strong>{pClipScore.total}/40</strong> · {pClipScore.frameCount} frames
                      {pClipScore.mock ? ' · MOCK' : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => handleSubmitClip('A')}
                        disabled={!!activeBet.clipA}
                        style={{ background: activeBet.clipA ? undefined : '#0e2418', borderColor: '#2ecc71' }}
                      >
                        Submit for {activeBet.playerAChoice?.name} (A)
                      </button>
                      <button
                        onClick={() => handleSubmitClip('B')}
                        disabled={!!activeBet.clipB}
                        style={{ background: activeBet.clipB ? undefined : '#2a1c0e', borderColor: '#e67e22' }}
                      >
                        Submit for {activeBet.playerBChoice?.name} (B)
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* --- Settlement controls --- */}
          {!betSettled && !betUnresolved && (
            <div style={{ marginTop: 16 }}>
              <strong>Settle</strong>
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {bothClips && (
                  <button onClick={handleSettle} disabled={settling}>
                    {settling ? 'Settling…' : 'Settle bet — compare clips'}
                  </button>
                )}
                {oneClip && (
                  <button onClick={handleForfeit} disabled={settling}
                    style={{ background: '#2a1c0e', borderColor: '#e67e22' }}
                  >
                    {settling ? 'Processing…' : 'Forfeit — one side has no clip'}
                  </button>
                )}
                {noClips && (
                  <button onClick={handleMarkUnresolved} disabled={settling}
                    style={{ background: '#2a1515', borderColor: '#c0392b' }}
                  >
                    Mark unresolved — neither player scored
                  </button>
                )}
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 11, color: '#666' }}>
                {bothClips && 'Both clips are in. Settling runs them through the same AI comparison Judge mode uses.'}
                {oneClip && 'Only one side submitted a clip. Forfeiting releases the full pot to that side, no comparison needed.'}
                {noClips && 'Neither side submitted a clip. No refund path exists — the bet will be marked as unresolved.'}
              </p>
            </div>
          )}

          {/* --- Settlement result --- */}
          {settleResult && (
            <div style={{ marginTop: 12 }}>
              <strong>Settlement result</strong>
              <pre style={{
                margin: '8px 0', padding: 12, background: '#1a1d23',
                borderRadius: 4, fontSize: 12, overflowX: 'auto',
              }}>
                {JSON.stringify(settleResult, null, 2)}
              </pre>
            </div>
          )}
        </section>
      )}

      {/* --- Log --- */}
      <section>
        <strong>Log</strong>
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
          {pLog.map((entry, i) => <div key={i}>{entry}</div>)}
        </div>
      </section>
    </div>
  )
}

