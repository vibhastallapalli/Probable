'use strict'

// Throwaway hand-run probe — NOT part of the app. Nothing imports this file,
// it writes nothing, and it is safe to delete once the question is answered.
//
//   Run:  node src/main/probe-heel.js <path-to-clipA> <path-to-clipB>
//
// Question under test: can the local judge model (Qwen3-VL 2B via QVAC)
// actually see WHICH PART OF THE FOOT strikes the ball at the moment of
// contact — back of the heel versus side foot versus laces — reliably enough
// to be worth adding to the real head-to-head comparison. This is a "can it
// even see it" check, run by hand on clip pairs where the true answer is
// already known. If the counted picks track the truth, a footing dimension
// may be worth building; if they wobble or glue to presentation order, it
// is not.
//
// Run discipline matches the shipped head-to-head checks in scoring.js:
//   - temperature 0 (greedy), identical generation params to the pipeline
//   - the SAME question asked twice, once with each clip's frames first
//   - a pick only counts when both orders point at the same real clip;
//     anything else — including one order saying "equal" — is counted as
//     "equal", because a pick that follows presentation order is positional
//     bias, not football
//
// Reused straight from scoring.js (all exported there):
//   - probeVideo / extractFrames — the pipeline's frame extraction
//   - selectComparisonFrames — the exact key-frame subset the shipped
//     head-to-head sends per clip (pre-kick stance, the contact, and the
//     ball in flight), so the probe sees the same contact frames the real
//     comparison would
//
// Copied here rather than reused: the model loader, the completion wrapper,
// the KV-cache clearing, and the order-check counting (getModel /
// runCompletion / clearCache / reconcileOrders in scoring.js). Those are
// module-private — not exported — and the ground rule for this probe is to
// leave the scoring pipeline completely untouched, so small verbatim copies
// live here instead of new export lines in the pipeline file. Only the
// Qwen3-VL 2B registry build is loaded (no fallback chain): the probe
// exists to test THAT model, so a failed load must fail loudly instead of
// silently swapping in a weaker model and polluting the answer.

const fs = require('fs')

const { probeVideo, extractFrames, selectComparisonFrames } = require('./scoring')

// Copied verbatim from scoring.js (module-private there). Rides along on the
// probe prompt the same way it rides along on every shipped vision prompt.
const GROUNDING_RULES = `
Hard rules — follow these exactly:
- Mention only what the frames actually show. Never invent players, a
  goalkeeper, defenders, a crowd, or anything else not visibly present.
- Do not assume things happened between frames. If something is unclear or
  not visible, say it is unclear instead of guessing.
- Do not fill gaps with general football knowledge. The frames are the only
  evidence that exists.`

// Same two-clip framing as the shipped comparison prompt, but a single
// closed question, worded plainly with no lead toward either answer.
function buildProbePrompt (countFirst, countSecond) {
  return `You are looking at still frames from TWO different short football (soccer)
clips. Each clip shows one player taking one shot at a goal.

The first ${countFirst} images are ordered moments from CLIP A's shot, start to
finish. The remaining ${countSecond} images are ordered moments from CLIP B's
shot, start to finish. Keep careful count so you never mix the two shots up.

In which clip does the player strike the ball with the back of the heel,
rather than with the side of the foot or the laces. Answer only A, B, or
equal. Then give one short reason for your answer.
${GROUNDING_RULES}`
}

// Same shape as the shipped head-to-head answers: a hard A/B/equal
// commitment first, then a short reason, grammar-enforced in that order.
const HEEL_SCHEMA = {
  type: 'object',
  properties: {
    pick: { type: 'string', enum: ['A', 'B', 'equal'] },
    reason: { type: 'string' },
  },
  required: ['pick', 'reason'],
  additionalProperties: false,
}

// --- Copies of scoring.js's private model call path ------------------------

// Mirrors getModel's primary candidate only (registry build, same ctx size).
const QWEN3VL_CTX_SIZE = Number(process.env.QVAC_CTX_SIZE) || 16384

async function loadJudgeModel () {
  const sdk = await import('@qvac/sdk')
  const modelId = await sdk.loadModel({
    modelSrc: sdk.QWEN3VL_2B_MULTIMODAL_Q4_K,
    modelConfig: {
      ctx_size: QWEN3VL_CTX_SIZE,
      projectionModelSrc: sdk.MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K,
    },
    onProgress: (p) => {
      if (p && typeof p.percentage === 'number') {
        console.log(`[probe] loading Qwen3-VL 2B ${p.percentage.toFixed(0)}%`)
      }
    },
  })
  console.log('[probe] model loaded: Qwen3-VL 2B (QWEN3VL_2B_MULTIMODAL_Q4_K)')
  return { sdk, modelId }
}

// Copy of scoring.js clearCache: a { success: false } result is a real
// failure even though nothing threw, so it is checked and logged.
async function clearCache (sdk) {
  try {
    const res = await sdk.deleteCache({ all: true })
    if (res && res.success === false) {
      console.warn(`[probe] deleteCache reported failure: ${res.error || 'unknown'}`)
    }
  } catch (err) {
    console.warn(`[probe] deleteCache threw: ${err.message}`)
  }
}

// Copy of scoring.js runCompletion: greedy decoding for reproducible
// verdicts, capped generation, KV cache cleared after every call.
async function runCompletion (sdk, modelId, { history, responseFormat }) {
  const run = sdk.completion({
    modelId,
    history,
    stream: false,
    generationParams: { temp: 0, predict: 768, repeat_penalty: 1.15 },
    ...(responseFormat ? { responseFormat } : {}),
  })

  let final
  try {
    final = await run.final
  } finally {
    await clearCache(sdk)
  }

  return String(final.contentText ?? final.raw?.fullText ?? '')
}

// Copy of scoring.js parseScore: the grammar constrains the output to valid
// JSON, but stay defensive in case prose leaks around it.
function parseAnswer (content) {
  const text = String(content ?? '').trim()
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      try { return JSON.parse(match[0]) } catch { /* fall through */ }
    }
    throw new Error(`Model did not return a valid JSON answer. Got: ${text.slice(0, 200)}`)
  }
}

// Copy of scoring.js mirrorPick: in the swapped run "A" means the clip shown
// first, which is the real clip B.
function mirrorPick (pick) {
  return pick === 'A' ? 'B' : pick === 'B' ? 'A' : 'equal'
}

// ---------------------------------------------------------------------------

async function prepareClip (label, videoPath) {
  const { duration } = await probeVideo(videoPath)
  const frames = await extractFrames(videoPath, { duration })
  const picked = selectComparisonFrames(frames)
  console.log(`Clip ${label}: ${videoPath}`)
  console.log(`  duration ${duration.toFixed(1)}s — ${frames.length} frames extracted, ` +
    `${picked.length} sent (same selection as the shipped head-to-head)`)
  for (const p of picked) console.log(`    ${p}`)
  return picked
}

// One run of the heel question with the given presentation order.
async function askHeel (sdk, modelId, firstFrames, secondFrames) {
  const answer = parseAnswer(await runCompletion(sdk, modelId, {
    history: [{
      role: 'user',
      content: buildProbePrompt(firstFrames.length, secondFrames.length),
      attachments: [...firstFrames, ...secondFrames].map((p) => ({ path: p })),
    }],
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'heel_probe', schema: HEEL_SCHEMA },
    },
  }))
  const pick = ['A', 'B', 'equal'].includes(answer?.pick) ? answer.pick : 'equal'
  return { pick, reason: String(answer?.reason ?? '').trim() }
}

// The QVAC worker intermittently dies mid-request on the big two-clip calls
// (native exit 0xC000041D, seen on real runs of this probe). The SDK resets
// its module state after a crash and respawns a fresh worker on the next
// loadModel, so a crashed order is re-asked on a fresh worker instead of
// wasting the whole hand run. Probe-only plumbing — the shipped pipeline has
// no such retry and this does not add one.
async function askHeelWithRetry (state, firstFrames, secondFrames, label) {
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; ; attempt++) {
    try {
      return await askHeel(state.sdk, state.modelId, firstFrames, secondFrames)
    } catch (err) {
      const crashed = err?.code === 50205 || /WORKER_CRASHED/i.test(String(err?.message))
      if (!crashed || attempt >= MAX_ATTEMPTS) throw err
      console.warn(`[probe] worker crashed during ${label} (attempt ${attempt}/${MAX_ATTEMPTS}) — respawning and retrying`)
      const reloaded = await loadJudgeModel()
      state.sdk = reloaded.sdk
      state.modelId = reloaded.modelId
      await clearCache(state.sdk)
    }
  }
}

async function main () {
  const [clipAPath, clipBPath] = process.argv.slice(2)
  if (!clipAPath || !clipBPath) {
    console.error('Usage: node src/main/probe-heel.js <path-to-clipA> <path-to-clipB>')
    process.exit(1)
  }
  for (const p of [clipAPath, clipBPath]) {
    if (!fs.existsSync(p)) {
      console.error(`Clip not found: ${p}`)
      process.exit(1)
    }
  }

  console.log('=== Heel-strike probe (hand-run, throwaway) ===\n')
  const framesA = await prepareClip('A', clipAPath)
  const framesB = await prepareClip('B', clipBPath)

  const state = await loadJudgeModel()

  // Clean slate before the first call, same guarantee the shipped
  // head-to-head takes before its paired runs.
  await clearCache(state.sdk)

  console.log('\n--- Order 1: clip A shown first ---')
  const forward = await askHeelWithRetry(state, framesA, framesB, 'order 1')
  // A shown first, so the labels already are the real clips.
  const forwardReal = forward.pick
  console.log(`raw pick:   ${forward.pick}  -> real clip: ${forwardReal}`)
  console.log(`raw reason: ${forward.reason}`)

  console.log('\n--- Order 2: clip B shown first ---')
  const reversed = await askHeelWithRetry(state, framesB, framesA, 'order 2')
  const reversedReal = mirrorPick(reversed.pick)
  console.log(`raw pick:   ${reversed.pick}  -> real clip: ${reversedReal}`)
  console.log(`raw reason: ${reversed.reason}`)

  // Same counting rule as the shipped order check (reconcileOrders in
  // scoring.js): a pick counts only when both orders point at the same real
  // clip; both-equal is an honest equal; any other combination means the
  // model failed to genuinely separate the shots and counts as equal.
  let counted
  let orderCheck
  if (forwardReal !== 'equal' && forwardReal === reversedReal) {
    counted = forwardReal
    orderCheck = `AGREED — both orders point at real clip ${forwardReal}`
  } else if (forwardReal === 'equal' && reversedReal === 'equal') {
    counted = 'equal'
    orderCheck = 'AGREED — both orders said equal'
  } else {
    counted = 'equal'
    orderCheck = `DISAGREED (order 1 -> ${forwardReal}, order 2 -> ${reversedReal})` +
      ' — failed the order check, counted as equal'
  }

  console.log('\n=============== RESULT ===============')
  console.log(`order check:    ${orderCheck}`)
  console.log(`COUNTED RESULT: ${counted}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[probe] failed:', err)
    process.exit(1)
  })
