'use strict'

const path = require('path')
const fs = require('fs')
const { app } = require('electron')

let _address = null

// Seed phrase is stored plaintext for hackathon purposes.
// Production builds must encrypt this at rest before writing to disk.
async function initWallet () {
  const { default: WDK } = await import('@tetherto/wdk')
  const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')

  const walletFile = path.join(app.getPath('userData'), 'wallet.json')

  let seedPhrase
  if (fs.existsSync(walletFile)) {
    seedPhrase = JSON.parse(fs.readFileSync(walletFile, 'utf8')).seedPhrase
  } else {
    seedPhrase = WDK.getRandomSeedPhrase()
    fs.writeFileSync(walletFile, JSON.stringify({ seedPhrase }, null, 2), 'utf8')
  }

  const provider = process.env.WDK_EVM_PROVIDER || 'https://sepolia.drpc.org'

  const wdk = new WDK(seedPhrase)
  wdk.registerWallet('ethereum', WalletManagerEvm, { provider })

  const account = await wdk.getAccount('ethereum', 0)
  _address = await account.getAddress()

  return _address
}

function getAddress () {
  if (!_address) throw new Error('Wallet not initialised — call initWallet() first')
  return _address
}

module.exports = { initWallet, getAddress }
