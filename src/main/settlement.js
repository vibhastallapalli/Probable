'use strict'

const escrow = require('./escrow')
const scoring = require('./scoring')

/**
 * Decide the match winner and, if there is one and the match wallet is
 * funded, release the full USDT balance to that winner.
 *
 * The winner comes from the head-to-head verdict — both clips judged side by
 * side (scoring.compareHeadToHead) — not from comparing two solo totals.
 * The caller normally passes the verdict it already computed and showed to
 * the players, so settlement never re-runs the model; when no verdict is
 * passed, one is computed here, falling back to the totals comparison only
 * for legacy score objects that carry no frame paths.
 *
 * Returns a single result object whose `outcome` is one of:
 *   'unfunded'        — match wallet has no USDT yet; nothing was touched
 *   'tied'            — the verdict is a dead heat; escrow left intact for human review
 *   'already_settled' — escrow already paid out; the recorded result is returned, no transfer
 *   'settled'         — winner determined, transfer sent, escrow settled
 *
 * @param {string} matchId   - Escrow ID (same key used for the match wallet)
 * @param {object} clipA     - scoreClip() result for participant A
 * @param {object} clipB     - scoreClip() result for participant B
 * @param {string} addressA  - EVM address of participant A
 * @param {string} addressB  - EVM address of participant B
 * @param {object} [verdict] - Precomputed compareHeadToHead() verdict
 * @returns {Promise<object>}
 */
// WHAT THIS DOES: Takes the verdict and pays the winner. A tie leaves the
//   money completely untouched — there is no automatic refund or split.
async function settleMatch (matchId, clipA, clipB, addressA, addressB, verdict) {
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

  // Winner source: the head-to-head verdict. The totals comparison is kept
  // alongside purely as supporting detail in the returned result.
  const validVerdict = verdict && ['A', 'B', 'tie'].includes(verdict.winner)
  const headToHead = validVerdict
    ? verdict
    : scoring.canCompareHeadToHead(clipA, clipB)
      ? await scoring.compareHeadToHead(clipA, clipB)
      : null
  const detail = scoring.compareClips(clipA, clipB)
  const winner = headToHead ? headToHead.winner : detail.winner

  if (winner === 'tie') {
    return {
      outcome: 'tied',
      matchId,
      summary: headToHead?.summary,
      verdict: headToHead,
      totalA: detail.totalA,
      totalB: detail.totalB,
      margin: detail.margin,
      breakdown: detail.breakdown
    }
  }

  const winnerAddress = winner === 'A' ? addressA : addressB
  const release = await escrow.releaseEscrow(matchId, winnerAddress)

  return {
    outcome: 'settled',
    matchId,
    winner,
    winnerAddress,
    summary: headToHead?.summary,
    verdict: headToHead,
    margin: detail.margin,
    totalA: detail.totalA,
    totalB: detail.totalB,
    breakdown: detail.breakdown,
    payout: release.payout,
    txHash: release.txHash,
    releasedAt: release.releasedAt
  }
}

module.exports = { settleMatch }
