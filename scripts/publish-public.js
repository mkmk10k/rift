#!/usr/bin/env node

/**
 * Rift Public Repo Sync Script
 *
 * Syncs curated source code from the private rift-dev repo to the
 * public mkmk10k/rift repo. Respects .publish-ignore to exclude
 * internal tooling, website, and test artifacts.
 *
 * Usage:
 *   bun run publish-public          # Full sync and push
 *   bun run publish-public --dry-run # Preview what would be synced
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PUBLIC_REPO = 'mkmk10k/rift';
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLISH_IGNORE = path.join(ROOT_DIR, '.publish-ignore');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function step(label, msg) {
  const prefix = isDryRun ? '[DRY RUN]' : '[PUBLISH]';
  log(`${prefix} ${label}: ${msg}`, 'blue');
}

function exec(cmd, opts = {}) {
  if (isDryRun && !opts.allowInDryRun) {
    log(`  Would run: ${cmd}`, 'dim');
    return opts.dryRunReturn || '';
  }
  return execSync(cmd, { encoding: 'utf-8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
}

function execSilent(cmd) {
  return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
}

// Read version from package.json
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
const version = pkg.version;

log(`\nRift Public Repo Sync — v${version}`, 'green');
log(`Target: github.com/${PUBLIC_REPO}`, 'dim');
if (isDryRun) log('DRY RUN MODE — no changes will be made\n', 'yellow');
else log('');

// 1. Verify gh auth
step('1/6', 'Checking GitHub CLI auth');
try {
  execSilent('gh auth status');
  log('  gh CLI authenticated', 'green');
} catch {
  log('  ERROR: gh CLI not authenticated. Run: gh auth login', 'red');
  process.exit(1);
}

// 2. Create temp directory and clone public repo
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-public-'));
step('2/6', `Cloning public repo into ${tmpDir}`);
exec(`gh repo clone ${PUBLIC_REPO} "${tmpDir}" -- --depth=1`, { allowInDryRun: false, silent: true });

// 3. Wipe existing files from clone (except .git/)
step('3/6', 'Clearing old files from public repo clone');
if (!isDryRun) {
  const entries = fs.readdirSync(tmpDir);
  for (const entry of entries) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
  }
  log('  Cleared', 'green');
} else {
  log('  Would clear all non-.git files from clone', 'dim');
}

// 4. Use rsync with .publish-ignore to copy files
step('4/6', 'Copying source files (respecting .publish-ignore)');
const rsyncCmd = [
  'rsync', '-a',
  `--exclude-from="${PUBLISH_IGNORE}"`,
  '--exclude=".git/"',
  `"${ROOT_DIR}/"`,
  `"${tmpDir}/"`,
].join(' ');
exec(rsyncCmd);

// 5. Commit and push
step('5/6', 'Committing and pushing to public repo');
const commitMsg = `Sync from v${version}`;
if (!isDryRun) {
  execSync(`cd "${tmpDir}" && git add -A`, { stdio: 'inherit' });
  const status = execSilent(`cd "${tmpDir}" && git status --porcelain`).trim();
  if (!status) {
    log('  Nothing to commit — public repo already up to date', 'yellow');
  } else {
    execSync(`cd "${tmpDir}" && git commit -m "${commitMsg}"`, { stdio: 'inherit' });
    execSync(`cd "${tmpDir}" && git push`, { stdio: 'inherit' });
    log(`  Pushed: "${commitMsg}"`, 'green');
  }
} else {
  log(`  Would commit: "${commitMsg}" and push`, 'dim');
}

// 6. Cleanup
step('6/6', 'Cleaning up temp directory');
if (!isDryRun) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  log('  Done', 'green');
} else {
  log(`  Would remove ${tmpDir}`, 'dim');
}

log(`\nPublic repo synced successfully!`, 'green');
log(`View at: https://github.com/${PUBLIC_REPO}\n`, 'dim');
