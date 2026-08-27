'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// scoring.js loads only these two native-binary path packages at module load.
// Test hooks below replace every placement crop/flip operation, so these paths
// are never spawned. process.execPath keeps the module-load fixture portable.
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'ffmpeg-static') return process.execPath
  if (request === 'ffprobe-static') return { path: process.execPath }
  return originalLoad.call(this, request, parent, isMain)
}
const scoring = require('../src/main/scoring')
Module._load = originalLoad

function observation (overrides = {}) {
  return {
    ball_visibility: 'visible',
    goal_visibility: 'full',
    ball_goal_stage: 'inside_goal',
    ball_ground_proximity: 'clear_air',
    row: 'top',
    column: 'center',
    explanation: 'The ball went in high through the middle.',
    ...overrides,
  }
}

function outside (overrides = {}) {
  return observation({
    ball_goal_stage: 'in_front',
    ball_ground_proximity: 'unclear',
    row: 'unclear',
    column: 'unclear',
    explanation: 'The ball is still outside the goal.',
    ...overrides,
  })
}

function goalPlane (overrides = {}) {
  return observation({
    ball_goal_stage: 'at_goal_plane',
    ...overrides,
  })
}

function missing (overrides = {}) {
  return observation({
    ball_visibility: 'not_visible',
    ball_goal_stage: 'unclear',
    ball_ground_proximity: 'unclear',
    row: 'unclear',
    column: 'unclear',
    explanation: 'The ball cannot be located.',
    ...overrides,
  })
}

function mockSdk (outputs) {
  let calls = 0
  const requests = []
  return {
    sdk: {
      completion: (request) => {
        requests.push(request)
        const output = typeof outputs === 'function'
          ? outputs(request, calls++)
          : outputs[calls++]
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


function mockObservationSdk (byPath) {
  const queues = new Map(Object.entries(byPath).map(([frame, value]) => [
    frame,
    Array.isArray(value) ? [...value] : [value],
  ]))
  const observed = new Map()
  return mockSdk((request) => {
    const frame = request.history[0].attachments?.[0]?.path
    const task = request.responseFormat?.json_schema?.name
    if (task === 'placement_geometry') {
      const source = frame.replace(/\.goal\.png$/i, '.png')
      const value = observed.get(source) || queues.get(source)?.[0]
      const geometry = value?.geometry || value
      return value && {
        row: geometry.row,
        column: geometry.column === 'left' || geometry.column === 'right'
          ? 'side'
          : geometry.column,
      }
    }

    const value = queues.get(frame)?.shift()
    if (value && !(value instanceof Error)) observed.set(frame, value)
    if (!value || value instanceof Error) return value
    return {
      ball_visibility: value.ball_visibility,
      goal_visibility: value.goal_visibility,
      ball_goal_stage: value.ball_goal_stage,
      ball_ground_proximity: value.ball_ground_proximity,
      row: value.row,
      column: value.column,
      explanation: value.explanation,
    }
  })
}

const frames = ['f1.png', 'f2.png', 'f3.png', 'f4.png', 'f5.png', 'f6.png']
const placementTestHooks = {
  placementCropper: async (frame) => frame.replace(/\.png$/i, '.goal.png'),
  placementFlipper: async (frame) => frame.replace(/\.png$/i, '.mirror.png'),
}

function classifyPlacement (model, selectedFrames = frames) {
  return scoring.classifyPlacement(model.sdk, 'model', selectedFrames, placementTestHooks)
}

test('initial quorum produces a CLEAR placement without recovery', async () => {
  const depthMidGeometryTop = observation({
    row: 'mid',
    geometry: { row: 'top', column: 'center' },
  })
  const model = mockObservationSdk({
    'f2.png': outside(),
    'f3.png': outside(),
    'f4.png': depthMidGeometryTop,
    'f5.png': depthMidGeometryTop,
    'f6.png': observation({ row: 'mid' }),
  })
  const result = await classifyPlacement(model)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.row, 'top')
  assert.equal(result.column, 'center')
  assert.equal(result.evidence.recovery, null)
  assert.equal(model.calls(), 7)
  assert.deepEqual(
    model.requests().map((request) =>
      request.history[0].attachments.map((attachment) => attachment.path)
    ),
    [
      ['f2.png'],
      ['f3.png'],
      ['f4.png'],
      ['f5.png'],
      ['f6.png'],
      ['f4.goal.png'],
      ['f5.goal.png'],
    ]
  )
  assert.deepEqual(
    model.requests().map((request) => request.responseFormat.json_schema.name),
    [
      'placement_depth',
      'placement_depth',
      'placement_depth',
      'placement_depth',
      'placement_depth',
      'placement_geometry',
      'placement_geometry',
    ]
  )
})

test('resolved explanation comes from a usable observation, not a later invalid guess', async () => {
  const model = mockObservationSdk({
    'f2.png': outside(),
    'f3.png': outside(),
    'f4.png': observation({ explanation: 'First usable observation.' }),
    'f5.png': observation({ explanation: 'Second usable observation.' }),
    'f6.png': missing({ explanation: 'Invalid later guess.' }),
  })
  const result = await classifyPlacement(model)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.explanation, 'Second usable observation.')
})

test('failed initial evidence can become RECOVERED on unused frames', async () => {
  const model = mockObservationSdk({
    'f1.png': outside(),
    'f2.png': observation(),
    'f3.png': observation(),
    'f4.png': missing(),
    'f5.png': missing(),
    'f6.png': missing(),
  })
  const result = await classifyPlacement(model)

  assert.equal(result.status, 'RECOVERED')
  assert.equal(result.row, 'top')
  assert.equal(result.column, 'center')
  assert.equal(result.evidence.initial.ready, false)
  assert.equal(result.evidence.combined.ready, true)
  assert.equal(model.calls(), 8)
})

test('Player A aftermath frames cannot turn a lifted arrival into a bottom placement', async () => {
  const fallenInNet = observation({
    ball_ground_proximity: 'near_ground',
    row: 'bottom',
    column: 'side',
  })
  const liftedArrival = observation({
    ball_ground_proximity: 'clear_air',
    row: 'top',
    column: 'center',
  })
  const model = mockObservationSdk({
    'f1.png': outside(),
    'f2.png': liftedArrival,
    'f3.png': liftedArrival,
    'f4.png': fallenInNet,
    'f5.png': fallenInNet,
    'f6.png': fallenInNet,
  })

  const result = await classifyPlacement(model)

  assert.equal(result.status, 'RECOVERED')
  assert.equal(result.row, 'top')
  assert.equal(result.column, 'center')
  assert.equal(result.evidence.initial.counts.aftermath, 3)
  assert.equal(result.evidence.initial.counts.usable, 0)
  assert.equal(model.calls(), 8)
})

test('Player A uses the high goal-plane position before the ball falls low in the net', async () => {
  const highSideAtLine = goalPlane({
    ball_ground_proximity: 'clear_air',
    row: 'top',
    column: 'side',
  })
  const highSideInside = observation({
    ball_ground_proximity: 'clear_air',
    row: 'top',
    column: 'side',
  })
  const fallenLowInside = observation({
    ball_ground_proximity: 'near_ground',
    row: 'bottom',
    column: 'side',
  })
  const model = mockObservationSdk({
    'f2.png': highSideAtLine,
    'f3.png': highSideAtLine,
    'f4.png': highSideInside,
    'f5.png': fallenLowInside,
    'f6.png': fallenLowInside,
    'f3.mirror.png': highSideAtLine,
  })

  const result = await classifyPlacement(model)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.row, 'top')
  assert.equal(result.column, 'side')
  assert.equal(result.evidence.initial.counts.usable, 2)
  assert.equal(result.evidence.initial.counts.aftermath, 1)
  assert.equal(result.evidence.mirrorChecks[0].passed, true)
  assert.equal(model.calls(), 8)
})

test('a foreground ball projected over the goal cannot become fake low placement evidence', async () => {
  const foregroundProjection = outside({
    // Deliberately contradictory model fields: normalization must discard
    // them because the ball has not reached the goal plane.
    ball_ground_proximity: 'near_ground',
    row: 'bottom',
    column: 'side',
  })
  const model = mockObservationSdk(Object.fromEntries(
    frames.map((frame) => [frame, foregroundProjection])
  ))

  const result = await classifyPlacement(model)

  assert.equal(result.status, 'UNRESOLVED')
  assert.equal(result.evidence.combined.counts.usable, 0)
  assert.deepEqual(result.issues, ['SHOT_MOMENT_NOT_CAPTURED'])
  assert.equal(model.calls(), 6)
})

test('failed initial and recovery evidence remains UNRESOLVED with feedback', async () => {
  const model = mockObservationSdk(Object.fromEntries(
    frames.map((frame) => [frame, missing()])
  ))
  const result = await classifyPlacement(model)

  assert.equal(result.status, 'UNRESOLVED')
  assert.equal(result.feedback.code, 'PLACEMENT_UNRESOLVED')
  assert.match(result.feedback.observations.join(' '), /locate the ball/i)
  assert.equal(model.calls(), 6)
})

test('an off-centre placement must remain side under the mirrored-image check', async () => {
  const side = observation({ column: 'side' })
  const model = mockObservationSdk({
    'f2.png': outside(),
    'f3.png': outside(),
    'f4.png': side,
    'f5.png': side,
    'f6.png': side,
    'f5.mirror.png': side,
  })
  const result = await classifyPlacement(model)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.column, 'side')
  assert.equal(result.directionNeutral, true)
  assert.equal(result.evidence.mirrorChecks[0].passed, true)
  assert.equal(model.calls(), 8)
})

test('Player B ground evidence corrects a contradictory mid-height label to bottom-side', async () => {
  const reportedMidSide = observation({
    row: 'mid',
    column: 'side',
    ball_ground_proximity: 'near_ground',
    explanation: 'The ball appears waist high near a post.',
  })
  const reportedMidSideAtLine = goalPlane({
    row: 'mid',
    column: 'side',
    ball_ground_proximity: 'near_ground',
  })
  const model = mockObservationSdk({
    'f2.png': outside(),
    'f3.png': reportedMidSideAtLine,
    'f4.png': reportedMidSide,
    'f5.png': reportedMidSide,
    'f6.png': reportedMidSide,
    'f3.mirror.png': reportedMidSideAtLine,
  })

  const result = await classifyPlacement(model)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.row, 'bottom')
  assert.equal(result.column, 'side')
  assert.equal(result.heightCorrected, true)
  assert.equal(result.evidence.initial.counts.heightCorrected, 2)
  assert.equal(result.evidence.mirrorChecks[0].observedRow, 'mid')
  assert.equal(result.evidence.mirrorChecks[0].heightCorrected, false)
  assert.equal(model.calls(), 8)
})

test('near-ground evidence cannot override an explicit high arrival', async () => {
  const highNearGround = observation({
    row: 'top',
    column: 'side',
    ball_ground_proximity: 'near_ground',
  })
  const highNearGroundAtLine = goalPlane({
    row: 'top',
    column: 'side',
    ball_ground_proximity: 'near_ground',
  })
  const model = mockObservationSdk({
    'f2.png': outside(),
    'f3.png': highNearGroundAtLine,
    'f4.png': highNearGround,
    'f5.png': highNearGround,
    'f6.png': highNearGround,
    'f3.mirror.png': highNearGroundAtLine,
  })

  const result = await classifyPlacement(model)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.row, 'top')
  assert.equal(result.column, 'side')
  assert.equal(result.heightCorrected, false)
})

test('an explicit low arrival remains bottom without a ground correction', async () => {
  const lowSide = observation({ row: 'bottom', column: 'side' })
  const lowSideAtLine = goalPlane({ row: 'bottom', column: 'side' })
  const model = mockObservationSdk({
    'f2.png': outside(),
    'f3.png': lowSideAtLine,
    'f4.png': lowSide,
    'f5.png': lowSide,
    'f6.png': lowSide,
    'f3.mirror.png': lowSideAtLine,
  })

  const result = await classifyPlacement(model)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.row, 'bottom')
  assert.equal(result.column, 'side')
  assert.equal(result.heightCorrected, false)
})

test('goal crop localization requires a crossbar, lower rail, and post support', () => {
  const width = 120
  const height = 120
  const pixels = Buffer.alloc(width * height * 3)
  const draw = (x, y) => {
    const offset = (y * width + x) * 3
    pixels[offset] = 220
    pixels[offset + 1] = 220
    pixels[offset + 2] = 220
  }
  for (let x = 20; x <= 100; x += 1) {
    draw(x, 30)
    draw(x, 65)
  }
  for (let y = 30; y <= 65; y += 1) {
    draw(20, y)
    draw(100, y)
  }

  const crossbar = scoring.detectGoalCrossbar(pixels, width, height)
  assert.ok(crossbar)
  assert.equal(crossbar.left, 20)
  assert.equal(crossbar.right, 100)
  const crop = scoring.placementGoalCropBox(crossbar, width, height)
  assert.ok(crop.left < crossbar.left)
  assert.ok(crop.bottom > 65)

  const unsupported = Buffer.alloc(width * height * 3)
  for (let x = 20; x <= 100; x += 1) {
    const offset = (30 * width + x) * 3
    unsupported.fill(220, offset, offset + 3)
  }
  assert.equal(scoring.detectGoalCrossbar(unsupported, width, height), null)
})

test('legacy directional words are discarded rather than displayed as exact left or right', async () => {
  const right = observation({ row: 'mid', column: 'right' })
  const model = mockObservationSdk({
    'f2.png': outside(),
    'f3.png': outside(),
    'f4.png': right,
    'f5.png': right,
    'f6.png': right,
    'f5.mirror.png': right,
  })
  const result = await classifyPlacement(model)

  assert.equal(result.status, 'CLEAR')
  assert.equal(result.row, 'mid')
  assert.equal(result.column, 'side')
  assert.equal(result.directionVerified, false)
  assert.equal(result.directionNeutral, true)
  assert.equal(result.explanation, '')
  assert.equal(result.evidence.mirrorChecks[0].passed, true)
  assert.equal(result.evidence.mirrorChecks[0].directionNeutral, true)
  assert.equal(model.calls(), 8)
})

test('mirror checks that lose side-vs-center evidence remain unresolved', async () => {
  const side = observation({ column: 'side' })
  const center = observation({ column: 'center' })
  const model = mockObservationSdk({
    'f1.png': outside(),
    'f2.png': outside(),
    'f3.png': outside(),
    'f4.png': side,
    'f5.png': side,
    'f6.png': side,
    'f5.mirror.png': center, // initial mirror lost the off-centre class
    'f4.mirror.png': center, // combined mirror failed on the other decider
  })
  const result = await classifyPlacement(model)

  assert.equal(result.status, 'UNRESOLVED')
  assert.equal(result.row, 'unclear')
  assert.equal(result.column, 'unclear')
  assert.deepEqual(result.issues, ['PLACEMENT_DISAGREEMENT'])
  assert.equal(result.evidence.mirrorChecks.length, 2)
  assert.equal(model.calls(), 10)
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
  const model = mockObservationSdk({
    'f2.png': [new Error('temporary worker failure'), outside()],
    'f3.png': outside(),
    'f4.png': observation(),
    'f5.png': observation(),
    'f6.png': observation(),
  })
  const result = await classifyPlacement(model)

  assert.equal(result.status, 'CLEAR')
  assert.equal(model.calls(), 8)
})

test('two technical failures propagate as a system error instead of a clip diagnosis', async () => {
  const model = mockObservationSdk({
    'f2.png': [new Error('worker failed'), new Error('worker still failed')],
  })

  await assert.rejects(
    classifyPlacement(model),
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
