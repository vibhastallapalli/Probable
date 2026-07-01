import { mkdir, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'

ffmpeg.setFfmpegPath(ffmpegStatic as string)

export interface ExtractFramesOptions {
  maxFrames?: number
  targetFps?: number
}

export async function extractFrames(
  videoPath: string,
  options: ExtractFramesOptions = {}
): Promise<string[]> {
  const { maxFrames = 12, targetFps = 2 } = options
  const outDir = join(tmpdir(), `probable-frames-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(outDir, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([`-vf fps=${targetFps}`, '-q:v 2'])
      .output(join(outDir, 'frame-%03d.jpg'))
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })

  const files = (await readdir(outDir))
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .slice(0, maxFrames)
    .map((f) => join(outDir, f))

  return files
}

export async function cleanupFrames(framePaths: string[]): Promise<void> {
  const dirs = new Set(framePaths.map((p) => join(p, '..')))
  for (const file of framePaths) {
    await unlink(file).catch(() => {})
  }
  for (const dir of dirs) {
    const remaining = await readdir(dir).catch(() => [])
    for (const f of remaining) {
      await unlink(join(dir, f)).catch(() => {})
    }
  }
}
