'use strict'

const escrow = require('./escrow')
const scoring = require('./scoring')

/**
 * Compare two pre-scored clips and, if there is a clear winner and the match
 * wallet is funded, release the full USDT balance to that winner.
 *
 * Returns a single result object whose `outcome` is one of:
 *   'unfunded'        — match wallet has no USDT yet; nothing was touched
 *   'tied'            — both clips scored identically; escrow left intact for human review
 *   'already_settled' — escrow already paid out; the recorded result is returned, no transfer
 *   'settled'         — winner determined, transfer sent, escrow settled
 *
 * @param {string} matchId   - Escrow ID (same key used for the match wallet)
 * @param {object} clipA     - scoreClip() result for participant A
 * @param {object} clipB     - scoreClip() result for participant B
 * @param {string} addressA  - EVM address of participant A
 * @param {string} addressB  - EVM address of participant B
 * @returns {Promise<object>}
 */
async function settleMatch (matchId, clipA, clipB, addressA, addressB) {
  const status = await escrow.getEscrowStatus(matchId)

  // A settled escrow has already paid out. Never move money a second time —
  // hand back the recorded winner and payout tx hash instead.
  if (status.status === 'settled') {
    return {
      outcome: 'already_settled',
      matchId,
      winnerAddress: status.winner,
      txHash: status.txHash,
      releasedAt: status.releasedAt
    }
  }

  if (status.balance <= 0) {
    return {
      outcome: 'unfunded',
      matchId,
      balance: status.balance,
      matchWalletAddress: status.matchWalletAddress
    }
  }

  const comparison = scoring.compareClips(clipA, clipB)

  if (comparison.winner === 'tie') {
    return {
      outcome: 'tied',
      matchId,
      totalA: comparison.totalA,
      totalB: comparison.totalB,
      margin: comparison.margin,
      breakdown: comparison.breakdown
    }
  }

  const winnerAddress = comparison.winner === 'A' ? addressA : addressB
  const release = await escrow.releaseEscrow(matchId, winnerAddress)

  return {
    outcome: 'settled',
    matchId,
    winner: comparison.winner,
    winnerAddress,
    margin: comparison.margin,
    totalA: comparison.totalA,
    totalB: comparison.totalB,
    breakdown: comparison.breakdown,
    payout: release.payout,
    txHash: release.txHash,
    releasedAt: release.releasedAt
  }
}

module.exports = { settleMatch }
