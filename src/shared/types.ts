export type PlayerId = string

export type BetSessionStatus = 'open' | 'locked' | 'settled' | 'cancelled'

export interface Player {
  id: PlayerId
  name: string
  walletAddress?: string
  depositedUsd: number
  prediction?: PlayerId
  points: number
}

export interface BetSession {
  id: string
  title: string
  mode: 'predict'
  status: BetSessionStatus
  potUsd: number
  minRaiseUsd: number
  currentStakeUsd: number
  players: Player[]
  winnerId?: PlayerId
  punishment?: string
  createdAt: string
  escrowAddress?: string
}

export type ShotType =
  | 'long-range'
  | 'power'
  | 'finesse-curler'
  | 'chip-lob'
  | 'volley'
  | 'half-volley'
  | 'header'
  | 'bicycle-kick'
  | 'scorpion-kick'
  | 'rabona'
  | 'backheel'
  | 'first-time'
  | 'free-kick'
  | 'penalty'
  | 'tap-in'
  | 'solo-run'
  | 'counterattack'
  | 'one-touch-team'
  | 'weak-foot'
  | 'tight-angle'
  | 'unknown'

export interface ClipScore {
  playerName: string
  clipPath: string
  shotType: ShotType
  tags: string[]
  totalScore: number
  breakdown: Record<string, number>
  explanation: string
}

export interface JudgeResult {
  winnerName: string
  winnerClipPath: string
  scores: ClipScore[]
  comparisonSummary: string
  judgedAt: string
}

export interface WalletInfo {
  address: string
  chain: string
  isDemo: boolean
}

export interface AppConfig {
  evmRpcUrl: string
  usdtContractAddress: string
  chainName: string
  demoMode: boolean
}
