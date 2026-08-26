import React, { useState, useEffect, useRef } from 'react'

const STAKE = 100

// Highest total a clip can score: skill + difficulty + aesthetic at 10 each,
// plus placement at 10 counted DOUBLE. Mirrors MAX_TOTAL in src/main/scoring.js
// — the renderer can't require main-process modules across the IPC boundary,
// so the two have to be changed together.
const MAX_TOTAL = 50

// The four categories of FIFA's Puskas Award rubric [the criteria FIFA uses
// to judge its own goal of the year]. Each label pairs plain English with the
// meaning in brackets, and `key` matches the fields in the score JSON.
const RUBRIC = [
  { key: 'skill', label: 'Skill', gloss: 'clean technique and ball control' },
  { key: 'difficulty', label: 'Difficulty', gloss: 'how hard the play was to pull off' },
  { key: 'aesthetic', label: 'Aesthetic', gloss: 'how spectacular it looks' },
  { key: 'placement', label: 'Placement', gloss: 'where in the goal the shot lands — counts double' },
]

// The four head-to-head dimensions the match verdict is decided on, in
// display order. Keys match the `dimensions` field of the verdict; distance,
// speed, and technique come from the side-by-side comparison call, placement
// from the two clips' zone verdicts. `points` mirrors COMPARE_DIMENSION_WEIGHTS
// in src/main/scoring.js — placement pays double because it is the hardest
// thing to actually do and the one the model reads most reliably.
const VERDICT_DIMENSIONS = [
  { key: 'distance', label: 'Distance', gloss: 'who shot from further out', points: 1 },
  { key: 'speed', label: 'Shot speed', gloss: 'whose shot flew faster', points: 1 },
  { key: 'technique', label: 'Strike', gloss: 'who caught it cleaner', points: 1 },
  { key: 'placement', label: 'Placement', gloss: 'who found the better spot', points: 2 },
]

// Plain-words labels for the 9 exact goal-mouth zones plus the three internal
// direction-neutral side zones used when a mirror check preserves off-centre
// placement but cannot verify exact left/right direction.
// Keys match the `zone` field the scorer returns; the score is derived from
// the zone in the main process, so showing both makes any mismatch obvious.
const ZONE_LABELS = {
  top_left: 'top left corner',
  top_center: 'top center',
  top_right: 'top right corner',
  top_side: 'top, toward one side (left/right unverified)',
  mid_left: 'mid-height left',
  mid_center: 'dead center',
  mid_right: 'mid-height right',
  mid_side: 'mid-height, toward one side (left/right unverified)',
  bottom_left: 'bottom left corner',
  bottom_center: 'bottom center',
  bottom_right: 'bottom right corner',
  bottom_side: 'low, toward one side (left/right unverified)',
}

// Fallback so the status badge renders even before the main process replies.
const DEFAULT_MODEL_INFO = { name: 'SmolVLM2 2.2B', id: '', runtime: 'QVAC' }

// A match is two sides, and everything about one side lives in its slot: the
// video that was dropped on it, that video's probe metadata, the scorecard
// once it has been judged, and what the slot is doing right now.
const SIDES = ['A', 'B']

function emptySlot () {
  return { path: null, probe: null, score: null, status: 'idle', error: null, issue: null, drag: false }
}

// Status pill per slot state. 'idle' deliberately has no pill — a loaded but
// unjudged clip should look calm, not pending.
const SLOT_STATUS = {
  queued: { text: 'queued', cls: 'pill' },
  preparing: { text: 'loading model', cls: 'pill' },
  scoring: { text: 'judging…', cls: 'pill pill--warn' },
  done: { text: '✓ judged', cls: 'pill pill--ok' },
  needs_better_clip: { text: 'new clip needed', cls: 'pill pill--warn' },
  failed: { text: 'failed', cls: 'pill pill--bad' },
}

function isValidAddress (val) {
  return typeof val === 'string' && /^0x[0-9a-fA-F]{40}$/.test(val)
}

// One decimal is plenty for a frame rate readout [24, 25, or 29.97 style values].
function roundFps (fps) {
  return Math.round(fps * 10) / 10
}

// Just the file name of a scored clip, so the assigned A/B slots say WHICH
// video is in them instead of only a number. Injected test scores carry no
// videoPath, hence the fallback.
function clipFileName (score) {
  const p = score?.videoPath
  if (typeof p !== 'string') return 'injected score'
  return p.split(/[\\/]/).pop()
}

// Dev/test shortcut — a faithfully shaped scoreClip() result with a fixed
// total, so the settlement flow can be driven end to end without waiting on a
// real on-device scoring run each iteration. Carries no frames (head-to-head
// can't run on it) and is flagged mock:true so nothing mistakes it for a real
// model score. The four field scores are passed in and totalled the same way
// sumScores() does in the main process — placement counted double.
function makeTestScore ({ skill, difficulty, aesthetic, placement, zone }) {
  const why = 'Injected test score — not a real model judgment.'
  return {
    scores: {
      skill: { score: skill, explanation: why },
      difficulty: { score: difficulty, explanation: why },
      aesthetic: { score: aesthetic, explanation: why },
      placement: { score: placement, explanation: why, zone },
    },
    total: skill + difficulty + aesthetic + 2 * placement,
    frameCount: 0,
    frames: [],
    duration: 0,
    model: 'test-injected',
    mock: true,
  }
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

// One evidence-based report shared by Judge and Predict mode. Clip-quality
// problems use the amber treatment; a worker/model failure uses red so the
// user is never told to replace a perfectly valid clip because the system
// itself failed.
function ClipIssue ({ issue }) {
  if (!issue) return null
  const technical = issue.code === 'ANALYSIS_ERROR'
  return (
    <div className={`clip-issue${technical ? ' clip-issue--technical' : ''}`}>
      <div className="clip-issue__title">{issue.title}</div>
      {issue.observations?.map((observation) => (
        <div key={observation} className="clip-issue__text">{observation}</div>
      ))}
      {issue.evidence && (
        <div className="clip-issue__evidence">
          Evidence: {issue.evidence.usable} of {issue.evidence.checked} analyzed moments supported a usable placement.
        </div>
      )}
      {issue.suggestions?.length > 0 && (
        <div className="clip-issue__actions">
          <b>What to try:</b>
          <ul>
            {issue.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * One side's clip slot — drop a video on it, or click to browse.
 *
 * It never shows a score. That is the whole point: if the two totals are on
 * screen the head-to-head has nothing left to reveal, so the numbers stay
 * behind the "See individual results" disclosure below the slots.
 */
function ClipSlot ({ side, slot, busy, onPick, onDrop, onDrag }) {
  const status = SLOT_STATUS[slot.status]
  // dragleave also fires when the cursor crosses onto a child element, which
  // would strobe the highlight — only clear it when the cursor really left.
  const dragProps = {
    onDragOver: (e) => { e.preventDefault(); if (!slot.drag) onDrag(side, true) },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) onDrag(side, false) },
    onDrop: (e) => onDrop(side, e),
  }
  const cls = `slot slot--${side.toLowerCase()}${slot.drag ? ' slot--drag' : ''}`

  if (!slot.path) {
    return (
      <button type="button" className={`${cls} slot--empty`} onClick={() => onPick(side)} disabled={busy} {...dragProps}>
        <span className="slot__side">Player {side}</span>
        <span className="slot__drop">
          <span className="slot__icon">↧</span>
          drop a goal clip here
          <small>or click to browse</small>
        </span>
      </button>
    )
  }

  return (
    <div className={cls} {...dragProps}>
      <div className="slot__top">
        <span className="slot__side">Player {side}</span>
        {status && <span className={status.cls}>{status.text}</span>}
      </div>
      <div className="slot__file" title={slot.path}>{slot.path.split(/[\\/]/).pop()}</div>
      <div className="slot__meta">
        {[
          slot.probe && `${roundFps(slot.probe.fps)} fps · ${slot.probe.duration.toFixed(1)}s`,
          slot.score?.frameCount > 0 && `${slot.score.frameCount} frames judged`,
          !slot.probe && !slot.score && 'reading clip…',
        ].filter(Boolean).join(' · ')}
      </div>
      {slot.probe?.lowFps && (
        <div className="warn-note">⚠ under {slot.probe.minFps} fps — judging may be less reliable</div>
      )}
      {slot.issue && <ClipIssue issue={slot.issue} />}
      {slot.error && <div className="slot__err">{slot.error}</div>}
      <button className="btn btn--ghost btn--sm" onClick={() => onPick(side)} disabled={busy}>Replace clip</button>
    </div>
  )
}

/**
 * One clip's full Puskas scorecard. Only ever rendered inside the collapsed
 * disclosure, so the totals stay out of sight until someone asks for them.
 */
function Scorecard ({ side, score }) {
  if (!score) {
    return (
      <div className="sheet">
        <div className="sheet__head"><span>Player {side}</span></div>
        <div className="micro">not judged yet</div>
      </div>
    )
  }
  return (
    <div className={`sheet sheet--${side.toLowerCase()}`}>
      <div className="sheet__head">
        <span>Player {side}</span>
        <span className="score-big">{score.total} <small>/ {MAX_TOTAL}</small></span>
      </div>
      <div className="sheet__file">{clipFileName(score)}{score.mock ? ' · mock' : ''}</div>
      {RUBRIC.map(({ key, label, gloss }) => (
        <div key={key} className="card">
          <div>
            <span className="card__title">{label}</span>{' '}
            <span className="card__gloss">[{gloss}]</span>{' '}
            <span className="card__val">— {score.scores[key].score} of 10</span>
            {key === 'placement' && score.scores[key].zone && (
              <span className="zone">
                {' '}· zone: {ZONE_LABELS[score.scores[key].zone] ?? score.scores[key].zone}
                {score.scores[key].evidenceStatus === 'RECOVERED' ? ' · recovered after retry' : ''}
              </span>
            )}
          </div>
          <div className="card__why">Why: {score.scores[key].explanation}</div>
        </div>
      ))}
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

  const [modelInfo, setModelInfo] = useState(DEFAULT_MODEL_INFO)
  // The whole match, in two objects. Held in memory only — reloading the app
  // clears both slots and you start the match over.
  const [slots, setSlots] = useState({ A: emptySlot(), B: emptySlot() })
  const [scoring, setScoring] = useState(false)
  const [verdict, setVerdict] = useState(null)
  const [comparing, setComparing] = useState(false)
  // On by default: judging the two clips against each other is the more
  // reliable call — the model separates two shots it can see side by side far
  // better than it assigns absolute ratings to each one alone. Untick to fall
  // back to paying out on the higher solo scorecard total.
  const [useHeadToHead, setUseHeadToHead] = useState(true)
  const [settleResult, setSettleResult] = useState(null)

  // The rest of the app talks in scorecards, not slots.
  const clipScoreA = slots.A.score
  const clipScoreB = slots.B.score
  // Sides holding a clip that still needs judging, in A-then-B order.
  const pending = SIDES.filter((s) => slots[s].path && !slots[s].score)

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

  function patchSlot (side, patch) {
    setSlots((prev) => ({ ...prev, [side]: { ...prev[side], ...patch } }))
  }

  // Load a video into one side's slot, from the file dialog or from a drop.
  // Any verdict on screen is stale the instant a clip changes.
  async function handlePickFor (side, droppedPath) {
    try {
      const picked = droppedPath || await window.probable.clip.pickVideo()
      if (!picked) return
      patchSlot(side, { ...emptySlot(), path: picked })
      setVerdict(null)
      emit(`Clip ${side}: ${picked.split(/[\\/]/).pop()}`)
      try {
        patchSlot(side, { probe: await window.probable.clip.probe(picked) })
      } catch { /* the probe is advisory only, it never blocks judging */ }
    } catch (err) {
      emit(`Pick failed: ${err.message}`)
    }
  }

  function handleDropOn (side, e) {
    e.preventDefault()
    patchSlot(side, { drag: false })
    if (scoring) return
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    const dropped = window.probable.clip.pathForFile(file)
    if (dropped) handlePickFor(side, dropped)
    else emit('Could not read the dropped file’s path — use the browse dialog instead')
  }

  // Judge whichever slots still need it. The clips run back to back, not at
  // the same time: there is one local model worker holding one context, and
  // two scoreClip calls in flight would interleave their passes through it.
  async function handleScoreClips () {
    if (scoring || pending.length === 0) return
    const todo = [...pending]
    setScoring(true)
    setVerdict(null)
    todo.forEach((s) => patchSlot(s, { status: 'queued', error: null, issue: null }))
    try {
      // One-time model download / warm-up first, so judging never races the
      // worker init timeout on first run. A no-op once the model is loaded.
      patchSlot(todo[0], { status: 'preparing' })
      emit('Preparing on-device model… first run downloads the weights, this can take a few minutes')
      const prep = await window.probable.clip.prepareModel()
      if (!prep.alreadyLoaded && !prep.mock) emit(`Model ready: ${prep.model}`)
      // The badge rendered before the load; re-read which model actually
      // loaded (2.2B, or the 500M fallback when the big download fails).
      window.probable.scoring.modelInfo()
        .then((info) => { if (info) setModelInfo(info) })
        .catch(() => { /* badge keeps its last known value */ })

      for (const side of todo) {
        patchSlot(side, { status: 'scoring', error: null, issue: null })
        emit(`Judging clip ${side} on this device via QVAC…`)
        try {
          const result = await window.probable.clip.score(slots[side].path)
          if (result.status === 'NEEDS_BETTER_CLIP') {
            patchSlot(side, {
              score: null,
              status: 'needs_better_clip',
              issue: result.issue,
              error: null,
            })
            emit(`Clip ${side}: ${result.issue.title} — ${result.issue.observations.join(' ')}`)
            continue
          }

          patchSlot(side, { score: result, status: 'done', issue: null, error: null })
          if (result.placementReport?.status === 'RECOVERED') {
            emit(`Clip ${side}: placement recovered using additional nearby moments`)
          }
          if (result.placementReport?.directionNeutral) {
            emit(`Clip ${side}: mirror preserved row and off-centre placement; exact left/right was not used`)
          }
          if (result.placementReport?.heightCorrected) {
            emit(`Clip ${side}: ground-reference check corrected the placement height to low`)
          }
          // No total in the log on purpose — the Log panel is on screen, and
          // leaking the two numbers there defeats the hidden scorecards.
          emit(`Clip ${side} judged from ${result.frameCount} frames${result.mock ? ' (mock)' : ''}`)
        } catch (err) {
          // One clip failing must not abandon the other.
          patchSlot(side, {
            score: null,
            status: 'failed',
            issue: null,
            error: `Analysis could not finish: ${err.message}. Retry the analysis; if it repeats, restart the on-device model.`,
          })
          emit(`Clip ${side} failed: ${err.message}`)
        }
      }
    } catch (err) {
      emit(`Model prepare failed: ${err.message}`)
      todo.forEach((s) => patchSlot(s, {
        status: 'failed',
        issue: null,
        error: `Model preparation failed: ${err.message}`,
      }))
    } finally {
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
      // Head-to-head mode pays out the verdict already shown to the players
      // (never re-running the model); raw-score mode skips the verdict entirely
      // and dumps the escrow to whichever clip scored the higher total.
      const result = await window.probable.match.settle(
        escrowId, clipScoreA, clipScoreB, playerA, playerB,
        useHeadToHead ? verdict : null,
        { useHeadToHead }
      )
      setSettleResult(result)
      if (result.outcome === 'unfunded') {
        emit(`Settle: unfunded, match wallet balance is ${result.balance} USDT`)
      } else if (result.outcome === 'awaiting_clearer_clip') {
        emit('Settle: blocked because at least one clip still needs resolved placement evidence')
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

  // Dev/test shortcut: skip the slow on-device scoring passes and drop in two
  // ready-made scorecards so the escrow → settle flow can be exercised in one
  // click. Forces raw-score mode off head-to-head, since injected clips carry
  // no frames to judge side by side; raw scores pay out to the higher total,
  // so Player A wins on the extra skill point.
  function handleInjectTestScores () {
    const a = makeTestScore({ skill: 8, difficulty: 7, aesthetic: 7, placement: 6, zone: 'bottom_left' })
    const b = makeTestScore({ skill: 7, difficulty: 7, aesthetic: 7, placement: 6, zone: 'bottom_right' })
    // Give the slots a path so they render as filled — these carry no real
    // video, hence no probe metadata and no frames to judge head to head.
    setSlots({
      A: { ...emptySlot(), path: 'injected test score', score: a, status: 'done' },
      B: { ...emptySlot(), path: 'injected test score', score: b, status: 'done' },
    })
    setVerdict(null)
    setUseHeadToHead(false)
    emit(`Test scores injected — Clip A ${a.total} of ${MAX_TOTAL}, Clip B ${b.total} of ${MAX_TOTAL} (mock, raw-score mode)`)
  }

  // Terminal state once the payout has gone out; disables further release/settle.
  // Accepts the legacy 'released' status so older records stay locked too.
  const settled = escrowRecord?.status === 'settled' || escrowRecord?.status === 'released'

  // Raw-score winner preview for the settlement panel — who the higher total
  // pays out to when head-to-head is off. Mirrors compareClips in the main process.
  const rawWinner = clipScoreA && clipScoreB
    ? (clipScoreA.total > clipScoreB.total ? 'A' : clipScoreB.total > clipScoreA.total ? 'B' : 'tie')
    : null

  return (
    <div className="app">
      <StatusBadge modelInfo={modelInfo} mockMode={clipScoreA?.mock === true || clipScoreB?.mock === true} />
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
          <div className="panel__head">
            <span className="panel__title">Match clips</span>
            <span className="micro">judged on this device via QVAC</span>
          </div>
          <p className="hint">
            Drop a goal clip on each side, or click a slot to browse. Both are judged on the four
            FIFA Puskas Award criteria [the rubric FIFA uses for its own goal of the year].
            The scorecards stay hidden until you ask for them, so the head-to-head is the reveal.
          </p>

          <div className="slots">
            {SIDES.map((side) => (
              <ClipSlot
                key={side}
                side={side}
                slot={slots[side]}
                busy={scoring}
                onPick={handlePickFor}
                onDrop={handleDropOn}
                onDrag={(s, on) => patchSlot(s, { drag: on })}
              />
            ))}
          </div>

          <div className="bar">
            <button className="btn btn--primary" onClick={handleScoreClips} disabled={scoring || pending.length === 0}>
              {scoring
                ? 'Judging…'
                : pending.length === 1 ? `Judge clip ${pending[0]}`
                : clipScoreA && clipScoreB ? 'Both clips judged'
                : 'Judge both clips'}
            </button>
            <span className="micro">
              {scoring
                ? 'One local worker, so the clips run back to back'
                : pending.length === 0 && clipScoreA && clipScoreB
                  ? 'Run the head-to-head below'
                  : !slots.A.path || !slots.B.path ? 'Load a clip on both sides' : ''}
            </span>
          </div>

          {/* Native <details>: the numbers exist, they are just not the point
              until the verdict is in. */}
          {(clipScoreA || clipScoreB) && (
            <details className="reveal">
              <summary>See individual results</summary>
              <div className="reveal__grid">
                {SIDES.map((side) => <Scorecard key={side} side={side} score={slots[side].score} />)}
              </div>
            </details>
          )}
        </section>

        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">Head-to-head verdict</span>
            <label className="toggle">
              <input
                type="checkbox"
                checked={useHeadToHead}
                onChange={(e) => setUseHeadToHead(e.target.checked)}
              />
              <span>Decide the match head-to-head</span>
            </label>
          </div>
          <p className="hint">
            {useHeadToHead
              ? 'Both clips judged side by side in one on-device call — who shot from further out, whose shot flew faster, who struck it cleaner — plus placement from each clip’s goal zone. Placement is worth 2 points, the rest 1 each, 5 on the table. The match settles on this verdict.'
              : 'Off — the match pays out to whichever clip scored the higher total on its own. Tick the box to judge the two clips against each other instead, which is the more reliable call.'}
          </p>

          {useHeadToHead && (<>
          <div className="bar" style={{ marginTop: 0 }}>
            <button className="btn btn--primary" onClick={handleCompare} disabled={!clipScoreA || !clipScoreB || comparing}>
              {comparing ? 'Judging head-to-head…' : verdict ? 'Re-run head-to-head' : 'Run head-to-head'}
            </button>
            {!(clipScoreA && clipScoreB) && (
              <span className="micro">Judge {!clipScoreA && !clipScoreB ? 'both clips' : !clipScoreA ? 'clip A' : 'clip B'} above first</span>
            )}
          </div>

          {verdict && (
            <div style={{ marginTop: 14 }}>
              <div className={`verdict ${verdict.winner === 'tie' ? 'verdict--tie' : verdict.winner === 'B' ? 'verdict--b' : ''}`}>
                <div className="verdict__head">
                  {verdict.winner === 'tie' ? 'DEAD EVEN' : `PLAYER ${verdict.winner} WINS`}
                  {verdict.winner !== 'tie' && (
                    <span className="verdict__meta">
                      {' '}· {verdict.points.a}–{verdict.points.b} of {verdict.maxPoints ?? 5} points
                      {verdict.tiebreak ? ' · settled by the scorecards' : ''}
                      {verdict.mock ? ' · MOCK' : ''}
                    </span>
                  )}
                </div>
                <p className="verdict__summary">
                  {verdict.summary}
                </p>
              </div>

              {VERDICT_DIMENSIONS.map(({ key, label, gloss, points }) => (
                <div key={key} className="card">
                  <div>
                    <span className="card__title">{label}</span>{' '}
                    <span className="card__gloss">[{gloss} · worth {points}]</span>:{' '}
                    <span className={`card__val ${verdict.dimensions[key].winner === 'equal' ? 'even' : verdict.dimensions[key].winner === 'A' ? 'side-a' : 'side-b'}`}>
                      {verdict.dimensions[key].winner === 'equal' ? 'even' : `Player ${verdict.dimensions[key].winner} +${points}`}
                    </span>
                  </div>
                  <div className="card__why">
                    Why: {verdict.dimensions[key].reason}
                  </div>
                </div>
              ))}
            </div>
          )}
          </>)}
        </section>

        <section className="panel">
          <div className="panel__head"><span className="panel__title">Match settlement</span></div>
          {/* Totals withheld here too — raw-score mode shows them on the
              "Deciding by" row below, because that mode IS the totals. */}
          <div className="kv"><span className="kv__k">Clip A</span><span className="kv__v side-a">{clipScoreA ? `${clipFileName(clipScoreA)} · judged` : 'not loaded'}</span></div>
          <div className="kv"><span className="kv__k">Clip B</span><span className="kv__v side-b">{clipScoreB ? `${clipFileName(clipScoreB)} · judged` : 'not loaded'}</span></div>
          <div className="kv"><span className="kv__k">Deciding by</span><span className="kv__v">
            {useHeadToHead
              ? (verdict
                  ? `head-to-head · ${verdict.winner === 'tie' ? 'dead even' : `Player ${verdict.winner}`}`
                  : 'head-to-head · run it first')
              : (rawWinner
                  ? `raw scores · ${rawWinner === 'tie' ? 'dead even' : `Player ${rawWinner}`} (${clipScoreA.total} vs ${clipScoreB.total})`
                  : 'raw scores · judge both clips')}
          </span></div>
          <div className="bar">
            {/* Head-to-head mode pays out the verdict, so it needs one first;
                raw-score mode settles on the higher total with no verdict. */}
            <button
              className="btn btn--primary"
              onClick={handleSettle}
              disabled={!escrowId || !clipScoreA || !clipScoreB || (useHeadToHead && !verdict) || settled}
            >
              Settle match
            </button>
            {/* Dev shortcut: fill both slots with fixed test scores so the
                settle path can be driven without a real scoring run. */}
            <button
              className="btn btn--ghost"
              onClick={handleInjectTestScores}
              disabled={settled}
              title="Skip judging: inject Clip A 34 / Clip B 33 and settle on raw scores"
            >
              🧪 Inject test scores (A 34 · B 33)
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
  const [pClipIssue, setPClipIssue] = useState(null)

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
      setPClipIssue(null)
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
      setPClipIssue(null)
      pEmit(`Picked clip: ${picked}`)
    } catch (err) { pEmit(`Pick failed: ${err.message}`) }
  }

  async function handleScoreClip () {
    if (!pVideoPath) return
    setPScoring(true)
    setPClipIssue(null)
    try {
      setPPreparingModel(true)
      pEmit('Preparing on-device model…')
      const prep = await window.probable.clip.prepareModel()
      if (!prep.alreadyLoaded && !prep.mock) pEmit(`Model ready: ${prep.model}`)
      setPPreparingModel(false)

      pEmit('Scoring clip locally…')
      const result = await window.probable.clip.score(pVideoPath)
      if (result.status === 'NEEDS_BETTER_CLIP') {
        setPClipScore(null)
        setPClipIssue(result.issue)
        pEmit(`${result.issue.title}: ${result.issue.observations.join(' ')}`)
        return
      }
      setPClipScore(result)
      setPClipIssue(null)
      if (result.placementReport?.status === 'RECOVERED') {
        pEmit('Placement recovered using additional nearby moments')
      }
      if (result.placementReport?.directionNeutral) {
        pEmit('Mirror preserved row and off-centre placement; exact left/right was not used')
      }
      if (result.placementReport?.heightCorrected) {
        pEmit('Ground-reference check corrected the placement height to low')
      }
      pEmit(`Scored: total ${result.total} of ${MAX_TOTAL} from ${result.frameCount} frames${result.mock ? ' (mock)' : ''}`)
    } catch (err) {
      setPClipScore(null)
      setPClipIssue({
        code: 'ANALYSIS_ERROR',
        title: 'Analysis could not finish',
        observations: [
          'Probable encountered a model or processing error. This does not mean the clip itself was bad.',
        ],
        suggestions: ['Run the analysis again. If it repeats, restart the on-device model and retry.'],
        evidence: null,
      })
      pEmit(`Score failed: ${err.message}`)
    }
    finally { setPPreparingModel(false); setPScoring(false) }
  }

  async function handleSubmitClip (side) {
    if (!activeBet || !pClipScore) return
    try {
      const updated = await window.probable.predict.submitClip(activeBet.id, side, pClipScore)
      setActiveBet(updated)
      const playerName = side === 'A' ? updated.playerAChoice.name : updated.playerBChoice.name
      pEmit(`Clip submitted for ${playerName} (side ${side}) — total ${pClipScore.total}/${MAX_TOTAL}`)
      setPClipScore(null)
      setPClipIssue(null)
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
      } else if (result.outcome === 'awaiting_clearer_clip') {
        pEmit('Settle blocked: at least one submitted clip lacks resolved placement evidence')
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
                      ✓ Clip submitted · Total: <b>{activeBet.clipA.total}/{MAX_TOTAL}</b>
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
                      ✓ Clip submitted · Total: <b>{activeBet.clipB.total}/{MAX_TOTAL}</b>
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
                <ClipIssue issue={pClipIssue} />
                {pClipScore && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                      <span className="score-big">{pClipScore.total} <small>/ {MAX_TOTAL}</small></span>
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
