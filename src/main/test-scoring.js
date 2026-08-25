'use strict'

// Standalone sanity check for the scoring rubric's arithmetic.
//   Run:  node src/main/test-scoring.js
//
// No model, no frames, no Electron — this asserts the parts of scoring.js
// that decide who gets paid: the goal-zone value table, the double weight on
// placement, and the head-to-head points. Those are the rules that were
// handing matches to the worse shot, so they get a check that fails loudly if
// anyone flattens them again.
//
// The real "is the AI right" question needs the model and lives in
// test-headtohead.js, which runs the actual clips.

const assert = require('assert')
const {
  PLACEMENT_ZONE_SCORES,
  PLACEMENT_WEIGHT,
  MAX_TOTAL,
  COMPARE_DIMENSION_WEIGHTS,
  compareClips,
  finalizeScore,
} = require('./scoring')

const Z = PLACEMENT_ZONE_SCORES

// --- the zone table ---------------------------------------------------------

// Height beats side. Lifting it under the bar is harder than rolling it
// past a keeper's feet into a corner, so EVERY top cell must outrank every
// bottom cell. This is the ordering that was inverted before: top center
// used to score 5 against a bottom corner's 8, which is how a lifted finish
// into the top middle lost placement to a low roller.
for (const top of ['top_left', 'top_center', 'top_right']) {
  for (const low of ['bottom_left', 'bottom_center', 'bottom_right']) {
    assert(Z[top] > Z[low], `${top} (${Z[top]}) must outrank ${low} (${Z[low]})`)
  }
}

// Within a row, the corners beat the middle.
assert(Z.top_left > Z.top_center && Z.top_right > Z.top_center, 'top corners beat top center')
assert(Z.bottom_left > Z.bottom_center && Z.bottom_right > Z.bottom_center, 'bottom corners beat bottom center')

// Left and right are always worth the same — the mirror check can only prove
// WHICH side, never that one side is harder than the other.
assert.equal(Z.top_left, Z.top_right, 'top corners are symmetric')
assert.equal(Z.bottom_left, Z.bottom_right, 'bottom corners are symmetric')
assert.equal(Z.mid_left, Z.mid_right, 'mid sides are symmetric')

// Dead center low is the softest finish on the board.
assert.equal(Math.min(...Object.values(Z)), Z.bottom_center, 'bottom center is the cheapest zone')

// --- placement counts double in a clip total --------------------------------

function score ({ skill, difficulty, aesthetic, zone }) {
  return finalizeScore(
    {
      skill: { score: skill, explanation: 'x' },
      difficulty: { score: difficulty, explanation: 'y' },
      aesthetic: { score: aesthetic, explanation: 'z' },
    },
    { row: zone.split('_')[0], column: zone.split('_')[1], explanation: 'w' },
    { frameCount: 0, frames: [], duration: 0, model: 'test', mock: true }
  )
}

const topCorner = score({ skill: 5, difficulty: 5, aesthetic: 5, zone: 'top_left' })
assert.equal(topCorner.scores.placement.zone, 'top_left')
assert.equal(topCorner.total, 15 + PLACEMENT_WEIGHT * Z.top_left, 'placement is weighted in the total')
assert(MAX_TOTAL >= topCorner.total, 'MAX_TOTAL bounds a real total')
assert.equal(MAX_TOTAL, 30 + 10 * PLACEMENT_WEIGHT, 'MAX_TOTAL matches the weighted ceiling')

// The regression that started all this, as scorecards: Player A lifts it into
// the top middle, Player B rolls it into a bottom corner and picks up a point
// on each of the soft criteria. A must still win the total.
const liftedTopMiddle = score({ skill: 7, difficulty: 6, aesthetic: 8, zone: 'top_center' })
const lowRollerCorner = score({ skill: 8, difficulty: 7, aesthetic: 9, zone: 'bottom_left' })
const headline = compareClips(liftedTopMiddle, lowRollerCorner)
assert.equal(headline.winner, 'A',
  `top-middle finish must beat a low corner roller (A=${headline.totalA} B=${headline.totalB})`)

// --- head-to-head points ----------------------------------------------------

assert.equal(COMPARE_DIMENSION_WEIGHTS.placement, PLACEMENT_WEIGHT, 'placement pays double as a dimension')
const maxPoints = Object.values(COMPARE_DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0)
assert.equal(maxPoints, 5, 'five points are on the table')

// Placement alone must not win a match, and must not lose to a single
// dimension either: it takes two of the three model-answered dimensions to
// overturn it. Both halves matter — the first keeps the vision pass from
// dictating every result, the second is the whole point of the reweighting.
const { distance, speed, technique, placement } = COMPARE_DIMENSION_WEIGHTS
assert(placement < distance + speed + technique, 'placement alone cannot win a match')
assert(placement > distance, 'one model-answered dimension cannot overturn placement')

console.log('scoring rules OK')
console.log(`  zone table:      ${Object.entries(Z).map(([k, v]) => `${k}=${v}`).join('  ')}`)
console.log(`  placement weight: x${PLACEMENT_WEIGHT}   clip total out of ${MAX_TOTAL}`)
console.log(`  head-to-head:    ${Object.entries(COMPARE_DIMENSION_WEIGHTS).map(([k, v]) => `${k}=${v}`).join('  ')}  (${maxPoints} on the table)`)
console.log(`  regression case: lifted top-middle ${headline.totalA} beats low corner roller ${headline.totalB}`)
