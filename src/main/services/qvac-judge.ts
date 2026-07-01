import {
  completion,
  loadModel,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  unloadModel
} from '@qvac/sdk'
import type { ClipScore, JudgeResult, ShotType } from '../../shared/types.js'
import { cleanupFrames, extractFrames } from './video-frames.js'

const SHOT_TYPES: ShotType[] = [
  'long-range',
  'power',
  'finesse-curler',
  'chip-lob',
  'volley',
  'header',
  'bicycle-kick',
  'free-kick',
  'penalty',
  'solo-run',
  'tap-in',
  'unknown'
]

const RUBRIC_HINT = `
Score each clip 0-100 using football aesthetics (not physics):
- Accuracy, technique, difficulty, flair, entertainment
- Classify shot type first, then apply type-specific weights
- Long-range: accuracy 25, power 20, technique 20, difficulty 20, flair 10, entertainment 5
- Finesse curler: finesse 30, accuracy 25, technique 20, difficulty 15, flair 10
- Volley: timing 25, technique 25, difficulty 20, accuracy 15, power 10, flair 5
- Header: positioning 25, timing 20, power 20, accuracy 20, difficulty 15
- Bicycle kick: difficulty 35, technique 25, flair 20, accuracy 10, athleticism 10
Respond in JSON only:
{"shotType":"...","tags":["..."],"totalScore":0-100,"breakdown":{"accuracy":0,"technique":0,"difficulty":0,"flair":0},"explanation":"..."}
`.trim()

let modelId: string | null = null
let lastJudgeResult: JudgeResult | null = null
let chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []

async function ensureModel(): Promise<string> {
  if (modelId) return modelId
  modelId = await loadModel({
    modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
    modelConfig: {
      ctx_size: 4096,
      projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0
    },
    onProgress: (p) => {
      process.stderr.write(`\r[QVAC] Loading model ${p.percentage.toFixed(0)}%`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })
  return modelId
}

async function streamCompletion(
  history: Array<{ role: 'user' | 'assistant'; content: string; attachments?: { path: string }[] }>
): Promise<string> {
  const id = await ensureModel()
  const result = completion({ modelId: id, history, stream: true })
  let text = ''
  for await (const token of result.tokenStream) {
    text += token
  }
  return text.trim()
}

function parseScoreJson(raw: string, fallbackName: string, clipPath: string): ClipScore {
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  try {
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as Partial<ClipScore>
    const shotType = SHOT_TYPES.includes(parsed.shotType as ShotType)
      ? (parsed.shotType as ShotType)
      : 'unknown'
    return {
      playerName: fallbackName,
      clipPath,
      shotType,
      tags: parsed.tags ?? [],
      totalScore: Number(parsed.totalScore) || 0,
      breakdown: parsed.breakdown ?? {},
      explanation: parsed.explanation ?? raw
    }
  } catch {
    return {
      playerName: fallbackName,
      clipPath,
      shotType: 'unknown',
      tags: [],
      totalScore: 50,
      breakdown: {},
      explanation: raw
    }
  }
}

async function scoreSingleClip(frames: string[], playerName: string, clipPath: string): Promise<ClipScore> {
  const attachments = frames.slice(0, 6).map((path) => ({ path }))
  const history = [
    {
      role: 'user' as const,
      content: `${RUBRIC_HINT}\n\nAnalyze this football clip for player "${playerName}". Judge impressiveness like FIFA Goal of the Year, not strict refereeing.`,
      attachments
    }
  ]
  const raw = await streamCompletion(history)
  return parseScoreJson(raw, playerName, clipPath)
}

export class QvacJudgeService {
  async judgeClips(
    clipAPath: string,
    clipBPath: string,
    playerAName: string,
    playerBName: string
  ): Promise<JudgeResult> {
    const framesA = await extractFrames(clipAPath, { maxFrames: 10, targetFps: 2 })
    const framesB = await extractFrames(clipBPath, { maxFrames: 10, targetFps: 2 })

    try {
      const [scoreA, scoreB] = await Promise.all([
        scoreSingleClip(framesA, playerAName, clipAPath),
        scoreSingleClip(framesB, playerBName, clipBPath)
      ])

      let winnerName: string
      let winnerClipPath: string
      if (scoreA.totalScore >= scoreB.totalScore) {
        winnerName = playerAName
        winnerClipPath = clipAPath
      } else {
        winnerName = playerBName
        winnerClipPath = clipBPath
      }

      const comparisonSummary = `${winnerName} wins ${Math.max(scoreA.totalScore, scoreB.totalScore)} vs ${Math.min(scoreA.totalScore, scoreB.totalScore)}. ${scoreA.explanation}`

      chatHistory = [
        {
          role: 'assistant',
          content: `I judged ${playerAName} (${scoreA.totalScore}/100, ${scoreA.shotType}) vs ${playerBName} (${scoreB.totalScore}/100, ${scoreB.shotType}). Winner: ${winnerName}. ${comparisonSummary}`
        }
      ]

      lastJudgeResult = {
        winnerName,
        winnerClipPath,
        scores: [scoreA, scoreB],
        comparisonSummary,
        judgedAt: new Date().toISOString()
      }

      return lastJudgeResult
    } finally {
      await cleanupFrames([...framesA, ...framesB])
    }
  }

  async chat(message: string): Promise<string> {
    if (!lastJudgeResult) {
      throw new Error('Run a judge comparison first')
    }
    chatHistory.push({ role: 'user', content: message })
    const id = await ensureModel()
    const result = completion({
      modelId: id,
      history: [
        {
          role: 'system',
          content:
            'You are the Probable football clip judge. Explain your prior scoring decisions. Do not act as a live referee for fouls/offsides.'
        },
        ...chatHistory
      ],
      stream: true
    })
    let reply = ''
    for await (const token of result.tokenStream) {
      reply += token
    }
    reply = reply.trim()
    chatHistory.push({ role: 'assistant', content: reply })
    return reply
  }

  getLastResult(): JudgeResult | null {
    return lastJudgeResult
  }

  async dispose(): Promise<void> {
    if (modelId) {
      await unloadModel({ modelId })
      modelId = null
    }
  }
}
