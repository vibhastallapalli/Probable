'use strict'

const path = require('path')
const fs = require('fs')
const { app } = require('electron')

// Exported so escrow.js can reference the same token without duplicating the address.
const USDT_SEPOLIA = '0xd077a400968890eacc75cdc901f0356c943e4fdb'

let _address = null

// Seed phrase is stored plaintext for hackathon purposes.
// Production builds must encrypt this at rest before writing to disk.
// WHAT THIS DOES: Creates or loads the app's own wallet on startup. The seed
//   phrase is stored in plaintext JSON — hackathon only.
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

// WHAT THIS DOES: Returns the app wallet's address. The only wallet thing
//   the UI is allowed to ask for.
function getAddress () {
  if (!_address) throw new Error('Wallet not initialised — call initWallet() first')
  return _address
}

// ---------------------------------------------------------------------------
// Match wallet storage — userData/match-wallets.json, keyed by matchId.
// ---------------------------------------------------------------------------

// WHAT THIS DOES: Path to the JSON file holding every match wallet's seed
//   phrase.
function _matchWalletsFile () {
  return path.join(app.getPath('userData'), 'match-wallets.json')
}

// WHAT THIS DOES: Reads all stored match wallets off disk.
function _readMatchWalletStore () {
  const file = _matchWalletsFile()
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// WHAT THIS DOES: Writes all match wallets back to disk.
function _writeMatchWalletStore (store) {
  fs.writeFileSync(_matchWalletsFile(), JSON.stringify(store, null, 2), 'utf8')
}

// Opens a WDK account for an existing match wallet. Throws if no seed is stored.
// WHAT THIS DOES: Opens an existing match wallet so we can read its balance
//   or send from it.
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
// WHAT THIS DOES: Makes a brand-new throwaway wallet for ONE match. Calling
//   it again with the same match ID gives back the same address.
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
// WHAT THIS DOES: Reads how much USDt is sitting in a match wallet, live
//   from the chain.
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
// WHAT THIS DOES: Sends the match wallet's ENTIRE balance to one address.
//   Not the stake — everything in it.
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
