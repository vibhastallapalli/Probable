'use strict'

const { randomUUID } = require('crypto')

// In-memory escrow store. Will be replaced with on-chain smart contract calls
// once the QVAC scoring layer determines the winner automatically.
const escrows = new Map()

/**
 * Lock both participant stakes into a new escrow.
 * @param {string} participant1 - EVM address of first participant
 * @param {string} participant2 - EVM address of second participant
 * @param {number|string} stakeAmount - USDt stake per participant
 * @returns {object} The created escrow record
 */
function createEscrow (participant1, participant2, stakeAmount) {
  if (!participant1 || !participant2) throw new Error('Both participant addresses are required')
  if (participant1.toLowerCase() === participant2.toLowerCase()) throw new Error('Participants must be different addresses')

  const amount = parseFloat(stakeAmount)
  if (isNaN(amount) || amount <= 0) throw new Error('Stake amount must be a positive number')

  const id = randomUUID()
  const record = {
    id,
    participant1,
    participant2,
    stakeAmount: amount,
    status: 'locked',
    balance: amount * 2,
    winner: null,
    createdAt: new Date().toISOString(),
    releasedAt: null
  }
  escrows.set(id, record)
  return { ...record }
}

/**
 * @param {string} escrowId
 * @returns {object} Current escrow status snapshot
 */
function getEscrowStatus (escrowId) {
  const record = escrows.get(escrowId)
  if (!record) throw new Error(`Escrow not found: ${escrowId}`)
  return { ...record }
}

/**
 * Release the full locked balance to the winner.
 * @param {string} escrowId
 * @param {string} winnerAddress - Must be one of the two participants
 * @returns {object} Release summary
 */
function releaseEscrow (escrowId, winnerAddress) {
  const record = escrows.get(escrowId)
  if (!record) throw new Error(`Escrow not found: ${escrowId}`)
  if (record.status === 'released') throw new Error('Escrow has already been released')

  const winner = winnerAddress.toLowerCase()
  if (winner !== record.participant1.toLowerCase() && winner !== record.participant2.toLowerCase()) {
    throw new Error('Winner address must be one of the two participants')
  }

  const payout = record.balance
  record.status = 'released'
  record.winner = winnerAddress
  record.balance = 0
  record.releasedAt = new Date().toISOString()

  return {
    id: record.id,
    status: record.status,
    winner: record.winner,
    payout,
    releasedAt: record.releasedAt
  }
}

module.exports = { createEscrow, getEscrowStatus, releaseEscrow }
