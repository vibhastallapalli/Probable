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
  const shotMoment = overrides.shot_moment ?? 'arrival'
  return {
    ball_visibility: 'visible',
    goal_visibility: 'full',
    before_ball_goal_relation: shotMoment === 'aftermath'
      ? 'in_or_entering'
      : 'outside',
    ball_goal_relation: 'in_or_entering',
    shot_moment: shotMoment,
    ball_ground_proximity: 'clear_air',
    row: 'top',
    column: 'center',
    explanation: 'The ball went in high through the middle.',
    ...overrides,
  }
}

function mockSdk (outputs) {
  let calls = 0
  const requests = []
  return {
    sdk: {
      completion: (request) => {
        requests.push(request)
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
    requests: () => requests,
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
  assert.deepEqual(
    model.requests().map((request) =>
      request.history[0].attachments.map((attachment) => attachment.path)
    ),
    [
      ['f4.pair.png'],
      ['f5.pair.png'],
      ['f6.pair.png'],
    ]
  )
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

test('Player A aftermath frames cannot turn a lifted arrival into a bottom placement', async () => {
  const fallenInNet = vote({
    // Reproduce the real failure: Qwen reports `arrival` even though both the
    // before and target images already place the ball in/entering the goal.
    before_ball_goal_relation: 'in_or_entering',
    shot_moment: 'arrival',
    ball_ground_proximity: 'near_ground',
    row: 'bottom',
    column: 'side',
  })
  const liftedArrival = vote({
    shot_moment: 'arrival',
    ball_ground_proximity: 'clear_air',
    row: 'top',
    column: 'center',
  })
  const model = mockSdk([
    fallenInNet, fallenInNet, fallenInNet,
    liftedArrival, liftedArrival, liftedArrival,
  ])

  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'RECOVERED')
  assert.equal(result.row, 'top')
  assert.equal(result.column, 'center')
  assert.equal(result.evidence.initial.counts.aftermath, 3)
  assert.equal(result.evidence.initial.counts.usable, 0)
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

test('an off-centre placement must remain side under the mirrored-image check', async () => {
  const side = vote({ column: 'side' })
  const model = mockSdk([side, side, side, side])
  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.column, 'side')
  assert.equal(result.directionNeutral, true)
  assert.equal(result.evidence.mirrorChecks[0].passed, true)
  assert.equal(model.calls(), 4)
})

test('Player B ground evidence corrects a contradictory mid-height label to bottom-side', async () => {
  const reportedMidSide = vote({
    row: 'mid',
    column: 'side',
    ball_ground_proximity: 'near_ground',
    explanation: 'The ball appears waist high near a post.',
  })
  const mirroredMidSide = vote({
    row: 'mid',
    column: 'side',
    ball_ground_proximity: 'near_ground',
  })
  const model = mockSdk([
    reportedMidSide,
    reportedMidSide,
    reportedMidSide,
    mirroredMidSide,
  ])

  const result = await scoring.classifyPlacement(model.sdk, 'model', frames)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.row, 'bottom')
  assert.equal(result.column, 'side')
  assert.equal(result.heightCorrected, true)
  assert.equal(result.evidence.initial.counts.heightCorrected, 3)
  assert.equal(result.evidence.mirrorChecks[0].observedRow, 'bottom')
  assert.equal(result.evidence.mirrorChecks[0].heightCorrected, true)
  assert.equal(model.calls(), 4)
})

test('legacy directional words are discarded rather than displayed as exact left or right', async () => {
  const right = vote({ row: 'mid', column: 'right' })
  const model = mockSdk([
    right, right, right,
    right,
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
  const side = vote({ column: 'side' })
  const center = vote({ column: 'center' })
  const model = mockSdk([
    side, side, side,
    center, // initial mirror lost the off-centre class
    side, side, side,
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
    column: 'side',
    explanation: 'The full goal is visible and the ball is waist high on the left.',
    heightCorrected: true,
  }, {})

  assert.equal(scored.scores.placement.zone, 'bottom_side')
  assert.equal(scored.scores.placement.heightCorrected, true)
  assert.equal(scored.scores.placement.explanation, 'The ball went in low toward one side of the goal.')
  assert.doesNotMatch(scored.scores.placement.explanation, /waist|full goal/i)
})

test('judge rubric excludes placement from the other criteria and anchors the full scale', () => {
  assert.match(scoring.JUDGE_RUBRIC, /Placement is scored separately/i)
  assert.match(scoring.JUDGE_RUBRIC, /Use the full scale conservatively/i)
  assert.match(scoring.JUDGE_RUBRIC, /Missing evidence earns no extra credit/i)
  assert.doesNotMatch(scoring.JUDGE_RUBRIC, /settled finishing spot/i)
})

test('clip facts discard invented prose fields and invalid category values', () => {
  const facts = scoring.normalizeClipFacts({
    shooter_distance: 'medium',
    shot_speed: 'ridiculously_fast',
    kicking_foot: 'right',
    contact_type: 'laces',
    dribbling: 'none',
    pressure: 'none',
    body_position: 'balanced',
    ball_motion: 'low_driven',
    goal_outcome: 'scored',
    footwear: 'barefoot',
    both_feet_contacted: true,
    story: 'A beautiful strike under the lights.',
  })

  assert.equal(facts.shooter_distance, 'medium')
  assert.equal(facts.shot_speed, 'unclear')
  assert.equal(facts.dribbling, 'none')
  assert.equal(facts.ball_motion, 'low_driven')
  assert.equal(facts.kicking_foot, undefined)
  assert.equal(facts.contact_type, undefined)
  assert.equal(facts.pressure, undefined)
  assert.equal(facts.goal_outcome, undefined)
  assert.equal(facts.footwear, undefined)
  assert.equal(facts.both_feet_contacted, undefined)
  assert.equal(facts.story, undefined)
})

test('clip facts use a bounded sample that still spans the whole clip', () => {
  const sixteenFrames = Array.from(
    { length: 16 },
    (_, index) => `frame-${String(index + 1).padStart(4, '0')}.png`
  )
  const picked = scoring.selectFactFrames(sixteenFrames, 10)

  assert.equal(picked.length, 10)
  assert.equal(picked[0], sixteenFrames[0])
  assert.equal(picked.at(-1), sixteenFrames.at(-1))
  assert.equal(new Set(picked).size, picked.length)
})

test('judge receives only normalized non-placement facts', () => {
  const text = scoring.clipFactsForJudge({
    shooter_distance: 'medium',
    shot_speed: 'medium',
    kicking_foot: 'right',
    contact_type: 'unclear',
    dribbling: 'none',
    pressure: 'none',
    body_position: 'balanced',
    ball_motion: 'rolling',
    goal_outcome: 'scored',
    footwear: 'barefoot',
  })

  assert.match(text, /Shooter distance: medium/)
  assert.match(text, /Dribbling: none/)
  assert.match(text, /Ball motion: rolling/)
  assert.doesNotMatch(
    text,
    /barefoot|footwear|goal outcome|scored|kicking foot|contact type|pressure|body position/i
  )
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
