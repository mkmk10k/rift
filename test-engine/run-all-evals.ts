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
 * Usage: bunx ts-node test-engine/run-all-evals.ts
 */

import { execSync, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const TEST_ENGINE_DIR = __dirname;
const PROJECT_ROOT = path.join(__dirname, '..');

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
  console.log('║            OUTLOUD EVAL ENGINE - Master Runner                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  
  const totalMem = os.totalmem() / 1024 / 1024 / 1024;
  console.log(`System: ${totalMem.toFixed(0)}GB RAM`);
  console.log(`Mode: Sequential (memory-safe)\n`);
  
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
  
  const entry = {
    timestamp: new Date().toISOString(),
    label: 'full-eval-run',
    suites: results.map(r => ({
      name: r.name,
      passed: r.passed,
      tests: r.totalTests,
      passedTests: r.passedTests,
    })),
    totalTests: results.reduce((s, r) => s + r.totalTests, 0),
    totalPassed: results.reduce((s, r) => s + r.passedTests, 0),
    allPassed: results.every(r => r.passed),
  };
  
  fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n');
  console.log(`\nHistory saved: ${historyPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
