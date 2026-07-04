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

const OLD_LINE = 'const RPC_INIT_TIMEOUT_MS = 30_000;';
// 5 minutes — comfortably longer than a first-run download on a slow connection.
// Underscore separator matches the SDK's own numeric style.
const NEW_LINE = 'const RPC_INIT_TIMEOUT_MS = 300_000;';

try {
  if (!fs.existsSync(TARGET)) process.exit(0);

  const src = fs.readFileSync(TARGET, 'utf8');

  if (src.includes(NEW_LINE)) process.exit(0); // already patched

  if (!src.includes(OLD_LINE)) {
    // Constant moved or was renamed in a newer SDK — leave it untouched and stay
    // silent; the model prewarm step still mitigates the first-run race.
    process.exit(0);
  }

  fs.writeFileSync(TARGET, src.replace(OLD_LINE, NEW_LINE));
  console.log('[patch-qvac-timeout] RPC worker init timeout raised to 300000ms.');
} catch (err) {
  if (process.env.DEBUG_PATCH_QVAC) console.error('[patch-qvac-timeout]', err);
  // Intentionally silent — never block a working install.
}
