'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// scoring.js loads only these two native-binary path packages at module load.
// Point both at a harmless executable so the policy orchestration can be
// tested without downloading the application's npm dependencies.
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'ffmpeg-static') return '/bin/true'
  if (request === 'ffprobe-static') return { path: '/bin/true' }
  return originalLoad.call(this, request, parent, isMain)
}
const scoring = require('../src/main/scoring')
Module._load = originalLoad

function vote (overrides = {}) {
  return {
    ball_visibility: 'visible',
    goal_visibility: 'full',
    ball_goal_relation: 'in_or_entering',
    ball_ground_proximity: 'clear_air',
    row: 'top',
    column: 'center',
    explanation: 'The ball went in high through the middle.',
    ...overrides,
  }
}

function mockSdk (outputs) {
  let calls = 0
  return {
    sdk: {
      completion: () => {
        const output = outputs[calls++]
        return {
          final: output instanceof Error
            ? Promise.reject(output)
            : Promise.resolve({ contentText: JSON.stringify(output) }),
        }
      },
      deleteCache: async () => ({ success: true }),
    },
    calls: () => calls,
  }
}

const frames = ['f1.png', 'f2.png', 'f3.png', 'f4.png', 'f5.png', 'f6.png']

test('initial quorum produces a CLEAR placement without recovery', async () => {
  const model = mockSdk([vote(), vote(), vote({ row: 'mid' })])
  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.row, 'top')
  assert.equal(result.column, 'center')
  assert.equal(result.evidence.recovery, null)
  assert.equal(model.calls(), 3)
})

test('resolved explanation comes from a usable observation, not a later invalid guess', async () => {
  const model = mockSdk([
    vote({ explanation: 'First usable observation.' }),
    vote({ explanation: 'Second usable observation.' }),
    vote({
      ball_visibility: 'not_visible',
      explanation: 'Invalid later guess.',
    }),
  ])
  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.explanation, 'Second usable observation.')
})

test('failed initial evidence can become RECOVERED on unused frames', async () => {
  const missing = vote({
    ball_visibility: 'not_visible',
    ball_goal_relation: 'unclear',
    row: 'unclear',
    column: 'unclear',
  })
  const model = mockSdk([missing, missing, missing, vote(), vote(), vote()])
  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'RECOVERED')
  assert.equal(result.row, 'top')
  assert.equal(result.column, 'center')
  assert.equal(result.evidence.initial.ready, false)
  assert.equal(result.evidence.combined.ready, true)
  assert.equal(model.calls(), 6)
})

test('failed initial and recovery evidence remains UNRESOLVED with feedback', async () => {
  const missing = vote({
    ball_visibility: 'not_visible',
    ball_goal_relation: 'unclear',
    row: 'unclear',
    column: 'unclear',
  })
  const model = mockSdk(Array(6).fill(missing))
  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'UNRESOLVED')
  assert.equal(result.feedback.code, 'PLACEMENT_UNRESOLVED')
  assert.match(result.feedback.observations.join(' '), /locate the ball/i)
  assert.equal(model.calls(), 6)
})

test('a side placement must pass the mirrored-image check', async () => {
  const left = vote({ column: 'left' })
  const mirroredRight = vote({ column: 'right' })
  const model = mockSdk([left, left, left, mirroredRight])
  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.column, 'left')
  assert.equal(result.evidence.mirrorChecks[0].passed, true)
  assert.equal(model.calls(), 4)
})

test('Player B ground evidence corrects a contradictory mid-height label to bottom-left', async () => {
  const reportedMidLeft = vote({
    row: 'mid',
    column: 'left',
    ball_ground_proximity: 'near_ground',
    explanation: 'The ball appears waist high on the left.',
  })
  const mirroredMidRight = vote({
    row: 'mid',
    column: 'right',
    ball_ground_proximity: 'near_ground',
  })
  const model = mockSdk([
    reportedMidLeft,
    reportedMidLeft,
    reportedMidLeft,
    mirroredMidRight,
  ])

  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.row, 'bottom')
  assert.equal(result.column, 'left')
  assert.equal(result.heightCorrected, true)
  assert.equal(result.evidence.initial.counts.heightCorrected, 3)
  assert.equal(result.evidence.mirrorChecks[0].observedRow, 'bottom')
  assert.equal(result.evidence.mirrorChecks[0].heightCorrected, true)
  assert.equal(model.calls(), 4)
})

test('a chirality-only mirror mismatch keeps an honest direction-neutral side zone', async () => {
  // Reproduces PlayerA_test_1: three mid/right observations followed by a
  // mirrored observation that incorrectly remains mid/right.
  const right = vote({ row: 'mid', column: 'right' })
  const model = mockSdk([
    right, right, right,
    right, // mirror preserved off-centre placement but did not flip direction
  ])
  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.row, 'mid')
  assert.equal(result.column, 'side')
  assert.equal(result.directionVerified, false)
  assert.equal(result.directionNeutral, true)
  assert.equal(result.explanation, '')
  assert.equal(result.evidence.mirrorChecks[0].passed, true)
  assert.equal(result.evidence.mirrorChecks[0].directionNeutral, true)
  assert.equal(model.calls(), 4)
})

test('mirror checks that lose side-vs-center evidence remain unresolved', async () => {
  const left = vote({ column: 'left' })
  const center = vote({ column: 'center' })
  const model = mockSdk([
    left, left, left,
    center, // initial mirror lost the off-centre class
    left, left, left,
    center, // recovery mirror failed the same invariant
  ])
  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'UNRESOLVED')
  assert.equal(result.row, 'unclear')
  assert.equal(result.column, 'unclear')
  assert.deepEqual(result.issues, ['PLACEMENT_DISAGREEMENT'])
  assert.equal(result.evidence.mirrorChecks.length, 2)
  assert.equal(model.calls(), 8)
})

test('direction-neutral side placement receives the same score without claiming left or right', () => {
  const scored = scoring.finalizeScore({
    skill: { score: 7, explanation: 'Clean contact.' },
    difficulty: { score: 7, explanation: 'A difficult attempt.' },
    aesthetic: { score: 7, explanation: 'A strong-looking finish.' },
  }, {
    status: 'CLEAR',
    row: 'mid',
    column: 'side',
    explanation: '',
    directionVerified: false,
  }, {})

  assert.equal(scored.scores.placement.zone, 'mid_side')
  assert.equal(scored.scores.placement.score, scoring.PLACEMENT_ZONE_SCORES.mid_left)
  assert.equal(scored.scores.placement.directionVerified, false)
  assert.match(scored.scores.placement.explanation, /toward one side/i)
  assert.doesNotMatch(scored.scores.placement.explanation, /left|right/i)
})

test('placement copy is composed from the corrected zone instead of raw model prose', () => {
  const scored = scoring.finalizeScore({
    skill: { score: 4, explanation: 'A basic strike.' },
    difficulty: { score: 3, explanation: 'An open attempt.' },
    aesthetic: { score: 3, explanation: 'A straightforward finish.' },
  }, {
    status: 'CLEAR',
    row: 'bottom',
    column: 'left',
    explanation: 'The full goal is visible and the ball is waist high on the left.',
    heightCorrected: true,
  }, {})

  assert.equal(scored.scores.placement.zone, 'bottom_left')
  assert.equal(scored.scores.placement.heightCorrected, true)
  assert.equal(scored.scores.placement.explanation, 'The ball went in low by the left post.')
  assert.doesNotMatch(scored.scores.placement.explanation, /waist|full goal/i)
})

test('judge rubric excludes placement from the other criteria and anchors the full scale', () => {
  assert.match(scoring.JUDGE_RUBRIC, /Placement is scored separately/i)
  assert.match(scoring.JUDGE_RUBRIC, /Use the full scale conservatively/i)
  assert.match(scoring.JUDGE_RUBRIC, /Missing evidence earns no extra credit/i)
  assert.doesNotMatch(scoring.JUDGE_RUBRIC, /settled finishing spot/i)
})

test('a technical placement call is retried on the same evidence', async () => {
  const model = mockSdk([
    new Error('temporary worker failure'),
    vote(),
    vote(),
    vote(),
  ])
  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'CLEAR')
  assert.equal(model.calls(), 4)
})

test('two technical failures propagate as a system error instead of a clip diagnosis', async () => {
  const model = mockSdk([
    new Error('worker failed'),
    new Error('worker still failed'),
  ])

  await assert.rejects(
    scoring.classifyPlacement(model.sdk, 'model', frames),
    (err) => err.code === 'PLACEMENT_ANALYSIS_ERROR'
  )
  assert.equal(model.calls(), 2)
})

test('score contract marks mock results scored and rejects unresolved comparisons', async () => {
  const previous = process.env.QVAC_MOCK_SCORING
  process.env.QVAC_MOCK_SCORING = '1'
  try {
    const scored = await scoring.scoreClip(frames, { duration: 2 })
    assert.equal(scored.status, 'SCORED')
    assert.equal(scoring.hasResolvedPlacement(scored), true)

    const unresolved = { status: 'NEEDS_BETTER_CLIP', placement: { status: 'UNRESOLVED' } }
    assert.equal(scoring.hasResolvedPlacement(unresolved), false)
    assert.throws(
      () => scoring.compareClips(scored, unresolved),
      /resolved placement/i
    )
  } finally {
    if (previous === undefined) delete process.env.QVAC_MOCK_SCORING
    else process.env.QVAC_MOCK_SCORING = previous
  }
})

test('final score assembly refuses to revive unclear placement as bottom-center', () => {
  const judged = {
    skill: { score: 7, explanation: 'Clean contact.' },
    difficulty: { score: 7, explanation: 'A difficult attempt.' },
    aesthetic: { score: 7, explanation: 'A strong-looking finish.' },
  }

  assert.throws(
    () => scoring.finalizeScore(judged, {
      status: 'UNRESOLVED',
      row: 'unclear',
      column: 'unclear',
    }, {}),
    /refuses to score unresolved/i
  )
})
