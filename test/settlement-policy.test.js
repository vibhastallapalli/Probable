'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

let releaseCalled = false
let comparisonCalled = false

const escrowStub = {
  getEscrowStatus: async () => ({
    status: 'funded',
    balance: 10,
    matchWalletAddress: '0xescrow',
  }),
  releaseEscrow: async () => {
    releaseCalled = true
    return { payout: 10, txHash: '0xtx', releasedAt: 'now' }
  },
}

const scoringStub = {
  hasResolvedPlacement: (clip) => clip?.resolved === true,
  canCompareHeadToHead: () => true,
  compareHeadToHead: async () => {
    comparisonCalled = true
    return { winner: 'A' }
  },
  compareClips: () => {
    comparisonCalled = true
    return { winner: 'A', totalA: 20, totalB: 10, margin: 10, breakdown: {} }
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (parent?.filename.endsWith('/src/main/settlement.js')) {
    if (request === './escrow') return escrowStub
    if (request === './scoring') return scoringStub
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { settleMatch } = require('../src/main/settlement')
Module._load = originalLoad

test('funded match remains untouched when either clip is unresolved', async () => {
  releaseCalled = false
  comparisonCalled = false

  const result = await settleMatch(
    'match-1',
    { resolved: true },
    { resolved: false },
    '0xplayerA',
    '0xplayerB'
  )

  assert.equal(result.outcome, 'awaiting_clearer_clip')
  assert.deepEqual(result.unresolved, { clipA: false, clipB: true })
  assert.equal(comparisonCalled, false)
  assert.equal(releaseCalled, false)
})
