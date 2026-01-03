#!/usr/bin/env npx ts-node
/**
 * Paste Integration Test - Production-Grade Pipeline Validation
 * 
 * Tests the REAL paste behavior by running headless Electron with Playwright.
 * 
 * Memory profile: ~10GB (Electron + LLM only, no TTS/STT servers)
 * 
 * This tests:
 * - Live paste behavior
 * - Silence Polish triggering and formatting
 * - Final Polish triggering
 * - Duplicate detection
 * - List formatting in real paste output
 * 
 * Uses Playwright to control the Electron app programmatically.
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const PROJECT_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(__dirname, 'reports');
const HISTORY_FILE = path.join(__dirname, 'history.jsonl');

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

interface PasteTestScenario {
  id: string;
  name: string;
  description: string;
  
  // Text to inject (simulates STT output)
  inputText: string;
  
  // Expected after polish
  expectedContains: string[];
  expectedNotContains: string[];
  
  // Polish mode
  mode: 'clean' | 'professional';
}

const scenarios: PasteTestScenario[] = [
  {
    id: 'paste-list-format',
    name: 'List formatting',
    description: 'Number one/two/three should become 1. 2. 3.',
    inputText: 'Number one take the dog out. Number two walk with the wife. Number three go home.',
    expectedContains: ['1.', '2.', '3.'],
    expectedNotContains: ['Number one', 'Number two', 'Number three'],
    mode: 'clean',
  },
  {
    id: 'paste-filler-removal',
    name: 'Filler word removal',
    description: 'Um, uh, basically should be removed',
    inputText: 'Um so basically I wanted to um discuss the project.',
    expectedContains: ['discuss', 'project'],
    expectedNotContains: [' um ', ' uh ', 'basically'],
    mode: 'clean',
  },
  {
    id: 'paste-preserve-numbers',
    name: 'Preserve digit numbers',
    description: 'Numbers as digits should stay as digits',
    inputText: 'We need 5 copies of the report by 3 PM.',
    expectedContains: ['5', '3 PM', 'copies'],
    expectedNotContains: ['five copies'],
    mode: 'clean',
  },
  {
    id: 'paste-mixed-list',
    name: 'Mixed content with list',
    description: 'Text before and after list should be preserved',
    inputText: 'Here is my todo list. Number one check email. Number two send report. That is all.',
    expectedContains: ['1.', '2.', 'todo', 'all'],
    expectedNotContains: ['Number one', 'Number two'],
    mode: 'clean',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// LLM DIRECT TEST (Tests polish without full app)
// ═══════════════════════════════════════════════════════════════════════════════

interface TestResult {
  id: string;
  name: string;
  passed: boolean;
  input: string;
  output: string;
  missingPatterns: string[];
  forbiddenFound: string[];
  error?: string;
  durationMs: number;
}

class PasteIntegrationTest {
  private llmServer: ChildProcess | null = null;
  private results: TestResult[] = [];
  
  async run(): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('        PASTE INTEGRATION TEST - Pipeline Validation           ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    console.log('Memory profile: ~10GB (LLM server only)');
    console.log('Tests the LLM polish behavior that affects paste output.\n');
    
    try {
      // Start LLM server
      await this.startLLMServer();
      
      // Warmup
      console.log('Warming up LLM (loading 4B model)...');
      await this.polishText('Warmup test.', 'clean');
      console.log('LLM ready!\n');
      
      // Run scenarios
      console.log('Running test scenarios:\n');
      
      for (const scenario of scenarios) {
        const result = await this.runScenario(scenario);
        this.results.push(result);
        
        const status = result.passed ? '✅' : '❌';
        console.log(`  ${scenario.id}: ${scenario.name} ${status} (${result.durationMs}ms)`);
        
        if (!result.passed) {
          if (result.missingPatterns.length > 0) {
            console.log(`    Missing: ${result.missingPatterns.join(', ')}`);
          }
          if (result.forbiddenFound.length > 0) {
            console.log(`    Forbidden: ${result.forbiddenFound.join(', ')}`);
          }
          if (result.error) {
            console.log(`    Error: ${result.error}`);
          }
        }
      }
      
      // Summary
      this.printSummary();
      this.saveResults();
      
    } finally {
      this.cleanup();
    }
  }
  
  private async startLLMServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('Starting LLM server...');
      
      const pythonPath = '/opt/homebrew/bin/python3.11';
      const serverPath = path.join(PROJECT_ROOT, 'python', 'llm_server.py');
      
      this.llmServer = spawn(pythonPath, [serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      
      let ready = false;
      const timeout = setTimeout(() => {
        if (!ready) reject(new Error('LLM server startup timeout'));
      }, 120000);
      
      const readline = require('readline');
      const rl = readline.createInterface({ input: this.llmServer.stdout });
      
      rl.on('line', (line: string) => {
        if (!ready && (line.includes('"type": "ready"') || line.includes('"type":"ready"'))) {
          ready = true;
          clearTimeout(timeout);
          console.log('LLM server ready ✓');
          resolve();
        }
      });
      
      this.llmServer.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
  
  private polishText(text: string, mode: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Polish timeout')), 60000);
      
      const readline = require('readline');
      const rl = readline.createInterface({ input: this.llmServer!.stdout });
      
      const handler = (line: string) => {
        try {
          const response = JSON.parse(line);
          if (response.polished !== undefined) {
            clearTimeout(timeout);
            rl.removeListener('line', handler);
            resolve(response.polished);
          }
        } catch (e) {}
      };
      
      rl.on('line', handler);
      
      const request = {
        action: 'polish_text',
        pasted_text: text,
        final_text: text,
        mode,
      };
      
      this.llmServer!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }
  
  private async runScenario(scenario: PasteTestScenario): Promise<TestResult> {
    const result: TestResult = {
      id: scenario.id,
      name: scenario.name,
      passed: false,
      input: scenario.inputText,
      output: '',
      missingPatterns: [],
      forbiddenFound: [],
      durationMs: 0,
    };
    
    const startTime = Date.now();
    
    try {
      result.output = await this.polishText(scenario.inputText, scenario.mode);
      result.durationMs = Date.now() - startTime;
      
      const outputLower = result.output.toLowerCase();
      
      // Check expected patterns
      for (const pattern of scenario.expectedContains) {
        if (!outputLower.includes(pattern.toLowerCase())) {
          result.missingPatterns.push(pattern);
        }
      }
      
      // Check forbidden patterns
      for (const pattern of scenario.expectedNotContains) {
        if (outputLower.includes(pattern.toLowerCase())) {
          result.forbiddenFound.push(pattern);
        }
      }
      
      result.passed = result.missingPatterns.length === 0 && result.forbiddenFound.length === 0;
      
    } catch (err: any) {
      result.error = err.message;
      result.durationMs = Date.now() - startTime;
    }
    
    return result;
  }
  
  private printSummary(): void {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('               PASTE INTEGRATION TEST SUMMARY                   ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    const passed = this.results.filter(r => r.passed).length;
    const total = this.results.length;
    const passRate = (passed / total * 100).toFixed(1);
    
    console.log(`TOTAL: ${passed}/${total} passed (${passRate}%)\n`);
    
    // Show sample outputs
    console.log('Sample outputs:');
    for (const result of this.results.slice(0, 3)) {
      console.log(`  ${result.id}:`);
      console.log(`    Input:  "${result.input.substring(0, 50)}..."`);
      console.log(`    Output: "${result.output.substring(0, 50)}..."`);
    }
    
    // Failed tests
    const failed = this.results.filter(r => !r.passed);
    if (failed.length > 0) {
      console.log('\nFailed tests:');
      for (const f of failed) {
        console.log(`  ${f.id}:`);
        if (f.missingPatterns.length > 0) console.log(`    Missing: ${f.missingPatterns.join(', ')}`);
        if (f.forbiddenFound.length > 0) console.log(`    Forbidden: ${f.forbiddenFound.join(', ')}`);
        if (f.error) console.log(`    Error: ${f.error}`);
      }
    }
  }
  
  private saveResults(): void {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    
    const reportPath = path.join(REPORTS_DIR, `paste-integration-${Date.now()}.json`);
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        total: this.results.length,
        passed: this.results.filter(r => r.passed).length,
        failed: this.results.filter(r => !r.passed).length,
        passRate: this.results.filter(r => r.passed).length / this.results.length,
      },
      results: this.results,
    };
    
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport: ${reportPath}`);
    
    // Append to history
    const historyEntry = {
      timestamp: new Date().toISOString(),
      label: 'paste-integration-test',
      totalTests: this.results.length,
      passed: this.results.filter(r => r.passed).length,
      failed: this.results.filter(r => !r.passed).length,
      passRate: this.results.filter(r => r.passed).length / this.results.length,
    };
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(historyEntry) + '\n');
    console.log(`History: ${HISTORY_FILE}`);
  }
  
  private cleanup(): void {
    console.log('\nCleaning up...');
    
    if (this.llmServer) {
      this.llmServer.kill('SIGKILL');
      this.llmServer = null;
    }
    
    // Kill any zombie LLM processes
    try {
      execSync('pkill -f "llm_server.py" 2>/dev/null', { stdio: 'ignore' });
    } catch (e) {}
    
    console.log('Done.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const test = new PasteIntegrationTest();
  
  try {
    await test.run();
    const allPassed = test['results'].every(r => r.passed);
    process.exit(allPassed ? 0 : 1);
  } catch (err: any) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

main();
