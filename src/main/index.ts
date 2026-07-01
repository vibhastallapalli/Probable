import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { EscrowService } from './services/escrow.js'
import { QvacJudgeService } from './services/qvac-judge.js'
import { WdkWalletService } from './services/wdk-wallet.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

let mainWindow: BrowserWindow | null = null
const walletService = new WdkWalletService()
const judgeService = new QvacJudgeService()
let escrowService: EscrowService

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    title: 'Probable — Tether Developers Cup',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc(): void {
  ipcMain.handle('wallet:getInfo', () => walletService.getInfo())
  ipcMain.handle('wallet:create', () => walletService.createWallet())
  ipcMain.handle('wallet:importSeed', (_e, seed: string) => walletService.importSeed(seed))
  ipcMain.handle('wallet:getConfig', () => walletService.getConfig())

  ipcMain.handle('predict:createSession', (_e, title: string, names: string[]) =>
    escrowService.createSession(title, names)
  )
  ipcMain.handle('predict:listSessions', () => escrowService.listSessions())
  ipcMain.handle('predict:getSession', (_e, id: string) => escrowService.getSession(id))
  ipcMain.handle('predict:joinSession', (_e, id: string, name: string) =>
    escrowService.joinSession(id, name)
  )
  ipcMain.handle('predict:setPrediction', (_e, id: string, playerId: string, predictionId: string) =>
    escrowService.setPrediction(id, playerId, predictionId)
  )
  ipcMain.handle('predict:raiseStake', (_e, id: string, playerId: string, stake: number) =>
    escrowService.raiseStake(id, playerId, stake)
  )
  ipcMain.handle('predict:deposit', (_e, id: string, playerId: string, amount: number) =>
    escrowService.deposit(id, playerId, amount)
  )
  ipcMain.handle('predict:lock', (_e, id: string) => escrowService.lockSession(id))
  ipcMain.handle('predict:declareWinner', (_e, id: string, winnerId: string) =>
    escrowService.declareWinner(id, winnerId)
  )
  ipcMain.handle('predict:settle', (_e, id: string) => escrowService.settle(id))

  ipcMain.handle('judge:pickVideo', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(
    'judge:compare',
    (_e, clipA: string, clipB: string, nameA: string, nameB: string) =>
      judgeService.judgeClips(clipA, clipB, nameA, nameB)
  )
  ipcMain.handle('judge:chat', (_e, message: string) => judgeService.chat(message))
  ipcMain.handle('judge:lastResult', () => judgeService.getLastResult())

  ipcMain.handle('app:getDataPath', () => escrowService.getDataPath())
  ipcMain.handle('app:openPath', (_e, filePath: string) => shell.openPath(filePath))
}

app.whenReady().then(async () => {
  const configCandidates = [
    join(process.cwd(), 'qvac.config.json'),
    join(app.getAppPath(), 'qvac.config.json')
  ]
  const configPath = configCandidates.find((p) => existsSync(p))
  if (configPath) process.env.QVAC_CONFIG_PATH = configPath

  await walletService.init()
  escrowService = new EscrowService(() => walletService.getEscrowAddress())
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await judgeService.dispose()
  walletService.dispose()
  if (process.platform !== 'darwin') app.quit()
})
