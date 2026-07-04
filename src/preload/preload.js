'use strict'

const { contextBridge, ipcRenderer } = require('electron')

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
    release: (escrowId, winnerAddress) =>
      ipcRenderer.invoke('escrow:release', escrowId, winnerAddress),
  },

  clip: {
    pickVideo: () => ipcRenderer.invoke('clip:pick-video'),
    probe: (videoPath) => ipcRenderer.invoke('clip:probe', videoPath),
    score: (videoPath) => ipcRenderer.invoke('clip:score', videoPath),
    compare: (clipA, clipB) => ipcRenderer.invoke('clip:compare', clipA, clipB),
  },

  scoring: {
    modelInfo: () => ipcRenderer.invoke('scoring:model'),
  },

  match: {
    settle: (matchId, clipA, clipB, addressA, addressB) =>
      ipcRenderer.invoke('match:settle', matchId, clipA, clipB, addressA, addressB),
  },
})
