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
    release: (escrowId, winnerAddress) =>
      ipcRenderer.invoke('escrow:release', escrowId, winnerAddress),
  },
})
