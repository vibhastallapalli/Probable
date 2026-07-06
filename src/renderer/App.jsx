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

// Status → pill styling. Green for paid-out terminal states, amber for
// forfeits, red for dead ends, neutral gray otherwise.
function statusPillClass (status) {
  if (status === 'settled' || status === 'released') return 'pill pill--ok'
  if (status === 'forfeited') return 'pill pill--warn'
  if (status === 'unresolved') return 'pill pill--bad'
  return 'pill'
}

// Always visible proof of QVAC compliance: which model, where it runs, and
// that nothing gets uploaded. Flips to an amber mock warning when the last
// score came from the offline stand in, so the badge never overclaims.
function StatusBadge ({ modelInfo, mockMode }) {
  return (
    <div className={mockMode ? 'ai ai--mock' : 'ai'} title={modelInfo.id}>
      <div>
        <div className="ai__title">
          <span className="dot dot--pulse" />
          {mockMode ? 'MOCK MODE [NO MODEL LOADED]' : 'ON-DEVICE AI [QVAC]'}
        </div>
        <div className="ai__row">model <b>{modelInfo.name}</b></div>
        <div className="ai__row">inference <b>{mockMode ? 'offline stand-in, not the real model' : 'on device, zero cloud calls'}</b></div>
      </div>
      <div className="ai__meter">
        <div className="ai__zero">0</div>
        <div className="ai__zerolabel">BYTES<br />UPLOADED</div>
      </div>
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
    <div className="app">
      <StatusBadge modelInfo={modelInfo} mockMode={clipScore?.mock === true} />
      <div className="container">
        <header className="topbar">
          <span className="wordmark">Probable</span>
          <span className="tagline">P2P football wagers · judged on device · settled in USDt</span>
        </header>

        {/* Tab switcher */}
        <div className="tabs">
          {['judge', 'predict'].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`tab ${tab === t ? 'tab--active' : ''}`}
            >
              {t === 'judge' ? '⚖ Judge' : '🎯 Predict'}
            </button>
          ))}
        </div>

        {tab === 'judge' && (<>
        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">App wallet</span>
            {address
              ? <span className="pill pill--ok"><span className="dot dot--pulse" />ready</span>
              : <span className="pill">initialising</span>}
          </div>
          <div className="kv"><span className="kv__k">Address</span><span className="kv__v">{address ?? 'initialising…'}</span></div>
        </section>

        <section className="panel">
          <div className="panel__head"><span className="panel__title">Test participants</span></div>
          <label className="field">
            <span className="field__label side-a">Player A address</span>
            <input
              type="text"
              placeholder="0x…"
              value={playerA}
              onChange={(e) => setPlayerA(e.target.value.trim())}
              disabled={!!escrowId}
              className={`input ${playerA && !isValidAddress(playerA) ? 'input--err' : ''}`}
            />
            {playerA && !isValidAddress(playerA) && (
              <span className="field__err">Must be a 42 character 0x address</span>
            )}
          </label>
          <label className="field">
            <span className="field__label side-b">Player B address</span>
            <input
              type="text"
              placeholder="0x…"
              value={playerB}
              onChange={(e) => setPlayerB(e.target.value.trim())}
              disabled={!!escrowId}
              className={`input ${playerB && !isValidAddress(playerB) ? 'input--err' : ''}`}
            />
            {playerB && !isValidAddress(playerB) && (
              <span className="field__err">Must be a 42 character 0x address</span>
            )}
          </label>
          <div className="kv"><span className="kv__k">Player A</span><span className="kv__v">{playerA || '(not set)'}</span></div>
          <div className="kv"><span className="kv__k">Player B</span><span className="kv__v">{playerB || '(not set)'}</span></div>
          <div className="kv"><span className="kv__k">Stake</span><span className="kv__v">{STAKE} USDt per player · {STAKE * 2} USDt total</span></div>
        </section>

        <section className="panel">
          <div className="panel__head"><span className="panel__title">Escrow actions</span></div>
          <div className="bar" style={{ marginTop: 0 }}>
            <button className="btn btn--primary" onClick={handleCreate} disabled={!!escrowId || !isValidAddress(playerA) || !isValidAddress(playerB)}>
              Create test escrow
            </button>
            <input
              type="text"
              placeholder="Escrow ID"
              value={loadId}
              onChange={(e) => setLoadId(e.target.value)}
              disabled={!!escrowId}
              className="input input--mid"
            />
            <button className="btn" onClick={handleLoad} disabled={!!escrowId || !loadId.trim()}>
              Load escrow
            </button>
            {escrowId && (
              <>
                <button className="btn" onClick={handleRefresh}>Refresh status</button>
                <button className="btn btn--a" onClick={() => handleRelease(playerA, 'Player A')} disabled={settled}>
                  Release → Player A
                </button>
                <button className="btn btn--b" onClick={() => handleRelease(playerB, 'Player B')} disabled={settled}>
                  Release → Player B
                </button>
              </>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">Saved escrows</span>
            {escrowList.length > 0 && (
              <button
                className={`btn btn--sm ${deleteMode ? 'btn--warn' : 'btn--ghost'}`}
                onClick={toggleDeleteMode}
              >
                {deleteMode ? 'Cancel' : 'Delete'}
              </button>
            )}
          </div>

          {deleteMode && (
            <div className="bar" style={{ marginTop: 0, marginBottom: 8 }}>
              <button
                className="btn btn--sm btn--danger"
                onClick={handleDeleteSelected}
                disabled={deleteSelected.size === 0}
              >
                Delete {deleteSelected.size > 0 ? `(${deleteSelected.size})` : ''}
              </button>
              <span className="micro">
                {deleteSelected.size === 0 ? 'Select escrows to delete' : `${deleteSelected.size} selected`}
              </span>
            </div>
          )}

          {escrowList.length === 0 ? (
            <p className="micro" style={{ margin: 0 }}>(none saved yet)</p>
          ) : (
            <div className="stack" style={{ marginTop: 0 }}>
              {escrowList.map((item) => {
                const isLoaded = item.id === escrowId
                const isChecked = deleteSelected.has(item.id)
                return (
                  <div
                    key={item.id}
                    onClick={() => deleteMode ? toggleDeleteSelect(item.id) : loadEscrow(item.id)}
                    title={deleteMode ? (isChecked ? 'Deselect' : 'Select for deletion') : `Load ${item.id}`}
                    className={`row ${isChecked ? 'row--checked' : isLoaded ? 'row--loaded' : ''}`}
                  >
                    {deleteMode && (
                      <div className={`checkbox ${isChecked ? 'checkbox--on' : ''}`}>
                        {isChecked && <span className="checkbox__tick">✓</span>}
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        <strong>{item.id.slice(0, 8)}…</strong> · {item.status}
                        {typeof item.balance === 'number' ? ` · ${item.balance} USDt` : ''}
                      </div>
                      <div className="row__meta">
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
          <section className="panel">
            <div className="panel__head">
              <span className="panel__title">Escrow state</span>
              <span className={statusPillClass(escrowRecord.status)}>{escrowRecord.status}</span>
            </div>
            {settled && (
              <div className="receipt" style={{ marginTop: 0, marginBottom: 12 }}>
                <div className="receipt__status"><span className="dot dot--pulse" /> Settled · paid out</div>
                <hr className="receipt__divider" />
                <div className="kv"><span className="kv__k">Winner</span><span className="kv__v">{escrowRecord.winner ?? '(unknown)'}</span></div>
                <div className="kv"><span className="kv__k">Payout tx</span><span className="kv__v">
                  {escrowRecord.txHash ? (
                    <a
                      className="hashlink"
                      href={`https://sepolia.etherscan.io/tx/${escrowRecord.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {escrowRecord.txHash}
                    </a>
                  ) : '(not recorded)'}
                </span></div>
                {escrowRecord.txHash && (
                  <a
                    className="receipt__link"
                    href={`https://sepolia.etherscan.io/tx/${escrowRecord.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on Sepolia Etherscan ↗
                  </a>
                )}
              </div>
            )}
            <div className="kv"><span className="kv__k">ID</span><span className="kv__v">{escrowRecord.id}</span></div>
            <div className="kv"><span className="kv__k">Status</span><span className="kv__v">{escrowRecord.status}</span></div>
            {typeof escrowRecord.balance === 'number' && (
              <div className="kv"><span className="kv__k">Balance</span><span className="kv__v">{escrowRecord.balance} USDt</span></div>
            )}
            {escrowRecord.matchWalletAddress && (
              <div className="kv"><span className="kv__k">Match wallet</span><span className="kv__v">{escrowRecord.matchWalletAddress}</span></div>
            )}
            <details className="raw">
              <summary>Raw escrow record</summary>
              <pre className="json">{JSON.stringify(escrowRecord, null, 2)}</pre>
            </details>
          </section>
        )}

        <section className="panel">
          <div className="panel__head"><span className="panel__title">Clip scoring [judged on this device via QVAC]</span></div>
          <p className="hint">
            Scored on the four FIFA Puskas Award criteria [the rubric FIFA uses for its own goal of the year]
          </p>
          <div className="kv"><span className="kv__k">Clip</span><span className="kv__v">{videoPath ?? '(none selected)'}</span></div>
          {clipProbe?.lowFps && (
            <p className="warn-note">
              ⚠ This clip is {roundFps(clipProbe.fps)} fps, under {clipProbe.minFps} fps, so scoring may be less reliable
            </p>
          )}
          <div className="bar">
            <button className="btn" onClick={handlePickVideo} disabled={scoring}>Pick video file</button>
            <button className="btn btn--primary" onClick={handleScoreClip} disabled={!videoPath || scoring}>
              {scoring ? (preparingModel ? 'Preparing model…' : 'Scoring…') : 'Run scoreClip'}
            </button>
          </div>

          {clipScore && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <span className="score-big">{clipScore.total} <small>/ 40</small></span>
                <span className="pill">{clipScore.model}</span>
                {clipScore.mock && <span className="pill pill--warn">mock</span>}
                <span className="micro">{clipScore.frameCount} frames</span>
              </div>
              <div className="bar">
                {/* Assigning a clip invalidates any verdict computed from the old pair. */}
                <button className="btn btn--a" onClick={() => { setClipScoreA(clipScore); setVerdict(null); emit(`Clip A assigned (total ${clipScore.total} of 40)`) }}>
                  Assign → Clip A (Player A)
                </button>
                <button className="btn btn--b" onClick={() => { setClipScoreB(clipScore); setVerdict(null); emit(`Clip B assigned (total ${clipScore.total} of 40)`) }}>
                  Assign → Clip B (Player B)
                </button>
              </div>
              {RUBRIC.map(({ key, label, gloss }) => (
                <div key={key} className="card">
                  <div>
                    <span className="card__title">{label}</span>{' '}
                    <span className="card__gloss">[{gloss}]</span>{' '}
                    <span className="card__val">— {clipScore.scores[key].score} of 10</span>
                    {key === 'placement' && clipScore.scores[key].zone && (
                      <span className="zone">
                        {' '}· zone: {ZONE_LABELS[clipScore.scores[key].zone] ?? clipScore.scores[key].zone}
                      </span>
                    )}
                  </div>
                  <div className="card__why">
                    Why: {clipScore.scores[key].explanation}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel__head"><span className="panel__title">Head-to-head verdict [decides the match]</span></div>
          <p className="hint">
            Both clips judged side by side in one on-device call — who shot from further out,
            whose shot flew faster, who struck it cleaner — plus placement from each clip's goal zone
          </p>
          <div className="bar" style={{ marginTop: 0 }}>
            <button className="btn btn--primary" onClick={handleCompare} disabled={!clipScoreA || !clipScoreB || comparing}>
              {comparing ? 'Judging head-to-head…' : 'Run head-to-head'}
            </button>
          </div>

          {verdict && (
            <div style={{ marginTop: 14 }}>
              <div className={`verdict ${verdict.winner === 'tie' ? 'verdict--tie' : verdict.winner === 'B' ? 'verdict--b' : ''}`}>
                <div className="verdict__head">
                  {verdict.winner === 'tie' ? 'DEAD EVEN' : `PLAYER ${verdict.winner} WINS`}
                  {verdict.winner !== 'tie' && (
                    <span className="verdict__meta">
                      {' '}· {verdict.points.a}–{verdict.points.b} on the four measures
                      {verdict.tiebreak ? ` · settled by ${verdict.tiebreak === 'spectacle' ? 'the better finish' : 'the scorecards'}` : ''}
                      {verdict.mock ? ' · MOCK' : ''}
                    </span>
                  )}
                </div>
                <p className="verdict__summary">
                  {verdict.summary}
                </p>
              </div>

              {VERDICT_DIMENSIONS.map(({ key, label, gloss }) => (
                <div key={key} className="card">
                  <div>
                    <span className="card__title">{label}</span>{' '}
                    <span className="card__gloss">[{gloss}]</span>:{' '}
                    <span className={`card__val ${verdict.dimensions[key].winner === 'equal' ? 'even' : verdict.dimensions[key].winner === 'A' ? 'side-a' : 'side-b'}`}>
                      {verdict.dimensions[key].winner === 'equal' ? 'even' : `Player ${verdict.dimensions[key].winner}`}
                    </span>
                  </div>
                  <div className="card__why">
                    Why: {verdict.dimensions[key].reason}
                  </div>
                </div>
              ))}
              <div className="card">
                <div>
                  <span className="card__title">Spectacle</span>{' '}
                  <span className="card__gloss">[tiebreaker only]</span>:{' '}
                  <span className={`card__val ${verdict.spectacle.pick === 'equal' ? 'even' : verdict.spectacle.pick === 'A' ? 'side-a' : 'side-b'}`}>
                    {verdict.spectacle.pick === 'equal' ? 'even' : `Player ${verdict.spectacle.pick}`}
                  </span>
                </div>
                <div className="card__why">
                  Why: {verdict.spectacle.reason}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel__head"><span className="panel__title">Match settlement</span></div>
          <div className="kv"><span className="kv__k">Clip A</span><span className="kv__v side-a">{clipScoreA ? `scored (${clipScoreA.total} of 40)` : 'not assigned'}</span></div>
          <div className="kv"><span className="kv__k">Clip B</span><span className="kv__v side-b">{clipScoreB ? `scored (${clipScoreB.total} of 40)` : 'not assigned'}</span></div>
          <div className="kv"><span className="kv__k">Verdict</span><span className="kv__v">{verdict ? (verdict.winner === 'tie' ? 'dead even' : `Player ${verdict.winner}`) : 'not run yet'}</span></div>
          <div className="bar">
            {/* Settlement pays out the head-to-head verdict, so it requires one. */}
            <button
              className="btn btn--primary"
              onClick={handleSettle}
              disabled={!escrowId || !clipScoreA || !clipScoreB || !verdict || settled}
            >
              Settle match
            </button>
          </div>
          {settleResult && (
            <details className="raw" open>
              <summary>Raw settlement result</summary>
              <pre className="json">{JSON.stringify(settleResult, null, 2)}</pre>
            </details>
          )}
        </section>

        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">Log</span>
            <span className="pill">local session</span>
          </div>
          <div className="log">
            {log.map((entry, i) => <div key={i}>{entry}</div>)}
          </div>
        </section>
        </>)}

        {tab === 'predict' && (
          <PredictTab address={address} modelInfo={modelInfo} />
        )}
      </div>
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

  // Which wager side this picker dresses as — purely visual, derived from the
  // label so the component's props stay exactly as they were.
  const side = label.toLowerCase().includes('person a') ? 'a' : 'b'

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
      <div className="picker">
        <span className={`field__label ${side === 'a' ? 'side-a' : 'side-b'}`}>{label}</span>
        <div className={`picker__chip picker__chip--${side}`}>
          <span className="picker__name">{selected.name}</span>
          <span className="picker__team">· {selected.team}</span>
          <span className="picker__goals">{selected.goals} goal{selected.goals !== 1 ? 's' : ''}</span>
          {!disabled && (
            <button className="btn btn--sm btn--ghost picker__change" onClick={() => onSelect(null)}>
              Change
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="picker">
      <span className={`field__label ${side === 'a' ? 'side-a' : 'side-b'}`}>{label}</span>
      <input
        type="text"
        className="input"
        placeholder="Search by player name or team…"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        disabled={disabled}
      />
      {open && filtered.length > 0 && (
        <div className="dd">
          {filtered.slice(0, 50).map((p) => (
            <div
              key={`${p.name}|${p.team}`}
              className="dd__item"
              onClick={() => { onSelect(p); setSearch(''); setOpen(false) }}
            >
              <b>{p.name}</b>
              <span className="dd__team"> · {p.team}</span>
              <span className="dd__goals">{p.goals} goal{p.goals !== 1 ? 's' : ''}</span>
            </div>
          ))}
        </div>
      )}
      {open && filtered.length === 0 && search && (
        <div className="dd dd__empty">
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
    <div className="odds">
      <div className="odds__label">
        Pre-match odds based on tournament stats — not a guarantee, does not affect payout
      </div>
      <div className="odds__meterrow">
        <span className="odds__pct odds__pct--a">{pctA}%</span>
        <div className="odds__meter">
          <div className="odds__fill-a" style={{ width: `${pctA}%` }} />
          <div className="odds__fill-b" style={{ width: `${pctB}%` }} />
        </div>
        <span className="odds__pct odds__pct--b">{pctB}%</span>
      </div>
      <div className="odds__ends">
        <span className="side-a">{playerA.player} · {playerA.goals} goals</span>
        <span className="side-b">{playerB.player} · {playerB.goals} goals</span>
      </div>
      <div className="odds__note">{note}</div>
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
      <section className="panel">
        <div className="panel__head"><span className="panel__title">Pick your players</span></div>
        <p className="hint">
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
      <section className="panel">
        <div className="panel__head"><span className="panel__title">Stake and wallets</span></div>
        <label className="field">
          <span className="field__label side-a">Person A wallet address</span>
          <input
            type="text" placeholder="0x…" value={addrA}
            onChange={(e) => setAddrA(e.target.value.trim())}
            disabled={!!activeBet}
            className={`input ${addrA && !isValidAddress(addrA) ? 'input--err' : ''}`}
          />
        </label>
        <label className="field">
          <span className="field__label side-b">Person B wallet address</span>
          <input
            type="text" placeholder="0x…" value={addrB}
            onChange={(e) => setAddrB(e.target.value.trim())}
            disabled={!!activeBet}
            className={`input ${addrB && !isValidAddress(addrB) ? 'input--err' : ''}`}
          />
        </label>
        <label className="field">
          <span className="field__label">Stake per person (USDt)</span>
          <input
            type="number" min="1" step="any" value={stake}
            onChange={(e) => setStake(e.target.value)}
            disabled={!!activeBet}
            className="input input--short"
          />
        </label>
        {stake && parseFloat(stake) > 0 && (
          <p className="micro" style={{ margin: '2px 0 0' }}>
            Total pot: {(parseFloat(stake) * 2).toFixed(2)} USDt ({stake} per person)
          </p>
        )}
        <div className="bar">
          <button
            className="btn btn--primary"
            onClick={handleCreateBet}
            disabled={!!activeBet || !pickA || !pickB || !isValidAddress(addrA) || !isValidAddress(addrB) || creating}
          >
            {creating ? 'Creating…' : 'Create bet'}
          </button>
          {activeBet && (
            <button
              className="btn btn--ghost"
              onClick={() => { setActiveBet(null); setSettleResult(null); setPClipScore(null); setPVideoPath(null) }}
            >
              New bet
            </button>
          )}
        </div>
      </section>

      {/* --- Saved bets list --- */}
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Saved bets</span>
          {betList.length > 0 && (
            <button
              className={`btn btn--sm ${betDeleteMode ? 'btn--warn' : 'btn--ghost'}`}
              onClick={() => { setBetDeleteMode((p) => !p); setBetDeleteSelected(new Set()) }}
            >
              {betDeleteMode ? 'Cancel' : 'Delete'}
            </button>
          )}
        </div>

        {betDeleteMode && (
          <div className="bar" style={{ marginTop: 0, marginBottom: 8 }}>
            <button
              className="btn btn--sm btn--danger"
              onClick={handleDeleteBets}
              disabled={betDeleteSelected.size === 0}
            >
              Delete {betDeleteSelected.size > 0 ? `(${betDeleteSelected.size})` : ''}
            </button>
          </div>
        )}

        {betList.length === 0 ? (
          <p className="micro" style={{ margin: 0 }}>(no bets yet)</p>
        ) : (
          <div className="stack" style={{ marginTop: 0 }}>
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
                  className={`row ${isChecked ? 'row--checked' : isLoaded ? 'row--loaded' : ''}`}
                >
                  {betDeleteMode && (
                    <div className={`checkbox ${isChecked ? 'checkbox--on' : ''}`}>
                      {isChecked && <span className="checkbox__tick">✓</span>}
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <strong>{bet.id.slice(0, 8)}…</strong>
                      <span className="side-a">{bet.playerAChoice?.name}</span>
                      <span style={{ color: 'var(--txt3)' }}>vs</span>
                      <span className="side-b">{bet.playerBChoice?.name}</span>
                      <span className={statusPillClass(bet.status)}>{bet.status}</span>
                    </div>
                    <div className="row__meta">
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
        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">Active bet</span>
            <button className="btn btn--sm btn--ghost" onClick={handleRefreshBet}>
              Refresh
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10, fontFamily: 'var(--mono)', fontSize: 13 }}>
            <span className="side-a" style={{ fontWeight: 700 }}>{activeBet.playerAChoice?.name}</span>
            <span className="micro">({activeBet.playerAChoice?.team})</span>
            <span className="micro">vs</span>
            <span className="side-b" style={{ fontWeight: 700 }}>{activeBet.playerBChoice?.name}</span>
            <span className="micro">({activeBet.playerBChoice?.team})</span>
            <span className={statusPillClass(activeBet.status)}>{activeBet.status}</span>
          </div>

          <div className="kv"><span className="kv__k">Escrow balance</span><span className="kv__v">{activeBet.escrowBalance ?? '(refresh to check)'} USDt</span></div>
          <div className="kv"><span className="kv__k">Stake</span><span className="kv__v">{activeBet.stakeAmount} USDt per side · total pot {activeBet.stakeAmount * 2} USDt</span></div>
          <div className="kv"><span className="kv__k">Match wallet</span><span className="kv__v">{activeBet.matchWalletAddress}</span></div>
          {activeBet.txHash && (
            <div className="kv"><span className="kv__k">Payout tx</span><span className="kv__v">
              <a
                className="hashlink"
                href={`https://sepolia.etherscan.io/tx/${activeBet.txHash}`}
                target="_blank" rel="noopener noreferrer"
              >
                {activeBet.txHash}
              </a>
            </span></div>
          )}

          {activeBet.odds && !betSettled && !betUnresolved && (
            <OddsBar oddsResult={activeBet.odds} />
          )}

          {/* --- Settled / forfeited / unresolved banner --- */}
          {betSettled && (
            <div className={`receipt ${activeBet.status === 'forfeited' ? 'receipt--warn' : ''}`}>
              <div className="receipt__status">
                <span className="dot dot--pulse" />
                {activeBet.status === 'forfeited'
                  ? `Forfeited — person ${activeBet.winner} wins`
                  : `Settled — person ${activeBet.winner} wins`}
              </div>
              <hr className="receipt__divider" />
              <div className="kv"><span className="kv__k">Winner</span><span className="kv__v">
                {activeBet.winner === 'A' ? activeBet.playerAChoice?.name : activeBet.playerBChoice?.name}
              </span></div>
              {activeBet.txHash && (
                <>
                  <div className="kv"><span className="kv__k">Payout tx</span><span className="kv__v">
                    <a
                      className="hashlink"
                      href={`https://sepolia.etherscan.io/tx/${activeBet.txHash}`}
                      target="_blank" rel="noopener noreferrer"
                    >
                      {activeBet.txHash}
                    </a>
                  </span></div>
                  <a
                    className="receipt__link"
                    href={`https://sepolia.etherscan.io/tx/${activeBet.txHash}`}
                    target="_blank" rel="noopener noreferrer"
                  >
                    View on Sepolia Etherscan ↗
                  </a>
                </>
              )}
            </div>
          )}

          {betUnresolved && (
            <div className="receipt receipt--bad">
              <div className="receipt__status"><span className="dot" /> Unresolved</div>
              <hr className="receipt__divider" />
              <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--txt2)' }}>
                No refund path exists. This bet cannot be settled with the current clips.
              </div>
            </div>
          )}

          {/* --- Clip submission --- */}
          {!betSettled && !betUnresolved && (
            <div style={{ marginTop: 16 }}>
              <div className="panel__title">Submit goal clips</div>
              <p className="hint" style={{ margin: '4px 0 12px' }}>
                Each side submits a real goal clip for their chosen player. Same scoring pipeline as Judge mode.
              </p>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {/* Side A clip */}
                <div className={`clipcard ${activeBet.clipA ? 'clipcard--a' : ''}`}>
                  <div className="clipcard__who side-a">
                    Person A — {activeBet.playerAChoice?.name}
                  </div>
                  {activeBet.clipA ? (
                    <div className="clipcard__body">
                      ✓ Clip submitted · Total: <b>{activeBet.clipA.total}/40</b>
                    </div>
                  ) : (
                    <div className="clipcard__body">No clip submitted yet</div>
                  )}
                </div>

                {/* Side B clip */}
                <div className={`clipcard ${activeBet.clipB ? 'clipcard--b' : ''}`}>
                  <div className="clipcard__who side-b">
                    Person B — {activeBet.playerBChoice?.name}
                  </div>
                  {activeBet.clipB ? (
                    <div className="clipcard__body">
                      ✓ Clip submitted · Total: <b>{activeBet.clipB.total}/40</b>
                    </div>
                  ) : (
                    <div className="clipcard__body">No clip submitted yet</div>
                  )}
                </div>
              </div>

              {/* Clip picker and scorer */}
              <div className="card" style={{ marginTop: 12 }}>
                <div className="micro" style={{ marginBottom: 8 }}>
                  Pick and score a goal clip, then assign it to a side
                </div>
                <div className="bar" style={{ marginTop: 0 }}>
                  <button className="btn" onClick={handlePickClip} disabled={pScoring}>Pick video file</button>
                  <button className="btn btn--primary" onClick={handleScoreClip} disabled={!pVideoPath || pScoring}>
                    {pScoring ? (pPreparingModel ? 'Preparing model…' : 'Scoring…') : 'Score clip'}
                  </button>
                  {pVideoPath && (
                    <span className="filename">
                      {pVideoPath.split(/[\\/]/).pop()}
                    </span>
                  )}
                </div>
                {pClipScore && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                      <span className="score-big">{pClipScore.total} <small>/ 40</small></span>
                      <span className="micro">{pClipScore.frameCount} frames</span>
                      {pClipScore.mock && <span className="pill pill--warn">mock</span>}
                    </div>
                    <div className="bar" style={{ marginTop: 0 }}>
                      <button
                        className="btn btn--a"
                        onClick={() => handleSubmitClip('A')}
                        disabled={!!activeBet.clipA}
                      >
                        Submit for {activeBet.playerAChoice?.name} (A)
                      </button>
                      <button
                        className="btn btn--b"
                        onClick={() => handleSubmitClip('B')}
                        disabled={!!activeBet.clipB}
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
              <div className="panel__title">Settle</div>
              <div className="bar">
                {bothClips && (
                  <button className="btn btn--primary" onClick={handleSettle} disabled={settling}>
                    {settling ? 'Settling…' : 'Settle bet — compare clips'}
                  </button>
                )}
                {oneClip && (
                  <button className="btn btn--warn" onClick={handleForfeit} disabled={settling}>
                    {settling ? 'Processing…' : 'Forfeit — one side has no clip'}
                  </button>
                )}
                {noClips && (
                  <button className="btn btn--danger" onClick={handleMarkUnresolved} disabled={settling}>
                    Mark unresolved — neither player scored
                  </button>
                )}
              </div>
              <p className="micro" style={{ margin: '8px 0 0' }}>
                {bothClips && 'Both clips are in. Settling runs them through the same AI comparison Judge mode uses.'}
                {oneClip && 'Only one side submitted a clip. Forfeiting releases the full pot to that side, no comparison needed.'}
                {noClips && 'Neither side submitted a clip. No refund path exists — the bet will be marked as unresolved.'}
              </p>
            </div>
          )}

          {/* --- Settlement result --- */}
          {settleResult && (
            <details className="raw" open>
              <summary>Raw settlement result</summary>
              <pre className="json">{JSON.stringify(settleResult, null, 2)}</pre>
            </details>
          )}
        </section>
      )}

      {/* --- Log --- */}
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Log</span>
          <span className="pill">local session</span>
        </div>
        <div className="log">
          {pLog.map((entry, i) => <div key={i}>{entry}</div>)}
        </div>
      </section>
    </div>
  )
}
