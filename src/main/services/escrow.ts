import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { BetSession, Player, PlayerId } from '../../shared/types.js'

const DATA_DIR = () => join(app.getPath('userData'), 'probable-data')
const SESSIONS_FILE = () => join(DATA_DIR(), 'sessions.json')

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR(), { recursive: true })
}

async function readSessions(): Promise<BetSession[]> {
  await ensureDataDir()
  try {
    const raw = await readFile(SESSIONS_FILE(), 'utf-8')
    return JSON.parse(raw) as BetSession[]
  } catch {
    return []
  }
}

async function writeSessions(sessions: BetSession[]): Promise<void> {
  await ensureDataDir()
  await writeFile(SESSIONS_FILE(), JSON.stringify(sessions, null, 2), 'utf-8')
}

function scorePoints(players: Player[], winnerId: PlayerId): Player[] {
  const sorted = [...players].sort((a, b) => {
    if (a.id === winnerId) return -1
    if (b.id === winnerId) return 1
    return b.depositedUsd - a.depositedUsd
  })

  return players.map((p) => {
    if (p.id === winnerId) return { ...p, points: p.points + 2 }
    const rank = sorted.findIndex((s) => s.id === p.id)
    if (rank === 1) return { ...p, points: p.points + 1 }
    if (p.depositedUsd <= 0 && !p.prediction) return { ...p, points: p.points + 0 }
    return { ...p, points: p.points - 1 }
  })
}

export class EscrowService {
  constructor(private getEscrowAddress: () => Promise<string | undefined>) {}

  async createSession(title: string, playerNames: string[]): Promise<BetSession> {
    const sessions = await readSessions()
    const escrowAddress = await this.getEscrowAddress()

    const players: Player[] = playerNames.map((name) => ({
      id: uuidv4(),
      name,
      depositedUsd: 0,
      points: 0
    }))

    const session: BetSession = {
      id: uuidv4(),
      title,
      mode: 'predict',
      status: 'open',
      potUsd: 0,
      minRaiseUsd: 1,
      currentStakeUsd: 1,
      players,
      createdAt: new Date().toISOString(),
      escrowAddress
    }

    sessions.push(session)
    await writeSessions(sessions)
    return session
  }

  async listSessions(): Promise<BetSession[]> {
    return readSessions()
  }

  async getSession(sessionId: string): Promise<BetSession | null> {
    const sessions = await readSessions()
    return sessions.find((s) => s.id === sessionId) ?? null
  }

  private async updateSession(sessionId: string, updater: (s: BetSession) => BetSession): Promise<BetSession> {
    const sessions = await readSessions()
    const idx = sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) throw new Error('Session not found')
    sessions[idx] = updater(sessions[idx])
    await writeSessions(sessions)
    return sessions[idx]
  }

  async joinSession(sessionId: string, playerName: string): Promise<BetSession> {
    return this.updateSession(sessionId, (s) => {
      if (s.status !== 'open') throw new Error('Session is not open')
      if (s.players.some((p) => p.name === playerName)) return s
      s.players.push({
        id: uuidv4(),
        name: playerName,
        depositedUsd: 0,
        points: 0
      })
      return s
    })
  }

  async setPrediction(sessionId: string, playerId: PlayerId, predictionId: PlayerId): Promise<BetSession> {
    return this.updateSession(sessionId, (s) => {
      s.players = s.players.map((p) =>
        p.id === playerId ? { ...p, prediction: predictionId } : p
      )
      return s
    })
  }

  async raiseStake(sessionId: string, playerId: PlayerId, newStakeUsd: number): Promise<BetSession> {
    return this.updateSession(sessionId, (s) => {
      if (newStakeUsd < s.currentStakeUsd + s.minRaiseUsd) {
        throw new Error(`Raise must be at least $${s.currentStakeUsd + s.minRaiseUsd}`)
      }
      s.currentStakeUsd = newStakeUsd
      return s
    })
  }

  async deposit(sessionId: string, playerId: PlayerId, amountUsd: number): Promise<BetSession> {
    return this.updateSession(sessionId, (s) => {
      if (amountUsd < s.currentStakeUsd) {
        throw new Error(`Minimum deposit for this pot is $${s.currentStakeUsd}`)
      }
      s.players = s.players.map((p) => {
        if (p.id !== playerId) return p
        const added = amountUsd
        return { ...p, depositedUsd: p.depositedUsd + added }
      })
      s.potUsd += amountUsd
      return s
    })
  }

  async lockSession(sessionId: string): Promise<BetSession> {
    return this.updateSession(sessionId, (s) => {
      s.status = 'locked'
      return s
    })
  }

  async declareWinner(sessionId: string, winnerId: PlayerId, punishment?: string): Promise<BetSession> {
    return this.updateSession(sessionId, (s) => {
      s.winnerId = winnerId
      s.punishment = punishment
      s.players = scorePoints(s.players, winnerId)
      return s
    })
  }

  async settle(sessionId: string): Promise<BetSession> {
    return this.updateSession(sessionId, (s) => {
      if (!s.winnerId) throw new Error('Declare a winner before settling')
      s.status = 'settled'
      return s
    })
  }

  getDataPath(): string {
    return DATA_DIR()
  }
}
