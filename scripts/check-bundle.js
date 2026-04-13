#!/usr/bin/env node
/**
 * Pre-flight check: verify python-bundle/ exists before packaging.
 * 
 * Runs before electron-builder to catch the most common build mistake:
 * forgetting to run "bun run bundle:python" before "bun run package".
 */

const fs = require('fs');
const path = require('path');

const BUNDLE_DIR = path.join(__dirname, '..', 'python-bundle');
const INTERPRETER = path.join(BUNDLE_DIR, 'bin', 'python3.11');
const SITE_PACKAGES = path.join(BUNDLE_DIR, 'lib', 'python3.11', 'site-packages');

console.log('Pre-flight: checking python-bundle...\n');

let ok = true;

if (!fs.existsSync(BUNDLE_DIR)) {
  console.error('FAIL: python-bundle/ directory does not exist.');
  console.error('      Run "bun run bundle:python" first.\n');
  ok = false;
} else if (!fs.existsSync(INTERPRETER)) {
  console.error('FAIL: python-bundle/bin/python3.11 not found.');
  console.error('      The bundle is incomplete. Run "bun run bundle:python" again.\n');
  ok = false;
} else if (!fs.existsSync(SITE_PACKAGES)) {
  console.error('FAIL: python-bundle/lib/python3.11/site-packages/ not found.');
  console.error('      The bundle is incomplete. Run "bun run bundle:python" again.\n');
  ok = false;
} else {
  // Quick check for a few critical packages
  const critical = ['mlx', 'mlx_lm', 'parakeet_mlx', 'mlx_audio'];
  const missing = critical.filter(p => !fs.existsSync(path.join(SITE_PACKAGES, p)));
  
  if (missing.length > 0) {
    console.error(`FAIL: Missing critical packages in bundle: ${missing.join(', ')}`);
    console.error('      Run "bun run bundle:python" again.\n');
    ok = false;
  }
}

if (!ok) {
  console.error('Packaging aborted. The app will not work without a complete Python bundle.');
  process.exit(1);
}

console.log('OK: python-bundle is present with interpreter and critical packages.\n');
process.exit(0);
