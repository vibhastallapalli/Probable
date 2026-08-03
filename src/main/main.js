'use strict'

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })

const { app, BrowserWindow, shell } = require('electron')
const { initWallet } = require('./wallet')
const { registerHandlers } = require('./ipc')

const isDev = !app.isPackaged
const DEV_SERVER_URL = 'http://localhost:5173'

// WHAT THIS DOES: Opens the app window, with the UI locked down so it has no
//   filesystem access and no Node APIs.
function createWindow () {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    title: 'Probable',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Open external links (e.g. the Sepolia Etherscan payout link) in the user's
  // default browser rather than a bare in-app window, and never let the app
  // itself navigate away from the UI.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.loadURL(DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'))
  }
}

app.whenReady().then(async () => {
  registerHandlers()
  await initWallet()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
