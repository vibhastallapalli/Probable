# Probable

A peer to peer football wagering desktop app. Stake testnet USDt on which of two goals is better, an on device AI model acts as referee scoring them against FIFA Puskas award style criteria, and the verdict triggers an automatic on chain payout. It works with any goal clips, whether that is two of your own or two players from a real match. Built for the Tether Developers Cup across the QVAC track (on device AI inference, zero cloud AI calls) and the WDK track (self custodial USDt wallet and settlement).

## How it works

Judge mode is the working core: submit any two goal clips, an on device vision model scores them head to head against a rubric based on FIFA Puskas award criteria, checking for positional bias by running the comparison both ways, and the winner is paid automatically from a per match escrow wallet on the Sepolia testnet. Placement is scored deterministically from a fixed goal zone grid, and odds are computed on device from real tournament goal data rather than guessed by the model.

## Roadmap

A Predict mode, where friends wager before a real match on which player will score the better goal and settle through the same scoring and payout pipeline, is built on a separate branch and slated to merge next.

## Prerequisites

- Node.js version 18 or higher.
- A Rabby wallet with two accounts on the Sepolia testnet, each holding some testnet USDt and some Sepolia ETH for gas.
- It is a desktop app built on Electron.

## Setup

1. Clone the repo and enter the folder.
2. Run `npm install`. This also runs a postinstall step that patches the Electron binary and the QVAC timeout automatically, so no extra setup is needed.
3. Copy the example environment file to a real one: `cp .env.example .env`.
4. In the new `.env` file, set the Sepolia RPC endpoint (`WDK_EVM_PROVIDER`) to your own provider URL. The other variables are optional tuning knobs with sensible defaults and can be left as they are.
5. Start the app in development mode: `npm run dev`.

## Tech stack and disclosures

All AI inference runs on device via the QVAC SDK using a Qwen vision model, with zero cloud AI calls.

Third party services and libraries used:

- QVAC SDK for on device inference
- WDK for the USDt escrow and settlement
- Rabby wallet
- The Sepolia testnet
- Real tournament goal data from the openfootball world cup dataset for on device odds
- Electron with React and Vite for the app itself
