'use strict'

const { ipcMain } = require('electron')
const wallet = require('./wallet')
const escrow = require('./escrow')

function registerHandlers () {
  ipcMain.handle('wallet:get-address', () => {
    return wallet.getAddress()
  })

  ipcMain.handle('escrow:create', (_event, participant1, participant2, stakeAmount) => {
    return escrow.createEscrow(participant1, participant2, stakeAmount)
  })

  ipcMain.handle('escrow:get-status', (_event, escrowId) => {
    return escrow.getEscrowStatus(escrowId)
  })

  ipcMain.handle('escrow:release', (_event, escrowId, winnerAddress) => {
    return escrow.releaseEscrow(escrowId, winnerAddress)
  })
}

module.exports = { registerHandlers }
