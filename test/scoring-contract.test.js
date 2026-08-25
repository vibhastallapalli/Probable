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

test('two failed mirror checks remain unresolved instead of becoming center', async () => {
  const left = vote({ column: 'left' })
  const model = mockSdk([
    left, left, left,
    left, // initial mirror should have flipped right
    left, left, left,
    left, // recovery mirror should also have flipped right
  ])
  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'UNRESOLVED')
  assert.equal(result.row, 'unclear')
  assert.equal(result.column, 'unclear')
  assert.deepEqual(result.issues, ['PLACEMENT_DISAGREEMENT'])
  assert.equal(result.evidence.mirrorChecks.length, 2)
  assert.equal(model.calls(), 8)
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
