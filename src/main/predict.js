'use strict'

const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const { randomUUID } = require('crypto')
const escrow = require('./escrow')
const settlement = require('./settlement')
const odds = require('./odds')

// ---------------------------------------------------------------------------
// Bet record storage — userData/bets.json, keyed by bet id.
// Same persistence pattern escrow.js uses for escrow records (userData JSON
// file, read/write helpers, survives app restarts).
// ---------------------------------------------------------------------------

function _betsFile () {
  return path.join(app.getPath('userData'), 'bets.json')
}

function _readBetStore () {
  const file = _betsFile()
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function _writeBetStore (store) {
  fs.writeFileSync(_betsFile(), JSON.stringify(store, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Tournament data — cached in memory after first load so repeated calls
// (player list, odds) never re-fetch.
// ---------------------------------------------------------------------------

let _tournamentData = null

async function loadTournamentData () {
  if (_tournamentData) return _tournamentData
  _tournamentData = await odds.loadTournamentData()
  return _tournamentData
}

// Normalise a name for deduplication: trim, lowercase, strip accents.
// Same normalisation odds.js uses internally.
function _norm (s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
}

/**
 * Return every player with at least one non-own-goal in the tournament,
 * pulled from the same dataset odds.js / computeOdds uses.
 *
 * Only players with >= 1 goal are included because computeOdds needs real
 * numbers to produce a meaningful split — a player with zero goals would
 * break the math or return something meaningless.
 *
 * @param {object} [data] - Parsed worldcup.json; loaded and cached if omitted.
 * @returns {Promise<{name:string, team:string, goals:number}[]>}
 */
async function getGoalScorers (data) {
  const d = data || await loadTournamentData()
  const matches = (d && d.matches) || []

  // Map keyed by normalised "name|team" to avoid duplicates from accent
  // or casing differences across match records.
  const seen = new Map()

  for (const m of matches) {
    const sides = [
      { team: m.team1, goals: m.goals1 },
      { team: m.team2, goals: m.goals2 }
    ]
    for (const side of sides) {
      if (!Array.isArray(side.goals)) continue
      for (const g of side.goals) {
        if (!g || !g.name || g.owngoal) continue
        const key = _norm(g.name) + '|' + _norm(side.team)
        if (!seen.has(key)) {
          seen.set(key, { name: g.name, team: side.team, goals: 0 })
        }
        seen.get(key).goals++
      }
    }
  }

  return [...seen.values()].sort((a, b) =>
    b.goals - a.goals || a.name.localeCompare(b.name)
  )
}

/**
 * Create a Predict-mode bet: lock in both players' picks, create an escrow
 * through the exact same path Judge mode uses, compute cosmetic pre-match
 * odds, and persist the bet record.
 *
 * @param {object} opts
 * @param {{name:string, team:string}} opts.playerAChoice - World Cup player person A picked
 * @param {{name:string, team:string}} opts.playerBChoice - World Cup player person B picked
 * @param {string} opts.participantA - EVM address of person A
 * @param {string} opts.participantB - EVM address of person B
 * @param {number|string} opts.stakeAmount - USDt stake per person (same for both sides)
 * @returns {Promise<object>} The created bet record
 */
async function createBet (opts) {
  const { playerAChoice, playerBChoice, participantA, participantB, stakeAmount } = opts

  if (!playerAChoice?.name || !playerAChoice?.team) throw new Error('Person A must pick a player')
  if (!playerBChoice?.name || !playerBChoice?.team) throw new Error('Person B must pick a player')
  if (_norm(playerAChoice.name) === _norm(playerBChoice.name) &&
      _norm(playerAChoice.team) === _norm(playerBChoice.team)) {
    throw new Error('Both sides picked the same player — choose a different player for each side')
  }

  // Create the escrow through the exact same path Judge mode uses.
  const escrowRecord = await escrow.createEscrow(participantA, participantB, stakeAmount)

  // Compute pre-match odds from tournament stats (cosmetic only, does not
  // affect payout size or any settlement math).
  const data = await loadTournamentData()
  const oddsResult = odds.computeOdds(playerAChoice, playerBChoice, data)

  const id = randomUUID()
  const record = {
    id,
    escrowId: escrowRecord.id,
    playerAChoice,
    playerBChoice,
    participantA,
    participantB,
    stakeAmount: parseFloat(stakeAmount),
    odds: oddsResult,
    clipA: null,
    clipB: null,
    status: 'pending_funding',
    winner: null,
    txHash: null,
    matchWalletAddress: escrowRecord.matchWalletAddress,
    createdAt: new Date().toISOString(),
    settledAt: null
  }

  const store = _readBetStore()
  store[id] = record
  _writeBetStore(store)

  console.log(`[predict:create] bet=${id.slice(0, 8)}… escrow=${escrowRecord.id.slice(0, 8)}…`)
  return { ...record }
}

/**
 * Return every saved bet record. Read-only, no on-chain reads.
 * @returns {object[]}
 */
function listBets () {
  const store = _readBetStore()
  return Object.values(store).map((r) => ({ ...r }))
}

/**
 * Remove bet records by id. No on-chain effect.
 * @param {string[]} ids
 */
function deleteBets (ids) {
  const set = new Set(ids)
  const store = _readBetStore()
  for (const id of set) delete store[id]
  _writeBetStore(store)
}

/**
 * Return a bet record with live on-chain escrow balance.
 * @param {string} betId
 * @returns {Promise<object>}
 */
async function getBetStatus (betId) {
  const store = _readBetStore()
  const record = store[betId]
  if (!record) throw new Error(`Bet not found: ${betId}`)

  const escrowStatus = await escrow.getEscrowStatus(record.escrowId)
  return {
    ...record,
    escrowBalance: escrowStatus.balance,
    escrowStatus: escrowStatus.status
  }
}

/**
 * Attach a scored clip to one side of a bet. Persists immediately.
 *
 * Uses the same scoreClip() result object Judge mode produces — this is not
 * a new scoring path, just storing the result against the bet record.
 *
 * @param {string} betId
 * @param {'A'|'B'} side
 * @param {object} clipScore - Full scoreClip() result
 * @returns {object} Updated bet record
 */
function submitClip (betId, side, clipScore) {
  const store = _readBetStore()
  const record = store[betId]
  if (!record) throw new Error(`Bet not found: ${betId}`)
  if (record.status === 'settled' || record.status === 'forfeited') {
    throw new Error('Bet is already settled')
  }
  if (side !== 'A' && side !== 'B') throw new Error('Side must be A or B')

  if (side === 'A') record.clipA = clipScore
  else record.clipB = clipScore

  store[betId] = record
  _writeBetStore(store)

  console.log(`[predict:clip] bet=${betId.slice(0, 8)}… side=${side} total=${clipScore?.total ?? '?'}`)
  return { ...record }
}

/**
 * Settle a Predict-mode bet.
 *
 * Three paths:
 * 1. Both clips submitted → run through settleMatch (the exact same pipeline
 *    Judge mode uses, including the same comparison function).
 * 2. One clip only → forfeit, release full pot to the side with a clip,
 *    no AI comparison needed.
 * 3. Neither clip → mark as unresolved. No refund path exists in the escrow
 *    system, so the bet is left visibly stuck rather than silently dropped.
 *
 * @param {string} betId
 * @param {object} [verdict] - Precomputed head-to-head verdict, if available.
 * @returns {Promise<object>}
 */
async function settleBet (betId, verdict) {
  const store = _readBetStore()
  const record = store[betId]
  if (!record) throw new Error(`Bet not found: ${betId}`)
  if (record.status === 'settled' || record.status === 'forfeited') {
    throw new Error('Bet is already settled')
  }

  const hasClipA = record.clipA !== null
  const hasClipB = record.clipB !== null

  // --- Neither side submitted a clip ---
  if (!hasClipA && !hasClipB) {
    record.status = 'unresolved'
    store[betId] = record
    _writeBetStore(store)
    return {
      outcome: 'unresolved',
      betId,
      reason: 'Neither player scored — no clips to compare. No refund path exists; bet is left unresolved.'
    }
  }

  // --- One side only — forfeit, skip AI comparison ---
  if (hasClipA !== hasClipB) {
    const winnerSide = hasClipA ? 'A' : 'B'
    const winnerAddress = winnerSide === 'A' ? record.participantA : record.participantB

    const release = await escrow.releaseEscrow(record.escrowId, winnerAddress)

    record.status = 'forfeited'
    record.winner = winnerSide
    record.txHash = release.txHash
    record.settledAt = new Date().toISOString()
    store[betId] = record
    _writeBetStore(store)

    const loserSide = winnerSide === 'A' ? 'B' : 'A'
    console.log(`[predict:forfeit] bet=${betId.slice(0, 8)}… side ${loserSide} had no clip, pot → ${winnerSide}`)

    return {
      outcome: 'forfeited',
      betId,
      winner: winnerSide,
      winnerAddress,
      forfeitedSide: loserSide,
      payout: release.payout,
      txHash: release.txHash
    }
  }

  // --- Both clips submitted — full comparison via the same pipeline Judge mode uses ---
  //
  // NOTE: settleMatch internally uses compareHeadToHead, which has a known
  // open issue: certain dimensions (speed, distance) can be biased by which
  // clip is presented first. A fix for this is being validated separately and
  // is not yet merged. This is an existing issue in Judge mode today, not
  // something introduced by Predict mode. Since Predict calls the exact same
  // settleMatch function Judge mode uses, once that fix merges, Predict mode
  // will pick it up automatically with no changes needed here.
  const result = await settlement.settleMatch(
    record.escrowId,
    record.clipA,
    record.clipB,
    record.participantA,
    record.participantB,
    verdict
  )

  if (result.outcome === 'settled') {
    record.status = 'settled'
    record.winner = result.winner
    record.txHash = result.txHash
    record.settledAt = new Date().toISOString()
  } else if (result.outcome === 'tied') {
    // Tied head-to-head — no refund path exists, same as the "neither scored"
    // case. The bet stays visibly unresolved.
    record.status = 'unresolved'
  }
  // 'unfunded' and 'already_settled' leave the record as-is.
  store[betId] = record
  _writeBetStore(store)

  return { ...result, betId }
}

module.exports = {
  loadTournamentData,
  getGoalScorers,
  createBet,
  listBets,
  deleteBets,
  getBetStatus,
  submitClip,
  settleBet
}
