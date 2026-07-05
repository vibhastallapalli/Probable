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
// Scoring prompts — tune the rubric here. Scoring runs in three passes so the
// model commits to what it can actually see before it judges anything:
//
//   Pass 1 (describe, frames attached): report only what is literally visible
//   in the sampled frames. No opinions, no scores, no football knowledge.
//   Pass 2 (placement, one tail frame per call): the last few frames are each
//   shown alone — one image, one row+column commitment — and the answers are
//   majority-voted, so pre-shot frames with the ball still on the ground
//   cannot drag the verdict down to "bottom, rolling". A left/right verdict
//   must additionally survive a mirrored-image consistency check before it is
//   trusted, because small VLMs guess chirality with confidence; an
//   unverified side degrades to the center column instead of a coin flip.
//   Pass 3 (judge, text only): score skill/difficulty/aesthetic from the
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

Judge the play on three criteria, based loosely on FIFA's Puskás Award (goal
of the year) criteria.

Score each from 0 to 10:

- skill: technical execution and control — first touch, dribbling, striking
  technique, body coordination, and the cleanness of the movement.
- difficulty: how hard the action was to pull off — angle, distance, pressure
  from defenders, body position, speed, and improvisation required.
- aesthetic: the visual beauty and spectacle of the play — how impressive or
  memorable it looks as a piece of football.

Base every judgment ONLY on what the description says, not on general
football knowledge and not on what usually happens in highlight clips. If the
description does not mention defenders or a goalkeeper, treat them as absent
and judge difficulty accordingly. For every field write a short (one to two
sentence) explanation that quotes the specific movement, body part, or moment
from the description. If the description calls something unclear, say so in
the explanation rather than guessing. This explanation will later be shown to
the players to justify the result, so it must be concrete and specific.
${GROUNDING_RULES}`

// Placement pass prompt — sent with ONE tail frame attached per call, so the
// zone is decided by a pass that can actually see the ball against the goal
// frame, one concrete image at a time. The judge pass never picks the zone;
// it can't see anything.
const PLACEMENT_PROMPT = `You are looking at one still frame from the end of a short football (soccer)
clip, at or just after the moment a shot reaches the goal. The ball may be in
flight, crossing the line, or already in the net.

First find the ball in this image, then find the crossbar and the two
goalposts, then compare them. Report the ball's position as a row and a
column.

Everything is from the CAMERA'S point of view — the picture exactly as you
see it. Never answer from the shooter's or the goalkeeper's point of view.

row — the ball's height:
- top: in the top third of the goal, near the crossbar
- mid: in the middle third, clearly below the crossbar and clearly above
  the ground
- bottom: in the bottom third, on or near the ground
- unclear: the ball is not visible, or it is not in or entering the goal

column — the ball's side of the goal:
- left: near the goalpost closer to the LEFT edge of the picture
- center: near the middle of the goal, away from both posts
- right: near the goalpost closer to the RIGHT edge of the picture
- unclear: the ball is not visible, or it is not in or entering the goal

Then explain in one or two sentences where the ball is relative to the
crossbar and the goalposts in this image.
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

// Placement carries no model-chosen score, and the model never even picks a
// whole zone: it commits to a row and a column separately (two small closed
// choices are far more reliable for a 2B VLM than one 9-way pick), and the
// zone key plus its score are composed in code. `row` and `column` come
// before `explanation` so the grammar forces the commitments first.
const placementField = {
  type: 'object',
  properties: {
    row: { type: 'string', enum: ['top', 'mid', 'bottom', 'unclear'] },
    column: { type: 'string', enum: ['left', 'center', 'right', 'unclear'] },
    explanation: { type: 'string' },
  },
  required: ['row', 'column', 'explanation'],
  additionalProperties: false,
}

// Judge schema covers only the three text-judged criteria; placement is
// answered by the vision pass and merged into the result in finalizeScore.
const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    skill: scoreField,
    difficulty: scoreField,
    aesthetic: scoreField,
  },
  required: ['skill', 'difficulty', 'aesthetic'],
  additionalProperties: false,
}

const JUDGED_FIELDS = ['skill', 'difficulty', 'aesthetic']
const SCORE_FIELDS = [...JUDGED_FIELDS, 'placement']

// Frame sampling limits. 30 fps is the hard ceiling; for anything but a very
// short clip the MAX_FRAMES cap pulls the effective rate well below that so the
// number of images (and therefore vision tokens) stays affordable for the
// local model's context window. Sampling is weighted toward the second half of
// the clip (see sampleTimestamps), where the shot and ball flight happen.
const FPS_CEILING = 30
const DEFAULT_MAX_FRAMES = Number(process.env.QVAC_MAX_FRAMES) || 16

// How many of the last sampled frames the placement pass polls, one frame per
// call. Sampling is weighted toward the end of the clip, so these frames hold
// the ball's arrival at the goal; each frame is asked about alone because a
// batch that includes pre-shot frames (ball on the ground) reliably drags the
// answer toward "bottom, rolling".
const PLACEMENT_FRAME_COUNT = Number(process.env.QVAC_PLACEMENT_FRAMES) || 3

// Longest edge (px) an extracted frame may keep. Qwen3-VL's image token cost
// scales with resolution (~(w/32)*(h/32) tokens per frame), so unbounded
// source resolution makes the describe pass overflow any fixed context: a
// 1080p clip costs ~2040 tokens per frame and 4K ~8160, versus ~576 at
// 1024x576. Capping the long edge at 1024 bounds a frame at ~1024 tokens
// worst case, keeping 8-16 frames inside the 16384 window with room for the
// prompt and answer. Frames are never upscaled — smaller sources pass
// through untouched.
const FRAME_MAX_EDGE = Number(process.env.QVAC_FRAME_EDGE) || 1024

// ffmpeg scale filter for FRAME_MAX_EDGE: fit inside a box no larger than the
// source on either axis, preserving aspect ratio, never enlarging.
const FRAME_SCALE_FILTER =
  `scale=w='min(${FRAME_MAX_EDGE},iw)':h='min(${FRAME_MAX_EDGE},ih)':force_original_aspect_ratio=decrease`

// Minimum source frame rate [frames per second, fps] we consider reliable for
// scoring. Clips under this get a visible warning in the UI but are never
// blocked. The check rounds to the nearest whole number first so NTSC style
// rates [29.97 fps, which cameras label as 30] never trip a false warning.
const MIN_CLIP_FPS = 30

// Context for the SmolVLM2 fallback models (fixed-grid projector, cheap
// per-image tokens). Must hold 16 projected frames plus the describe prompt
// and its long text answer in a single window — 4096 overflowed once the
// frame count doubled. The QVAC_CTX_SIZE override applies to the Qwen3-VL
// primary too (see QWEN3VL_CTX_SIZE), so leave it unset unless every
// candidate should share one window size.
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
 * captured instead of mostly run-up. Frames keep the source resolution up to
 * FRAME_MAX_EDGE on the long side — enough detail for foot-to-ball contact,
 * while bounding the per-frame vision-token cost that scales with resolution
 * (see FRAME_MAX_EDGE). Falls back to an even sweep when the duration cannot
 * be read.
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
          '-vf', FRAME_SCALE_FILTER,
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
      '-vf', `fps=${fpsCeiling},${FRAME_SCALE_FILTER}`,
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

// Primary judge model: Qwen3-VL 2B from the QVAC registry. Chosen
// empirically on real goal frames: SmolVLM2 2.2B could not locate the ball
// at all — its answers flipped between identical calls and failed every
// mirrored-image check — while Qwen3-VL 2B at temperature 0 answered every
// ground-truth probe correctly, deterministically, and flipped sides
// correctly on mirrored frames. SmolVLM2 2.2B stays as a fallback (weights
// via the SDK's HTTP model source from the official ggml-org conversion,
// pinned to a fixed revision), then the 500M registry build as last resort.
// Network policy unchanged: one-time download into QVAC's on-disk cache,
// then fully local llama.cpp inference.
const SMOLVLM2_2_2B_BASE =
  'https://huggingface.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF/resolve/1bc3c9f74ceafd4c8d4411cc9cf188bba3798f91'

// Qwen3-VL sees images at native resolution, so its per-image token cost is
// far higher than SmolVLM2's fixed grid — a 16-frame describe pass does not
// fit in 8192. KV cache for a 2B model at 16384 stays affordable.
const QWEN3VL_CTX_SIZE = Number(process.env.QVAC_CTX_SIZE) || 16384

// Live facts for the status badge in the renderer. Starts as the model we
// intend to load; getModel overwrites name/id with whichever candidate
// actually loaded, so the badge never lies on camera.
const MODEL_INFO = {
  name: 'Qwen3-VL 2B',
  id: 'QWEN3VL_2B_MULTIMODAL_Q4_K',
  runtime: 'QVAC',
}

// Lazily-loaded, process-wide multimodal model handle. Loading pulls the model
// into memory (and downloads it on first ever use), so we do it once and reuse.
let _qvac = null

async function getModel (onProgress) {
  if (_qvac) return _qvac

  const sdk = await import('@qvac/sdk')

  // Load order: Qwen3-VL 2B first (the only candidate that proved it can
  // actually locate the ball — see the comment above MODEL_INFO), SmolVLM2
  // 2.2B next, 500M registry build last, so a failed download degrades
  // scoring instead of breaking it. QVAC_FORCE_500M=1 skips straight to the
  // small registry build (useful on low-RAM machines).
  const candidates = [
    {
      name: 'Qwen3-VL 2B',
      id: 'QWEN3VL_2B_MULTIMODAL_Q4_K',
      loadOptions: {
        modelSrc: sdk.QWEN3VL_2B_MULTIMODAL_Q4_K,
        modelConfig: {
          ctx_size: QWEN3VL_CTX_SIZE,
          projectionModelSrc: sdk.MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K,
        },
      },
    },
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
  if (process.env.QVAC_FORCE_500M === '1') candidates.splice(0, candidates.length - 1)

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
 * Three passes: the model first describes what is literally visible in the
 * frames, then classifies the goal-mouth zone while looking at the tail
 * frames, then scores the three judged criteria from the description alone.
 * Judging from its own literal account keeps the score anchored to what is
 * actually in the clip instead of what usually happens in football highlights,
 * and answering the zone question visually keeps placement anchored to where
 * the ball actually crossed the line.
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

  // Pass 2 — placement. A visual question answered visually, one frame at a
  // time: each tail frame is classified alone and the verdicts are voted, so
  // a pre-shot frame with the ball still on the ground cannot decide the
  // zone, and a left/right verdict must survive the mirror check.
  const placement = await classifyPlacement(sdk, modelId, frames)

  // Pass 3 — judge skill/difficulty/aesthetic from the description alone (no
  // frames), grammar-constrained to the score schema.
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

  return finalizeScore(parsed, placement, {
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
    // Greedy decoding: verdicts must be reproducible — the same clip has to
    // get the same score when money settles on it, and at the default
    // temperature the spatial answers were observed to flip between
    // identical calls.
    generationParams: { temp: 0 },
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
 * Classify the goal-mouth cell by polling the tail frames one at a time.
 *
 * Each of the last PLACEMENT_FRAME_COUNT frames is shown alone with the
 * placement prompt and the row/column answers are majority-voted, ties going
 * to the latest frame (where the ball is deepest into the goal). A left or
 * right column must then survive a mirror check: the deciding frame is
 * flipped horizontally and the question asked again — a model that truly
 * sees the ball must give the opposite side on the mirrored image. A side
 * that fails the check is not trusted, and the shot is scored through the
 * center column of its row rather than gambling on a guessed corner.
 *
 * @param {object} sdk - Loaded QVAC SDK module.
 * @param {string} modelId - Loaded model handle from getModel().
 * @param {string[]} frames - All extracted frame paths, in clip order.
 * @returns {Promise<{row: string, column: string, explanation: string, sideUnverified: boolean}>}
 */
async function classifyPlacement (sdk, modelId, frames) {
  const tail = frames.slice(-PLACEMENT_FRAME_COUNT)

  const votes = []
  for (const frame of tail) {
    const vote = parseScore(await askPlacement(sdk, modelId, frame))
    votes.push({ frame, ...vote })
    console.log(`[qvac] placement vote ${path.basename(frame)}: row=${vote.row} column=${vote.column}`)
  }

  const row = majority(votes.map((v) => v.row), ['top', 'mid', 'bottom'])
  let column = majority(votes.map((v) => v.column), ['left', 'center', 'right'])
  let sideUnverified = false

  if (row !== 'unclear' && (column === 'left' || column === 'right')) {
    // Mirror check, run on the latest frame that voted for the winning side.
    const decider = [...votes].reverse().find((v) => v.column === column)
    const mirrored = parseScore(await askPlacement(sdk, modelId, await flipFrame(decider.frame)))
    const expected = column === 'left' ? 'right' : 'left'
    console.log(`[qvac] placement mirror check: column=${mirrored.column} (expected ${expected})`)
    if (mirrored.column !== expected) {
      column = 'center'
      sideUnverified = true
    }
  } else if (row !== 'unclear' && column === 'unclear') {
    // Height is known but the side is not — score through the center column
    // instead of dropping a visible goal all the way to "unclear".
    column = 'center'
    sideUnverified = true
  }

  // Prefer the explanation of a vote that matches the final verdict; fall
  // back to the latest vote that agreed on the row, then to the last vote.
  const chosen =
    [...votes].reverse().find((v) => v.row === row && v.column === column) ||
    [...votes].reverse().find((v) => v.row === row) ||
    votes[votes.length - 1]

  return { row, column, explanation: chosen?.explanation ?? '', sideUnverified }
}

// One single-frame placement question, grammar-locked to the row/column enums.
function askPlacement (sdk, modelId, framePath) {
  return runCompletion(sdk, modelId, {
    history: [{
      role: 'user',
      content: PLACEMENT_PROMPT,
      attachments: [{ path: framePath }],
    }],
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'placement_zone', schema: placementField },
    },
  })
}

// Majority vote counting only the allowed (clear) values; ties resolve to the
// value backed by the latest frame. 'unclear' when no frame answered clearly.
function majority (values, allowed) {
  const counts = new Map()
  for (const v of values) {
    if (allowed.includes(v)) counts.set(v, (counts.get(v) || 0) + 1)
  }
  let best = 'unclear'
  let bestCount = 0
  for (const v of [...values].reverse()) {
    if (counts.has(v) && counts.get(v) > bestCount) {
      best = v
      bestCount = counts.get(v)
    }
  }
  return best
}

// Horizontally mirrored copy of a frame for the chirality check, written next
// to the source frame so it lives and dies with the extraction directory.
async function flipFrame (framePath) {
  const out = framePath.replace(/\.png$/i, '.mirror.png')
  if (!fs.existsSync(out)) {
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', framePath, '-vf', 'hflip', out,
    ])
  }
  return out
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
// Placement is special: its zone comes from the vision pass, never the judge,
// and its score is looked up in PLACEMENT_ZONE_SCORES so the number can never
// contradict the zone.
function finalizeScore (parsed, placement, meta) {
  const scores = {}
  for (const field of JUDGED_FIELDS) {
    const raw = parsed?.[field] || {}
    scores[field] = {
      score: clampScore(raw.score),
      explanation: String(raw.explanation ?? '').trim() || '(no explanation returned)',
    }
  }

  // The zone key is composed from the two vision commitments. Any 'unclear'
  // row or column (or anything that somehow slipped past the enum grammar)
  // fails the table lookup and maps to the lowest-value cell, same treatment
  // as before for unknown placement.
  const composed = `${placement?.row}_${placement?.column}`
  const unclear = PLACEMENT_ZONE_SCORES[composed] === undefined
  const zone = unclear ? UNCLEAR_ZONE : composed
  let explanation = String(placement?.explanation ?? '').trim() || '(no explanation returned)'
  if (unclear) {
    explanation = `Ball's entry into the goal was unclear, scored as ${zone.replace('_', ' ')}. ${explanation}`
  } else if (placement?.sideUnverified) {
    explanation = `${explanation} (Which side of the goal could not be verified from the frames, so the shot is scored through the center of its row.)`
  }
  scores.placement = { score: PLACEMENT_ZONE_SCORES[zone], zone, explanation }

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
  classifyPlacement,
  compareClips,
}
