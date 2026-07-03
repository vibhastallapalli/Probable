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
// Scoring prompt — tune the rubric here. Wording is loosely based on the four
// criteria FIFA uses for its Puskás Award (best goal of the year): skill,
// difficulty, aesthetic quality (beauty), and fair play. The four numeric
// fields are enforced by the JSON schema below; this text steers the model to
// judge THIS clip specifically rather than in generalities.
// ---------------------------------------------------------------------------
const SCORING_PROMPT = `You are judging a short football (soccer) highlight clip for a friendly wager.
The images are ordered still frames sampled from the clip, first frame to last.

Watch the play across the frames and score it on four criteria, each from 0 to 10,
based loosely on FIFA's Puskás Award (goal of the year) criteria:

- skill: technical execution and control — first touch, dribbling, striking
  technique, body coordination, and the cleanness of the movement.
- difficulty: how hard the action was to pull off — angle, distance, pressure
  from defenders, body position, speed, and improvisation required.
- aesthetic: the visual beauty and spectacle of the play — how impressive or
  memorable it looks as a piece of football.
- fairPlay: sporting conduct — no dangerous, reckless, or cheating actions.
  A clean, sporting play scores high; visible fouls or unsporting behaviour
  score low.

For every field write a short (one to two sentence) explanation that refers to
what actually happens in THESE frames — the specific movement, body part,
defenders, angle, or moment you observed. Do not give generic praise; ground
each explanation in the visible action. This explanation will later be shown to
the players to justify the result, so it must be concrete and specific.`

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

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    skill: scoreField,
    difficulty: scoreField,
    aesthetic: scoreField,
    fairPlay: scoreField,
  },
  required: ['skill', 'difficulty', 'aesthetic', 'fairPlay'],
  additionalProperties: false,
}

const SCORE_FIELDS = ['skill', 'difficulty', 'aesthetic', 'fairPlay']

// Frame sampling limits. 30 fps is the hard ceiling; for anything but a very
// short clip the MAX_FRAMES cap pulls the effective rate well below that so the
// number of images (and therefore vision tokens) stays affordable for the
// local model's context window.
const FPS_CEILING = 30
const DEFAULT_MAX_FRAMES = Number(process.env.QVAC_MAX_FRAMES) || 8

// Minimum source frame rate [frames per second, fps] we consider reliable for
// scoring. Clips under this get a visible warning in the UI but are never
// blocked. The check rounds to the nearest whole number first so NTSC style
// rates [29.97 fps, which cameras label as 30] never trip a false warning.
const MIN_CLIP_FPS = 30

// Multimodal model context. Must be large enough to hold several projected
// images plus the prompt and JSON answer.
const MODEL_CTX_SIZE = Number(process.env.QVAC_CTX_SIZE) || 4096

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
 * Extract still frames from a clip at a capped rate.
 *
 * The effective sampling rate is min(FPS_CEILING, maxFrames / duration), so a
 * long clip is sampled sparsely and a short one densely, while the total frame
 * count never exceeds maxFrames.
 *
 * @param {string} videoPath - Absolute path to the source video.
 * @param {object} [opts]
 * @param {number} [opts.duration] - Known duration (s); probed if omitted.
 * @param {number} [opts.maxFrames] - Hard cap on returned frames.
 * @param {number} [opts.fpsCeiling] - Upper bound on sampling fps.
 * @returns {Promise<string[]>} Ordered array of extracted frame image paths.
 */
async function extractFrames (videoPath, opts = {}) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`)
  }

  const maxFrames = opts.maxFrames || DEFAULT_MAX_FRAMES
  const fpsCeiling = opts.fpsCeiling || FPS_CEILING
  const duration = opts.duration || (await getVideoDuration(videoPath))

  // Sampling rate: cap total frames for long clips, never exceed the ceiling.
  let fps = fpsCeiling
  if (duration > 0) {
    fps = Math.min(fpsCeiling, maxFrames / duration)
  }
  // ffmpeg needs a positive rate; clamp to a sane floor.
  if (!Number.isFinite(fps) || fps <= 0) fps = 1

  const outDir = path.join(os.tmpdir(), `probable-frames-${randomUUID()}`)
  fs.mkdirSync(outDir, { recursive: true })

  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-vf', `fps=${fps}`,
    '-frames:v', String(maxFrames), // extra guard against overshooting the cap
    path.join(outDir, 'frame-%04d.png'),
  ])

  const frames = fs.readdirSync(outDir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => path.join(outDir, f))

  if (frames.length === 0) {
    throw new Error('Frame extraction produced no frames — is this a valid video?')
  }

  return frames
}

// ---------------------------------------------------------------------------
// Clip scoring (QVAC local inference)
// ---------------------------------------------------------------------------

// Single source of truth for the status badge in the renderer. Keep in step
// with the modelSrc used in getModel below so the badge never lies on camera.
const MODEL_INFO = {
  name: 'SmolVLM2 500M',
  id: 'SMOLVLM2_500M_MULTIMODAL_Q8_0',
  runtime: 'QVAC',
}

// Lazily-loaded, process-wide multimodal model handle. Loading pulls the model
// into memory (and downloads it on first ever use), so we do it once and reuse.
let _qvac = null

async function getModel () {
  if (_qvac) return _qvac

  const sdk = await import('@qvac/sdk')
  const modelId = await sdk.loadModel({
    modelSrc: sdk.SMOLVLM2_500M_MULTIMODAL_Q8_0,
    modelConfig: {
      ctx_size: MODEL_CTX_SIZE,
      projectionModelSrc: sdk.MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
    },
    onProgress: (p) => {
      if (p && typeof p.percentage === 'number') {
        console.log(`[qvac] loading model ${p.percentage.toFixed(0)}%`)
      }
    },
  })

  _qvac = { sdk, modelId }
  return _qvac
}

/**
 * Score a clip's frames on the four Puskás-style criteria via the local model.
 *
 * @param {string[]} frames - Ordered frame image paths from extractFrames().
 * @param {object} [metadata]
 * @param {number} [metadata.duration] - Clip duration in seconds.
 * @returns {Promise<object>} Structured score:
 *   { scores: { skill:{score,explanation}, difficulty, aesthetic, fairPlay },
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

  const history = [
    {
      role: 'user',
      content: SCORING_PROMPT + durationLine,
      attachments: frames.map((p) => ({ path: p })),
    },
  ]

  const run = sdk.completion({
    modelId,
    history,
    stream: false,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'clip_score', schema: SCORE_SCHEMA },
    },
  })

  const final = await run.final
  // QVAC's CompletionFinal exposes the assistant text as `contentText`
  // (with the unparsed original at `raw.fullText`).
  const parsed = parseScore(final.contentText ?? final.raw?.fullText ?? '')

  return finalizeScore(parsed, {
    frameCount: frames.length,
    duration: metadata.duration || 0,
    model: MODEL_INFO.id,
    mock: false,
  })
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
function finalizeScore (parsed, meta) {
  const scores = {}
  for (const field of SCORE_FIELDS) {
    const raw = parsed?.[field] || {}
    scores[field] = {
      score: clampScore(raw.score),
      explanation: String(raw.explanation ?? '').trim() || '(no explanation returned)',
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
  SCORING_PROMPT,
  MODEL_INFO,
  MIN_CLIP_FPS,
  extractFrames,
  getVideoDuration,
  probeVideo,
  scoreClip,
  compareClips,
}
