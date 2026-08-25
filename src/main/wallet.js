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

// ---------------------------------------------------------------------------
// Transient RPC error handling
//
// Public Sepolia endpoints (drpc.org in particular) intermittently answer
// eth_sendRawTransaction with a JSON-RPC "Temporary internal error. Please
// retry" (code 19), which ethers v6 surfaces as "could not coalesce error".
// The signed transaction never reaches the mempool in that case, so re-sending
// after a short backoff succeeds. We also rotate to fallback endpoints so a
// longer blip on one provider doesn't fail an otherwise-valid payout.
// ---------------------------------------------------------------------------

// Sepolia RPC endpoints, tried in order. The configured/default endpoint is
// primary; the rest are fallbacks used only when a send hits a transient error.
const SEPOLIA_RPCS = (() => {
  const primary = process.env.WDK_EVM_PROVIDER || 'https://sepolia.drpc.org'
  // Verified live (probed 2026-07) key-free public Sepolia endpoints. Public
  // endpoints get deprecated without notice (rpc.sepolia.org and blastapi both
  // died this way), so for a reliable demo set WDK_EVM_PROVIDER to a keyed
  // provider (Alchemy/Infura) — it becomes primary and these stay as backups.
  const fallbacks = [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://rpc.sepolia.ethpandaops.io',
    'https://sepolia.gateway.tenderly.co'
  ].filter((url) => url !== primary)
  return [primary, ...fallbacks]
})()

const RELEASE_MAX_ATTEMPTS = 5
const RELEASE_BASE_DELAY_MS = 800

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// True when err looks like a temporary provider hiccup that a retry can clear,
// rather than a real rejection (bad nonce, insufficient funds, already known).
// Checks both the nested ethers JSON-RPC error and the flattened message text,
// since WDK may re-wrap the error and drop the structured `error` field.
function _isTransientRpcError (err) {
  const inner = err?.error ?? err
  const code = inner?.code ?? err?.code
  const text = `${err?.message ?? ''} ${inner?.message ?? ''}`.toLowerCase()

  // Insufficient funds (the match wallet has no ETH to pay gas) is permanent:
  // no amount of retrying or endpoint rotation changes an on-chain balance, and
  // one endpoint reports it inside a 400 that would otherwise trip the
  // SERVER_ERROR rule below and waste five retries hiding the real cause. Must
  // be checked FIRST so it always wins over the transient rules.
  if (code === 'INSUFFICIENT_FUNDS' || text.includes('insufficient funds')) return false
  // JSON-RPC code 19 is drpc's "Temporary internal error. Please retry".
  if (code === 19) return true
  // A dead/misconfigured endpoint answers HTTP-level (404/5xx) rather than with
  // JSON-RPC. ethers surfaces these as code SERVER_ERROR. The signed tx never
  // reaches a mempool, so rotating to the next endpoint is safe and correct.
  if (code === 'SERVER_ERROR') return true
  return (
    text.includes('temporary internal error') ||
    text.includes('please retry') ||
    text.includes('could not coalesce') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('bad gateway') ||
    text.includes('service unavailable') ||
    text.includes('econnreset') ||
    text.includes('not found') ||
    text.includes('404') ||
    text.includes('502') ||
    text.includes('503')
  )
}

// True when the failure is the match wallet having no ETH to pay gas — a
// funding gap the operator must fix, distinct from a token-balance shortfall
// (guarded separately) or a transient RPC error. ethers tags this
// INSUFFICIENT_FUNDS; the text check catches endpoints that only report it as
// a message inside a batch/HTTP error.
function _isInsufficientGas (err) {
  const inner = err?.error ?? err
  const code = inner?.code ?? err?.code
  const text = `${err?.message ?? ''} ${inner?.message ?? ''}`.toLowerCase()
  return code === 'INSUFFICIENT_FUNDS' || text.includes('insufficient funds')
}

// Opens a WDK account for an existing match wallet against the given RPC
// endpoint. Throws if no seed is stored.
async function _getMatchWalletAccount (matchId, providerUrl = SEPOLIA_RPCS[0]) {
  const { default: WDK } = await import('@tetherto/wdk')
  const { default: WalletManagerEvm } = await import('@tetherto/wdk-wallet-evm')

  const store = _readMatchWalletStore()
  const entry = store[matchId]
  if (!entry) throw new Error(`No match wallet found for match: ${matchId}`)

  const wdk = new WDK(entry.seedPhrase)
  wdk.registerWallet('ethereum', WalletManagerEvm, { provider: providerUrl })
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
  // Public Sepolia endpoints occasionally reject eth_sendRawTransaction with a
  // transient "please retry" internal error before the tx reaches the mempool.
  // Retry with exponential backoff, rotating the RPC endpoint each attempt so a
  // longer blip on one provider doesn't fail the payout. Because every attempt
  // re-signs with the same (still-unused) nonce, at most one transaction can
  // ever confirm — there is no risk of paying the winner twice.
  let lastErr
  for (let attempt = 0; attempt < RELEASE_MAX_ATTEMPTS; attempt++) {
    const providerUrl = SEPOLIA_RPCS[attempt % SEPOLIA_RPCS.length]
    try {
      const account = await _getMatchWalletAccount(matchId, providerUrl)
      const balance = await account.getTokenBalance(tokenAddress)

      if (balance === 0n) throw new Error('Match wallet has no USDT balance to release')

      const result = await account.transfer({
        token: tokenAddress,
        recipient: recipientAddress,
        amount: balance
      })

      return { ...result, amount: balance }
    } catch (err) {
      // No ETH for gas is a funding gap, not an RPC blip: the match wallet holds
      // USDT but was never given the small amount of Sepolia ETH a transfer
      // needs to pay gas. Replace the raw hex-dump error with one that says
      // exactly where to send ETH, and stop immediately — retrying can't help.
      if (_isInsufficientGas(err)) {
        const address = await _getMatchWalletAccount(matchId)
          .then((acct) => acct.getAddress())
          .catch(() => null)
        throw new Error(
          'Match wallet has no Sepolia ETH to pay gas for the payout. Send a ' +
          'little test ETH (≈0.001 is plenty)' +
          (address ? ` to ${address}` : ' to the match wallet') +
          ', then settle again.'
        )
      }
      lastErr = err
      const isLastAttempt = attempt === RELEASE_MAX_ATTEMPTS - 1
      // Only retry transient RPC failures; real rejections surface immediately.
      if (isLastAttempt || !_isTransientRpcError(err)) throw err
      const delay = RELEASE_BASE_DELAY_MS * 2 ** attempt
      console.warn(
        `[wallet:release] transient RPC error on ${providerUrl} ` +
        `(attempt ${attempt + 1}/${RELEASE_MAX_ATTEMPTS}), retrying in ${delay}ms: ${err?.message ?? err}`
      )
      await _sleep(delay)
    }
  }
  throw lastErr
}

module.exports = { initWallet, getAddress, createMatchWallet, getMatchWalletBalance, releaseMatchWallet, USDT_SEPOLIA }
