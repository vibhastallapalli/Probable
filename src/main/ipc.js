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

  // Read-only: returns every persisted escrow record for the saved list UI.
  ipcMain.handle('escrow:list', () => {
    return escrow.listEscrows()
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

  // Static facts about the local model, shown by the status badge in the UI.
  ipcMain.handle('scoring:model', () => {
    return scoring.MODEL_INFO
  })

  // Lightweight metadata read so the UI can warn about a low frame rate as
  // soon as a clip is picked, before any scoring work starts.
  ipcMain.handle('clip:probe', (_event, videoPath) => {
    return scoring.probeVideo(videoPath)
  })

  // One-time model warm-up before the first scoreClip. Streams download/load
  // progress back to the calling renderer on 'clip:model-progress' so the Log
  // shows the download instead of a silent wait, then resolves when ready.
  ipcMain.handle('clip:prepare-model', (event) => {
    return scoring.prepareModel((p) => {
      event.sender.send('clip:model-progress', p)
    })
  })

  // Full local pipeline: probe → extract frames → score via QVAC.
  ipcMain.handle('clip:score', async (_event, videoPath) => {
    const { duration, fps, lowFps } = await scoring.probeVideo(videoPath)
    const frames = await scoring.extractFrames(videoPath, { duration })
    const score = await scoring.scoreClip(frames, { duration })
    return { ...score, videoPath, fps, lowFps }
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
