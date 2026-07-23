'use strict'

// Unit tests for the pure metrics core. Run: node --test eval/
// These need no model, no clips, no GPU — they validate the math and the
// slot-flip bookkeeping that the swap test depends on.

const { test } = require('node:test')
const assert = require('node:assert')
const {
  wilson,
  aggregate,
  isOrderConsistent,
  forwardRealWinner,
  swappedRealWinner,
} = require('./metrics')

test('wilson interval brackets the point estimate and stays in [0,1]', () => {
  const w = wilson(8, 10)
  assert.ok(w.low <= w.rate && w.rate <= w.high)
  assert.ok(w.low >= 0 && w.high <= 1)
  assert.strictEqual(w.rate, 0.8)
})

test('wilson handles the degenerate ends without going out of range', () => {
  assert.deepStrictEqual(wilson(0, 0), { rate: 0, low: 0, high: 0, n: 0, successes: 0 })
  const perfect = wilson(5, 5)
  assert.strictEqual(perfect.rate, 1)
  assert.ok(perfect.high <= 1)
  assert.ok(perfect.low < 1) // CI still admits uncertainty from 5 samples
})

test('slot labels flip correctly between forward and swapped runs', () => {
  // Forward A + swapped B == the same physical clip (clipA) won both times.
  const stable = { id: 'p', human: 'A', forwardWinner: 'A', swappedWinner: 'B' }
  assert.strictEqual(forwardRealWinner(stable), 'clipA')
  assert.strictEqual(swappedRealWinner(stable), 'clipA')
  assert.ok(isOrderConsistent(stable))

  // Forward A + swapped A == the model just liked slot A both times -> biased.
  const biased = { id: 'q', human: 'A', forwardWinner: 'A', swappedWinner: 'A' }
  assert.ok(!isOrderConsistent(biased))
})

test('aggregate: a perfectly stable, human-matching set scores 100%', () => {
  const records = [
    { id: '1', human: 'A', forwardWinner: 'A', swappedWinner: 'B' },
    { id: '2', human: 'B', forwardWinner: 'B', swappedWinner: 'A' },
    { id: '3', human: 'A', forwardWinner: 'A', swappedWinner: 'B' },
  ]
  const m = aggregate(records)
  assert.strictEqual(m.pairs, 3)
  assert.strictEqual(m.orderConsistency.rate, 1)
  assert.strictEqual(m.positionalBiasRate, 0)
  assert.strictEqual(m.humanAgreementConsistent.rate, 1)
})

test('aggregate: a first-slot-biased judge is flagged, not graded as right', () => {
  // Every verdict is slot A regardless of which clip sits there.
  const records = [
    { id: '1', human: 'A', forwardWinner: 'A', swappedWinner: 'A' },
    { id: '2', human: 'B', forwardWinner: 'A', swappedWinner: 'A' },
    { id: '3', human: 'B', forwardWinner: 'A', swappedWinner: 'A' },
  ]
  const m = aggregate(records)
  assert.strictEqual(m.orderConsistency.rate, 0)
  assert.strictEqual(m.positionalBiasRate, 1)
  assert.strictEqual(m.slotAFirstBias, 1)
  // Nothing is order-stable, so there is no gradable verdict against the human.
  assert.strictEqual(m.humanAgreementConsistent.n, 0)
})

test('aggregate: mixed set computes partial rates', () => {
  const records = [
    { id: '1', human: 'A', forwardWinner: 'A', swappedWinner: 'B' },  // stable, right
    { id: '2', human: 'A', forwardWinner: 'B', swappedWinner: 'A' },  // stable, wrong
    { id: '3', human: 'A', forwardWinner: 'A', swappedWinner: 'A' },  // unstable
    { id: '4', human: 'tie', forwardWinner: 'tie', swappedWinner: 'tie' }, // stable tie
  ]
  const m = aggregate(records)
  assert.strictEqual(m.orderConsistency.successes, 3) // 1,2,4 stable
  assert.strictEqual(m.orderConsistency.n, 4)
  // Gradable = stable & decisive = pairs 1 and 2. One right.
  assert.strictEqual(m.humanAgreementConsistent.successes, 1)
  assert.strictEqual(m.humanAgreementConsistent.n, 2)
})

test('aggregate: dimension tallies come through', () => {
  const records = [
    {
      id: '1', human: 'A', forwardWinner: 'A', swappedWinner: 'B',
      dimensionsForward: { speed: 'A', technique: 'equal', placement: 'B' },
    },
    {
      id: '2', human: 'B', forwardWinner: 'B', swappedWinner: 'A',
      dimensionsForward: { speed: 'A', technique: 'B', placement: 'B' },
    },
  ]
  const m = aggregate(records)
  assert.deepStrictEqual(m.dimensionWins.speed, { A: 2, B: 0, equal: 0 })
  assert.deepStrictEqual(m.dimensionWins.technique, { A: 0, B: 1, equal: 1 })
  assert.deepStrictEqual(m.dimensionWins.placement, { A: 0, B: 2, equal: 0 })
})
