'use strict'

// Evaluation metrics for the Probable AI judge.
//
// This module is PURE: it takes verdict records and returns numbers. It never
// touches the model, the filesystem, or the network, so it can be unit-tested
// on its own (see metrics.test.js). run-eval.js produces the records by driving
// the real scoring pipeline; everything measured here is derived from those.
//
// A "record" is one labeled pair judged in BOTH clip orders:
//   {
//     id:            string,               // pair identifier
//     human:         'A' | 'B' | 'tie',    // ground-truth winner (clipA vs clipB)
//     forwardWinner: 'A' | 'B' | 'tie',    // compareHeadToHead(clipA, clipB)
//     swappedWinner: 'A' | 'B' | 'tie',    // compareHeadToHead(clipB, clipA)
//     dimensionsForward?: object,          // optional per-dimension winners
//   }
//
// In the swapped run the physical clips trade slots, so a stable judge must
// FLIP its answer: forward 'A' should come back as swapped 'B'. Anything else
// is positional bias — the model favoring a slot rather than a clip.

// ---------------------------------------------------------------------------
// Which real clip a verdict points at, independent of slot order.
// ---------------------------------------------------------------------------

// Forward run: slot A == clipA, slot B == clipB.
function forwardRealWinner (rec) {
  if (rec.forwardWinner === 'A') return 'clipA'
  if (rec.forwardWinner === 'B') return 'clipB'
  return 'tie'
}

// Swapped run: slot A == clipB, slot B == clipA — so the labels invert.
function swappedRealWinner (rec) {
  if (rec.swappedWinner === 'A') return 'clipB'
  if (rec.swappedWinner === 'B') return 'clipA'
  return 'tie'
}

function humanRealWinner (rec) {
  if (rec.human === 'A') return 'clipA'
  if (rec.human === 'B') return 'clipB'
  return 'tie'
}

// A pair is order-consistent when both orders name the same physical winner.
function isOrderConsistent (rec) {
  return forwardRealWinner(rec) === swappedRealWinner(rec)
}

// ---------------------------------------------------------------------------
// Wilson score interval — a small-sample-safe 95% CI for a proportion.
// The normal approximation (p ± 1.96·se) breaks near 0/1 and on the handful
// of pairs an eval like this usually has; Wilson stays inside [0, 1].
// ---------------------------------------------------------------------------

function wilson (successes, n, z = 1.96) {
  if (n === 0) return { rate: 0, low: 0, high: 0, n: 0, successes: 0 }
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom
  return {
    rate: p,
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
    n,
    successes,
  }
}

// ---------------------------------------------------------------------------
// Aggregate metrics over every record.
// ---------------------------------------------------------------------------

function aggregate (records) {
  const n = records.length
  if (n === 0) throw new Error('aggregate: no records to score')

  let consistent = 0
  let slotABias = 0          // inconsistent pairs where the model picked whoever sat in slot A
  let humanAgreeConsistent = 0
  let consistentDecisive = 0 // consistent, non-tie pairs (the ones we can grade vs human)
  let forwardAgree = 0
  let forwardDecisive = 0

  const dimensionWins = {}   // dimension -> { A, B, equal }

  for (const rec of records) {
    const consistent_ = isOrderConsistent(rec)
    if (consistent_) consistent++
    else {
      // Both orders disagree. If the model named slot A both times it is
      // biased toward the first slot; if slot B both times, toward the second.
      if (rec.forwardWinner === 'A' && rec.swappedWinner === 'A') slotABias++
    }

    const human = humanRealWinner(rec)

    // Grade against the human label only where a clip actually won.
    if (consistent_ && forwardRealWinner(rec) !== 'tie') {
      consistentDecisive++
      if (forwardRealWinner(rec) === human) humanAgreeConsistent++
    }
    if (forwardRealWinner(rec) !== 'tie') {
      forwardDecisive++
      if (forwardRealWinner(rec) === human) forwardAgree++
    }

    const dims = rec.dimensionsForward || {}
    for (const [dim, pick] of Object.entries(dims)) {
      const bucket = dimensionWins[dim] || (dimensionWins[dim] = { A: 0, B: 0, equal: 0 })
      const key = pick === 'A' ? 'A' : pick === 'B' ? 'B' : 'equal'
      bucket[key]++
    }
  }

  return {
    pairs: n,
    // Positional robustness: how often the verdict survives swapping clip order.
    orderConsistency: wilson(consistent, n),
    positionalBiasRate: 1 - consistent / n,
    slotAFirstBias: n === consistent ? 0 : slotABias / (n - consistent),
    // Accuracy vs human, restricted to the pairs the judge itself is stable on.
    humanAgreementConsistent: wilson(humanAgreeConsistent, consistentDecisive),
    // Accuracy on the raw forward run, for comparison.
    humanAgreementForward: wilson(forwardAgree, forwardDecisive),
    dimensionWins,
  }
}

// ---------------------------------------------------------------------------
// Markdown report.
// ---------------------------------------------------------------------------

function pct (x) {
  return `${(x * 100).toFixed(1)}%`
}

function ci (w) {
  return `${pct(w.rate)}  (95% CI ${pct(w.low)}–${pct(w.high)}, n=${w.n})`
}

function formatReport (m, records, meta = {}) {
  const lines = []
  lines.push('# Probable — AI Judge Evaluation')
  lines.push('')
  if (meta.model) lines.push(`Model: ${meta.model}`)
  if (meta.generatedAt) lines.push(`Generated: ${meta.generatedAt}`)
  lines.push(`Pairs evaluated: ${m.pairs}  (each judged in both clip orders)`)
  lines.push('')
  lines.push('## Headline')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('|---|---|')
  lines.push(`| Order consistency (swap-stable verdicts) | ${ci(m.orderConsistency)} |`)
  lines.push(`| Positional bias rate | ${pct(m.positionalBiasRate)} |`)
  lines.push(`| Agreement with human (swap-stable pairs) | ${ci(m.humanAgreementConsistent)} |`)
  lines.push(`| Agreement with human (raw forward run) | ${ci(m.humanAgreementForward)} |`)
  lines.push('')
  lines.push('*Order consistency* is the share of pairs whose winner does not change')
  lines.push('when the two clips swap slots — the direct measure of positional bias the')
  lines.push('swap test was built to catch. Human agreement is reported on the swap-stable')
  lines.push('pairs, because a verdict that flips with slot order is not a real opinion to grade.')
  lines.push('')

  if (Object.keys(m.dimensionWins).length) {
    lines.push('## Per-dimension winners (forward run)')
    lines.push('')
    lines.push('| Dimension | A | B | equal |')
    lines.push('|---|:--:|:--:|:--:|')
    for (const [dim, b] of Object.entries(m.dimensionWins)) {
      lines.push(`| ${dim} | ${b.A} | ${b.B} | ${b.equal} |`)
    }
    lines.push('')
  }

  lines.push('## Per-pair')
  lines.push('')
  lines.push('| Pair | Human | Forward | Swapped | Order-stable? |')
  lines.push('|---|:--:|:--:|:--:|:--:|')
  for (const rec of records) {
    lines.push(
      `| ${rec.id} | ${rec.human} | ${rec.forwardWinner} | ${rec.swappedWinner} | ` +
      `${isOrderConsistent(rec) ? '✓' : '✗'} |`
    )
  }
  lines.push('')
  return lines.join('\n')
}

module.exports = {
  wilson,
  aggregate,
  formatReport,
  isOrderConsistent,
  forwardRealWinner,
  swappedRealWinner,
  humanRealWinner,
}
