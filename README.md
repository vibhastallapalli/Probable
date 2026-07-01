# Probable

Football app for the [Tether Developers Cup](https://dorahacks.io) — **Predict** with WDK escrow, **Judge** clips with on-device QVAC AI.

## Tracks

- **WDK** — self-custodial wallet, escrow sub-account, USDt pot (demo + testnet-ready)
- **QVAC** — SmolVLM2 multimodal judging, rubric-based scoring, post-match chat

## Requirements

- **Node.js** ≥ 22.17
- **npm** ≥ 10.9
- Windows / macOS / Linux (Electron desktop)

## Quick start

```bash
git clone https://github.com/vibhastallapalli/Probable.git
cd Probable
npm install
npm run dev
```

First launch:

1. **Create wallet** (WDK seed stored locally in app userData)
2. **Predict** — create a session, raise stakes, deposit, lock, declare winner, settle
3. **Judge** — pick two short `.mp4` clips; QVAC downloads the vision model on first run (~500MB)

## Environment (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PROBABLE_DEMO_MODE` | `true` | Local pot tracking without on-chain USDt |
| `PROBABLE_EVM_RPC` | Sepolia public RPC | WDK Ethereum provider |
| `PROBABLE_USDT_CONTRACT` | Sepolia USDT | ERC-20 address for real escrow |
| `QVAC_CONFIG_PATH` | `./qvac.config.json` | QVAC logging / download settings |

Set `PROBABLE_DEMO_MODE=false` when testnet USDt transfers are wired.

## Project structure

```
src/
├── main/           # Electron main — WDK, QVAC, ffmpeg, IPC
├── preload/        # contextBridge API
├── renderer/       # React UI — Predict + Judge
└── shared/         # TypeScript types
```

## Branch workflow (PRs)

**Every feature goes on its own branch.** Do not commit directly to `main`.

```powershell
# From repo root
git checkout main
git pull origin main
git checkout -b feat/your-feature-name

# … work, commit …
git push -u origin feat/your-feature-name
gh pr create --title "feat: your feature" --body "Summary + test plan"
```

See [docs/BRANCHING.md](docs/BRANCHING.md) for naming conventions.

### Current branch

`feat/electron-scaffold-wdk-qvac` — Electron shell, Predict mode, Judge mode, WDK wallet, QVAC pipeline.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Electron + Vite dev server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript check |

## Demo video checklist (Jul 8)

- [ ] Create Predict session, raise pot, settle winner
- [ ] Judge two clips, show scores + shot type
- [ ] Ask judge chat: "Why did you pick this one?"
- [ ] Show WDK wallet address + escrow address
- [ ] Confirm QVAC runs with network disabled (optional proof)

## License

MIT — see [LICENSE](LICENSE).
