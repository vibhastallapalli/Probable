'use strict'

const { ipcMain, dialog } = require('electron')
const wallet = require('./wallet')
const escrow = require('./escrow')
const scoring = require('./scoring')
const settlement = require('./settlement')

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

  // Renderer has no filesystem access — the file picker runs in main.
  ipcMain.handle('clip:pick-video', async () => {
    // Test seam: bypass the native dialog in automated runs. Unset in normal use.
    if (process.env.QVAC_TEST_CLIP) return process.env.QVAC_TEST_CLIP
    const result = await dialog.showOpenDialog({
      title: 'Select a clip to score',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Full local pipeline: probe → extract frames → score via QVAC.
  ipcMain.handle('clip:score', async (_event, videoPath) => {
    const duration = await scoring.getVideoDuration(videoPath)
    const frames = await scoring.extractFrames(videoPath, { duration })
    const score = await scoring.scoreClip(frames, { duration })
    return { ...score, videoPath }
  })

  // Exposed for testing; NOT yet wired to escrow.releaseEscrow (manual next step).
  ipcMain.handle('clip:compare', (_event, clipA, clipB) => {
    return scoring.compareClips(clipA, clipB)
  })

  ipcMain.handle('match:settle', (_event, matchId, clipA, clipB, addressA, addressB) => {
    return settlement.settleMatch(matchId, clipA, clipB, addressA, addressB)
  })
}

module.exports = { registerHandlers }
