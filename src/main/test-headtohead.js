'use strict'

// Benchmark harness: run the REAL judging pipeline on a known clip pair and
// print everything it decided, so a verdict that looks wrong can be traced to
// the pass that got it wrong instead of guessed at.
//
//   Run:  node src/main/test-headtohead.js <clipA.mp4> <clipB.mp4> [expected]
//
// `expected` is optional and is A, B, or tie — the answer you already know by
// eye. Given one, the script exits non-zero when the pipeline disagrees, so a
// pair with a known-correct answer can be kept as a regression case.
//
// Example (the pair the placement reweighting was tuned on — A lifts it into
// the top middle, B rolls it into a bottom corner, so A should win):
//   node src/main/test-headtohead.js "graphify-out/Test videos/PlayerA/PlayerA_test_1.mp4" \
//                                    "graphify-out/Test videos/PlayerB/PlayerB_test_1.mp4" A
//
// This calls the shipped exports — probeVideo, extractFrames, scoreClip,
// compareHeadToHead — with no copies and no shortcuts, so what it prints is
// exactly what the app would settle on. Runs under plain Node; nothing here
// needs Electron. QVAC_MOCK_SCORING=1 exercises the plumbing without the
// model, but the answers are then meaningless.

const path = require('path')
const scoring = require('./scoring')

const PLACEMENT_ZONE_PHRASES = {
  top_left: 'top left corner', top_center: 'top middle', top_right: 'top right corner',
  mid_left: 'mid-height left', mid_center: 'dead center', mid_right: 'mid-height right',
  bottom_left: 'bottom left corner', bottom_center: 'bottom middle', bottom_right: 'bottom right corner',
}

async function judge (label, videoPath) {
  console.log(`\n--- ${label}: ${path.basename(videoPath)} ---`)
  const { duration, fps, lowFps } = await scoring.probeVideo(videoPath)
  if (lowFps) console.log(`!! ${fps.toFixed(1)} fps, under ${scoring.MIN_CLIP_FPS} — scoring is less reliable on this clip`)

  const frames = await scoring.extractFrames(videoPath, { duration })
  const score = await scoring.scoreClip(frames, { duration })

  for (const field of ['skill', 'difficulty', 'aesthetic']) {
    console.log(`  ${field.padEnd(11)} ${String(score.scores[field].score).padStart(2)}/10`)
  }
  const p = score.scores.placement
  console.log(`  placement   ${String(p.score).padStart(2)}/10  x${scoring.PLACEMENT_WEIGHT}  (${PLACEMENT_ZONE_PHRASES[p.zone] ?? p.zone})`)
  console.log(`  TOTAL       ${score.total}/${scoring.MAX_TOTAL}`)
  return score
}

async function main () {
  const [clipPathA, clipPathB, expected] = process.argv.slice(2)
  if (!clipPathA || !clipPathB) {
    console.error('usage: node src/main/test-headtohead.js <clipA.mp4> <clipB.mp4> [A|B|tie]')
    process.exit(1)
  }
  if (expected && !['A', 'B', 'tie'].includes(expected)) {
    console.error(`expected winner must be A, B, or tie — got ${JSON.stringify(expected)}`)
    process.exit(1)
  }

  const clipA = await judge('Player A', clipPathA)
  const clipB = await judge('Player B', clipPathB)

  console.log('\n=== HEAD TO HEAD ===')
  const verdict = await scoring.compareHeadToHead(clipA, clipB)

  for (const [dim, weight] of Object.entries(scoring.COMPARE_DIMENSION_WEIGHTS)) {
    const d = verdict.dimensions[dim]
    const won = d.winner === 'equal' ? 'even' : `Player ${d.winner} +${weight}`
    console.log(`  ${dim.padEnd(10)} ${won.padEnd(12)} ${d.reason}`)
  }

  console.log(`\n  points   A ${verdict.points.a} — B ${verdict.points.b}  (of ${verdict.maxPoints})`)
  console.log(`  totals   A ${verdict.totals.a} — B ${verdict.totals.b}`)
  if (verdict.tiebreak) console.log(`  tiebreak ${verdict.tiebreak}`)
  console.log(`\n  WINNER: ${verdict.winner === 'tie' ? 'dead even' : `Player ${verdict.winner}`}`)
  console.log(`  ${verdict.summary}`)

  if (expected) {
    const ok = verdict.winner === expected
    console.log(`\n  expected ${expected} — ${ok ? 'MATCH' : 'MISMATCH'}`)
    if (!ok) process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
