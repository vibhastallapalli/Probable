#!/usr/bin/env node
// Windows-only fallback: if Electron's own postinstall left node_modules/electron
// without a binary (cache hit but extraction silently no-ops — sometimes happens
// when Defender or OneDrive intercepts the write), extract the cached zip with
// PowerShell's Expand-Archive. No-op on other platforms or when the binary is
// already in place. All errors are swallowed; the user can still re-run install.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') process.exit(0);

try {
  const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
  if (!fs.existsSync(electronDir)) process.exit(0);

  const pathTxt = path.join(electronDir, 'path.txt');
  const exe = path.join(electronDir, 'dist', 'electron.exe');
  if (fs.existsSync(pathTxt) && fs.existsSync(exe)) process.exit(0);

  // Common failure mode: extraction succeeded but path.txt wasn't written.
  // Don't touch dist (it may have files locked by a running Electron process)
  // — just create the marker and let require('electron') succeed.
  if (fs.existsSync(exe)) {
    fs.writeFileSync(pathTxt, 'electron.exe');
    console.log('[fix-electron-binary] Wrote missing path.txt marker.');
    process.exit(0);
  }

  const { version } = require(path.join(electronDir, 'package.json'));
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
  if (!cacheRoot || !fs.existsSync(cacheRoot)) process.exit(0);

  const zipName = `electron-v${version}-win32-${process.arch}.zip`;
  let zipPath = null;
  for (const dir of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, dir, zipName);
    if (fs.existsSync(candidate)) {
      zipPath = candidate;
      break;
    }
  }
  if (!zipPath) process.exit(0);

  const distDir = path.join(electronDir, 'dist');

  // Delegate wipe + extract to PowerShell — Node's fs.rmSync hits EPERM on
  // OneDrive-backed paths even with force:true.
  const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
  const psScript = [
    `$ErrorActionPreference = 'Stop'`,
    `$dest = ${psQuote(distDir)}`,
    `if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }`,
    `New-Item -ItemType Directory -Force -Path $dest | Out-Null`,
    `Expand-Archive -Path ${psQuote(zipPath)} -DestinationPath $dest -Force`,
  ].join('; ');

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { encoding: 'utf8' },
  );
  if (process.env.DEBUG_FIX_ELECTRON) {
    console.error('[fix-electron-binary] ps status:', result.status);
    if (result.stderr) console.error('[fix-electron-binary] ps stderr:', result.stderr);
    if (result.stdout) console.error('[fix-electron-binary] ps stdout:', result.stdout);
  }
  if (result.status !== 0 || !fs.existsSync(exe)) process.exit(0);

  fs.writeFileSync(pathTxt, 'electron.exe');
  console.log('[fix-electron-binary] Restored Electron binary from cache.');
} catch (err) {
  if (process.env.DEBUG_FIX_ELECTRON) console.error('[fix-electron-binary]', err);
  // Intentionally silent — fallback should never block a working install.
}
