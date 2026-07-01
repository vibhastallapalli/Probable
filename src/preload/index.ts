import { contextBridge, ipcRenderer } from 'electron'

const probable = {
  wallet: {
    getInfo: () => ipcRenderer.invoke('wallet:getInfo'),
    createWallet: () => ipcRenderer.invoke('wallet:create'),
    importSeed: (seedPhrase: string) => ipcRenderer.invoke('wallet:importSeed', seedPhrase),
    getConfig: () => ipcRenderer.invoke('wallet:getConfig')
  },
  predict: {
    createSession: (title: string, playerNames: string[]) =>
      ipcRenderer.invoke('predict:createSession', title, playerNames),
    listSessions: () => ipcRenderer.invoke('predict:listSessions'),
    getSession: (sessionId: string) => ipcRenderer.invoke('predict:getSession', sessionId),
    joinSession: (sessionId: string, playerName: string) =>
      ipcRenderer.invoke('predict:joinSession', sessionId, playerName),
    setPrediction: (sessionId: string, playerId: string, predictionId: string) =>
      ipcRenderer.invoke('predict:setPrediction', sessionId, playerId, predictionId),
    raiseStake: (sessionId: string, playerId: string, newStakeUsd: number) =>
      ipcRenderer.invoke('predict:raiseStake', sessionId, playerId, newStakeUsd),
    deposit: (sessionId: string, playerId: string, amountUsd: number) =>
      ipcRenderer.invoke('predict:deposit', sessionId, playerId, amountUsd),
    lockSession: (sessionId: string) => ipcRenderer.invoke('predict:lock', sessionId),
    declareWinner: (sessionId: string, winnerId: string) =>
      ipcRenderer.invoke('predict:declareWinner', sessionId, winnerId),
    settle: (sessionId: string) => ipcRenderer.invoke('predict:settle', sessionId)
  },
  judge: {
    pickVideo: () => ipcRenderer.invoke('judge:pickVideo'),
    judgeClips: (clipAPath: string, clipBPath: string, playerAName: string, playerBName: string) =>
      ipcRenderer.invoke('judge:compare', clipAPath, clipBPath, playerAName, playerBName),
    chat: (message: string) => ipcRenderer.invoke('judge:chat', message),
    getLastResult: () => ipcRenderer.invoke('judge:lastResult')
  },
  app: {
    getDataPath: () => ipcRenderer.invoke('app:getDataPath'),
    openPath: (filePath: string) => ipcRenderer.invoke('app:openPath', filePath)
  }
}

contextBridge.exposeInMainWorld('probable', probable)
