import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import type { AppConfig, WalletInfo } from '../../shared/types.js'

type EvmAccount = { getAddress(): Promise<string> }

async function readAddress(account: unknown): Promise<string> {
  return (account as EvmAccount).getAddress()
}

const WALLET_FILE = () => join(app.getPath('userData'), 'probable-data', 'wallet.json')

/** Sepolia USDT — swap for mainnet address in production */
const DEFAULT_CONFIG: AppConfig = {
  chainName: 'ethereum-sepolia',
  evmRpcUrl: process.env.PROBABLE_EVM_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com',
  usdtContractAddress: process.env.PROBABLE_USDT_CONTRACT ?? '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0',
  demoMode: process.env.PROBABLE_DEMO_MODE !== 'false'
}

export class WdkWalletService {
  private wdk: InstanceType<typeof WDK> | null = null
  private seedPhrase: string | null = null
  private config: AppConfig = { ...DEFAULT_CONFIG }

  async init(): Promise<void> {
    await mkdir(join(app.getPath('userData'), 'probable-data'), { recursive: true })
    try {
      const raw = await readFile(WALLET_FILE(), 'utf-8')
      const saved = JSON.parse(raw) as { seedPhrase: string; config?: AppConfig }
      this.seedPhrase = saved.seedPhrase
      if (saved.config) this.config = { ...DEFAULT_CONFIG, ...saved.config }
      await this.buildWdk()
    } catch {
      // no wallet yet
    }
  }

  private async buildWdk(): Promise<void> {
    if (!this.seedPhrase) return
    this.wdk?.dispose()
    // WDK beta: EVM wallet manager types lag behind runtime API
    this.wdk = new WDK(this.seedPhrase).registerWallet(
      'ethereum',
      WalletManagerEvm as unknown as Parameters<InstanceType<typeof WDK>['registerWallet']>[1],
      { provider: this.config.evmRpcUrl } as never
    )
  }

  private async persist(): Promise<void> {
    if (!this.seedPhrase) return
    await writeFile(
      WALLET_FILE(),
      JSON.stringify({ seedPhrase: this.seedPhrase, config: this.config }, null, 2),
      'utf-8'
    )
  }

  getConfig(): AppConfig {
    return { ...this.config }
  }

  async createWallet(): Promise<WalletInfo> {
    this.seedPhrase = WDK.getRandomSeedPhrase()
    await this.buildWdk()
    await this.persist()
    return this.getInfo()
  }

  async importSeed(seedPhrase: string): Promise<WalletInfo> {
    const normalized = seedPhrase.trim()
    if (normalized.split(/\s+/).length < 12) {
      throw new Error('Seed phrase must be at least 12 words')
    }
    this.seedPhrase = normalized
    await this.buildWdk()
    await this.persist()
    return this.getInfo()
  }

  async getInfo(): Promise<WalletInfo> {
    if (!this.wdk) {
      return {
        address: '',
        chain: this.config.chainName,
        isDemo: this.config.demoMode
      }
    }
    const account = await this.wdk.getAccount('ethereum', 0)
    const address = await readAddress(account)
    return {
      address,
      chain: this.config.chainName,
      isDemo: this.config.demoMode
    }
  }

  /** Escrow sub-account (index 1) holds pooled USDt for Predict sessions */
  async getEscrowAddress(): Promise<string | undefined> {
    if (!this.wdk) return undefined
    const escrow = await this.wdk.getAccount('ethereum', 1)
    return readAddress(escrow)
  }

  /**
   * Demo: records intent. Production: ERC-20 transfer to escrow via WDK account.
   * Full on-chain USDT wiring lands in the WDK integration PR after testnet faucet setup.
   */
  async depositToEscrow(amountUsd: number): Promise<{ txHash?: string; demo: boolean }> {
    if (this.config.demoMode) {
      return { demo: true }
    }
    if (!this.wdk) throw new Error('Wallet not initialized')
    // TODO: ERC-20 USDT transfer — account.sendTransaction with token contract data
    void amountUsd
    return { demo: false, txHash: 'pending-wdk-usdt-integration' }
  }

  async payoutWinner(winnerAddress: string, amountUsd: number): Promise<{ txHash?: string; demo: boolean }> {
    if (this.config.demoMode) {
      return { demo: true }
    }
    if (!this.wdk) throw new Error('Wallet not initialized')
    void winnerAddress
    void amountUsd
    return { demo: false, txHash: 'pending-wdk-usdt-integration' }
  }

  dispose(): void {
    this.wdk?.dispose()
    this.wdk = null
  }
}
