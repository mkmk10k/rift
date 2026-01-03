#!/usr/bin/env node
/**
 * Auto-version script for Rift
 * 
 * VERSION FORMAT: YYYY.MM.DD+<git-short-hash>
 * Example: 2026.01.02+cfc5e46
 * 
 * This matches the versioning shown on myrift.dev
 * Run automatically before packaging via `bun run version`
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get current date
const now = new Date();
const year = now.getFullYear();
const month = String(now.getMonth() + 1).padStart(2, '0');
const day = String(now.getDate()).padStart(2, '0');

// Get git short hash
let gitHash = 'unknown';
try {
  gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch (e) {
  console.warn('⚠️  Could not get git hash, using "unknown"');
}

// Build version string
const version = `${year}.${month}.${day}+${gitHash}`;

// Update package.json
const pkgPath = path.join(__dirname, '../package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
pkg.version = version;

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`📦 Version updated: ${oldVersion} → ${version}`);
console.log(`   Date: ${year}.${month}.${day}`);
console.log(`   Git:  ${gitHash}`);
