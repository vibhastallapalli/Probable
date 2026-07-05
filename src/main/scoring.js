'use strict'

// Clip scoring module — fully local, on-device inference via the QVAC SDK.
//
// NETWORK POLICY: no clip data ever leaves this machine and no remote AI
// provider is ever called. Inference runs in QVAC's local worker (llama.cpp).
// The only network activity QVAC performs is a ONE-TIME download of the model
// weights into its on-disk cache on first use; after that it is fully offline.
// See docs: https://docs.qvac.tether.io/ai-capabilities/multimodal/

const os = require('os')
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

// ---------------------------------------------------------------------------
// Scoring prompts — tune the rubric here. Scoring runs in two passes so the
// model commits to what it can actually see before it judges anything:
//
//   Pass 1 (describe, frames attached): report only what is literally visible
//   in the sampled frames. No opinions, no scores, no football knowledge.
//   Pass 2 (judge, text only): score the four Puskás-style criteria from the
//   pass-1 description alone, so every point traces back to something the
//   model claimed to see rather than to what usually happens in highlights.
//
// GROUNDING_RULES rides along on every prompt sent to the model.
// ---------------------------------------------------------------------------

const GROUNDING_RULES = `
Hard rules — follow these exactly:
- Mention only what the frames actually show. Never invent players, a
  goalkeeper, defenders, a crowd, or anything else not visibly present.
- Do not assume things happened between frames. If something is unclear or
  not visible, say it is unclear instead of guessing.
- Do not fill gaps with general football knowledge. The frames are the only
  evidence that exists.`

const DESCRIBE_PROMPT = `You are looking at ordered still frames sampled from a short football (soccer)
clip, first frame to last. Later frames are sampled more densely because the
shot and ball flight usually happen late in the clip.

Describe only what is literally visible across the frames, in order:
- how many people are in frame and where they are
- the player with the ball: position, movement, and which body part touches
  the ball in each touch you can actually see
- the ball: where it is and how it moves from frame to frame
- the goal, if one is visible, and whether the ball ends up in it. If it
  does, mentally split the goal mouth into 3 rows (top, middle, bottom) and
  3 columns (left, center, right), using the crossbar and both goalposts as
  reference lines, and name which one of those 9 cells the ball crosses into
  (for example top left, mid right, bottom center)
- the pitch, surroundings, and camera view, briefly

Write 6 to 12 short factual sentences. No opinions, no scores, no praise.
${GROUNDING_RULES}`

const JUDGE_PROMPT_PREFIX = `You are judging a short football (soccer) highlight clip for a friendly wager.
You cannot see the clip. Your only evidence is the following literal
description of the sampled frames, written by an observer who reported only
what was visible:

`

const JUDGE_RUBRIC = `

Judge the play on four criteria, based loosely on FIFA's Puskás Award (goal
of the year) criteria, with placement in place of fair play.

Score each of these three from 0 to 10:

- skill: technical execution and control — first touch, dribbling, striking
  technique, body coordination, and the cleanness of the movement.
- difficulty: how hard the action was to pull off — angle, distance, pressure
  from defenders, body position, speed, and improvisation required.
- aesthetic: the visual beauty and spectacle of the play — how impressive or
  memorable it looks as a piece of football.

For placement, do NOT give a number. Instead classify where the ball crossed
into the goal. Mentally split the goal mouth into 3 rows (top, middle,
bottom) and 3 columns (left, center, right), using the crossbar and both
goalposts as reference lines, and pick which one of the 9 cells the ball
crossed into: top_left, top_center, top_right, mid_left, mid_center,
mid_right, bottom_left, bottom_center, or bottom_right. Give the zone FIRST,
then the explanation — the explanation must justify why the ball's position
relative to the crossbar and goalposts puts it in that zone. If the
description does not say where the ball entered the goal, or no goal is
described, pick bottom_center and say the placement was unclear in the
explanation.

Base every judgment ONLY on what the description says, not on general
football knowledge and not on what usually happens in highlight clips. If the
description does not mention defenders or a goalkeeper, treat them as absent
and judge difficulty accordingly. For every field write a short (one to two
sentence) explanation that quotes the specific movement, body part, or moment
from the description. If the description calls something unclear, say so in
the explanation rather than guessing. This explanation will later be shown to
the players to justify the result, so it must be concrete and specific.
${GROUNDING_RULES}`

// The 9 cells of the goal-mouth grid (3 rows x 3 columns, split by the
// crossbar and goalposts) and the fixed score each one is worth. The model
// only ever picks a zone; the number comes from this table, so the score can
// never contradict the zone. Corners are the hardest targets, mid-height
// sides and top center are reachable, and central or low-central shots are
// the easiest for a keeper to cover.
const PLACEMENT_ZONE_SCORES = {
  top_left: 10,
  top_right: 10,
  bottom_left: 8,
  bottom_right: 8,
  mid_left: 6,
  mid_right: 6,
  top_center: 5,
  mid_center: 3,
  bottom_center: 2,
}

const PLACEMENT_ZONES = Object.keys(PLACEMENT_ZONE_SCORES)

// Zone the rubric maps "unclear or no goal described" to — the lowest-value
// cell, matching the old behavior of scoring unclear placement low.
const UNCLEAR_ZONE = 'bottom_center'

// JSON schema handed to llama.cpp (via responseFormat) so the model is
// grammar-constrained to emit exactly this shape — no fragile text parsing.
const scoreField = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 10 },
    explanation: { type: 'string' },
  },
  required: ['score', 'explanation'],
  additionalProperties: false,
}

// Placement carries no model-chosen score: the model picks one of the 9
// closed-list zones and the number is looked up in PLACEMENT_ZONE_SCORES.
// `zone` is listed (and required) before `explanation` so the grammar forces
// the model to commit to a cell before it writes the justification.
const placementField = {
  type: 'object',
  properties: {
    zone: { type: 'string', enum: PLACEMENT_ZONES },
    explanation: { type: 'string' },
  },
  required: ['zone', 'explanation'],
  additionalProperties: false,
}

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    skill: scoreField,
    difficulty: scoreField,
    aesthetic: scoreField,
    placement: placementField,
  },
  required: ['skill', 'difficulty', 'aesthetic', 'placement'],
  additionalProperties: false,
}

const SCORE_FIELDS = ['skill', 'difficulty', 'aesthetic', 'placement']

// Frame sampling limits. 30 fps is the hard ceiling; for anything but a very
// short clip the MAX_FRAMES cap pulls the effective rate well below that so the
// number of images (and therefore vision tokens) stays affordable for the
// local model's context window. Sampling is weighted toward the second half of
// the clip (see sampleTimestamps), where the shot and ball flight happen.
const FPS_CEILING = 30
const DEFAULT_MAX_FRAMES = Number(process.env.QVAC_MAX_FRAMES) || 16

// Minimum source frame rate [frames per second, fps] we consider reliable for
// scoring. Clips under this get a visible warning in the UI but are never
// blocked. The check rounds to the nearest whole number first so NTSC style
// rates [29.97 fps, which cameras label as 30] never trip a false warning.
const MIN_CLIP_FPS = 30

// Multimodal model context. Must be large enough to hold 16 projected frames
// plus the describe prompt and its long text answer in a single window — 4096
// overflowed once the frame count doubled.
const MODEL_CTX_SIZE = Number(process.env.QVAC_CTX_SIZE) || 8192

// ---------------------------------------------------------------------------
// Frame extraction
// ---------------------------------------------------------------------------

/**
 * Probe a video's duration (seconds) using ffprobe.
 * @param {string} videoPath
 * @returns {Promise<number>}
 */
async function getVideoDuration (videoPath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ])
  const duration = parseFloat(String(stdout).trim())
  return Number.isFinite(duration) && duration > 0 ? duration : 0
}

/**
 * Probe a video's duration and frame rate in a single ffprobe call.
 *
 * @param {string} videoPath
 * @returns {Promise<{duration: number, fps: number|null, lowFps: boolean, minFps: number}>}
 *   duration in seconds, fps as a number or null when unreadable, lowFps true
 *   when the clip is meaningfully under MIN_CLIP_FPS, and minFps echoing the
 *   threshold so the UI can show it without duplicating the constant.
 */
async function probeVideo (videoPath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=avg_frame_rate,r_frame_rate',
    '-show_entries', 'format=duration',
    '-of', 'json',
    videoPath,
  ])

  let info = {}
  try { info = JSON.parse(String(stdout)) } catch { /* fall through to safe defaults */ }

  const duration = parseFloat(info?.format?.duration)
  const stream = Array.isArray(info?.streams) ? info.streams[0] : null

  // avg_frame_rate counts the frames the file actually contains, the honest
  // number for phone footage with a variable frame rate. r_frame_rate is the
  // container's declared base rate, kept as a fallback.
  const fps = parseFrameRate(stream?.avg_frame_rate) || parseFrameRate(stream?.r_frame_rate) || null

  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    fps,
    // Warn only when the rate could actually be read. Rounding first keeps a
    // 29.97 fps clip from being flagged as under 30.
    lowFps: fps !== null && Math.round(fps) < MIN_CLIP_FPS,
    minFps: MIN_CLIP_FPS,
  }
}

// ffprobe reports frame rates as fractions like "30000/1001". Returns the
// rate as a plain number, or 0 when the field is missing or malformed.
function parseFrameRate (value) {
  if (typeof value !== 'string' || value.length === 0) return 0
  const parts = value.split('/')
  const num = Number(parts[0])
  if (!Number.isFinite(num) || num <= 0) return 0
  if (parts.length === 1) return num
  const den = Number(parts[1])
  if (!Number.isFinite(den) || den <= 0) return 0
  return num / den
}

/**
 * Extract still frames from a clip, weighted toward the second half.
 *
 * Two thirds of the frames come from the second half of the clip, where the
 * shot and ball flight almost always happen, so the decisive moment is
 * captured instead of mostly run-up. Frames keep the source resolution — no
 * downscaling — so fine detail like foot-to-ball contact survives for the
 * model's own preprocessor. Falls back to an even sweep when the duration
 * cannot be read.
 *
 * @param {string} videoPath - Absolute path to the source video.
 * @param {object} [opts]
 * @param {number} [opts.duration] - Known duration (s); probed if omitted.
 * @param {number} [opts.maxFrames] - Hard cap on returned frames.
 * @param {number} [opts.fpsCeiling] - Upper bound on sampling fps (fallback path).
 * @returns {Promise<string[]>} Ordered array of extracted frame image paths.
 */
async function extractFrames (videoPath, opts = {}) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`)
  }

  const maxFrames = opts.maxFrames || DEFAULT_MAX_FRAMES
  const duration = opts.duration || (await getVideoDuration(videoPath))

  const outDir = path.join(os.tmpdir(), `probable-frames-${randomUUID()}`)
  fs.mkdirSync(outDir, { recursive: true })

  if (duration > 0) {
    // One fast-seek ffmpeg call per timestamp, a few at a time. Per-timestamp
    // extraction is what makes non-uniform sampling possible at all, and a
    // single-frame seek is cheap enough that the batch stays fast.
    const timestamps = sampleTimestamps(duration, maxFrames)
    const CONCURRENCY = 4
    for (let i = 0; i < timestamps.length; i += CONCURRENCY) {
      await Promise.all(timestamps.slice(i, i + CONCURRENCY).map((ts, j) =>
        execFileAsync(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error',
          '-ss', ts.toFixed(3),
          '-i', videoPath,
          '-frames:v', '1',
          path.join(outDir, `frame-${String(i + j + 1).padStart(4, '0')}.png`),
        ])
      ))
    }
  } else {
    // Duration unreadable: even sweep at a capped rate.
    const fpsCeiling = opts.fpsCeiling || FPS_CEILING
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-vf', `fps=${fpsCeiling}`,
      '-frames:v', String(maxFrames), // extra guard against overshooting the cap
      path.join(outDir, 'frame-%04d.png'),
    ])
  }

  const frames = fs.readdirSync(outDir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => path.join(outDir, f))

  if (frames.length === 0) {
    throw new Error('Frame extraction produced no frames — is this a valid video?')
  }

  return frames
}

/**
 * Sampling timestamps weighted toward the second half of the clip: one third
 * of the frames spread evenly over the first half (the run-up), two thirds
 * over the second half (the shot, ball flight, and goal).
 *
 * @param {number} duration - Clip duration in seconds (> 0).
 * @param {number} count - Total number of timestamps wanted.
 * @returns {number[]} Ascending timestamps in seconds.
 */
function sampleTimestamps (duration, count) {
  // Stop shy of the very end — a seek at or past the final frame yields nothing.
  const end = Math.max(0, duration - Math.min(0.25, duration * 0.05))
  if (count <= 2) {
    return count === 1 ? [end / 2] : [0, end]
  }

  const firstCount = Math.max(1, Math.round(count / 3))
  const secondCount = count - firstCount
  const mid = duration / 2

  // First half: even steps that stop before mid, so the halves never overlap.
  const first = Array.from({ length: firstCount }, (_, i) => (i * mid) / firstCount)
  // Second half: even steps from mid through the (safe) end, inclusive.
  const second = Array.from(
    { length: secondCount },
    (_, i) => mid + (i * (Math.max(mid, end) - mid)) / (secondCount - 1)
  )
  return [...first, ...second]
}

// ---------------------------------------------------------------------------
// Clip scoring (QVAC local inference)
// ---------------------------------------------------------------------------

// Primary judge model: SmolVLM2 2.2B, the largest SmolVLM2 variant. The QVAC
// registry only carries the 500M build, so the 2.2B weights come through the
// SDK's HTTP model source from the official ggml-org conversion, pinned to a
// fixed revision. The network policy is unchanged: one-time download into
// QVAC's on-disk cache, then fully local llama.cpp inference — exactly how the
// registry constants resolve too.
const SMOLVLM2_2_2B_BASE =
  'https://huggingface.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF/resolve/1bc3c9f74ceafd4c8d4411cc9cf188bba3798f91'

// Live facts for the status badge in the renderer. Starts as the model we
// intend to load; getModel overwrites name/id with whichever candidate
// actually loaded, so the badge never lies on camera.
const MODEL_INFO = {
  name: 'SmolVLM2 2.2B',
  id: 'SMOLVLM2_2_2B_INSTRUCT_Q8_0',
  runtime: 'QVAC',
}

// Lazily-loaded, process-wide multimodal model handle. Loading pulls the model
// into memory (and downloads it on first ever use), so we do it once and reuse.
let _qvac = null

async function getModel (onProgress) {
  if (_qvac) return _qvac

  const sdk = await import('@qvac/sdk')

  // Load order: 2.2B first for judgment quality, 500M registry build as the
  // fallback so a failed 2.2B download degrades scoring instead of breaking
  // it. QVAC_FORCE_500M=1 skips the big model (useful on low-RAM machines).
  const candidates = [
    {
      name: 'SmolVLM2 2.2B',
      id: 'SMOLVLM2_2_2B_INSTRUCT_Q8_0',
      loadOptions: {
        modelSrc: `${SMOLVLM2_2_2B_BASE}/SmolVLM2-2.2B-Instruct-Q8_0.gguf`,
        // URL sources carry no registry metadata, so the engine is explicit.
        modelType: 'llamacpp-completion',
        modelConfig: {
          ctx_size: MODEL_CTX_SIZE,
          projectionModelSrc: `${SMOLVLM2_2_2B_BASE}/mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf`,
        },
      },
    },
    {
      name: 'SmolVLM2 500M',
      id: 'SMOLVLM2_500M_MULTIMODAL_Q8_0',
      loadOptions: {
        modelSrc: sdk.SMOLVLM2_500M_MULTIMODAL_Q8_0,
        modelConfig: {
          ctx_size: MODEL_CTX_SIZE,
          projectionModelSrc: sdk.MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
        },
      },
    },
  ]
  if (process.env.QVAC_FORCE_500M === '1') candidates.shift()

  let lastError
  for (const candidate of candidates) {
    try {
      const modelId = await sdk.loadModel({
        ...candidate.loadOptions,
        onProgress: (p) => {
          if (p && typeof p.percentage === 'number') {
            console.log(`[qvac] loading ${candidate.name} ${p.percentage.toFixed(0)}%`)
            if (typeof onProgress === 'function') {
              try { onProgress(p) } catch { /* progress reporting is best-effort */ }
            }
          }
        },
      })
      MODEL_INFO.name = candidate.name
      MODEL_INFO.id = candidate.id
      console.log(`[qvac] loaded model: ${candidate.name} (${candidate.id})`)
      _qvac = { sdk, modelId }
      return _qvac
    } catch (err) {
      lastError = err
      console.warn(`[qvac] failed to load ${candidate.name}: ${err.message}`)
    }
  }
  throw lastError
}

/**
 * One-time model warm-up. Pulls the weights into QVAC's on-disk cache and loads
 * the model into memory BEFORE the first scoreClip, so the one-time first-run
 * download cannot race the worker's init timeout and fail with RPC_INIT_TIMEOUT.
 * Idempotent: after the first successful load it returns immediately without
 * re-downloading.
 *
 * @param {(p: {percentage: number}) => void} [onProgress] - Download/load
 *   progress, forwarded so the UI can show it instead of a silent wait.
 * @returns {Promise<{ready: boolean, alreadyLoaded: boolean, model: string, mock?: boolean}>}
 */
async function prepareModel (onProgress) {
  // Mock mode never touches the real model, so warm-up is a no-op.
  if (process.env.QVAC_MOCK_SCORING === '1') {
    return { ready: true, alreadyLoaded: true, model: 'mock', mock: true }
  }
  const alreadyLoaded = _qvac !== null
  await getModel(onProgress)
  return { ready: true, alreadyLoaded, model: MODEL_INFO.id }
}

/**
 * Score a clip's frames on the four Puskás-style criteria via the local model.
 *
 * Two passes: the model first describes what is literally visible in the
 * frames, then scores the four criteria from that description alone. Judging
 * from its own literal account keeps the score anchored to what is actually
 * in the clip instead of what usually happens in football highlights.
 *
 * @param {string[]} frames - Ordered frame image paths from extractFrames().
 * @param {object} [metadata]
 * @param {number} [metadata.duration] - Clip duration in seconds.
 * @returns {Promise<object>} Structured score:
 *   { scores: { skill:{score,explanation}, difficulty, aesthetic, placement },
 *     total, frameCount, duration, model, mock }
 */
async function scoreClip (frames, metadata = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('scoreClip requires a non-empty array of frame paths')
  }

  // Offline/dev escape hatch: exercise the full pipeline without pulling the
  // model. Off by default — real runs go through the local QVAC model below.
  if (process.env.QVAC_MOCK_SCORING === '1') {
    return mockScore(frames, metadata)
  }

  const { sdk, modelId } = await getModel()

  const durationLine = metadata.duration
    ? `\nClip duration: ${metadata.duration.toFixed(1)}s across ${frames.length} sampled frames.`
    : `\n${frames.length} sampled frames.`

  // Pass 1 — describe. Frames attached, free text out.
  const description = (await runCompletion(sdk, modelId, {
    history: [{
      role: 'user',
      content: DESCRIBE_PROMPT + durationLine,
      attachments: frames.map((p) => ({ path: p })),
    }],
  })).trim()
  if (!description) {
    throw new Error('Model returned an empty frame description')
  }
  console.log(`[qvac] clip description:\n${description}`)

  // Pass 2 — judge from the description alone (no frames), grammar-constrained
  // to the score schema.
  const judged = await runCompletion(sdk, modelId, {
    history: [{
      role: 'user',
      content: JUDGE_PROMPT_PREFIX + description + JUDGE_RUBRIC,
    }],
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'clip_score', schema: SCORE_SCHEMA },
    },
  })

  const parsed = parseScore(judged)

  return finalizeScore(parsed, {
    frameCount: frames.length,
    duration: metadata.duration || 0,
    model: MODEL_INFO.id,
    mock: false,
  })
}

// Run one completion call and return the assistant text. The worker
// accumulates KV cache across completion() calls on the same modelId; without
// clearing it, the next call's prompt stacks on top of the previous context
// and overflows the window. Clear after every call (success or failure) so
// each pass and each clip starts from a clean slate.
async function runCompletion (sdk, modelId, { history, responseFormat }) {
  const run = sdk.completion({
    modelId,
    history,
    stream: false,
    ...(responseFormat ? { responseFormat } : {}),
  })

  let final
  try {
    final = await run.final
  } finally {
    try { await sdk.deleteCache({ all: true }) } catch { /* best-effort; model stays loaded */ }
  }

  // QVAC's CompletionFinal exposes the assistant text as `contentText`
  // (with the unparsed original at `raw.fullText`).
  return String(final.contentText ?? final.raw?.fullText ?? '')
}

/**
 * Compare two scored clips and decide a winner by total score.
 *
 * NOTE: this is the function that will later drive automatic settlement — once
 * both clips in a Judge-mode match are scored, the caller will pass their
 * results here and, on a decisive result, invoke escrow.releaseEscrow(escrowId,
 * winnerAddress). That wiring is intentionally NOT done here yet.
 *
 * @param {object} clipA - scoreClip() result for clip A.
 * @param {object} clipB - scoreClip() result for clip B.
 * @returns {object} { winner: 'A'|'B'|'tie', margin, totalA, totalB, breakdown }
 */
function compareClips (clipA, clipB) {
  const totalA = clipA.total ?? sumScores(clipA.scores)
  const totalB = clipB.total ?? sumScores(clipB.scores)
  const margin = Math.abs(totalA - totalB)

  let winner = 'tie'
  if (totalA > totalB) winner = 'A'
  else if (totalB > totalA) winner = 'B'

  const breakdown = SCORE_FIELDS.map((field) => ({
    field,
    a: clipA.scores?.[field]?.score ?? 0,
    b: clipB.scores?.[field]?.score ?? 0,
  }))

  return { winner, margin, totalA, totalB, breakdown }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sumScores (scores) {
  if (!scores) return 0
  return SCORE_FIELDS.reduce((sum, f) => sum + (Number(scores[f]?.score) || 0), 0)
}

function clampScore (n) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(10, v))
}

// The JSON schema constrains the model to valid JSON, but stay defensive in
// case a model emits leading/trailing prose despite the grammar.
function parseScore (content) {
  const text = String(content ?? '').trim()
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      try { return JSON.parse(match[0]) } catch { /* fall through */ }
    }
    throw new Error(`Model did not return valid JSON score. Got: ${text.slice(0, 200)}`)
  }
}

// Normalize the raw parsed object into our canonical, clamped shape and add the
// derived total, so downstream code (and compareClips) can rely on it.
// Placement is special: its score is never taken from the model — the zone is
// looked up in PLACEMENT_ZONE_SCORES and the number follows from the table.
function finalizeScore (parsed, meta) {
  const scores = {}
  for (const field of SCORE_FIELDS) {
    const raw = parsed?.[field] || {}
    const explanation = String(raw.explanation ?? '').trim() || '(no explanation returned)'
    if (field === 'placement') {
      // The enum grammar guarantees a valid zone; the fallback only covers a
      // parse that slipped past it, and maps to the same cell as "unclear".
      const zone = PLACEMENT_ZONE_SCORES[raw.zone] !== undefined ? raw.zone : UNCLEAR_ZONE
      scores[field] = { score: PLACEMENT_ZONE_SCORES[zone], zone, explanation }
    } else {
      scores[field] = { score: clampScore(raw.score), explanation }
    }
  }
  return { scores, total: sumScores(scores), ...meta }
}

// Deterministic offline stand-in used only when QVAC_MOCK_SCORING=1.
function mockScore (frames, metadata) {
  const seed = frames.length + Math.round((metadata.duration || 0) * 10)
  const pick = (offset) => 4 + ((seed + offset) % 7) // 4..10
  const scores = {}
  SCORE_FIELDS.forEach((field, i) => {
    scores[field] = {
      score: pick(i * 3),
      explanation: `(offline mock) ${field} estimated from ${frames.length} frames over ${(metadata.duration || 0).toFixed(1)}s.`,
    }
  })
  // Placement mirrors the real path: a zone picked deterministically, score
  // taken from the table so mock output has the same shape as a real score.
  const mockZone = PLACEMENT_ZONES[seed % PLACEMENT_ZONES.length]
  scores.placement.zone = mockZone
  scores.placement.score = PLACEMENT_ZONE_SCORES[mockZone]
  return {
    scores,
    total: sumScores(scores),
    frameCount: frames.length,
    duration: metadata.duration || 0,
    model: 'mock',
    mock: true,
  }
}

module.exports = {
  DESCRIBE_PROMPT,
  JUDGE_PROMPT_PREFIX,
  JUDGE_RUBRIC,
  MODEL_INFO,
  PLACEMENT_ZONE_SCORES,
  PLACEMENT_ZONES,
  MIN_CLIP_FPS,
  extractFrames,
  getVideoDuration,
  probeVideo,
  prepareModel,
  scoreClip,
  compareClips,
}
