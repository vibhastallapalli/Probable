'use strict'

// Pure placement-evidence policy. This module deliberately knows nothing
// about QVAC, ffmpeg, React, or wallets, which makes every policy branch
// testable without loading the vision model.

const PLACEMENT_ISSUES = Object.freeze({
  BALL_NOT_LOCALIZED: 'BALL_NOT_LOCALIZED',
  GOAL_NOT_CONFIRMED: 'GOAL_NOT_CONFIRMED',
  SHOT_MOMENT_NOT_CAPTURED: 'SHOT_MOMENT_NOT_CAPTURED',
  PLACEMENT_DISAGREEMENT: 'PLACEMENT_DISAGREEMENT',
})

const ISSUE_COPY = Object.freeze({
  [PLACEMENT_ISSUES.BALL_NOT_LOCALIZED]: {
    observation: 'Probable could not consistently locate the ball in the analyzed moments.',
    suggestion: 'Use a clip that keeps the ball visible from the strike through the finish.',
  },
  [PLACEMENT_ISSUES.GOAL_NOT_CONFIRMED]: {
    observation: 'Probable could not confirm the full goal mouth in enough analyzed moments.',
    suggestion: 'Keep both posts and the crossbar visible throughout the finish.',
  },
  [PLACEMENT_ISSUES.SHOT_MOMENT_NOT_CAPTURED]: {
    observation: 'The analyzed moments did not consistently show the ball in or entering the goal.',
    suggestion: 'Include the complete ball path and the moment the shot reaches the goal.',
  },
  [PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT]: {
    observation: 'Usable moments produced conflicting placement estimates.',
    suggestion: 'Try a clearer, steadier clip where the ball is easy to separate from the goal.',
  },
})

const CLEAR_ROWS = ['top', 'mid', 'bottom']
const CLEAR_COLUMNS = ['left', 'center', 'right']

/**
 * Assess a collection of structured, per-frame placement observations.
 *
 * A placement is ready only when at least two distinct frames carry usable
 * evidence and a strict majority of those usable frames agree on both row
 * and column. One confident-looking model answer can therefore never settle
 * placement by itself.
 */
function assessPlacementEvidence (votes, opts = {}) {
  const minimumEvidenceVotes = Math.max(2, Number(opts.minimumEvidenceVotes) || 2)
  const safeVotes = Array.isArray(votes) ? votes.filter(Boolean) : []

  const counts = {
    checked: safeVotes.length,
    ballVisible: safeVotes.filter((v) => v.ball_visibility === 'visible').length,
    goalFull: safeVotes.filter((v) => v.goal_visibility === 'full').length,
    ballAtGoal: safeVotes.filter((v) => v.ball_goal_relation === 'in_or_entering').length,
    usable: 0,
    rowAgreement: 0,
    columnAgreement: 0,
    heightCorrected: safeVotes.filter((v) => v.heightCorrected === true).length,
  }

  const issues = []
  if (counts.ballVisible < minimumEvidenceVotes) {
    issues.push(PLACEMENT_ISSUES.BALL_NOT_LOCALIZED)
  }
  if (counts.goalFull < minimumEvidenceVotes) {
    issues.push(PLACEMENT_ISSUES.GOAL_NOT_CONFIRMED)
  }
  if (counts.ballVisible >= minimumEvidenceVotes &&
      counts.ballAtGoal < minimumEvidenceVotes) {
    issues.push(PLACEMENT_ISSUES.SHOT_MOMENT_NOT_CAPTURED)
  }

  const usable = safeVotes.filter((v) =>
    v.ball_visibility === 'visible' &&
    v.goal_visibility === 'full' &&
    v.ball_goal_relation === 'in_or_entering' &&
    CLEAR_ROWS.includes(v.row) &&
    CLEAR_COLUMNS.includes(v.column)
  )
  counts.usable = usable.length

  const rowVote = strictConsensus(usable.map((v) => v.row), CLEAR_ROWS, minimumEvidenceVotes)
  const columnVote = strictConsensus(usable.map((v) => v.column), CLEAR_COLUMNS, minimumEvidenceVotes)
  counts.rowAgreement = rowVote.count
  counts.columnAgreement = columnVote.count

  // Only call this disagreement when the basic scene evidence exists. When
  // the ball or goal itself is missing, that more direct diagnosis is the
  // honest one and a conflicting-zone message would be misleading.
  if (issues.length === 0 && (!rowVote.value || !columnVote.value)) {
    issues.push(PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT)
  }

  return {
    ready: issues.length === 0,
    row: issues.length === 0 ? rowVote.value : 'unclear',
    column: issues.length === 0 ? columnVote.value : 'unclear',
    issues,
    counts,
    requiredAgreement: Math.max(
      minimumEvidenceVotes,
      Math.floor(usable.length / 2) + 1
    ),
  }
}

// Return a unique strict-majority winner. Ties, pluralities that do not clear
// 50%, and a lone answer all remain unresolved.
function strictConsensus (values, allowed, minimumEvidenceVotes) {
  const filtered = values.filter((v) => allowed.includes(v))
  const required = Math.max(
    minimumEvidenceVotes,
    Math.floor(filtered.length / 2) + 1
  )
  const counts = new Map()
  for (const value of filtered) {
    counts.set(value, (counts.get(value) || 0) + 1)
  }

  let winner = null
  let winnerCount = 0
  let tied = false
  for (const [value, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = value
      winnerCount = count
      tied = false
    } else if (count === winnerCount) {
      tied = true
    }
  }

  return {
    value: !tied && winnerCount >= required ? winner : null,
    count: winnerCount,
    required,
  }
}

/**
 * Choose additional frames for one bounded visual recovery attempt.
 *
 * Ball/shot/disagreement failures use the closest earlier moments, where a
 * fast ball may still be visible in flight. A goal-visibility failure uses a
 * wider spread through the latter half of the clip in case the camera briefly
 * showed the full goal before panning or zooming.
 */
function selectPlacementRecoveryFrames (frames, initialFrames, issues, count = 3) {
  const all = Array.isArray(frames) ? frames : []
  const excluded = new Set(Array.isArray(initialFrames) ? initialFrames : [])
  const available = all.filter((frame) => !excluded.has(frame))
  if (available.length <= count) return available

  if (issues.includes(PLACEMENT_ISSUES.GOAL_NOT_CONFIRMED)) {
    const latterHalf = available.slice(Math.floor(available.length / 2))
    return pickEvenly(latterHalf.length >= count ? latterHalf : available, count)
  }

  return available.slice(-count)
}

function pickEvenly (items, count) {
  if (items.length <= count) return [...items]
  if (count <= 1) return [items[items.length - 1]]
  const picked = new Set()
  const span = items.length - 1
  for (let i = 0; i < count; i++) {
    picked.add(items[Math.round((i * span) / (count - 1))])
  }
  return [...picked]
}

function buildPlacementFeedback (issues, counts, metadata = {}) {
  const uniqueIssues = [...new Set(
    (Array.isArray(issues) ? issues : [])
      .filter((issue) => ISSUE_COPY[issue])
  )]
  const observations = uniqueIssues.map((issue) => {
    if (issue === PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT &&
        (Number(counts?.usable) || 0) < 2) {
      return 'The ball and goal checks did not align in enough of the same analyzed moments.'
    }
    return ISSUE_COPY[issue].observation
  })
  const suggestions = [...new Set(
    uniqueIssues.map((issue) => ISSUE_COPY[issue].suggestion)
  )]

  if (metadata.lowFps) {
    const shownFps = Number.isFinite(metadata.fps)
      ? Math.round(metadata.fps * 10) / 10
      : null
    observations.push(
      shownFps === null
        ? 'The clip frame rate may leave too little visual evidence around a fast shot.'
        : `The clip is ${shownFps} fps, which may leave less visual evidence around a fast shot.`
    )
    suggestions.push('If possible, use a clip recorded at 30 fps or higher.')
  }

  return {
    code: 'PLACEMENT_UNRESOLVED',
    title: 'Placement could not be scored',
    primaryReason: uniqueIssues[0] || PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT,
    reasons: uniqueIssues,
    observations,
    suggestions,
    evidence: {
      checked: Number(counts?.checked) || 0,
      usable: Number(counts?.usable) || 0,
    },
  }
}

module.exports = {
  PLACEMENT_ISSUES,
  assessPlacementEvidence,
  buildPlacementFeedback,
  selectPlacementRecoveryFrames,
  strictConsensus,
}
