'use strict'

const path = require('path')
const fs = require('fs')
const { app } = require('electron')

// Exported so escrow.js can reference the same token without duplicating the address.
const USDT_SEPOLIA = '0xd077a400968890eacc75cdc901f0356c943e4fdb'

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

// ---------------------------------------------------------------------------
// Match wallet storage — userData/match-wallets.json, keyed by matchId.
// ---------------------------------------------------------------------------

function _matchWalletsFile () {
  return path.join(app.getPath('userData'), 'match-wallets.json')
}

function _readMatchWalletStore () {
  const file = _matchWalletsFile()
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function _writeMatchWalletStore (store) {
  fs.writeFileSync(_matchWalletsFile(), JSON.stringify(store, null, 2), 'utf8')
}

// Opens a WDK account for an existing match wallet. Throws if no seed is stored.
async function _getMatchWalletAccount (matchId) {
  const { default: WDK } = await import('@tetherto/wdk')
  const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')

  const store = _readMatchWalletStore()
  const entry = store[matchId]
  if (!entry) throw new Error(`No match wallet found for match: ${matchId}`)

  const provider = process.env.WDK_EVM_PROVIDER || 'https://sepolia.drpc.org'
  const wdk = new WDK(entry.seedPhrase)
  wdk.registerWallet('ethereum', WalletManagerEvm, { provider })
  return wdk.getAccount('ethereum', 0)
}

/**
 * Generate a fresh single-use wallet for one match and persist its seed to userData.
 * Idempotent: returns the same address if called again with the same matchId.
 * @param {string} matchId
 * @returns {Promise<string>} Ethereum address of the match wallet
 */
async function createMatchWallet (matchId) {
  const { default: WDK } = await import('@tetherto/wdk')
  const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')

  const store = _readMatchWalletStore()

  const seedPhrase = store[matchId]?.seedPhrase ?? WDK.getRandomSeedPhrase()
  if (!store[matchId]) {
    store[matchId] = { seedPhrase }
    _writeMatchWalletStore(store)
  }

  const provider = process.env.WDK_EVM_PROVIDER || 'https://sepolia.drpc.org'
  const wdk = new WDK(seedPhrase)
  wdk.registerWallet('ethereum', WalletManagerEvm, { provider })
  const account = await wdk.getAccount('ethereum', 0)
  return account.getAddress()
}

/**
 * Return the ERC-20 token balance of a match wallet in base units.
 * @param {string} matchId
 * @param {string} tokenAddress
 * @returns {Promise<bigint>} Balance in base units (6 decimals for USDT)
 */
async function getMatchWalletBalance (matchId, tokenAddress) {
  const account = await _getMatchWalletAccount(matchId)
  return account.getTokenBalance(tokenAddress)
}

/**
 * Transfer the entire ERC-20 balance of the match wallet to recipientAddress.
 * The match wallet must hold a small amount of Sepolia ETH to cover gas.
 * @param {string} matchId
 * @param {string} tokenAddress
 * @param {string} recipientAddress
 * @returns {Promise<{hash: string, fee: bigint, amount: bigint}>}
 */
async function releaseMatchWallet (matchId, tokenAddress, recipientAddress) {
  const account = await _getMatchWalletAccount(matchId)
  const balance = await account.getTokenBalance(tokenAddress)

  if (balance === 0n) throw new Error('Match wallet has no USDT balance to release')

  const result = await account.transfer({
    token: tokenAddress,
    recipient: recipientAddress,
    amount: balance
  })

  return { ...result, amount: balance }
}

module.exports = { initWallet, getAddress, createMatchWallet, getMatchWalletBalance, releaseMatchWallet, USDT_SEPOLIA }
