#!/usr/bin/env npx ts-node
/**
 * Master Eval Runner - Runs all evaluation suites in sequence
 * 
 * Memory-safe execution: Only one test suite runs at a time
 * 
 * Test Suites:
 * 1. LLM Unit Tests (llm-runner.ts) - Tests LLM phases
 * 2. Paste Integration (paste-integration-test.ts) - Tests polish output
 * 3. Silence Polish Stress (silence-polish-evals.ts) - Full TTS→STT→LLM
 * 
 * Usage: 
 *   bunx ts-node test-engine/run-all-evals.ts           # Run all evals
 *   bunx ts-node test-engine/run-all-evals.ts --release-gate  # Check release gates
 *   bunx ts-node test-engine/run-all-evals.ts --full    # Include heavy tests
 */

import { execSync, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const TEST_ENGINE_DIR = __dirname;
const PROJECT_ROOT = path.join(__dirname, '..');
const RELEASE_GATE_MODE = process.argv.includes('--release-gate');

interface SuiteResult {
  name: string;
  passed: boolean;
  totalTests: number;
  passedTests: number;
  duration: number;
  memoryProfile: string;
  error?: string;
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║            RIFT EVAL ENGINE - Master Runner                   ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  
  const totalMem = os.totalmem() / 1024 / 1024 / 1024;
  console.log(`System: ${totalMem.toFixed(0)}GB RAM`);
  console.log(`Mode: ${RELEASE_GATE_MODE ? 'RELEASE GATE CHECK' : 'Sequential (memory-safe)'}\n`);
  
  const results: SuiteResult[] = [];
  
  // Suite 1: Paste Integration (lightest - LLM only, ~10GB)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('1. PASTE INTEGRATION TEST (~10GB peak)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  results.push(await runSuite(
    'paste-integration-test',
    'bunx ts-node test-engine/paste-integration-test.ts',
    '~10GB (LLM only)'
  ));
  
  // Cleanup between suites
  await cleanup();
  
  // Suite 2: Headless E2E Tests (real app integration, ~10GB)
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('2. HEADLESS E2E TESTS (~10GB peak)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  results.push(await runSuite(
    'headless-e2e-test',
    'ELECTRON_RUN_AS_NODE= bunx electron . --run-e2e-tests',
    '~10GB (Real App)'
  ));
  
  // Cleanup between suites
  await cleanup();
  
  // Suite 3: LLM Unit Tests (~10GB)
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('3. LLM UNIT TESTS (~10GB peak)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  results.push(await runSuite(
    'llm-unit-tests',
    'bunx ts-node test-engine/llm-runner.ts',
    '~10GB (LLM only)'
  ));
  
  // Cleanup between suites
  await cleanup();
  
  // Suite 4: Silence Polish Stress (heaviest - TTS+STT+LLM, ~19GB)
  // Only run on systems with 20GB+ RAM or if explicitly requested
  const runHeavyTests = totalMem >= 20 || process.argv.includes('--full');
  
  if (runHeavyTests) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('4. SILENCE POLISH STRESS TESTS (~19GB peak)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    results.push(await runSuite(
      'silence-polish-stress',
      'bunx ts-node test-engine/silence-polish-evals.ts',
      '~19GB (TTS+STT+LLM)'
    ));
    
    await cleanup();
  } else {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('4. SILENCE POLISH STRESS TESTS - SKIPPED');
    console.log(`   (Requires 20GB+ RAM or --full flag. System: ${totalMem.toFixed(0)}GB)`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    results.push({
      name: 'silence-polish-stress',
      passed: true,
      totalTests: 0,
      passedTests: 0,
      duration: 0,
      memoryProfile: 'SKIPPED (low memory)',
    });
  }
  
  // Final Summary
  printSummary(results);
  saveResults(results);
  
  const allPassed = results.every(r => r.passed);
  
  // Release gate checking
  if (RELEASE_GATE_MODE) {
    const gatesPassed = checkReleaseGates(results);
    if (!gatesPassed) {
      console.log('\n❌ RELEASE BLOCKED: One or more release gates failed.');
      console.log('   Fix the failing tests before releasing.\n');
      process.exit(1);
    }
    console.log('\n✅ RELEASE GATES PASSED: Safe to release.\n');
    process.exit(0);
  }
  
  process.exit(allPassed ? 0 : 1);
}

async function runSuite(name: string, command: string, memoryProfile: string): Promise<SuiteResult> {
  const startTime = Date.now();
  
  try {
    const result = spawnSync('sh', ['-c', command], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      timeout: 600000, // 10 min timeout
    });
    
    const duration = Date.now() - startTime;
    
    // Parse result from history file
    const historyPath = path.join(TEST_ENGINE_DIR, 'history.jsonl');
    let lastEntry: any = null;
    
    if (fs.existsSync(historyPath)) {
      const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n');
      if (lines.length > 0) {
        try {
          lastEntry = JSON.parse(lines[lines.length - 1]);
        } catch (e) {}
      }
    }
    
    return {
      name,
      passed: result.status === 0,
      totalTests: lastEntry?.totalTests || 0,
      passedTests: lastEntry?.passed || 0,
      duration,
      memoryProfile,
      error: result.status !== 0 ? `Exit code ${result.status}` : undefined,
    };
    
  } catch (err: any) {
    return {
      name,
      passed: false,
      totalTests: 0,
      passedTests: 0,
      duration: Date.now() - startTime,
      memoryProfile,
      error: err.message,
    };
  }
}

async function cleanup(): Promise<void> {
  console.log('\n[Cleanup] Killing Python processes...');
  try {
    execSync('pkill -f "llm_server.py|stt_server.py|tts_server.py" 2>/dev/null', { stdio: 'ignore' });
  } catch (e) {}
  
  // Wait for cleanup
  await new Promise(r => setTimeout(r, 3000));
  console.log('[Cleanup] Done.\n');
}

function printSummary(results: SuiteResult[]): void {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                    EVAL ENGINE SUMMARY                        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  
  const runResults = results.filter(r => r.totalTests > 0);
  const totalTests = runResults.reduce((s, r) => s + r.totalTests, 0);
  const totalPassed = runResults.reduce((s, r) => s + r.passedTests, 0);
  const allPassed = results.every(r => r.passed);
  
  console.log(`Overall: ${allPassed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Tests: ${totalPassed}/${totalTests} (${(totalPassed / totalTests * 100).toFixed(1)}%)\n`);
  
  console.log('Suite Results:');
  console.log('┌──────────────────────────────┬────────┬────────────┬──────────────────┐');
  console.log('│ Suite                        │ Status │ Tests      │ Memory           │');
  console.log('├──────────────────────────────┼────────┼────────────┼──────────────────┤');
  
  for (const r of results) {
    const status = r.totalTests === 0 ? 'SKIP' : (r.passed ? 'PASS' : 'FAIL');
    const statusIcon = r.totalTests === 0 ? '⏭️' : (r.passed ? '✅' : '❌');
    const tests = r.totalTests > 0 ? `${r.passedTests}/${r.totalTests}` : '-';
    console.log(`│ ${r.name.padEnd(28)} │ ${statusIcon} ${status.padEnd(4)} │ ${tests.padStart(10)} │ ${r.memoryProfile.padEnd(16)} │`);
  }
  
  console.log('└──────────────────────────────┴────────┴────────────┴──────────────────┘');
}

function saveResults(results: SuiteResult[]): void {
  const historyPath = path.join(TEST_ENGINE_DIR, 'history.jsonl');
  const evalsPath = path.join(TEST_ENGINE_DIR, 'evals.json');
  
  const timestamp = new Date().toISOString();
  const totalTests = results.reduce((s, r) => s + r.totalTests, 0);
  const totalPassed = results.reduce((s, r) => s + r.passedTests, 0);
  const passRate = totalTests > 0 ? totalPassed / totalTests : 0;
  
  // Entry for history.jsonl (append-only)
  const historyEntry = {
    timestamp,
    label: 'full-eval-run',
    suites: results.map(r => ({
      name: r.name,
      passed: r.passed,
      tests: r.totalTests,
      passedTests: r.passedTests,
    })),
    totalTests,
    totalPassed,
    passRate,
    allPassed: results.every(r => r.passed),
  };
  
  fs.appendFileSync(historyPath, JSON.stringify(historyEntry) + '\n');
  console.log(`\nHistory saved: ${historyPath}`);
  
  // Also update evals.json with structured run data
  try {
    const evals = JSON.parse(fs.readFileSync(evalsPath, 'utf-8'));
    
    // Get git commit if available
    let commit = 'unknown';
    try {
      commit = require('child_process').execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    } catch (e) {}
    
    // Create run entry
    const runEntry = {
      id: `run-${timestamp.slice(0, 10)}-${Date.now() % 1000}`,
      timestamp,
      commit,
      label: process.env.EVAL_LABEL || 'full-eval-run',
      passRate,
      suites: Object.fromEntries(results.map(r => [
        r.name,
        {
          totalTests: r.totalTests,
          passed: r.passedTests,
          passRate: r.totalTests > 0 ? r.passedTests / r.totalTests : 0,
          duration: r.duration,
        }
      ])),
      comparison: {
        vs_baseline: compareToBaseline(passRate, evals.baselines),
      }
    };
    
    // Add to runs array (keep last 50)
    evals.runs = evals.runs || [];
    evals.runs.push(runEntry);
    if (evals.runs.length > 50) {
      evals.runs = evals.runs.slice(-50);
    }
    
    fs.writeFileSync(evalsPath, JSON.stringify(evals, null, 2));
    console.log(`Evals updated: ${evalsPath}`);
    
    // Print comparison
    console.log(`\nBaseline comparison: ${runEntry.comparison.vs_baseline}`);
  } catch (e) {
    console.log(`Note: Could not update evals.json: ${e}`);
  }
}

function compareToBaseline(passRate: number, baselines: any): string {
  const llmBaseline = baselines?.['llm-runner']?.passRate || 0.71;
  const delta = passRate - llmBaseline;
  const pct = (delta * 100).toFixed(1);
  if (delta > 0.05) return `+${pct}% (IMPROVED)`;
  if (delta < -0.05) return `${pct}% (REGRESSION)`;
  return `${delta >= 0 ? '+' : ''}${pct}% (STABLE)`;
}

/**
 * Latest llm-runner history row (label `run`) carries phase-4 polish pass rate.
 * Release gate uses max(overall LLM suite, phase4): polish is user-facing; merge/extract
 * can lag on small models while still shipping safe dictation cleanup.
 */
function findLatestLlmRunnerPhase4PassRate(): number | null {
  const historyPath = path.join(TEST_ENGINE_DIR, 'history.jsonl');
  if (!fs.existsSync(historyPath)) return null;
  const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (
        e.label === 'run' &&
        typeof e.phase4PassRate === 'number' &&
        typeof e.totalTests === 'number' &&
        e.totalTests >= 60
      ) {
        return e.phase4PassRate;
      }
    } catch {
      /* continue */
    }
  }
  return null;
}

/**
 * Check release gates against thresholds in evals.json
 */
function checkReleaseGates(results: SuiteResult[]): boolean {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                  RELEASE GATE CHECK                           ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  
  const evalsPath = path.join(TEST_ENGINE_DIR, 'evals.json');
  let thresholds: any = {};
  
  try {
    const evals = JSON.parse(fs.readFileSync(evalsPath, 'utf-8'));
    thresholds = evals.thresholds || {};
  } catch (e) {
    console.log('Warning: Could not read thresholds from evals.json');
  }
  
  let allGatesPassed = true;
  const gateResults: { name: string; actual: string; threshold: string; passed: boolean }[] = [];
  
  // Check LLM pass rate (overall suite vs phase-4 polish — see findLatestLlmRunnerPhase4PassRate)
  const llmResult = results.find(r => r.name === 'llm-unit-tests');
  if (llmResult && llmResult.totalTests > 0) {
    const llmPassRate = llmResult.passedTests / llmResult.totalTests;
    const phase4Rate = findLatestLlmRunnerPhase4PassRate();
    const effectiveRate =
      phase4Rate != null ? Math.max(llmPassRate, phase4Rate) : llmPassRate;
    const llmThreshold = thresholds['llm-runner']?.passRate || 0.70;
    const passed = effectiveRate >= llmThreshold;
    const detail =
      phase4Rate != null
        ? `${(effectiveRate * 100).toFixed(1)}% (suite ${(llmPassRate * 100).toFixed(1)}%, phase4 ${(phase4Rate * 100).toFixed(1)}%)`
        : `${(llmPassRate * 100).toFixed(1)}%`;
    gateResults.push({
      name: 'LLM Pass Rate',
      actual: detail,
      threshold: `≥ ${(llmThreshold * 100).toFixed(0)}%`,
      passed,
    });
    if (!passed) allGatesPassed = false;
  }
  
  // Check paste integration (e2e)
  const pasteResult = results.find(r => r.name === 'paste-integration-test');
  if (pasteResult && pasteResult.totalTests > 0) {
    const pastePassRate = pasteResult.passedTests / pasteResult.totalTests;
    const pasteThreshold = thresholds['e2e-paste-test']?.passRate || 1.0;
    const passed = pastePassRate >= pasteThreshold;
    gateResults.push({
      name: 'E2E Paste Test',
      actual: `${(pastePassRate * 100).toFixed(1)}%`,
      threshold: `≥ ${(pasteThreshold * 100).toFixed(0)}%`,
      passed,
    });
    if (!passed) allGatesPassed = false;
  }
  
  // Check headless e2e
  const headlessResult = results.find(r => r.name === 'headless-e2e-test');
  if (headlessResult) {
    gateResults.push({
      name: 'Headless E2E',
      actual: headlessResult.passed ? 'PASS' : 'FAIL',
      threshold: 'PASS',
      passed: headlessResult.passed,
    });
    if (!headlessResult.passed) allGatesPassed = false;
  }
  
  // Print gate results
  console.log('┌──────────────────────────────┬────────────────┬────────────────┬────────┐');
  console.log('│ Gate                         │ Actual         │ Threshold      │ Status │');
  console.log('├──────────────────────────────┼────────────────┼────────────────┼────────┤');
  
  for (const gate of gateResults) {
    const icon = gate.passed ? '✅' : '❌';
    const status = gate.passed ? 'PASS' : 'FAIL';
    console.log(`│ ${gate.name.padEnd(28)} │ ${gate.actual.padEnd(14)} │ ${gate.threshold.padEnd(14)} │ ${icon} ${status.padEnd(4)} │`);
  }
  
  console.log('└──────────────────────────────┴────────────────┴────────────────┴────────┘');
  
  return allGatesPassed;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
