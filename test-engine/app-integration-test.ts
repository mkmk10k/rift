#!/usr/bin/env npx ts-node
/**
 * App Integration Test - Paste Pipeline Validation
 * 
 * Tests the REAL Electron app's paste behavior without human intervention.
 * 
 * Memory profile:
 *   - Only runs the Electron app (with its LLM server)
 *   - Peak: ~10GB (app + LLM) - fits in 16GB Mac
 *   - NO separate TTS/STT/LLM servers
 * 
 * Test flow:
 *   1. Start Electron app in test mode
 *   2. Connect via IPC (Electron's test capture service)
 *   3. Inject simulated speech text
 *   4. Trigger Silence Polish and Final Polish
 *   5. Capture all paste events
 *   6. Verify output, check for duplicates
 *   7. Report results
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ROOT = path.join(__dirname, '..');
const TEST_PORT = 19876; // Port for test communication
const APP_STARTUP_TIMEOUT = 60000; // 60s for app + LLM model loading
const TEST_TIMEOUT = 30000; // 30s per test scenario

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

interface PasteTestScenario {
  id: string;
  name: string;
  category: 'silence-polish' | 'final-polish' | 'duplicate-check' | 'mixed';
  
  // Simulated speech chunks (as if coming from STT)
  speechChunks: {
    text: string;
    silenceAfterMs: number; // Simulate pause after this chunk
  }[];
  
  // Expected outcomes
  expectations: {
    finalOutputContains?: string[];
    finalOutputNotContains?: string[];
    silencePolishCount?: number;
    finalPolishCount?: number;
    noDuplicates: boolean;
    listFormatted?: boolean;
  };
}

const testScenarios: PasteTestScenario[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // SILENCE POLISH TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'paste-sp-list',
    name: 'Silence Polish formats numbered list',
    category: 'silence-polish',
    speechChunks: [
      { text: 'Number one take the dog out', silenceAfterMs: 0 },
      { text: 'Number two walk with the wife', silenceAfterMs: 0 },
      { text: 'Number three go home', silenceAfterMs: 3000 }, // 3s silence triggers polish
    ],
    expectations: {
      finalOutputContains: ['1.', '2.', '3.'],
      finalOutputNotContains: ['Number one', 'Number two', 'Number three'],
      silencePolishCount: 1,
      noDuplicates: true,
      listFormatted: true,
    },
  },
  {
    id: 'paste-sp-filler',
    name: 'Silence Polish removes fillers',
    category: 'silence-polish',
    speechChunks: [
      { text: 'Um so basically I wanted to um discuss the project', silenceAfterMs: 3000 },
    ],
    expectations: {
      finalOutputContains: ['discuss', 'project'],
      finalOutputNotContains: ['um', 'basically'],
      silencePolishCount: 1,
      noDuplicates: true,
    },
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // DUPLICATE DETECTION TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'paste-dup-silence-then-final',
    name: 'No duplicate after Silence then Final Polish',
    category: 'duplicate-check',
    speechChunks: [
      { text: 'Number one check email', silenceAfterMs: 3000 }, // Silence Polish triggers
      { text: 'Number two send report', silenceAfterMs: 500 },   // More speech
      // Final Polish on stop
    ],
    expectations: {
      finalOutputContains: ['1.', '2.'],
      noDuplicates: true,
      silencePolishCount: 1,
      finalPolishCount: 1,
    },
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // MIXED FLOW TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'paste-mixed-multi-pause',
    name: 'Multiple pauses with lists',
    category: 'mixed',
    speechChunks: [
      { text: 'Morning tasks', silenceAfterMs: 500 },
      { text: 'Number one check email', silenceAfterMs: 0 },
      { text: 'Number two standup meeting', silenceAfterMs: 3000 }, // First Silence Polish
      { text: 'Afternoon tasks', silenceAfterMs: 500 },
      { text: 'Number one code review', silenceAfterMs: 0 },
      { text: 'Number two testing', silenceAfterMs: 3000 }, // Second Silence Polish
    ],
    expectations: {
      finalOutputContains: ['Morning', 'Afternoon', '1.', '2.'],
      noDuplicates: true,
      silencePolishCount: 2,
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

interface TestResult {
  id: string;
  name: string;
  category: string;
  passed: boolean;
  finalOutput: string;
  silencePolishCount: number;
  finalPolishCount: number;
  duplicateCount: number;
  duplicates: string[];
  events: any[];
  failures: string[];
  durationMs: number;
}

class AppIntegrationTest {
  private appProcess: ChildProcess | null = null;
  private testSocket: net.Socket | null = null;
  private results: TestResult[] = [];
  
  async run(): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('     APP INTEGRATION TEST - Paste Pipeline Validation          ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    console.log('Memory profile: ~10GB (Electron + LLM only)');
    console.log('This tests the REAL paste behavior in the actual app.\n');
    
    try {
      // Step 1: Build the app if needed
      await this.ensureAppBuilt();
      
      // Step 2: Start app in test mode
      await this.startApp();
      
      // Step 3: Run test scenarios
      for (const scenario of testScenarios) {
        const result = await this.runScenario(scenario);
        this.results.push(result);
      }
      
      // Step 4: Print summary
      this.printSummary();
      
      // Step 5: Save results
      this.saveResults();
      
    } finally {
      await this.cleanup();
    }
  }
  
  private async ensureAppBuilt(): Promise<void> {
    const distMain = path.join(PROJECT_ROOT, 'dist', 'main', 'index.js');
    
    if (!fs.existsSync(distMain)) {
      console.log('Building app...');
      execSync('bun run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    } else {
      console.log('App already built ✓');
    }
  }
  
  private async startApp(): Promise<void> {
    console.log('Starting Electron app in test mode...');
    
    // Kill any existing Electron processes
    try {
      execSync('pkill -f "Electron.*outloud" 2>/dev/null', { stdio: 'ignore' });
      await this.sleep(1000);
    } catch (e) {}
    
    // Start with test mode flag
    this.appProcess = spawn('bunx', ['electron', '.', '--test-mode', `--test-port=${TEST_PORT}`], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    });
    
    // Wait for app to be ready
    await this.waitForAppReady();
    console.log('App started and ready ✓\n');
  }
  
  private async waitForAppReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('App startup timeout'));
      }, APP_STARTUP_TIMEOUT);
      
      let output = '';
      
      this.appProcess?.stdout?.on('data', (data) => {
        output += data.toString();
        // Look for ready signal
        if (output.includes('LLM service ready') || output.includes('App ready')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      
      this.appProcess?.stderr?.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('ready') || msg.includes('LLM')) {
          console.log('  [App]', msg.trim());
        }
      });
      
      this.appProcess?.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      
      this.appProcess?.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`App exited with code ${code}`));
        }
      });
      
      // Also check if app is ready by attempting connection
      const checkReady = setInterval(async () => {
        try {
          // Try to connect to the test server
          const connected = await this.tryConnect();
          if (connected) {
            clearInterval(checkReady);
            clearTimeout(timeout);
            resolve();
          }
        } catch (e) {}
      }, 1000);
    });
  }
  
  private async tryConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      
      socket.connect(TEST_PORT, '127.0.0.1', () => {
        this.testSocket = socket;
        resolve(true);
      });
      
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }
  
  private async runScenario(scenario: PasteTestScenario): Promise<TestResult> {
    console.log(`Running: ${scenario.id} - ${scenario.name}`);
    const startTime = Date.now();
    
    const result: TestResult = {
      id: scenario.id,
      name: scenario.name,
      category: scenario.category,
      passed: false,
      finalOutput: '',
      silencePolishCount: 0,
      finalPolishCount: 0,
      duplicateCount: 0,
      duplicates: [],
      events: [],
      failures: [],
      durationMs: 0,
    };
    
    try {
      // Start capture
      await this.sendCommand({ action: 'start-capture' });
      
      // Simulate speech chunks
      for (const chunk of scenario.speechChunks) {
        await this.sendCommand({ 
          action: 'inject-speech', 
          text: chunk.text 
        });
        
        if (chunk.silenceAfterMs > 0) {
          // Notify speech stopped (triggers silence detection)
          await this.sendCommand({ action: 'speech-stopped' });
          await this.sleep(chunk.silenceAfterMs);
        } else {
          await this.sleep(100); // Small delay between chunks
        }
      }
      
      // Signal recording stop (triggers Final Polish)
      await this.sendCommand({ action: 'stop-recording' });
      await this.sleep(2000); // Wait for Final Polish
      
      // Get capture results
      const captureResult = await this.sendCommand({ action: 'stop-capture' });
      
      // Parse results
      if (captureResult.summary) {
        result.finalOutput = captureResult.summary.finalOutput || '';
        result.silencePolishCount = captureResult.summary.silencePolishCount || 0;
        result.finalPolishCount = captureResult.summary.finalPolishCount || 0;
        result.duplicateCount = captureResult.summary.duplicateCount || 0;
        result.duplicates = captureResult.summary.duplicates || [];
        result.events = captureResult.events || [];
      }
      
      // Validate expectations
      result.failures = this.validateExpectations(scenario, result);
      result.passed = result.failures.length === 0;
      
    } catch (err: any) {
      result.failures.push(`Error: ${err.message}`);
    }
    
    result.durationMs = Date.now() - startTime;
    
    const status = result.passed ? '✅' : '❌';
    console.log(`  ${status} ${result.durationMs}ms`);
    
    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        console.log(`    - ${failure}`);
      }
    }
    
    return result;
  }
  
  private validateExpectations(scenario: PasteTestScenario, result: TestResult): string[] {
    const failures: string[] = [];
    const exp = scenario.expectations;
    const output = result.finalOutput.toLowerCase();
    
    // Check contains
    if (exp.finalOutputContains) {
      for (const pattern of exp.finalOutputContains) {
        if (!output.includes(pattern.toLowerCase())) {
          failures.push(`Missing expected: "${pattern}"`);
        }
      }
    }
    
    // Check not contains
    if (exp.finalOutputNotContains) {
      for (const pattern of exp.finalOutputNotContains) {
        if (output.includes(pattern.toLowerCase())) {
          failures.push(`Found forbidden: "${pattern}"`);
        }
      }
    }
    
    // Check silence polish count
    if (exp.silencePolishCount !== undefined && result.silencePolishCount !== exp.silencePolishCount) {
      failures.push(`Silence polish count: got ${result.silencePolishCount}, expected ${exp.silencePolishCount}`);
    }
    
    // Check final polish count
    if (exp.finalPolishCount !== undefined && result.finalPolishCount !== exp.finalPolishCount) {
      failures.push(`Final polish count: got ${result.finalPolishCount}, expected ${exp.finalPolishCount}`);
    }
    
    // Check duplicates
    if (exp.noDuplicates && result.duplicateCount > 0) {
      failures.push(`Duplicates found: ${result.duplicates.join(', ')}`);
    }
    
    // Check list formatting
    if (exp.listFormatted) {
      if (!output.match(/\d\./)) {
        failures.push('List not formatted (no numbered items found)');
      }
    }
    
    return failures;
  }
  
  private async sendCommand(command: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.testSocket) {
        reject(new Error('Not connected to app'));
        return;
      }
      
      const timeout = setTimeout(() => {
        reject(new Error('Command timeout'));
      }, TEST_TIMEOUT);
      
      let response = '';
      
      const onData = (data: Buffer) => {
        response += data.toString();
        try {
          const parsed = JSON.parse(response);
          clearTimeout(timeout);
          this.testSocket?.off('data', onData);
          resolve(parsed);
        } catch (e) {
          // Incomplete JSON, wait for more data
        }
      };
      
      this.testSocket.on('data', onData);
      this.testSocket.write(JSON.stringify(command) + '\n');
    });
  }
  
  private printSummary(): void {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                 APP INTEGRATION TEST SUMMARY                   ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    const passed = this.results.filter(r => r.passed).length;
    const total = this.results.length;
    const passRate = (passed / total * 100).toFixed(1);
    
    console.log(`TOTAL: ${passed}/${total} passed (${passRate}%)\n`);
    
    // By category
    const categories = [...new Set(this.results.map(r => r.category))];
    console.log('By Category:');
    for (const cat of categories) {
      const catResults = this.results.filter(r => r.category === cat);
      const catPassed = catResults.filter(r => r.passed).length;
      console.log(`  ${cat}: ${catPassed}/${catResults.length}`);
    }
    
    // Duplicate summary
    const totalDuplicates = this.results.reduce((s, r) => s + r.duplicateCount, 0);
    if (totalDuplicates > 0) {
      console.log(`\n⚠️  Total duplicates found: ${totalDuplicates}`);
    } else {
      console.log('\n✅ No duplicate content detected');
    }
    
    // Failed tests
    const failed = this.results.filter(r => !r.passed);
    if (failed.length > 0) {
      console.log('\nFailed tests:');
      for (const f of failed) {
        console.log(`  ${f.id}: ${f.failures.join('; ')}`);
      }
    }
  }
  
  private saveResults(): void {
    const reportDir = path.join(__dirname, 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    
    const reportPath = path.join(reportDir, `app-integration-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: {
        total: this.results.length,
        passed: this.results.filter(r => r.passed).length,
        failed: this.results.filter(r => !r.passed).length,
        passRate: this.results.filter(r => r.passed).length / this.results.length,
      },
      results: this.results,
    }, null, 2));
    
    console.log(`\nReport: ${reportPath}`);
    
    // Append to history
    const historyPath = path.join(__dirname, 'history.jsonl');
    const entry = {
      timestamp: new Date().toISOString(),
      label: 'app-integration-test',
      totalTests: this.results.length,
      passed: this.results.filter(r => r.passed).length,
      failed: this.results.filter(r => !r.passed).length,
      passRate: this.results.filter(r => r.passed).length / this.results.length,
      duplicatesFound: this.results.reduce((s, r) => s + r.duplicateCount, 0),
    };
    fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n');
    console.log(`History: ${historyPath}`);
  }
  
  private async cleanup(): Promise<void> {
    console.log('\nCleaning up...');
    
    if (this.testSocket) {
      this.testSocket.destroy();
      this.testSocket = null;
    }
    
    if (this.appProcess) {
      this.appProcess.kill('SIGTERM');
      await this.sleep(1000);
      this.appProcess.kill('SIGKILL');
      this.appProcess = null;
    }
    
    // Kill any remaining Electron processes
    try {
      execSync('pkill -f "Electron.*outloud" 2>/dev/null', { stdio: 'ignore' });
    } catch (e) {}
    
    console.log('Done.');
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const test = new AppIntegrationTest();
  
  try {
    await test.run();
    const passed = test['results'].every(r => r.passed);
    process.exit(passed ? 0 : 1);
  } catch (err: any) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

main();
