'use strict'

// Probable AI-judge evaluation runner.
//
// Drives the REAL scoring pipeline (src/main/scoring.js) over a set of
// human-labeled clip pairs, judging every pair in BOTH clip orders, then hands
// the verdicts to the pure metrics core (metrics.js) and writes a report.
//
// Usage:
//   node eval/run-eval.js --manifest eval/pairs.jsonl --out eval/results
//   QVAC_MOCK_SCORING=1 node eval/run-eval.js --manifest eval/pairs.example.jsonl
//
// The QVAC_MOCK_SCORING=1 form runs the whole plumbing with scoring.js's built-in
// mock model — no weights, no GPU — so you can validate the harness end to end
// before spending real inference on it.
//
// Manifest: one JSON object per line (JSONL):
//   {"id": "pair-01", "clipA": "/abs/clipA.mp4", "clipB": "/abs/clipB.mp4", "human": "A"}
// where "human" is the winner YOU labeled: "A", "B", or "tie".

const fs = require('fs')
const path = require('path')
const scoring = require('../src/main/scoring')
const { aggregate, formatReport } = require('./metrics')

function parseArgs (argv) {
  const args = { manifest: 'eval/pairs.jsonl', out: 'eval/results' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--manifest') args.manifest = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

function loadManifest (file) {
  const raw = fs.readFileSync(file, 'utf8')
  const pairs = []
  raw.split('\n').forEach((line, idx) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch (e) {
      throw new Error(`manifest line ${idx + 1}: invalid JSON (${e.message})`)
    }
    for (const key of ['id', 'clipA', 'clipB', 'human']) {
      if (!obj[key]) throw new Error(`manifest line ${idx + 1}: missing "${key}"`)
    }
    if (!['A', 'B', 'tie'].includes(obj.human)) {
      throw new Error(`manifest line ${idx + 1}: human must be A, B, or tie`)
    }
    pairs.push(obj)
  })
  if (!pairs.length) throw new Error(`manifest ${file} has no pairs`)
  return pairs
}

// Score one clip through the real pipeline: probe -> extract frames -> scoreClip.
// Returns a scoreClip result carrying { scores, total, frames }.
async function scoreOne (clipPath) {
  const abs = path.resolve(clipPath)
  if (!fs.existsSync(abs)) throw new Error(`clip not found: ${abs}`)
  const { duration } = await scoring.probeVideo(abs)
  const frames = await scoring.extractFrames(abs, { duration })
  const score = await scoring.scoreClip(frames, { duration })
  return { ...score, frames }
}

// Pull the per-dimension winners out of a compareHeadToHead verdict, if present,
// so the report can show where matches are actually decided.
function extractDimensions (verdict) {
  const out = {}
  const dims = verdict && verdict.dimensions
  if (!dims) return out
  for (const [dim, info] of Object.entries(dims)) {
    if (info && typeof info.winner === 'string') out[dim] = info.winner
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log('Usage: node eval/run-eval.js --manifest <file.jsonl> [--out <dir>]')
    console.log('       QVAC_MOCK_SCORING=1 node eval/run-eval.js --manifest eval/pairs.example.jsonl')
    return
  }

  const pairs = loadManifest(args.manifest)
  const mock = process.env.QVAC_MOCK_SCORING === '1'
  console.log(`[eval] ${pairs.length} pair(s) from ${args.manifest}${mock ? '  (MOCK model)' : ''}`)

  if (!mock) {
    // Warm the model once so first-pair latency does not swallow the download.
    await scoring.prepareModel((p) => {
      if (p && p.status) process.stdout.write(`\r[eval] preparing model: ${p.status}    `)
    })
    process.stdout.write('\n')
  }

  const records = []
  for (const pair of pairs) {
    console.log(`[eval] ${pair.id}: scoring both clips…`)
    const clipA = await scoreOne(pair.clipA)
    const clipB = await scoreOne(pair.clipB)

    // Judge in both orders. A stable judge flips its label when the slots swap.
    const forward = await scoring.compareHeadToHead(clipA, clipB)
    const swapped = await scoring.compareHeadToHead(clipB, clipA)

    const rec = {
      id: pair.id,
      human: pair.human,
      forwardWinner: forward.winner,
      swappedWinner: swapped.winner,
      dimensionsForward: extractDimensions(forward),
      totals: { a: clipA.total, b: clipB.total },
    }
    records.push(rec)
    console.log(
      `[eval] ${pair.id}: human=${pair.human} forward=${forward.winner} ` +
      `swapped=${swapped.winner} ${forward.winner !== 'tie' && swapped.winner !== 'tie' &&
        ((forward.winner === 'A') === (swapped.winner === 'B')) ? 'stable' : 'CHECK'}`
    )
  }

  const meta = {
    model: mock ? 'MOCK (QVAC_MOCK_SCORING=1)' : (scoring.MODEL_INFO && scoring.MODEL_INFO.id),
    generatedAt: new Date().toISOString(),
  }
  const metrics = aggregate(records)
  const report = formatReport(metrics, records, meta)

  fs.mkdirSync(args.out, { recursive: true })
  const jsonPath = path.join(args.out, 'report.json')
  const mdPath = path.join(args.out, 'report.md')
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, metrics, records }, null, 2))
  fs.writeFileSync(mdPath, report)

  console.log(`\n${report}\n`)
  console.log(`[eval] wrote ${mdPath} and ${jsonPath}`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[eval] failed:', err.message)
    process.exitCode = 1
  })
}

module.exports = { loadManifest, scoreOne, extractDimensions }
