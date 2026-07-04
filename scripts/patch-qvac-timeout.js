#!/usr/bin/env node
// Raise the QVAC SDK's RPC worker-init timeout so the ONE-TIME model download on
// first run does not trip the default 30s limit and fail with RPC_INIT_TIMEOUT.
//
// The timeout lives as a hardcoded constant in the SDK's node RPC client and is
// not exposed through any option or env var, so we rewrite it here after install.
// Only the worker-init constant is touched; the per-call and download timeouts
// are left alone. Idempotent, and silent on any failure — patching a dependency
// must never block an otherwise working install (the separate model prewarm step
// in scoring.js still helps even if this no-ops).

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
  __dirname, '..', 'node_modules', '@qvac', 'sdk',
  'dist', 'client', 'rpc', 'node-rpc-client.js',
);

// Both the SDK's stock value and our previous 5-minute patch get rewritten, so
// re-running after an npm install or over an already-patched tree both work.
const OLD_LINES = [
  'const RPC_INIT_TIMEOUT_MS = 30_000;',
  'const RPC_INIT_TIMEOUT_MS = 300_000;',
];
// 20 minutes — the judge model is now SmolVLM2 2.2B (~2.4 GB with its
// projector, ~4x the old 500M download), so the first-run window scales with
// it. Underscore separator matches the SDK's own numeric style.
const NEW_LINE = 'const RPC_INIT_TIMEOUT_MS = 1_200_000;';

try {
  if (!fs.existsSync(TARGET)) process.exit(0);

  const src = fs.readFileSync(TARGET, 'utf8');

  if (src.includes(NEW_LINE)) process.exit(0); // already patched

  const oldLine = OLD_LINES.find((line) => src.includes(line));
  if (!oldLine) {
    // Constant moved or was renamed in a newer SDK — leave it untouched and stay
    // silent; the model prewarm step still mitigates the first-run race.
    process.exit(0);
  }

  fs.writeFileSync(TARGET, src.replace(oldLine, NEW_LINE));
  console.log('[patch-qvac-timeout] RPC worker init timeout raised to 1200000ms.');
} catch (err) {
  if (process.env.DEBUG_PATCH_QVAC) console.error('[patch-qvac-timeout]', err);
  // Intentionally silent — never block a working install.
}
