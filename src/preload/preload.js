'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('probable', {
  appName: 'Probable',
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },

  // Safe wallet surface: address only — no keys, no signing
  wallet: {
    getAddress: () => ipcRenderer.invoke('wallet:get-address'),
  },

  escrow: {
    create: (participant1, participant2, stakeAmount) =>
      ipcRenderer.invoke('escrow:create', participant1, participant2, stakeAmount),
    getStatus: (escrowId) =>
      ipcRenderer.invoke('escrow:get-status', escrowId),
    list: () => ipcRenderer.invoke('escrow:list'),
    delete: (ids) => ipcRenderer.invoke('escrow:delete', ids),
    release: (escrowId, winnerAddress) =>
      ipcRenderer.invoke('escrow:release', escrowId, winnerAddress),
  },

  clip: {
    pickVideo: () => ipcRenderer.invoke('clip:pick-video'),
    // Absolute path of a dropped File. Electron 32 removed File.path, so the
    // renderer can no longer read it directly — this is the sanctioned route.
    pathForFile: (file) => webUtils.getPathForFile(file),
    probe: (videoPath) => ipcRenderer.invoke('clip:probe', videoPath),
    prepareModel: () => ipcRenderer.invoke('clip:prepare-model'),
    score: (videoPath) => ipcRenderer.invoke('clip:score', videoPath),
    compare: (clipA, clipB) => ipcRenderer.invoke('clip:compare', clipA, clipB),
    // Subscribe to model download/load progress. Returns an unsubscribe fn.
    onModelProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('clip:model-progress', listener)
      return () => ipcRenderer.removeListener('clip:model-progress', listener)
    },
  },

  scoring: {
    modelInfo: () => ipcRenderer.invoke('scoring:model'),
  },

  match: {
    compare: (clipA, clipB) =>
      ipcRenderer.invoke('match:compare', clipA, clipB),
    settle: (matchId, clipA, clipB, addressA, addressB, verdict, opts) =>
      ipcRenderer.invoke('match:settle', matchId, clipA, clipB, addressA, addressB, verdict, opts),
  },

  predict: {
    getScorers: () => ipcRenderer.invoke('predict:get-scorers'),
    computeOdds: (playerA, playerB) =>
      ipcRenderer.invoke('predict:compute-odds', playerA, playerB),
    createBet: (opts) => ipcRenderer.invoke('predict:create-bet', opts),
    listBets: () => ipcRenderer.invoke('predict:list-bets'),
    deleteBets: (ids) => ipcRenderer.invoke('predict:delete-bets', ids),
    getBetStatus: (betId) => ipcRenderer.invoke('predict:get-bet-status', betId),
    submitClip: (betId, side, clipScore) =>
      ipcRenderer.invoke('predict:submit-clip', betId, side, clipScore),
    settleBet: (betId, verdict) =>
      ipcRenderer.invoke('predict:settle-bet', betId, verdict),
  },
})
