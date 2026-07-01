# Branching & pull requests

## Rule

**One branch per change. One PR per branch.** Never force-push `main`.

## Branch names

```
feat/     new feature
fix/      bug fix
chore/    tooling, deps, docs-only
refactor/ internal restructure
```

Examples:

- `feat/electron-scaffold-wdk-qvac`
- `feat/wdk-usdt-escrow-transfer`
- `feat/qvac-full-rubric-engine`
- `fix/judge-frame-extraction-windows`

## Workflow

```powershell
git fetch origin
git checkout main
git pull origin main
git checkout -b feat/my-change

# edit, then:
git add -A
git commit -m "feat: short description of why"
git push -u origin feat/my-change
```

Create PR on GitHub (or `gh pr create`).

## PR checklist

- [ ] Runs with `npm run dev`
- [ ] `npm run typecheck` passes
- [ ] README updated if setup changed
- [ ] No secrets (.env, seed phrases) in commits
- [ ] Demo path documented for judges

## Milestone branches (suggested)

| Branch | Target date | Goal |
|--------|-------------|------|
| `feat/electron-scaffold-wdk-qvac` | Jul 1–3 | Shell + both modes working |
| `feat/wdk-usdt-escrow` | Jul 4–6 | Real testnet USDt lock/release |
| `feat/judge-polish` | Jul 8 | Demo video + rubric tuning |
| `feat/final-pitch` | Jul 14 | Live-final build |
