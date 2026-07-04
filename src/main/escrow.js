'use strict'

const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const { randomUUID } = require('crypto')
const wallet = require('./wallet')

// USDT has 6 decimal places; balances from the chain are in base units.
const USDT_DECIMALS = 6

// ---------------------------------------------------------------------------
// Escrow record storage — userData/escrows.json, keyed by escrow id.
// Replaces the previous in-memory Map so records survive restarts.
// ---------------------------------------------------------------------------

function _escrowsFile () {
  return path.join(app.getPath('userData'), 'escrows.json')
}

function _readEscrowStore () {
  const file = _escrowsFile()
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function _writeEscrowStore (store) {
  fs.writeFileSync(_escrowsFile(), JSON.stringify(store, null, 2), 'utf8')
}

function _toUsdt (baseUnits) {
  return Number(baseUnits) / Math.pow(10, USDT_DECIMALS)
}

/**
 * Generate a match wallet, persist the escrow record, and return it.
 * The matchWalletAddress in the returned record is where both participants
 * must send their USDT stake (plus a small amount of Sepolia ETH for gas).
 * @param {string} participant1 - EVM address of first participant
 * @param {string} participant2 - EVM address of second participant
 * @param {number|string} stakeAmount - USDt stake per participant (human-readable)
 * @returns {Promise<object>} The created escrow record
 */
async function createEscrow (participant1, participant2, stakeAmount) {
  if (!participant1 || !participant2) throw new Error('Both participant addresses are required')
  if (participant1.toLowerCase() === participant2.toLowerCase()) throw new Error('Participants must be different addresses')

  const amount = parseFloat(stakeAmount)
  if (isNaN(amount) || amount <= 0) throw new Error('Stake amount must be a positive number')

  const id = randomUUID()
  const matchWalletAddress = await wallet.createMatchWallet(id)

  console.log(`[escrow:create] id=${id.slice(0, 8)}...`)
  console.log(`[escrow:create] Match wallet: ${matchWalletAddress}`)
  console.log(`[escrow:create] Fund with ${amount * 2} USDT + small Sepolia ETH for gas → ${matchWalletAddress}`)

  const record = {
    id,
    participant1,
    participant2,
    stakeAmount: amount,
    status: 'locked',
    balance: 0,
    winner: null,
    matchWalletAddress,
    createdAt: new Date().toISOString(),
    releasedAt: null
  }

  const store = _readEscrowStore()
  store[id] = record
  _writeEscrowStore(store)

  return { ...record }
}

/**
 * Return current escrow state with live on-chain USDT balance.
 * @param {string} escrowId
 * @returns {Promise<object>}
 */
async function getEscrowStatus (escrowId) {
  const store = _readEscrowStore()
  const record = store[escrowId]
  if (!record) throw new Error(`Escrow not found: ${escrowId}`)

  const rawBalance = await wallet.getMatchWalletBalance(escrowId, wallet.USDT_SEPOLIA)
  const balance = _toUsdt(rawBalance)

  return { ...record, balance }
}

/**
 * Return every persisted escrow record. Read-only: reads the same
 * userData/escrows.json store that createEscrow writes to and never mutates
 * it. Balances are the last persisted values, not live on-chain reads.
 * @returns {object[]} All stored escrow records
 */
function listEscrows () {
  const store = _readEscrowStore()
  return Object.values(store).map((record) => ({ ...record }))
}

/**
 * Send the full USDT balance of the match wallet to the winner.
 * All existing guards (double-release, participant check) are preserved.
 * @param {string} escrowId
 * @param {string} winnerAddress - Must be one of the two participants
 * @returns {Promise<object>} Release summary with on-chain tx hash
 */
async function releaseEscrow (escrowId, winnerAddress) {
  const store = _readEscrowStore()
  const record = store[escrowId]
  if (!record) throw new Error(`Escrow not found: ${escrowId}`)
  if (record.status === 'released') throw new Error('Escrow has already been released')

  const winner = winnerAddress.toLowerCase()
  if (winner !== record.participant1.toLowerCase() && winner !== record.participant2.toLowerCase()) {
    throw new Error('Winner address must be one of the two participants')
  }

  const { hash, amount } = await wallet.releaseMatchWallet(escrowId, wallet.USDT_SEPOLIA, winnerAddress)
  const payout = _toUsdt(amount)

  record.status = 'released'
  record.winner = winnerAddress
  record.balance = 0
  record.releasedAt = new Date().toISOString()
  store[escrowId] = record
  _writeEscrowStore(store)

  console.log(`[escrow:release] ${payout} USDT → ${winnerAddress} | tx: ${hash}`)

  return {
    id: record.id,
    status: record.status,
    winner: record.winner,
    payout,
    txHash: hash,
    releasedAt: record.releasedAt
  }
}

module.exports = { createEscrow, getEscrowStatus, listEscrows, releaseEscrow }
