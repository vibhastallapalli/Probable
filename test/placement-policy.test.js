'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  PLACEMENT_ISSUES,
  assessPlacementEvidence,
  buildPlacementFeedback,
  selectPlacementRecoveryFrames,
} = require('../src/main/placement-policy')

function vote (overrides = {}) {
  return {
    ball_visibility: 'visible',
    goal_visibility: 'full',
    ball_goal_relation: 'in_or_entering',
    shot_moment: 'arrival',
    row: 'top',
    column: 'side',
    explanation: 'The ball went into the top left corner.',
    ...overrides,
  }
}

test('placement issue codes remain stable', () => {
  assert.deepEqual(PLACEMENT_ISSUES, {
    BALL_NOT_LOCALIZED: 'BALL_NOT_LOCALIZED',
    GOAL_NOT_CONFIRMED: 'GOAL_NOT_CONFIRMED',
    SHOT_MOMENT_NOT_CAPTURED: 'SHOT_MOMENT_NOT_CAPTURED',
    PLACEMENT_DISAGREEMENT: 'PLACEMENT_DISAGREEMENT',
  })
})

test('feedback attributes unverified perception without claiming objective absence', () => {
  const cases = [
    {
      issue: PLACEMENT_ISSUES.BALL_NOT_LOCALIZED,
      expected: 'Probable could not reliably locate the ball in enough analyzed moments.',
      suggestion: 'Try a clip where the ball stays large and easy to distinguish through the finish.',
      forbidden: /the ball (?:is|was|is not|was not) visible/i,
    },
    {
      issue: PLACEMENT_ISSUES.GOAL_NOT_CONFIRMED,
      expected: 'Probable could not reliably confirm the full goal mouth in enough analyzed moments.',
      suggestion: 'Keep both posts and the crossbar clearly visible through the finish.',
      forbidden: /the (?:full )?goal (?:is|was|is not|was not) visible/i,
    },
    {
      issue: PLACEMENT_ISSUES.SHOT_MOMENT_NOT_CAPTURED,
      expected: 'Probable could not reliably verify the ball reaching the goal line before it fell, bounced, or settled.',
      suggestion: "Use a steadier finish where the ball's arrival at the goal is easy to distinguish.",
      forbidden: /(?:clip|video) (?:does not|did not|doesn't|didn't) (?:include|show).*cross/i,
    },
  ]

  for (const { issue, expected, suggestion, forbidden } of cases) {
    const feedback = buildPlacementFeedback([issue], { checked: 6, usable: 0 })
    assert.deepEqual(feedback.observations, [expected])
    assert.deepEqual(feedback.suggestions, [suggestion])
    assert.doesNotMatch(
      [...feedback.observations, ...feedback.suggestions].join(' '),
      forbidden
    )
    assert.equal(feedback.attribution, 'PERCEPTION_UNVERIFIED')
    assert.equal(feedback.evidenceState, 'INSUFFICIENT_EVIDENCE')
    assert.equal(feedback.policyDecision, 'POLICY_BLOCKED')
  }
})

test('feedback attributes placement disagreement to conflicting evidence', () => {
  const feedback = buildPlacementFeedback(
    [PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT],
    { checked: 6, usable: 4 }
  )

  assert.deepEqual(feedback.observations, [
    'Probable found conflicting placement evidence across the usable moments.',
  ])
  assert.equal(feedback.attribution, 'EVIDENCE_CONFLICT')
  assert.equal(feedback.evidenceState, 'CONFLICTING_EVIDENCE')
  assert.equal(feedback.policyDecision, 'POLICY_BLOCKED')
})

test('two agreeing usable frames can settle a three-frame attempt', () => {
  const result = assessPlacementEvidence([
    vote(),
    vote(),
    vote({ row: 'mid', column: 'center' }),
  ])

  assert.equal(result.ready, true)
  assert.equal(result.row, 'top')
  assert.equal(result.column, 'side')
  assert.deepEqual(result.issues, [])
  assert.equal(result.counts.usable, 3)
  assert.equal(result.requiredAgreement, 2)
})

test('one clear-looking model answer can never settle placement by itself', () => {
  const result = assessPlacementEvidence([
    vote(),
    vote({ ball_visibility: 'unclear', row: 'unclear', column: 'unclear' }),
    vote({ ball_visibility: 'not_visible', row: 'unclear', column: 'unclear' }),
  ])

  assert.equal(result.ready, false)
  assert.deepEqual(result.issues, [PLACEMENT_ISSUES.BALL_NOT_LOCALIZED])
})

test('missing ball evidence is distinguished from a placement disagreement', () => {
  const result = assessPlacementEvidence([
    vote({ ball_visibility: 'not_visible', row: 'unclear', column: 'unclear' }),
    vote({ ball_visibility: 'unclear', row: 'unclear', column: 'unclear' }),
    vote({ ball_visibility: 'not_visible', row: 'unclear', column: 'unclear' }),
  ])

  assert.equal(result.ready, false)
  assert.deepEqual(result.issues, [
    PLACEMENT_ISSUES.BALL_NOT_LOCALIZED,
  ])
})

test('partial goal evidence produces a goal-specific failure', () => {
  const result = assessPlacementEvidence([
    vote({ goal_visibility: 'partial' }),
    vote({ goal_visibility: 'partial' }),
    vote({ goal_visibility: 'unclear' }),
  ])

  assert.equal(result.ready, false)
  assert.deepEqual(result.issues, [PLACEMENT_ISSUES.GOAL_NOT_CONFIRMED])
})

test('one full-goal observation cannot clear the goal visibility gate', () => {
  const result = assessPlacementEvidence([
    vote({ goal_visibility: 'full' }),
    vote({ goal_visibility: 'partial' }),
    vote({ goal_visibility: 'not_visible' }),
  ])

  assert.equal(result.ready, false)
  assert.equal(result.counts.goalFull, 1)
  assert.deepEqual(result.issues, [PLACEMENT_ISSUES.GOAL_NOT_CONFIRMED])
})

test('visible ball that never reaches the goal is a missing-shot-moment failure', () => {
  const result = assessPlacementEvidence([
    vote({ ball_goal_relation: 'outside', row: 'unclear', column: 'unclear' }),
    vote({ ball_goal_relation: 'unclear', row: 'unclear', column: 'unclear' }),
    vote({ ball_goal_relation: 'outside', row: 'unclear', column: 'unclear' }),
  ])

  assert.equal(result.ready, false)
  assert.deepEqual(result.issues, [PLACEMENT_ISSUES.SHOT_MOMENT_NOT_CAPTURED])
})

test('one at-goal observation cannot clear the shot-moment gate', () => {
  const result = assessPlacementEvidence([
    vote(),
    vote({ ball_goal_relation: 'outside', row: 'unclear', column: 'unclear' }),
    vote({ ball_goal_relation: 'unclear', row: 'unclear', column: 'unclear' }),
  ])

  assert.equal(result.ready, false)
  assert.equal(result.counts.ballAtGoal, 1)
  assert.deepEqual(result.issues, [PLACEMENT_ISSUES.SHOT_MOMENT_NOT_CAPTURED])
})

test('a ball that has fallen or bounced in the net is aftermath, not placement evidence', () => {
  const result = assessPlacementEvidence([
    vote({ shot_moment: 'aftermath', row: 'bottom', column: 'side' }),
    vote({ shot_moment: 'aftermath', row: 'bottom', column: 'side' }),
    vote({ shot_moment: 'arrival', row: 'top', column: 'center' }),
  ])

  assert.equal(result.ready, false)
  assert.equal(result.counts.aftermath, 2)
  assert.equal(result.counts.ballAtGoal, 1)
  assert.deepEqual(result.issues, [PLACEMENT_ISSUES.SHOT_MOMENT_NOT_CAPTURED])
})

test('usable frames without a strict majority remain a placement disagreement', () => {
  const result = assessPlacementEvidence([
    vote({ row: 'top', column: 'side' }),
    vote({ row: 'top', column: 'center' }),
    vote({ row: 'mid', column: 'side' }),
    vote({ row: 'mid', column: 'center' }),
  ])

  assert.equal(result.ready, false)
  assert.deepEqual(result.issues, [PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT])
})

test('row agreement cannot hide a two-versus-two horizontal-region tie', () => {
  const result = assessPlacementEvidence([
    vote({ column: 'side' }),
    vote({ column: 'center' }),
    vote({ column: 'side' }),
    vote({ column: 'center' }),
  ])

  assert.equal(result.ready, false)
  assert.equal(result.counts.rowAgreement, 4)
  assert.equal(result.counts.columnAgreement, 2)
  assert.deepEqual(result.issues, [PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT])
})

test('evidence fields that occur on different frames do not compose a fake zone', () => {
  const result = assessPlacementEvidence([
    vote({ goal_visibility: 'partial', row: 'unclear', column: 'unclear' }),
    vote({ ball_visibility: 'not_visible', row: 'unclear', column: 'unclear' }),
    vote({ ball_goal_relation: 'outside', row: 'unclear', column: 'unclear' }),
  ])

  assert.equal(result.ready, false)
  assert.equal(result.counts.usable, 0)
  assert.deepEqual(result.issues, [PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT])

  const feedback = buildPlacementFeedback(result.issues, result.counts)
  assert.match(feedback.observations.join(' '), /did not align/i)
})

test('simultaneous ball and goal evidence failures are both retained', () => {
  const result = assessPlacementEvidence([
    vote({ ball_visibility: 'not_visible', goal_visibility: 'partial', row: 'unclear', column: 'unclear' }),
    vote({ ball_visibility: 'unclear', goal_visibility: 'partial', row: 'unclear', column: 'unclear' }),
    vote({ ball_visibility: 'not_visible', goal_visibility: 'unclear', row: 'unclear', column: 'unclear' }),
  ])

  assert.deepEqual(result.issues, [
    PLACEMENT_ISSUES.BALL_NOT_LOCALIZED,
    PLACEMENT_ISSUES.GOAL_NOT_CONFIRMED,
  ])
})

test('a six-frame recovery needs a strict majority of the usable evidence', () => {
  const result = assessPlacementEvidence([
    vote({ row: 'top' }),
    vote({ row: 'top' }),
    vote({ row: 'top' }),
    vote({ row: 'mid' }),
    vote({ row: 'mid' }),
    vote({ row: 'bottom' }),
  ])

  assert.equal(result.ready, false)
  assert.deepEqual(result.issues, [PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT])
  assert.equal(result.requiredAgreement, 4)
})

test('ball recovery chooses the closest unused earlier frames', () => {
  const frames = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8']
  const picked = selectPlacementRecoveryFrames(
    frames,
    ['f6', 'f7', 'f8'],
    [PLACEMENT_ISSUES.BALL_NOT_LOCALIZED],
    3
  )

  assert.deepEqual(picked, ['f3', 'f4', 'f5'])
})

test('goal recovery spreads its checks across a wider late window', () => {
  const frames = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10']
  const picked = selectPlacementRecoveryFrames(
    frames,
    ['f8', 'f9', 'f10'],
    [PLACEMENT_ISSUES.GOAL_NOT_CONFIRMED],
    3
  )

  assert.deepEqual(picked, ['f4', 'f6', 'f7'])
})

test('feedback reports evidence and adds low-fps guidance without inventing a cause', () => {
  const feedback = buildPlacementFeedback(
    [PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT],
    { checked: 6, usable: 4 },
    { lowFps: true, fps: 24 }
  )

  assert.equal(feedback.code, 'PLACEMENT_UNRESOLVED')
  assert.equal(feedback.evidence.checked, 6)
  assert.equal(feedback.evidence.usable, 4)
  assert.match(feedback.observations.join(' '), /conflicting placement/i)
  assert.match(feedback.observations.join(' '), /24 fps/i)
})
