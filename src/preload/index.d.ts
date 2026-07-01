import type {
  AppConfig,
  BetSession,
  JudgeResult,
  Player,
  PlayerId,
  WalletInfo
} from '../shared/types.js'

export interface ProbableApi {
  wallet: {
    getInfo: () => Promise<WalletInfo>
    createWallet: () => Promise<WalletInfo>
    importSeed: (seedPhrase: string) => Promise<WalletInfo>
    getConfig: () => Promise<AppConfig>
  }
  predict: {
    createSession: (title: string, playerNames: string[]) => Promise<BetSession>
    listSessions: () => Promise<BetSession[]>
    getSession: (sessionId: string) => Promise<BetSession | null>
    joinSession: (sessionId: string, playerName: string) => Promise<BetSession>
    setPrediction: (sessionId: string, playerId: PlayerId, predictionId: PlayerId) => Promise<BetSession>
    raiseStake: (sessionId: string, playerId: PlayerId, newStakeUsd: number) => Promise<BetSession>
    deposit: (sessionId: string, playerId: PlayerId, amountUsd: number) => Promise<BetSession>
    lockSession: (sessionId: string) => Promise<BetSession>
    declareWinner: (sessionId: string, winnerId: PlayerId) => Promise<BetSession>
    settle: (sessionId: string) => Promise<BetSession>
  }
  judge: {
    pickVideo: () => Promise<string | null>
    judgeClips: (clipAPath: string, clipBPath: string, playerAName: string, playerBName: string) => Promise<JudgeResult>
    chat: (message: string) => Promise<string>
    getLastResult: () => Promise<JudgeResult | null>
  }
  app: {
    getDataPath: () => Promise<string>
    openPath: (filePath: string) => Promise<void>
  }
}

declare global {
  interface Window {
    probable: ProbableApi
  }
}

export {}
