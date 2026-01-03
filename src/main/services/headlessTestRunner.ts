/**
 * Headless Test Runner
 * 
 * Runs E2E tests without UI when app starts with --run-e2e-tests flag.
 * Tests the REAL app integration: LLM service, paste handlers, duplicate detection.
 * 
 * Usage: bun run start -- --run-e2e-tests
 */

import { app } from 'electron';
import { llmServer } from './llmService';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

interface TestScenario {
  id: string;
  name: string;
  description: string;
  
  // Input text (as if from STT)
  inputText: string;
  
  // Expected patterns in polished output
  expectedContains: string[];
  expectedNotContains: string[];
  
  // Test type
  testType: 'polish' | 'silence-timing' | 'duplicate-check';
}

const testScenarios: TestScenario[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // POLISH BEHAVIOR TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'headless-list-format',
    name: 'List Formatting',
    description: 'Number one/two/three should become 1. 2. 3.',
    inputText: 'Number one take the dog out. Number two walk with the wife. Number three go home.',
    expectedContains: ['1.', '2.', '3.'],
    expectedNotContains: ['Number one', 'Number two', 'Number three'],
    testType: 'polish',
  },
  {
    id: 'headless-filler-removal',
    name: 'Filler Word Removal',
    description: 'Um, uh, basically should be removed',
    inputText: 'Um so basically I wanted to um discuss the project.',
    expectedContains: ['discuss', 'project'],
    expectedNotContains: [' um ', ' uh ', 'basically'],
    testType: 'polish',
  },
  {
    id: 'headless-preserve-numbers',
    name: 'Preserve Digit Numbers',
    description: 'Numbers as digits should stay as digits',
    inputText: 'We need 5 copies of the report by 3 PM.',
    expectedContains: ['5', '3 PM', 'copies'],
    expectedNotContains: ['five copies'],
    testType: 'polish',
  },
  {
    id: 'headless-mixed-content',
    name: 'Mixed Content with List',
    description: 'Text before and after list should be preserved',
    inputText: 'Here is my to-do list. Number one check email. Number two send report. That is all.',
    expectedContains: ['1.', '2.', 'list', 'all'],
    expectedNotContains: ['Number one', 'Number two'],
    testType: 'polish',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SILENCE TIMING TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'headless-silence-trigger',
    name: 'Silence Detection Trigger',
    description: 'After 2 seconds of silence, polish should trigger',
    inputText: 'Number one test the silence detection feature.',
    expectedContains: ['1.', 'test'],
    expectedNotContains: ['Number one'],
    testType: 'silence-timing',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // DUPLICATE PREVENTION TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'headless-no-duplicate',
    name: 'No Duplicate Content',
    description: 'Same content should not appear twice after polish',
    inputText: 'Number one first item. Number two second item.',
    expectedContains: ['1.', '2.'],
    expectedNotContains: ['Number one', 'Number two'],
    testType: 'duplicate-check',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FIX VALIDATION TESTS (New fixes being tested)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'headless-dedup-sentences',
    name: 'Deduplicate Sentences (LLM)',
    description: 'Exact duplicate sentences should be removed by LLM',
    inputText: 'I went to the store. I bought milk. I went to the store. I bought milk. Then I came home.',
    expectedContains: ['store', 'milk', 'home'],
    expectedNotContains: [],
    testType: 'duplicate-check',
  },
  {
    id: 'headless-compound-fillers',
    name: 'Compound Filler Removal',
    description: 'And uh, like um, etc. should be removed',
    inputText: 'And uh let me explain this. Like um basically we need to do this thing.',
    expectedContains: ['explain', 'need', 'thing'],
    expectedNotContains: [' uh ', ' um ', 'basically'],
    testType: 'polish',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // LONG INPUT TESTS (80+ words - catches first-inference-after-load bugs)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'headless-long-list-80words',
    name: 'Long Input with List (80+ words)',
    description: 'Tests that long inputs are not truncated or corrupted',
    inputText: 'Testing the silence polish feature with a comprehensive input. Number one we need to verify that the content is preserved correctly. Number two we need to ensure that lists are formatted properly with numbered items. Number three we need to check that the output is not truncated or corrupted in any way. Number four we should validate that all important words from the input appear in the output. This test has approximately eighty words to simulate real user dictation patterns.',
    expectedContains: ['1.', '2.', '3.', '4.', 'verify', 'content', 'preserved', 'lists', 'formatted', 'truncated'],
    expectedNotContains: ['Number one', 'Number two', 'Number three', 'Number four'],
    testType: 'polish',
  },
  {
    id: 'headless-content-preservation',
    name: 'Content Preservation (No Major Deletion)',
    description: 'Ensures polish does not delete large portions of content',
    inputText: 'I am going to dictate a longer passage to test the silence polish feature thoroughly. This passage includes multiple sentences with various topics. First I want to talk about the weather today. It is quite nice outside. Second I want to mention that I have several tasks to complete. These include checking email and attending meetings. Third I want to note that the application should preserve all of this content without any significant deletions or corruptions.',
    expectedContains: ['weather', 'nice', 'tasks', 'email', 'meetings', 'preserve', 'content'],
    expectedNotContains: [],
    testType: 'polish',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// TEST RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

interface TestResult {
  id: string;
  name: string;
  passed: boolean;
  input: string;
  output: string;
  missingPatterns: string[];
  forbiddenFound: string[];
  duplicateDetected: boolean;
  silenceTriggered: boolean;
  durationMs: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEADLESS TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

export class HeadlessTestRunner {
  private results: TestResult[] = [];
  private llmReady = false;
  
  async run(): Promise<number> {
    console.log('\n╔═══════════════════════════════════════════════════════════════╗');
    console.log('║        HEADLESS E2E TEST - Real App Integration              ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝\n');
    
    console.log('This tests the REAL app flow without UI.');
    console.log('Uses actual LLM service, silence detection, paste logic.\n');
    
    try {
      // Initialize LLM service
      await this.initializeLLM();
      
      // Run all test scenarios
      console.log('Running test scenarios:\n');
      
      for (const scenario of testScenarios) {
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
      
      // Print summary
      this.printSummary();
      
      // Save results
      this.saveResults();
      
      // Return exit code
      const allPassed = this.results.every(r => r.passed);
      return allPassed ? 0 : 1;
      
    } catch (err: any) {
      console.error('Fatal error:', err.message);
      return 1;
    }
  }
  
  private async initializeLLM(): Promise<void> {
    console.log('Initializing LLM service...');
    
    // Wait for LLM service to be ready
    const maxWait = 120000; // 2 minutes
    const startTime = Date.now();
    
    while (!this.llmReady && Date.now() - startTime < maxWait) {
      try {
        const status = await llmServer.getStatus();
        if (status.available) {
          this.llmReady = true;
          console.log('LLM service ready ✓');
          
          // Warmup with a simple polish request
          console.log('Warming up LLM (loading 4B model)...');
          const warmupResult = await llmServer.polishText('Warmup test.', 'Warmup test.', 'clean');
          if (warmupResult.success) {
            console.log('LLM warmup complete ✓\n');
          }
          return;
        }
      } catch (e) {
        // LLM not ready yet
      }
      
      await this.sleep(1000);
    }
    
    if (!this.llmReady) {
      throw new Error('LLM service failed to start within timeout');
    }
  }
  
  private async runScenario(scenario: TestScenario): Promise<TestResult> {
    const result: TestResult = {
      id: scenario.id,
      name: scenario.name,
      passed: false,
      input: scenario.inputText,
      output: '',
      missingPatterns: [],
      forbiddenFound: [],
      duplicateDetected: false,
      silenceTriggered: false,
      durationMs: 0,
    };
    
    const startTime = Date.now();
    
    try {
      switch (scenario.testType) {
        case 'polish':
          result.output = await this.testPolish(scenario);
          break;
          
        case 'silence-timing':
          const silenceResult = await this.testSilenceTiming(scenario);
          result.output = silenceResult.output;
          result.silenceTriggered = silenceResult.triggered;
          break;
          
        case 'duplicate-check':
          const dupResult = await this.testDuplicateDetection(scenario);
          result.output = dupResult.output;
          result.duplicateDetected = dupResult.hasDuplicate;
          break;
      }
      
      result.durationMs = Date.now() - startTime;
      
      // Verify expected patterns
      const outputLower = result.output.toLowerCase();
      
      for (const pattern of scenario.expectedContains) {
        if (!outputLower.includes(pattern.toLowerCase())) {
          result.missingPatterns.push(pattern);
        }
      }
      
      for (const pattern of scenario.expectedNotContains) {
        if (outputLower.includes(pattern.toLowerCase())) {
          result.forbiddenFound.push(pattern);
        }
      }
      
      // Determine pass/fail
      result.passed = 
        result.missingPatterns.length === 0 &&
        result.forbiddenFound.length === 0 &&
        !result.duplicateDetected &&
        (scenario.testType !== 'silence-timing' || result.silenceTriggered);
      
    } catch (err: any) {
      result.error = err.message;
      result.durationMs = Date.now() - startTime;
    }
    
    return result;
  }
  
  private async testPolish(scenario: TestScenario): Promise<string> {
    // Direct polish test - uses the LLM service directly
    const result = await llmServer.polishText(
      scenario.inputText,
      scenario.inputText,
      'clean'
    );
    return result.polished || scenario.inputText;
  }
  
  private async testSilenceTiming(scenario: TestScenario): Promise<{ output: string; triggered: boolean }> {
    // Test that silence detection triggers polish
    // This simulates: speech -> silence -> polish
    
    let polishTriggered = false;
    let polishedText = '';
    
    // Set up a callback to receive polish results
    const originalCallback = (llmServer as any).silencePolishCallback;
    
    // Create a promise that resolves when polish is triggered
    const polishPromise = new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(''); // Timeout - no polish triggered
      }, 5000);
      
      (llmServer as any).silencePolishCallback = (polished: string) => {
        polishTriggered = true;
        clearTimeout(timeout);
        resolve(polished);
      };
    });
    
    // Simulate speech input
    llmServer.onSpeechDetected();
    llmServer.updatePastedText(scenario.inputText, 1);
    
    // Start silence monitoring
    llmServer.startSilenceMonitoring((polished: string) => {
      polishTriggered = true;
      polishedText = polished;
    });
    
    // Wait for silence timeout (2 seconds) + processing
    await this.sleep(4000);
    
    // Stop monitoring
    llmServer.stopSilenceMonitoring();
    
    // If polish didn't trigger via callback, try direct call
    if (!polishTriggered) {
      const result = await llmServer.polishText(
        scenario.inputText,
        scenario.inputText,
        'clean'
      );
      polishedText = result.polished || scenario.inputText;
      // Mark as not triggered naturally, but still get the output
    }
    
    // Restore original callback
    (llmServer as any).silencePolishCallback = originalCallback;
    
    return {
      output: polishedText || scenario.inputText,
      triggered: polishTriggered,
    };
  }
  
  private async testDuplicateDetection(scenario: TestScenario): Promise<{ output: string; hasDuplicate: boolean }> {
    // Test that content doesn't get duplicated
    // Simulate: text -> polish -> check for repeated content
    
    const result = await llmServer.polishText(
      scenario.inputText,
      scenario.inputText,
      'clean'
    );
    
    const polished = result.polished || scenario.inputText;
    
    // Check for duplicates: look for repeated phrases
    const hasDuplicate = this.detectDuplicates(polished);
    
    return {
      output: polished,
      hasDuplicate,
    };
  }
  
  private detectDuplicates(text: string): boolean {
    // Split into sentences and check for repeats
    const sentences = text.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 10);
    
    const seen = new Set<string>();
    for (const sentence of sentences) {
      if (seen.has(sentence)) {
        return true;
      }
      seen.add(sentence);
    }
    
    // Also check for repeated numbered list items
    const listItems = text.match(/\d+\.\s*[^.]+/g) || [];
    const seenItems = new Set<string>();
    for (const item of listItems) {
      const normalized = item.replace(/\d+\./, '').trim().toLowerCase();
      if (normalized.length > 5 && seenItems.has(normalized)) {
        return true;
      }
      seenItems.add(normalized);
    }
    
    return false;
  }
  
  private printSummary(): void {
    console.log('\n╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                  HEADLESS E2E TEST SUMMARY                    ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝\n');
    
    const passed = this.results.filter(r => r.passed).length;
    const total = this.results.length;
    const passRate = (passed / total * 100).toFixed(1);
    
    console.log(`TOTAL: ${passed}/${total} passed (${passRate}%)\n`);
    
    // Group by test type
    const types = ['polish', 'silence-timing', 'duplicate-check'];
    console.log('By Type:');
    for (const type of types) {
      const typeResults = this.results.filter(r => {
        const scenario = testScenarios.find(s => s.id === r.id);
        return scenario?.testType === type;
      });
      if (typeResults.length > 0) {
        const typePassed = typeResults.filter(r => r.passed).length;
        console.log(`  ${type}: ${typePassed}/${typeResults.length}`);
      }
    }
    
    // Sample outputs
    console.log('\nSample outputs:');
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
        if (f.duplicateDetected) console.log(`    Duplicate content detected`);
        if (f.error) console.log(`    Error: ${f.error}`);
      }
    }
  }
  
  private saveResults(): void {
    const testEngineDir = path.join(app.getAppPath(), 'test-engine');
    const reportsDir = path.join(testEngineDir, 'reports');
    const historyPath = path.join(testEngineDir, 'history.jsonl');
    
    // Ensure directories exist
    try {
      fs.mkdirSync(reportsDir, { recursive: true });
    } catch (e) {}
    
    // Save detailed report
    const reportPath = path.join(reportsDir, `headless-e2e-${Date.now()}.json`);
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
    
    try {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`\nReport: ${reportPath}`);
    } catch (e) {
      console.log('\nCould not save report (app path may not be writable)');
    }
    
    // Append to history
    const historyEntry = {
      timestamp: new Date().toISOString(),
      label: 'headless-e2e-test',
      totalTests: this.results.length,
      passed: this.results.filter(r => r.passed).length,
      failed: this.results.filter(r => !r.passed).length,
      passRate: this.results.filter(r => r.passed).length / this.results.length,
    };
    
    try {
      fs.appendFileSync(historyPath, JSON.stringify(historyEntry) + '\n');
      console.log(`History: ${historyPath}`);
    } catch (e) {
      // History may not be writable
    }
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Helper to check if we're in headless test mode
export function isHeadlessTestMode(): boolean {
  return process.argv.includes('--run-e2e-tests');
}
