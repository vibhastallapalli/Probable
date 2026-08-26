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

const {
  PLACEMENT_ISSUES,
  assessPlacementEvidence,
  buildPlacementFeedback,
  selectPlacementRecoveryFrames,
} = require('./placement-policy')

// ---------------------------------------------------------------------------
// Scoring prompts — tune the rubric here. Scoring runs in three stages so the
// model commits to what it can actually see before it judges anything:
//
//   Stage 1 (placement readiness, one image per call): each tail image reports
//   ball visibility, full-goal visibility, ball/goal relation, row, and
//   column. At least two usable observations and a strict majority are
//   required. A failed first attempt gets one targeted retry with unused
//   nearby moments. A left/right verdict is checked on a mirrored image. If
//   the model preserves every visual invariant and still sees an off-centre
//   finish but cannot flip left/right reliably, only the direction is
//   discarded and the result becomes a direction-neutral side zone. A loss
//   of the ball, goal, row, or side-vs-centre distinction stays unresolved.
//   Stage 2 (describe, frames attached): report only what is literally visible
//   in the sampled frames — including how far the shooter stands from the
//   goal, how fast the shot travels, and the kicking foot at contact. No
//   opinions, no scores, no football knowledge.
//   Stage 3 (judge, text only): score skill/difficulty/aesthetic from the
//   stage-2 description plus the stage-1 zone, handed over as a settled fact
//   so all three criteria reason about the same finishing spot instead of
//   each re-guessing it from the description. Every point still traces back
//   to something the model claimed to see rather than to what usually
//   happens in highlights.
//
// On top of the per-clip passes, a match is decided by a HEAD-TO-HEAD pass
// (compareHeadToHead): both clips' key frames go into one call and the model
// answers direct either/or questions — whose shot flew faster, whose strike
// was cleaner. Scoring each clip alone kept producing near-identical numbers
// because the model never had the other clip in view to notice the
// differences; asking it to pick between two shots it can see side by side
// is a far easier judgment for a small VLM than assigning absolute ratings
// from memory of a rubric.
//
// "Whose finish looked better" was a third question here and is now gone.
// Spectacle is a taste call, not something a 2B VLM can read off seven
// stills, and on real pairs it handed the win to the scuffier shot often
// enough to be worse than no signal. What survives are the questions with a
// physical answer in the pixels.
//
// PLACEMENT COUNTS DOUBLE (PLACEMENT_WEIGHT), both in a clip's total and as
// a head-to-head dimension win. Picking your spot in the goal is the hardest
// thing in the clip and the only dimension decided by a deterministic,
// mirror-checked vision pass instead of the model's shakier either/or
// judgment — so pace and strike cleanliness, which it wobbles on, can no
// longer outvote it on their own.
//
// Two safeguards keep that judgment honest, both in the spirit of the
// placement pass's mirror check:
// - ORDER CHECK: the question call runs twice, once with each clip first.
//   A pick only counts when the two runs agree (the answers mirror); a pick
//   that sticks to whichever clip came first is positional bias, observed on
//   real runs, and degrades to "equal" instead of settling money.
// - DISTANCE PROBE: "who shot from farther out" is NOT asked across the two
//   frame sequences at all — on real runs that answer glued itself to the
//   first clip in every single call, and a side-by-side composite variant
//   glued itself to the left half. Relative distance questions are beyond
//   this model. Instead each clip is judged ALONE on a closed stride scale
//   (under 5 / 5-10 / 10-20 / over 20 strides from goal), asked on two
//   different pre-shot moments that must agree, and the two clips' buckets
//   are compared in code. Absolute closed-choice questions on single
//   images with a consistency vote are exactly what this model has already
//   proven it can do in the placement pass, and judging each clip alone
//   removes the positional confound by construction.
// Placement is NOT re-asked either: each clip's zone verdict (the
// deterministic, mirror-checked pass above) is reused, and the zones' table
// scores decide who wins the placement dimension.
//
// Every "why" text shown to players must read like a person casually
// describing the shot to a friend: the prompts and the fallback strings
// below ban frame/grid/row/column/cell talk and any narration of the
// analysis process.
//
// GROUNDING_RULES rides along on the describe and placement prompts (the
// passes that see images). The judge pass carries its own text-only ground
// rules inside JUDGE_RUBRIC, because its explanations are player-facing and
// must not narrate uncertainty the way the vision passes are told to.
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
- how far from the goal the shooter appears to be at the moment the shot is
  struck, judged by how much ground is visible between the player and the
  goal — close range, medium range, or long range
- how fast the shot appears to travel, judged by how much distance the ball
  covers between consecutive frames — a slow roller, medium pace, or struck
  hard
- the kicking foot and leg at the moment of contact, if visible, and the
  kind of contact you can actually see — side foot, laces, toe poke, volley,
  header, or whatever it actually is. If the foot or the contact moment is
  not clearly visible, say so plainly instead of guessing
- the goal, if one is visible, and whether the ball ends up in it
- the pitch, surroundings, and camera view, briefly

Write 8 to 14 short factual sentences. No opinions, no scores, no praise.
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
- difficulty: how hard the action was to pull off — distance from goal,
  angle, shot speed, pressure from defenders, body position, and
  improvisation required.
- aesthetic: the visual beauty and spectacle of the play — how impressive or
  memorable it looks as a piece of football.

Base every judgment ONLY on what the description says and on the settled
finishing spot given above it, not on general football knowledge and not on
what usually happens in highlight clips. If the description does not mention
defenders or a goalkeeper, treat them as absent and judge difficulty
accordingly. Where the description reports how far out the shooter was, how
fast the shot traveled, or what kind of foot contact was made, use those
reports directly: distance and shot speed belong in the difficulty judgment,
foot contact and strike type in the skill judgment.

For each criterion write a short (one to two sentence) explanation. These
explanations are shown to the players to justify the result, and each one
must read like a person casually describing the shot to a friend — plain
everyday football language only. Never use the words frame, frames, grid,
row, column, or cell. Never describe how the clip was analyzed, and never
say that something could not be verified, was unclear, or was assumed. If
you are not sure about a detail, give your best natural read of it in plain
words instead of talking about the uncertainty.

Each explanation must cover its own ground, and no two of them may say the
same thing:
- skill: talk specifically about the player's touch, technique, and control
  of the ball, including the kind of contact on the strike if it is
  described.
- difficulty: talk specifically about how far out the shot was taken, the
  angle, how fast the ball traveled, and any pressure or defenders.
- aesthetic: talk specifically about the overall spectacle and flair — what
  makes the play striking or plain to watch.

Ground rules: mention only people, objects, and events the description
reports. Never invent players, a goalkeeper, defenders, or a crowd it does
not mention, and do not fill gaps with general football knowledge.`

// The zone is decided once by the placement pass and handed to the judge as
// a settled fact, so skill, difficulty, and aesthetic all reason about the
// same finishing spot instead of each re-guessing it from the description —
// four independent guesses used to contradict each other and the placement
// score.
function placementFactLine (zone) {
  return `\n\nOne fact is already settled: the shot went ${PLACEMENT_ZONE_PHRASES[zone]}. ` +
    'Treat that as exactly where the ball ended up, even if the description ' +
    'above reads differently, and weigh it when judging all three criteria.'
}

// Placement pass prompt — sent with ONE tail frame attached per call, so the
// zone is decided by a pass that can actually see the ball against the goal
// frame, one concrete image at a time. The judge pass never picks the zone;
// it can't see anything.
const PLACEMENT_PROMPT = `You are looking at one still frame from the end of a short football (soccer)
clip, at or just after the moment a shot reaches the goal. The ball may be in
flight, crossing the line, or already in the net.

First report the visual evidence. These fields are separate so that a missing
ball, an incomplete goal, and a disagreement about placement never get treated
as the same problem.

ball_visibility — whether you can locate the actual football:
- visible: the ball itself can be located
- not_visible: the ball itself cannot be seen
- unclear: a possible ball is present, but you cannot distinguish it reliably

goal_visibility — whether the goal mouth can be used as a complete reference:
- full: the crossbar and both goalposts are visible enough to divide the goal
- partial: only part of that goal frame is visible
- not_visible: no usable goal is visible
- unclear: you cannot tell whether the complete goal frame is present

ball_goal_relation — what the visible ball is doing relative to the goal:
- in_or_entering: the ball is inside, crossing into, or clearly entering the goal
- outside: the ball is visibly outside and not entering the goal
- unclear: the ball's relationship to the goal cannot be determined

Only when the ball is visible, the full goal is visible, and the ball is in or
entering the goal, report its position as a row and a column. Otherwise answer
unclear for both row and column.

Everything is from the CAMERA'S point of view — the picture exactly as you
see it. Never answer from the shooter's or the goalkeeper's point of view.

row — the ball's height:
- top: in the top third of the goal, near the crossbar
- mid: in the middle third, clearly below the crossbar and clearly above
  the ground
- bottom: in the bottom third, on or near the ground
- unclear: the evidence conditions above were not all satisfied

column — the ball's side of the goal:
- left: near the goalpost closer to the LEFT edge of the picture
- center: near the middle of the goal, away from both posts
- right: near the goalpost closer to the RIGHT edge of the picture
- unclear: the evidence conditions above were not all satisfied

Then, in one or two sentences, say where the shot ended up the way you
would casually tell a friend — for example "curled into the top left
corner" or "rolled in low through the middle". Plain everyday football
words only: never use the words frame, image, grid, row, column, or cell,
and never describe how you worked the answer out.
${GROUNDING_RULES}`

// Head-to-head prompt — sent with BOTH clips' key frames attached (the
// first clip's frames, then the second's). Direct either/or questions
// instead of absolute ratings: a small VLM that scores two solo clips
// almost identically can still tell which of two shots it can see side by
// side travels faster. The image counts are spelled out so the model never
// mixes up whose shot is whose, and the whole call runs twice with the
// clip order swapped — only answers that mirror across the two runs count.
// Distance is deliberately NOT asked here (see DISTANCE_PROMPT).
function buildComparePrompt (countA, countB) {
  return `You are looking at still frames from TWO different short football (soccer)
clips. Each clip shows one player taking one shot at a goal.

The first ${countA} images are ordered moments from PLAYER A's clip, start to
finish. The remaining ${countB} images are ordered moments from PLAYER B's
clip, start to finish. Keep careful count so you never mix the two shots up.

Compare the two shots directly and answer two questions. For each one pick
"A" if it is true of Player A's shot, "B" if it is true of Player B's shot,
or "equal" ONLY if the two shots genuinely look the same on that point.

1. faster_shot: Whose shot travels FASTER? Judge by how much distance the
   ball covers from one moment to the next in each clip.
2. cleaner_strike: Whose strike is the CLEANER contact — a properly struck
   side-foot or laces hit, rather than a scrappy toe poke or a mishit?

For each answer also give one short reason, worded the way a person would
casually say it out loud to a friend — for example "he absolutely leathered
it, the keeper would have no chance". Plain everyday football words only:
never use the words frame, frames, image, grid, row, column, or cell, and
never describe how you compared the clips.
${GROUNDING_RULES}`
}

// Distance probe prompt — sent with ONE pre-shot frame from ONE clip. Each
// clip is judged alone on a closed stride scale, on two different pre-shot
// moments that must agree; the two clips' buckets are then compared in
// code. Relative "who is farther" questions proved positional on real runs
// (across two frame sequences AND across a side-by-side composite), so
// distance is decided the way placement is: absolute closed choices on
// single images, held to a consistency vote.
const DISTANCE_PROMPT = `You are looking at one still moment from a short football (soccer) clip.
A player is on the pitch with a ball, before or during a shot at a goal.

Find the player who is shooting and the goal they are shooting toward.
Judge how far the player is standing from the goal line, measured in the
big strides a grown adult would need to walk from the player straight to
the goal.

Answer with exactly one of:
- under_5: fewer than 5 strides — right on top of the goal
- 5_to_10: between 5 and 10 strides — close range
- 10_to_20: between 10 and 20 strides — medium range
- over_20: more than 20 strides — long range

Then give one short reason in plain everyday football words, the way a
person would casually say it to a friend. Never use the words frame,
image, picture, grid, row, column, or cell, and never describe how you
worked the answer out.
${GROUNDING_RULES}`

// The 9 exact cells of the goal-mouth grid (3 rows x 3 columns, split by the
// crossbar and goalposts) and three internal direction-neutral side zones.
// The latter are used only when a mirror test preserves row and off-centre
// placement but cannot verify exact left/right chirality. Left and right have
// identical point values, so discarding direction never changes the score.
//
// HEIGHT DOMINATES SIDE. Getting the ball up under the crossbar takes a
// struck, lifted shot; a bottom corner can be reached by rolling it past a
// keeper's feet. The old table ranked bottom corners (8) above top center
// (5), which is why a lifted finish into the top middle lost the placement
// dimension to a low roller in the corner — the exact complaint this table
// is tuned to fix. Every top-row cell now outranks every bottom-row one.
const PLACEMENT_ZONE_SCORES = {
  top_left: 10,
  top_right: 10,
  top_side: 10,
  top_center: 8,
  bottom_left: 6,
  bottom_right: 6,
  bottom_side: 6,
  mid_left: 5,
  mid_right: 5,
  mid_side: 5,
  mid_center: 3,
  bottom_center: 2,
}

// Placement counts double everywhere a score is added up or a dimension is
// won. Picking your spot in the goal is the hardest thing in the clip and
// the one thing this model reads reliably; shot pace and strike cleanliness
// are the metrics it wobbles on, so they no longer outvote it.
const PLACEMENT_WEIGHT = 2

// Highest total sumScores can return: skill + difficulty + aesthetic at 10
// each, plus a weighted placement. The renderer shows totals out of this.
const MAX_TOTAL = 30 + 10 * PLACEMENT_WEIGHT

// Keep mock scoring on the ordinary nine-cell grid. Direction-neutral zones
// are evidence fallbacks, so they should only appear after a real mirror check.
const PLACEMENT_ZONES = [
  'top_left', 'top_center', 'top_right',
  'mid_left', 'mid_center', 'mid_right',
  'bottom_left', 'bottom_center', 'bottom_right',
]

// Plain-words rendering of each zone, used wherever a zone is spoken about
// in player-facing text (the judge's settled-fact line and the placement
// "why" fallback). Phrased to follow "the ball went ..." / "the shot went
// ...", so internal zone keys never leak into what players read.
const PLACEMENT_ZONE_PHRASES = {
  top_left: 'into the top left corner',
  top_right: 'into the top right corner',
  top_side: 'in high toward one side of the goal',
  bottom_left: 'in low by the left post',
  bottom_right: 'in low by the right post',
  bottom_side: 'in low toward one side of the goal',
  mid_left: 'in at waist height on the left side',
  mid_right: 'in at waist height on the right side',
  mid_side: 'in at waist height toward one side of the goal',
  top_center: 'in high through the middle',
  mid_center: 'in through the middle of the goal',
  bottom_center: 'in low through the middle',
}

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
    ball_visibility: { type: 'string', enum: ['visible', 'not_visible', 'unclear'] },
    goal_visibility: { type: 'string', enum: ['full', 'partial', 'not_visible', 'unclear'] },
    ball_goal_relation: { type: 'string', enum: ['in_or_entering', 'outside', 'unclear'] },
    row: { type: 'string', enum: ['top', 'mid', 'bottom', 'unclear'] },
    column: { type: 'string', enum: ['left', 'center', 'right', 'unclear'] },
    explanation: { type: 'string' },
  },
  required: [
    'ball_visibility',
    'goal_visibility',
    'ball_goal_relation',
    'row',
    'column',
    'explanation',
  ],
  additionalProperties: false,
}

// One head-to-head answer: a hard A/B/equal commitment plus a short spoken
// reason. `pick` comes before `reason` so the grammar forces the commitment
// first, same trick as the placement row/column ordering.
const comparePickField = {
  type: 'object',
  properties: {
    pick: { type: 'string', enum: ['A', 'B', 'equal'] },
    reason: { type: 'string' },
  },
  required: ['pick', 'reason'],
  additionalProperties: false,
}

// The two direct questions the head-to-head call must answer. Placement is
// deliberately absent — it comes from each clip's zone verdict — and so is
// distance, which gets its own single-image probe (DISTANCE_PROMPT).
//
// "Whose finish is more spectacular" used to be asked here as a tiebreaker.
// It is gone: judging spectacle is a taste call this model has no business
// making from seven stills, and on real pairs it happily crowned a scuffed
// low roller. A tie now falls straight to the scorecards.
const COMPARE_SCHEMA = {
  type: 'object',
  properties: {
    faster_shot: comparePickField,
    cleaner_strike: comparePickField,
  },
  required: ['faster_shot', 'cleaner_strike'],
  additionalProperties: false,
}

// Distance probe answer: a hard stride-bucket commitment plus a short
// spoken reason, bucket first so the grammar forces the commitment.
const STRIDE_BUCKETS = ['under_5', '5_to_10', '10_to_20', 'over_20']

const distanceField = {
  type: 'object',
  properties: {
    strides: { type: 'string', enum: STRIDE_BUCKETS },
    reason: { type: 'string' },
  },
  required: ['strides', 'reason'],
  additionalProperties: false,
}

// Plain-words rendering of each stride bucket for composed distance reasons.
const STRIDE_BUCKET_PHRASES = {
  under_5: 'right on top of the goal',
  '5_to_10': 'close range',
  '10_to_20': 'medium range',
  over_20: 'long range',
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

// One bounded visual recovery attempt polls additional frames that were
// already extracted but were not part of the initial placement vote.
const PLACEMENT_RECOVERY_FRAME_COUNT =
  Number(process.env.QVAC_PLACEMENT_RECOVERY_FRAMES) || 3

// A failed or malformed single-frame model response is retried once against
// the same evidence. This is a system recovery, not a clip-quality judgment.
const PLACEMENT_CALL_ATTEMPTS = 2

// How many key frames per clip the head-to-head pass sends. Both clips must
// share one context window: at the FRAME_MAX_EDGE cap a 16:9 frame costs
// ~576 vision tokens, so 7+7 frames is ~8k tokens — comfortable inside the
// Qwen3-VL 16384 window with the prompt and answer, and still enough frames
// to cover the pre-kick stance, the contact, and the ball in flight for
// both shots. Selection skips the earliest run-up (see
// selectComparisonFrames).
const COMPARE_FRAME_COUNT = Number(process.env.QVAC_COMPARE_FRAMES) || 7

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
 * Three stages: the model first checks whether placement has enough visual
 * evidence, including one bounded recovery attempt when needed. Only a clip
 * with resolved placement proceeds to the description and judge passes.
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
// WHAT THIS DOES: Checks placement evidence first, then describes and judges
//   only a clip that passed that gate.
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

  // Start every clip from a clean KV cache. runCompletion clears after each
  // call, but if a previous clip's final clear ever failed silently, this
  // guarantees the describe pass here does not inherit that leftover context
  // and overflow the window partway through a batch.
  await clearCache(sdk)

  const baseMeta = {
    frameCount: frames.length,
    frames,
    duration: metadata.duration || 0,
    model: MODEL_INFO.id,
    mock: false,
  }

  // Stage 1 — placement readiness. Every frame returns explicit scene
  // evidence as well as row/column. A lone answer cannot settle the result;
  // an unresolved first attempt gets one targeted retry with unused frames.
  const placement = await classifyPlacement(sdk, modelId, frames, metadata)
  if (placement.status === 'UNRESOLVED') {
    return {
      status: 'NEEDS_BETTER_CLIP',
      issue: placement.feedback,
      placement: {
        status: placement.status,
        issues: placement.issues,
        evidence: placement.evidence,
      },
      ...baseMeta,
    }
  }

  const { zone } = resolveZone(placement)
  if (!zone) {
    throw new Error('Resolved placement did not map to a valid goal zone')
  }

  const durationLine = metadata.duration
    ? `\nClip duration: ${metadata.duration.toFixed(1)}s across ${frames.length} sampled frames.`
    : `\n${frames.length} sampled frames.`

  // Stage 2 — describe. Frames attached, free text out. This expensive pass
  // is skipped entirely when placement evidence is unresolved.
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

  // Stage 3 — judge skill/difficulty/aesthetic from the description plus the
  // settled zone (no frames), grammar-constrained to the score schema.
  const judged = await runCompletion(sdk, modelId, {
    history: [{
      role: 'user',
      content: JUDGE_PROMPT_PREFIX + description + placementFactLine(zone) + JUDGE_RUBRIC,
    }],
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'clip_score', schema: SCORE_SCHEMA },
    },
  })

  const parsed = parseScore(judged)

  return finalizeScore(parsed, placement, {
    status: 'SCORED',
    placementReport: {
      status: placement.status,
      evidence: placement.evidence,
      directionVerified: placement.directionVerified,
      directionNeutral: placement.directionNeutral,
    },
    ...baseMeta,
  })
}

// Wipe the worker's KV cache. The worker accumulates KV cache across
// completion() calls on the same modelId; without clearing it the next
// prompt stacks on top of the previous context and eventually overflows the
// window. deleteCache can report failure through a { success: false } RESULT
// without throwing, so a bare try/catch that only guards against a thrown
// error would treat a silently-failed clear as a success — exactly how
// context creeps across clips until one overflows. Check the flag and log a
// real failure instead of assuming the cache is clean.
async function clearCache (sdk) {
  try {
    const res = await sdk.deleteCache({ all: true })
    if (res && res.success === false) {
      console.warn(`[qvac] deleteCache reported failure: ${res.error || 'unknown'}`)
    }
  } catch (err) {
    console.warn(`[qvac] deleteCache threw: ${err.message}`)
  }
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
    //
    // predict caps the tokens generated per pass so a dark / low-signal clip
    // (e.g. a night shot) cannot send the greedy describe pass into an endless
    // repetition loop that fills the whole context window and dies with a
    // CONTEXT_OVERFLOW. repeat_penalty discourages that loop from starting.
    // An honest description is 8-14 sentences (~350 tokens); 768 leaves room
    // for the judge's three explanations while still capping a runaway well
    // short of the 16k ceiling.
    generationParams: { temp: 0, predict: 768, repeat_penalty: 1.15 },
    ...(responseFormat ? { responseFormat } : {}),
  })

  let final
  try {
    final = await run.final
  } catch (err) {
    // The QVAC worker is a separate process and it does occasionally die
    // mid-request (WORKER_CRASHED). `_qvac` caches its modelId process-wide,
    // so without dropping the handle here every later call would keep talking
    // to a corpse: one flaky crash would brick scoring for the rest of the
    // session and every clip after it would fail with the same error. Drop
    // the handle so the next call reloads the model, and skip the cache clear
    // because there is no worker left to clear.
    if (isWorkerDead(err)) {
      console.warn('[qvac] worker died mid-request — dropping the model handle so the next call reloads it')
      _qvac = null
      throw err
    }
    await clearCache(sdk)
    throw err
  }
  await clearCache(sdk)

  // QVAC's CompletionFinal exposes the assistant text as `contentText`
  // (with the unparsed original at `raw.fullText`).
  return String(final.contentText ?? final.raw?.fullText ?? '')
}

// Whether an error means the worker process is gone, rather than the model
// having refused or overflowed. Matched on both the SDK's numeric code and
// the message, since only the message is stable across SDK versions.
function isWorkerDead (err) {
  return err?.code === 50205 || /WORKER_CRASHED|worker exited/i.test(String(err?.message ?? ''))
}

/**
 * Resolve placement from repeated, structured evidence.
 *
 * The initial three tail frames must provide at least two usable observations
 * and a strict row/column majority. A failed initial attempt gets one bounded
 * visual recovery using additional frames chosen for the observed failure.
 * A left/right result is also checked under a mirror transformation. Exact
 * chirality must flip. If all invariant facts survive and both observations
 * remain off-centre, the system may retain only the direction-neutral side
 * class because left and right carry identical points. Nothing here converts
 * missing or contradictory visual evidence into a real goal zone.
 */
// WHAT THIS DOES: Collects several independent observations, retries once
//   with unused frames when needed, and returns CLEAR, RECOVERED, or
//   UNRESOLVED with an evidence report.
async function classifyPlacement (sdk, modelId, frames, metadata = {}) {
  const initialFrames = frames.slice(-PLACEMENT_FRAME_COUNT)
  const initialVotes = await collectPlacementVotes(sdk, modelId, initialFrames)
  const failedMirrorFrames = new Set()
  const mirrorChecks = []

  const initial = await assessWithMirror(
    sdk,
    modelId,
    initialVotes,
    failedMirrorFrames
  )
  if (initial.mirror) mirrorChecks.push(initial.mirror)

  if (initial.assessment.ready) {
    return resolvedPlacement('CLEAR', initialVotes, initial.assessment, {
      initial: publicAssessment(initial.assessment),
      recovery: null,
      combined: publicAssessment(initial.assessment),
      mirrorChecks,
    })
  }

  const recoveryFrames = selectPlacementRecoveryFrames(
    frames,
    initialFrames,
    initial.assessment.issues,
    PLACEMENT_RECOVERY_FRAME_COUNT
  )
  const recoveryVotes = await collectPlacementVotes(sdk, modelId, recoveryFrames)
  const frameOrder = new Map(frames.map((frame, index) => [frame, index]))
  const combinedVotes = [...initialVotes, ...recoveryVotes]
    .sort((a, b) => (frameOrder.get(a.frame) ?? 0) - (frameOrder.get(b.frame) ?? 0))

  const combined = await assessWithMirror(
    sdk,
    modelId,
    combinedVotes,
    failedMirrorFrames
  )
  if (combined.mirror) mirrorChecks.push(combined.mirror)

  const evidence = {
    initial: publicAssessment(initial.assessment),
    recovery: publicAssessment(assessPlacementEvidence(recoveryVotes)),
    combined: publicAssessment(combined.assessment),
    mirrorChecks,
  }

  if (combined.assessment.ready) {
    return resolvedPlacement('RECOVERED', combinedVotes, combined.assessment, evidence)
  }

  return {
    status: 'UNRESOLVED',
    row: 'unclear',
    column: 'unclear',
    explanation: '',
    issues: combined.assessment.issues,
    evidence,
    feedback: buildPlacementFeedback(
      combined.assessment.issues,
      combined.assessment.counts,
      metadata
    ),
  }
}

async function collectPlacementVotes (sdk, modelId, frames) {
  const votes = []
  for (const frame of frames) {
    const vote = await askPlacementWithRetry(sdk, modelId, frame)
    votes.push({ frame, ...vote })
    console.log(
      `[qvac] placement evidence ${path.basename(frame)}: ` +
      `ball=${vote.ball_visibility} goal=${vote.goal_visibility} ` +
      `relation=${vote.ball_goal_relation} row=${vote.row} column=${vote.column}`
    )
  }
  return votes
}

// Retry a technical/model-output failure once against the exact same frame.
// If both attempts fail, the error propagates as a system failure; it is never
// turned into a claim about clip quality.
async function askPlacementWithRetry (sdk, modelId, frame) {
  let lastError
  for (let attempt = 1; attempt <= PLACEMENT_CALL_ATTEMPTS; attempt++) {
    try {
      return parseScore(await askPlacement(sdk, modelId, frame))
    } catch (err) {
      lastError = err
      console.warn(
        `[qvac] placement call failed for ${path.basename(frame)} ` +
        `(attempt ${attempt}/${PLACEMENT_CALL_ATTEMPTS}): ${err.message}`
      )
    }
  }

  const error = new Error(
    `Placement analysis failed after ${PLACEMENT_CALL_ATTEMPTS} attempts: ` +
    `${lastError?.message || 'unknown model error'}`
  )
  error.code = 'PLACEMENT_ANALYSIS_ERROR'
  throw error
}

async function assessWithMirror (sdk, modelId, votes, failedMirrorFrames) {
  const assessment = assessPlacementEvidence(votes)
  if (!assessment.ready) return { assessment, mirror: null }

  const mirror = await verifyPlacementMirror(
    sdk,
    modelId,
    votes,
    assessment,
    failedMirrorFrames
  )
  if (mirror.passed) {
    if (mirror.directionNeutral) {
      return {
        assessment: {
          ...assessment,
          column: 'side',
          directionNeutral: true,
          directionVerified: false,
          mirrorMismatch: true,
        },
        mirror,
      }
    }
    return {
      assessment: {
        ...assessment,
        directionNeutral: false,
        directionVerified: true,
      },
      mirror,
    }
  }

  if (mirror.frame) failedMirrorFrames.add(mirror.frame)
  return {
    assessment: {
      ...assessment,
      ready: false,
      row: 'unclear',
      column: 'unclear',
      issues: [PLACEMENT_ISSUES.PLACEMENT_DISAGREEMENT],
      mirrorMismatch: true,
      directionVerified: false,
      directionNeutral: false,
    },
    mirror,
  }
}

async function verifyPlacementMirror (sdk, modelId, votes, assessment, excludedFrames) {
  if (assessment.column === 'center') {
    return {
      required: false,
      passed: true,
      directionVerified: true,
      directionNeutral: false,
    }
  }

  const decider = [...votes].reverse().find((vote) =>
    vote.row === assessment.row &&
    vote.column === assessment.column &&
    !excludedFrames.has(vote.frame)
  )
  if (!decider) {
    return { required: true, passed: false, frame: null, reason: 'no_unused_decider' }
  }

  const mirrored = await askPlacementWithRetry(
    sdk,
    modelId,
    await flipFrame(decider.frame)
  )
  const expectedColumn = assessment.column === 'left' ? 'right' : 'left'
  const invariantsPassed =
    mirrored.ball_visibility === 'visible' &&
    mirrored.goal_visibility === 'full' &&
    mirrored.ball_goal_relation === 'in_or_entering' &&
    mirrored.row === assessment.row
  const exactDirectionPassed = invariantsPassed && mirrored.column === expectedColumn
  const sideClassPreserved = invariantsPassed &&
    (mirrored.column === 'left' || mirrored.column === 'right')
  const directionNeutral = !exactDirectionPassed && sideClassPreserved
  const passed = exactDirectionPassed || directionNeutral

  console.log(
    `[qvac] placement mirror check: row=${mirrored.row} ` +
    `column=${mirrored.column} (expected row=${assessment.row} column=${expectedColumn})` +
    (directionNeutral ? ' — exact side unverified; retaining direction-neutral side' : '')
  )

  return {
    required: true,
    passed,
    frame: decider.frame,
    expectedColumn,
    observedColumn: mirrored.column,
    observedRow: mirrored.row,
    invariantsPassed,
    directionVerified: exactDirectionPassed,
    directionNeutral,
    reason: exactDirectionPassed
      ? 'exact_direction_verified'
      : directionNeutral
        ? 'side_class_preserved_direction_unverified'
        : 'mirror_invariant_failed',
  }
}

function resolvedPlacement (status, votes, assessment, evidence) {
  const directionNeutral = assessment.column === 'side'
  const chosen = [...votes].reverse().find((vote) =>
    vote.ball_visibility === 'visible' &&
    vote.goal_visibility === 'full' &&
    vote.ball_goal_relation === 'in_or_entering' &&
    vote.row === assessment.row &&
    (directionNeutral
      ? vote.column === 'left' || vote.column === 'right'
      : vote.column === assessment.column)
  )
  return {
    status,
    row: assessment.row,
    column: assessment.column,
    // A raw explanation may name left or right. Do not expose that discarded
    // detail when the mirror check retained only the direction-neutral class.
    explanation: directionNeutral ? '' : (chosen?.explanation ?? ''),
    directionVerified: !directionNeutral,
    directionNeutral,
    issues: [],
    evidence,
  }
}

function publicAssessment (assessment) {
  return {
    ready: Boolean(assessment?.ready),
    row: assessment?.row || 'unclear',
    column: assessment?.column || 'unclear',
    issues: Array.isArray(assessment?.issues) ? assessment.issues : [],
    counts: assessment?.counts || {
      checked: 0,
      ballVisible: 0,
      goalFull: 0,
      ballAtGoal: 0,
      usable: 0,
      rowAgreement: 0,
      columnAgreement: 0,
    },
    requiredAgreement: Number(assessment?.requiredAgreement) || 2,
    mirrorMismatch: Boolean(assessment?.mirrorMismatch),
    directionVerified: assessment?.directionVerified === true,
    directionNeutral: Boolean(assessment?.directionNeutral),
  }
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
 * Compare two scored clips by total score.
 *
 * No longer the settlement decider: matches settle on compareHeadToHead's
 * verdict, which judges both clips side by side. This totals comparison
 * remains as supporting detail, as the last tiebreak when the head-to-head
 * dimensions all come out dead even, and as the fallback
 * for legacy score objects that carry no frame paths.
 *
 * @param {object} clipA - scoreClip() result for clip A.
 * @param {object} clipB - scoreClip() result for clip B.
 * @returns {object} { winner: 'A'|'B'|'tie', margin, totalA, totalB, breakdown }
 */
function compareClips (clipA, clipB) {
  if (!hasResolvedPlacement(clipA) || !hasResolvedPlacement(clipB)) {
    throw new Error('Clip comparison requires resolved placement for both clips')
  }
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
// Head-to-head comparison — the pass that actually decides a match
// ---------------------------------------------------------------------------

// The four dimensions a match is decided on, in the order they are reported.
// distance/speed/technique come from the model's either/or answers in the
// comparison call; placement is decided in code from the two zone verdicts.
const COMPARE_DIMENSIONS = ['distance', 'speed', 'technique', 'placement']

// Points a dimension win is worth. Placement pays double: it is the hardest
// thing to actually do in a clip and the only dimension decided by a
// deterministic, mirror-checked vision pass rather than the model's shakier
// either/or judgment. At weight 1 a clean top-corner finish kept losing 3-1
// to a low roller that the model happened to call faster and cleaner. Out of
// 5 available points, placement alone no longer wins a match, but it now
// takes two of the three model-answered dimensions to overturn it.
const COMPARE_DIMENSION_WEIGHTS = {
  distance: 1,
  speed: 1,
  technique: 1,
  placement: PLACEMENT_WEIGHT,
}

// Maps each model-answered dimension to its question key in COMPARE_SCHEMA.
// Distance is absent: it is answered by the composite-image probe.
const COMPARE_QUESTION_KEYS = {
  speed: 'faster_shot',
  technique: 'cleaner_strike',
}

// Words the model is banned from using in player-facing reasons. A reason
// that trips this is replaced with a composed fallback and logged as a
// prompt bug, same policy as the placement pass's composed explanations.
const BANNED_REASON_WORDS = /\b(frames?|images?|pictures?|hal(f|ves)|dividers?|grids?|rows?|columns?|cells?)\b/i

// Composed fallback reasons, used when the model's reason narrates the
// analysis despite the prompt. Keyed by dimension, then by pick.
const FALLBACK_REASONS = {
  distance: {
    A: 'Player A takes his shot from further out.',
    B: 'Player B takes his shot from further out.',
    equal: 'Both shots look about the same distance out.',
  },
  speed: {
    A: 'Player A hits the quicker, harder shot.',
    B: 'Player B hits the quicker, harder shot.',
    equal: 'The two shots travel at about the same pace.',
  },
  technique: {
    A: 'Player A catches his strike more cleanly.',
    B: 'Player B catches his strike more cleanly.',
    equal: 'Both strikes look equally clean.',
  },
}

// What each dimension win means, in spoken words, for the verdict summary.
const DIMENSION_WIN_PHRASES = {
  distance: 'shot from further out',
  speed: 'hit the faster shot',
  technique: 'struck it cleaner',
  placement: 'found the better spot in the goal',
}

/**
 * Whether two score objects carry everything a head-to-head needs: the
 * extracted frame paths, still present on disk, and a placement zone each.
 * Settlement uses this to fall back to the totals comparison for legacy
 * scores instead of failing the match.
 */
function canCompareHeadToHead (clipA, clipB) {
  return [clipA, clipB].every((clip) =>
    hasResolvedPlacement(clip) &&
    Array.isArray(clip?.frames) &&
    clip.frames.length > 0 &&
    clip.frames.every((p) => typeof p === 'string' && fs.existsSync(p))
  )
}

// A failed readiness report can never masquerade as a scored clip. Legacy
// score objects without the new top-level status remain valid only when they
// still carry a real zone from the fixed table.
function hasResolvedPlacement (clip) {
  const zone = clip?.scores?.placement?.zone
  return clip?.status !== 'NEEDS_BETTER_CLIP' &&
    Object.prototype.hasOwnProperty.call(PLACEMENT_ZONE_SCORES, zone)
}

/**
 * Pick the key frames one clip contributes to the head-to-head call.
 *
 * Skips the earliest quarter of the extracted frames (pure run-up, no signal
 * for any of the four questions), then spreads evenly through the rest and
 * always keeps the final frame — covering the pre-kick stance, the moment of
 * contact, and the ball in flight, which is exactly what the distance, speed,
 * and technique questions need. Deterministic, so the same two clips always
 * produce the same call.
 *
 * @param {string[]} frames - Ordered frame paths from extractFrames().
 * @param {number} [count] - How many frames to keep.
 * @returns {string[]} Ordered subset of frames.
 */
function selectComparisonFrames (frames, count = COMPARE_FRAME_COUNT) {
  if (frames.length <= count) return [...frames]
  const start = Math.floor(frames.length / 4)
  const span = frames.length - 1 - start
  const picked = new Set()
  for (let i = 0; i < count; i++) {
    picked.add(frames[start + Math.round((i * span) / (count - 1))])
  }
  return [...picked]
}

/**
 * Judge two scored clips head to head and produce the match verdict.
 *
 * The question call (whose shot flew faster, whose strike was cleaner) sees
 * both clips' key frames together and runs TWICE, once with each clip
 * first; an answer only counts when the two runs mirror each other, so a
 * pick that just favors whichever clip came first degrades to "equal".
 * Distance gets its own probe: each clip is judged ALONE on a closed stride
 * scale, on two pre-shot moments that must agree, and the buckets are
 * compared in code. Placement is not re-asked: the two clips' zone verdicts
 * are compared by their table scores (top corner beats bottom corner beats
 * center).
 *
 * Distance, speed, and technique award one point each and placement awards
 * PLACEMENT_WEIGHT (2), out of 5; most points wins. A points tie falls to
 * the scorecard totals, then to a genuine tie.
 *
 * Greedy decoding (temp 0, inherited from runCompletion) keeps the verdict
 * reproducible — the same two clips must produce the same winner when money
 * settles on it.
 *
 * @param {object} clipA - scoreClip() result for Player A (must carry frames).
 * @param {object} clipB - scoreClip() result for Player B (must carry frames).
 * @param {object} [opts]
 * @param {string[]} [opts.framesA] - Override frame paths for clip A.
 * @param {string[]} [opts.framesB] - Override frame paths for clip B.
 * @returns {Promise<object>} Verdict:
 *   { winner: 'A'|'B'|'tie', summary, points: {a, b}, maxPoints,
 *     dimensions: { distance|speed|technique: {winner, reason},
 *                   placement: {winner, reason, zoneA, zoneB} },
 *     tiebreak: null|'totals',
 *     totals: {a, b}, frameCounts: {a, b}, model, mock }
 */
async function compareHeadToHead (clipA, clipB, opts = {}) {
  if (!hasResolvedPlacement(clipA) || !hasResolvedPlacement(clipB)) {
    throw new Error('Head-to-head judging requires resolved placement for both clips')
  }
  const framesA = opts.framesA || clipA?.frames
  const framesB = opts.framesB || clipB?.frames
  if (!Array.isArray(framesA) || framesA.length === 0 ||
      !Array.isArray(framesB) || framesB.length === 0) {
    throw new Error('compareHeadToHead needs both clips’ extracted frame paths')
  }

  const pickedA = selectComparisonFrames(framesA)
  const pickedB = selectComparisonFrames(framesB)
  const meta = {
    frameCounts: { a: pickedA.length, b: pickedB.length },
    model: MODEL_INFO.id,
    mock: false,
  }

  if (process.env.QVAC_MOCK_SCORING === '1') {
    return buildVerdict(mockModelDimensions(clipA, clipB), clipA, clipB, {
      ...meta, model: 'mock', mock: true,
    })
  }

  const { sdk, modelId } = await getModel()

  // Same clean-slate guarantee as scoreClip: these calls must never inherit
  // leftover context from a previous clip's passes.
  await clearCache(sdk)

  // Order check: the same questions with the clips in both orders. In the
  // swapped run "A" means clipB, so its picks are mirrored before comparing.
  const forward = await askComparison(sdk, modelId, pickedA, pickedB)
  const reversed = await askComparison(sdk, modelId, pickedB, pickedA)
  console.log('[qvac] head-to-head forward: ' + JSON.stringify(forward))
  console.log('[qvac] head-to-head reversed: ' + JSON.stringify(reversed))

  const modelDimensions = {}
  for (const [dim, key] of Object.entries(COMPARE_QUESTION_KEYS)) {
    modelDimensions[dim] = reconcileOrders(dim, forward[key], reversed[key])
  }

  // Distance probe: each clip's pre-shot moments judged alone on the
  // stride scale, buckets compared in code.
  modelDimensions.distance = await probeDistance(sdk, modelId, pickedA, pickedB)

  return buildVerdict(modelDimensions, clipA, clipB, meta)
}

// One run of the three-question comparison call, grammar-locked to
// COMPARE_SCHEMA. The first clip's frames are presented as Player A.
async function askComparison (sdk, modelId, firstFrames, secondFrames) {
  return parseScore(await runCompletion(sdk, modelId, {
    history: [{
      role: 'user',
      content: buildComparePrompt(firstFrames.length, secondFrames.length),
      attachments: [...firstFrames, ...secondFrames].map((p) => ({ path: p })),
    }],
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'head_to_head', schema: COMPARE_SCHEMA },
    },
  }))
}

// A↔B mirror for the swapped run's picks.
function mirrorPick (pick) {
  return pick === 'A' ? 'B' : pick === 'B' ? 'A' : 'equal'
}

// An answer survives the order check only when the swapped run points at
// the same actual clip. Anything else — including one run saying "equal" —
// is treated as the model failing to genuinely separate the shots, and the
// dimension scores as equal with a composed reason.
function reconcileOrders (dimension, forwardAnswer, reversedAnswer) {
  const fwd = normalizeAnswer(dimension, forwardAnswer)
  const rev = normalizeAnswer(dimension, reversedAnswer)
  const mirrored = mirrorPick(rev.pick)
  if (fwd.pick !== 'equal' && fwd.pick === mirrored) {
    return { winner: fwd.pick, reason: fwd.reason }
  }
  if (fwd.pick === 'equal' && rev.pick === 'equal') {
    return { winner: 'equal', reason: fwd.reason }
  }
  console.warn(
    `[qvac] head-to-head ${dimension} failed the order check ` +
    `(forward=${fwd.pick}, reversed=${rev.pick}) — scoring it equal`
  )
  return { winner: 'equal', reason: FALLBACK_REASONS[dimension].equal }
}

// One stride question against one frame, grammar-locked to the bucket enum.
async function askStrides (sdk, modelId, framePath) {
  return parseScore(await runCompletion(sdk, modelId, {
    history: [{
      role: 'user',
      content: DISTANCE_PROMPT,
      attachments: [{ path: framePath }],
    }],
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'distance_probe', schema: distanceField },
    },
  }))
}

// One clip's stride bucket: two different pre-shot moments are asked
// independently and must agree, the same consistency bar the placement
// pass holds its votes to. Disagreement means the model cannot pin this
// clip's distance down, reported as null.
async function clipStrideBucket (sdk, modelId, pickedFrames, label) {
  const probes = pickedFrames.slice(0, 2)
  const answers = []
  for (const frame of probes) {
    answers.push(await askStrides(sdk, modelId, frame))
  }
  const agreed = answers.every((a) => a.strides === answers[0].strides)
  const bucket = agreed ? answers[0].strides : null
  console.log(
    `[qvac] stride probe ${label}: ${answers.map((a) => a.strides).join(' / ')} -> ${bucket ?? 'unclear'}`
  )
  return bucket
}

// The distance dimension: each clip judged ALONE on the closed stride
// scale, buckets compared in code. Judging the clips separately removes
// the positional confound by construction — relative "who is farther"
// questions proved positional on real runs in every format tried. Reasons
// shown to players are composed from the buckets, never the model's words.
async function probeDistance (sdk, modelId, pickedA, pickedB) {
  const bucketA = await clipStrideBucket(sdk, modelId, pickedA, 'clip A')
  const bucketB = await clipStrideBucket(sdk, modelId, pickedB, 'clip B')

  if (!bucketA || !bucketB || bucketA === bucketB) {
    return { winner: 'equal', reason: FALLBACK_REASONS.distance.equal }
  }

  const winner = STRIDE_BUCKETS.indexOf(bucketA) > STRIDE_BUCKETS.indexOf(bucketB) ? 'A' : 'B'
  const [farBucket, nearBucket] = winner === 'A' ? [bucketA, bucketB] : [bucketB, bucketA]
  return {
    winner,
    reason: `Player ${winner} takes his shot from further out — ` +
      `${STRIDE_BUCKET_PHRASES[farBucket]} against ${STRIDE_BUCKET_PHRASES[nearBucket]}.`,
  }
}

// Normalize one model answer: guarantee a valid pick and a plain-language
// reason. A reason that mentions banned analysis words is a prompt bug —
// logged loudly and replaced with the composed fallback, never shown.
function normalizeAnswer (dimension, answer) {
  const pick = ['A', 'B', 'equal'].includes(answer?.pick) ? answer.pick : 'equal'
  let reason = String(answer?.reason ?? '').trim()
  if (!reason || BANNED_REASON_WORDS.test(reason)) {
    if (reason) {
      console.error(`[qvac] BUG: banned wording in ${dimension} reason: ${JSON.stringify(reason)}`)
    }
    reason = FALLBACK_REASONS[dimension][pick]
  }
  return { pick, reason }
}

// Decide the placement dimension from the two zone verdicts: the zone with
// the higher table score wins (top corner beats center). The reason is
// composed from the zones' plain-words phrases, so it is deterministic and
// can never leak internal zone keys or narrate the grid.
function placementDimension (clipA, clipB) {
  const zoneA = clipA?.scores?.placement?.zone
  const zoneB = clipB?.scores?.placement?.zone
  if (!Object.prototype.hasOwnProperty.call(PLACEMENT_ZONE_SCORES, zoneA) ||
      !Object.prototype.hasOwnProperty.call(PLACEMENT_ZONE_SCORES, zoneB)) {
    throw new Error('Placement comparison requires resolved evidence for both clips')
  }
  const scoreA = PLACEMENT_ZONE_SCORES[zoneA]
  const scoreB = PLACEMENT_ZONE_SCORES[zoneB]

  let winner = 'equal'
  let reason
  if (scoreA > scoreB) {
    winner = 'A'
    reason = `Player A found the harder spot — his shot went ${PLACEMENT_ZONE_PHRASES[zoneA]}, while Player B's went ${PLACEMENT_ZONE_PHRASES[zoneB]}.`
  } else if (scoreB > scoreA) {
    winner = 'B'
    reason = `Player B found the harder spot — his shot went ${PLACEMENT_ZONE_PHRASES[zoneB]}, while Player A's went ${PLACEMENT_ZONE_PHRASES[zoneA]}.`
  } else if (zoneA === zoneB) {
    reason = `Both shots went ${PLACEMENT_ZONE_PHRASES[zoneA]}.`
  } else {
    reason = `The two finishes ended up in equally tough spots — one went ${PLACEMENT_ZONE_PHRASES[zoneA]}, the other ${PLACEMENT_ZONE_PHRASES[zoneB]}.`
  }

  return { winner, reason, zoneA, zoneB }
}

// Combine the order-checked model dimensions, the zone-derived placement
// dimension, and the tiebreak chain into the final match verdict.
// `modelDimensions` carries distance/speed/technique already
// reconciled to { winner: 'A'|'B'|'equal', reason }.
function buildVerdict (modelDimensions, clipA, clipB, meta) {
  const dimensions = {}
  for (const dim of COMPARE_DIMENSIONS) {
    dimensions[dim] = dim === 'placement'
      ? placementDimension(clipA, clipB)
      : modelDimensions[dim]
  }

  const points = { a: 0, b: 0 }
  for (const dim of COMPARE_DIMENSIONS) {
    const weight = COMPARE_DIMENSION_WEIGHTS[dim]
    if (dimensions[dim].winner === 'A') points.a += weight
    else if (dimensions[dim].winner === 'B') points.b += weight
  }

  const totalsDetail = compareClips(clipA, clipB)

  let winner
  let tiebreak = null
  if (points.a !== points.b) {
    winner = points.a > points.b ? 'A' : 'B'
  } else if (totalsDetail.winner !== 'tie') {
    winner = totalsDetail.winner
    tiebreak = 'totals'
  } else {
    winner = 'tie'
  }

  return {
    winner,
    summary: buildSummary(winner, tiebreak, dimensions),
    points,
    maxPoints: Object.values(COMPARE_DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0),
    dimensions,
    tiebreak,
    totals: { a: totalsDetail.totalA, b: totalsDetail.totalB },
    ...meta,
  }
}

// The one-paragraph plain-language "why they won" shown as the headline.
// Composed in code from the per-dimension reasons, so it is deterministic
// and stays inside the same plain-language rules as everything else.
function buildSummary (winner, tiebreak, dimensions) {
  if (winner === 'tie') {
    return 'Dead even — nothing separates the two shots on distance, pace, strike, or placement.'
  }

  const wins = COMPARE_DIMENSIONS.filter((dim) => dimensions[dim].winner === winner)

  if (wins.length === 0) {
    // Won purely on the scorecards with no dimension in their column.
    return `Player ${winner} takes it — the shots are level on every measure, so the overall scorecards settle it.`
  }

  const winPhrases = wins.map((dim) => DIMENSION_WIN_PHRASES[dim])
  const listed = winPhrases.length === 1
    ? winPhrases[0]
    : winPhrases.slice(0, -1).join(', ') + ' and ' + winPhrases[winPhrases.length - 1]

  const reasons = wins.map((dim) => dimensions[dim].reason).join(' ')
  const tiebreakNote = tiebreak === 'totals'
    ? ' With the shots split down the middle, the overall scorecards settle it.'
    : ''

  return `Player ${winner} takes it — he ${listed}. ${reasons}${tiebreakNote}`
}

// Deterministic offline stand-in for the reconciled model dimensions, used
// only when QVAC_MOCK_SCORING=1 so the full verdict plumbing can run
// without a model.
function mockModelDimensions (clipA, clipB) {
  const answer = (dim, a, b) => {
    const winner = a === b ? 'equal' : a > b ? 'A' : 'B'
    return { winner, reason: `(offline mock) ${FALLBACK_REASONS[dim][winner]}` }
  }
  return {
    distance: answer('distance', clipA?.scores?.difficulty?.score ?? 0, clipB?.scores?.difficulty?.score ?? 0),
    speed: answer('speed', clipA?.scores?.skill?.score ?? 0, clipB?.scores?.skill?.score ?? 0),
    technique: answer('technique', clipA?.scores?.skill?.score ?? 0, clipB?.scores?.skill?.score ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sumScores (scores) {
  if (!scores) return 0
  return SCORE_FIELDS.reduce((sum, f) => {
    const weight = f === 'placement' ? PLACEMENT_WEIGHT : 1
    return sum + weight * (Number(scores[f]?.score) || 0)
  }, 0)
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

// Compose the zone key from two resolved vision commitments. An unclear or
// invalid pair stays null; uncertainty is never converted to a real cell.
// WHAT THIS DOES: Sticks row and column together only when both are valid.
function resolveZone (placement) {
  const composed = `${placement?.row}_${placement?.column}`
  const unclear = PLACEMENT_ZONE_SCORES[composed] === undefined
  return { zone: unclear ? null : composed, unclear }
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

  const { zone, unclear } = resolveZone(placement)
  if (unclear || !zone) {
    throw new Error('finalizeScore refuses to score unresolved placement evidence')
  }
  // The model's own words are shown only when the verdict was clear and any
  // left/right call survived the mirror check. If it returned no natural
  // explanation, compose one from the already-verified zone.
  let explanation = String(placement?.explanation ?? '').trim()
  if (!explanation) {
    explanation = `The ball went ${PLACEMENT_ZONE_PHRASES[zone]}.`
  }
  scores.placement = {
    score: PLACEMENT_ZONE_SCORES[zone],
    zone,
    explanation,
    evidenceStatus: placement.status,
    directionVerified: placement?.directionVerified !== false,
  }

  warnOnDuplicateExplanations(scores)

  return { scores, total: sumScores(scores), ...meta }
}

// Each criterion is instructed to reason about different things, so two
// matching "why" texts mean the model copy-pasted one justification across
// criteria. That is a prompt bug we want to see during testing, so it is
// logged loudly instead of shipped silently to the players.
function warnOnDuplicateExplanations (scores) {
  const entries = SCORE_FIELDS.map((field) => ({
    field,
    text: normalizeExplanation(scores[field]?.explanation),
  })).filter((entry) => entry.text.length > 0)

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (nearIdentical(entries[i].text, entries[j].text)) {
        console.error(
          `[qvac] BUG: near-identical explanations for "${entries[i].field}" and ` +
          `"${entries[j].field}": ${JSON.stringify(scores[entries[i].field].explanation)}`
        )
      }
    }
  }
}

// Case, punctuation, and spacing differences don't count as different text.
function normalizeExplanation (text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Exact match after normalization, or near-total word overlap — a copy-paste
// with a couple of words swapped still counts as the same text.
function nearIdentical (a, b) {
  if (a === b) return true
  const wordsA = new Set(a.split(' '))
  const wordsB = new Set(b.split(' '))
  let shared = 0
  for (const word of wordsA) {
    if (wordsB.has(word)) shared++
  }
  const union = wordsA.size + wordsB.size - shared
  return union > 0 && shared / union >= 0.9
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
  scores.placement.evidenceStatus = 'MOCK'
  return {
    status: 'SCORED',
    scores,
    total: sumScores(scores),
    frameCount: frames.length,
    frames,
    duration: metadata.duration || 0,
    model: 'mock',
    mock: true,
    placementReport: { status: 'MOCK', evidence: null },
  }
}

module.exports = {
  DESCRIBE_PROMPT,
  JUDGE_PROMPT_PREFIX,
  JUDGE_RUBRIC,
  MODEL_INFO,
  PLACEMENT_ZONE_SCORES,
  PLACEMENT_ZONES,
  PLACEMENT_WEIGHT,
  MAX_TOTAL,
  COMPARE_DIMENSION_WEIGHTS,
  MIN_CLIP_FPS,
  extractFrames,
  getVideoDuration,
  probeVideo,
  prepareModel,
  scoreClip,
  classifyPlacement,
  compareClips,
  compareHeadToHead,
  canCompareHeadToHead,
  hasResolvedPlacement,
  selectComparisonFrames,
  finalizeScore,
}
