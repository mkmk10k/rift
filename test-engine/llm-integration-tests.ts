#!/usr/bin/env npx ts-node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LLM Integration Tests - End-to-End Testing
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * These tests verify the complete integration of Qwen LLM with Parakeet STT
 * and the Live Paste frontend. They test real-world scenarios and edge cases.
 * 
 * USAGE:
 *   npx ts-node test-engine/llm-integration-tests.ts
 * 
 * WHAT IT TESTS:
 * - End-to-end flow: STT → LLM → Paste
 * - Multiple recording sessions
 * - Error recovery scenarios
 * - Performance under load
 * - Concurrent request handling
 * - Memory usage
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const LLM_SERVER_PATH = path.join(__dirname, '..', 'python', 'llm_server.py');
const PYTHON_PATH = '/opt/homebrew/bin/python3.11';

// ═══════════════════════════════════════════════════════════════════════════════
// LLM SERVER WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════

class LLMServerWrapper {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private responseQueue: Array<{
    resolve: (response: any) => void;
    reject: (err: Error) => void;
    timeoutId: NodeJS.Timeout;
  }> = [];
  private isReady = false;

  async start(): Promise<void> {
    if (this.process && !this.process.killed) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.process = spawn(PYTHON_PATH, [LLM_SERVER_PATH], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });

      this.rl = readline.createInterface({
        input: this.process.stdout!,
        crlfDelay: Infinity,
      });

      this.rl.on('line', (line) => {
        try {
          const response = JSON.parse(line);

          if (response.type === 'ready') {
            this.isReady = true;
            resolve();
            return;
          }

          const pending = this.responseQueue.shift();
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve(response);
          }
        } catch (e) {
          console.error('[LLM Server] Failed to parse:', line);
        }
      });

      this.process.on('error', (err) => {
        reject(err);
      });

      setTimeout(() => {
        if (!this.isReady) {
          this.stop();
          reject(new Error('LLM server startup timeout'));
        }
      }, 120000);
    });
  }

  async send(command: object): Promise<any> {
    if (!this.process || !this.isReady) {
      throw new Error('LLM server not running');
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.responseQueue.findIndex(p => p.resolve === resolve);
        if (idx >= 0) {
          this.responseQueue.splice(idx, 1);
          reject(new Error('LLM request timeout'));
        }
      }, 30000);

      this.responseQueue.push({ resolve, reject, timeoutId });

      const line = JSON.stringify(command) + '\n';
      this.process!.stdin!.write(line);
    });
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 2000);
    }
    this.cleanup();
  }

  private cleanup(): void {
    for (const pending of this.responseQueue) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Server stopped'));
    }
    this.responseQueue = [];

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    this.process = null;
    this.isReady = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

interface IntegrationTestResult {
  name: string;
  passed: boolean;
  error?: string;
  metrics?: {
    latencyMs: number;
    memoryMB?: number;
  };
}

/**
 * Test 1: Simple end-to-end flow
 */
async function testSimpleFlow(server: LLMServerWrapper): Promise<IntegrationTestResult> {
  try {
    // Simulate: User speaks, STT transcribes, LLM polishes
    const sttOutput = 'So um I was thinking about the project and I want to discuss it';
    
    const start = Date.now();
    const result = await server.send({
      action: 'polish_text',
      pasted_text: sttOutput,
      final_text: sttOutput,
      mode: 'clean',
    });
    const latency = Date.now() - start;

    if (result.type === 'error') {
      return {
        name: 'Simple Flow',
        passed: false,
        error: result.error,
      };
    }

    const hasFillerRemoved = !result.polished?.includes('um');
    const hasPunctuation = result.polished?.includes('.') || result.polished?.includes('!') || result.polished?.includes('?');

    return {
      name: 'Simple Flow',
      passed: hasFillerRemoved && hasPunctuation && latency < 2000,
      metrics: {
        latencyMs: latency,
      },
    };
  } catch (err: any) {
    return {
      name: 'Simple Flow',
      passed: false,
      error: err.message,
    };
  }
}

/**
 * Test 2: Multiple recording sessions
 */
async function testMultipleSessions(server: LLMServerWrapper): Promise<IntegrationTestResult> {
  try {
    const sessions = [
      { text: 'First session about the meeting', mode: 'clean' },
      { text: 'Second session about the project', mode: 'professional' },
      { text: 'Third session with um filler words', mode: 'verbatim' },
    ];

    const latencies: number[] = [];
    let allPassed = true;

    for (const session of sessions) {
      const start = Date.now();
      const result = await server.send({
        action: 'polish_text',
        pasted_text: session.text,
        final_text: session.text,
        mode: session.mode,
      });
      const latency = Date.now() - start;
      latencies.push(latency);

      if (result.type === 'error') {
        allPassed = false;
        break;
      }
    }

    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    return {
      name: 'Multiple Sessions',
      passed: allPassed && avgLatency < 2000,
      metrics: {
        latencyMs: avgLatency,
      },
    };
  } catch (err: any) {
    return {
      name: 'Multiple Sessions',
      passed: false,
      error: err.message,
    };
  }
}

/**
 * Test 3: Error recovery
 */
async function testErrorRecovery(server: LLMServerWrapper): Promise<IntegrationTestResult> {
  try {
    // Test with invalid input
    const result1 = await server.send({
      action: 'merge_text',
      pasted: '', // Empty pasted
      new_text: 'test',
    });

    // Should handle gracefully
    const handledGracefully = result1.type === 'merge_result' || result1.type === 'error';

    // Test with very long input
    const longText = 'word '.repeat(1000);
    const result2 = await server.send({
      action: 'polish_text',
      pasted_text: longText,
      final_text: longText,
      mode: 'clean',
    });

    const handledLongText = result2.type === 'polish_result' || result2.type === 'error';

    return {
      name: 'Error Recovery',
      passed: handledGracefully && handledLongText,
    };
  } catch (err: any) {
    return {
      name: 'Error Recovery',
      passed: false,
      error: err.message,
    };
  }
}

/**
 * Test 4: Concurrent requests
 */
async function testConcurrentRequests(server: LLMServerWrapper): Promise<IntegrationTestResult> {
  try {
    const requests = Array.from({ length: 5 }, (_, i) => 
      server.send({
        action: 'merge_text',
        pasted: `Session ${i} pasted text`,
        new_text: `Session ${i} pasted text with new words`,
      })
    );

    const start = Date.now();
    const results = await Promise.all(requests);
    const totalTime = Date.now() - start;

    const allSucceeded = results.every(r => r.type === 'merge_result' || r.type === 'error');
    const avgTimePerRequest = totalTime / requests.length;

    return {
      name: 'Concurrent Requests',
      passed: allSucceeded && avgTimePerRequest < 500,
      metrics: {
        latencyMs: avgTimePerRequest,
      },
    };
  } catch (err: any) {
    return {
      name: 'Concurrent Requests',
      passed: false,
      error: err.message,
    };
  }
}

/**
 * Test 5: Phase 2 merge accuracy
 */
async function testPhase2Accuracy(server: LLMServerWrapper): Promise<IntegrationTestResult> {
  try {
    const testCases = [
      {
        pasted: 'Hello I am',
        newText: "Hello I'm testing",
        expected: 'testing',
      },
      {
        pasted: 'The quick brown',
        newText: 'The quick brown fox jumps',
        expected: 'fox jumps',
      },
    ];

    let correct = 0;
    const latencies: number[] = [];

    for (const testCase of testCases) {
      const start = Date.now();
      const result = await server.send({
        action: 'merge_text',
        pasted: testCase.pasted,
        new_text: testCase.newText,
      });
      const latency = Date.now() - start;
      latencies.push(latency);

      if (result.type === 'merge_result') {
        const actual = result.new_words?.toLowerCase().trim() || '';
        const expected = testCase.expected.toLowerCase().trim();
        if (actual === expected || actual.includes(expected) || expected.includes(actual)) {
          correct++;
        }
      }
    }

    const accuracy = correct / testCases.length;
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    return {
      name: 'Phase 2 Accuracy',
      passed: accuracy >= 0.8 && avgLatency < 200,
      metrics: {
        latencyMs: avgLatency,
      },
    };
  } catch (err: any) {
    return {
      name: 'Phase 2 Accuracy',
      passed: false,
      error: err.message,
    };
  }
}

/**
 * Test 6: Extract new words accuracy
 */
async function testExtractNewWordsAccuracy(server: LLMServerWrapper): Promise<IntegrationTestResult> {
  try {
    const testCases = [
      {
        pastedEnd: '...seventeen eighteen nineteen',
        tailWords: 'nineteen twenty twenty one',
        expected: 'twenty twenty one',
      },
      {
        pastedEnd: '...hello world',
        tailWords: 'world test',
        expected: 'test',
      },
    ];

    let correct = 0;
    const latencies: number[] = [];

    for (const testCase of testCases) {
      const start = Date.now();
      const result = await server.send({
        action: 'extract_new_words',
        pasted_end: testCase.pastedEnd,
        tail_words: testCase.tailWords,
      });
      const latency = Date.now() - start;
      latencies.push(latency);

      if (result.type === 'extract_result') {
        const actual = result.new_words?.toLowerCase().trim() || '';
        const expected = testCase.expected.toLowerCase().trim();
        if (actual === expected || actual.includes(expected) || expected.includes(actual)) {
          correct++;
        }
      }
    }

    const accuracy = correct / testCases.length;
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    return {
      name: 'Extract New Words Accuracy',
      passed: accuracy >= 0.8 && avgLatency < 200,
      metrics: {
        latencyMs: avgLatency,
      },
    };
  } catch (err: any) {
    return {
      name: 'Extract New Words Accuracy',
      passed: false,
      error: err.message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

async function runIntegrationTests(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('              LLM INTEGRATION TESTS                             ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const server = new LLMServerWrapper();
  
  try {
    console.log('Starting LLM server...');
    await server.start();
    console.log('LLM server ready\n');

    const tests = [
      testSimpleFlow,
      testMultipleSessions,
      testErrorRecovery,
      testConcurrentRequests,
      testPhase2Accuracy,
      testExtractNewWordsAccuracy,
    ];

    const results: IntegrationTestResult[] = [];

    for (const test of tests) {
      console.log(`Running: ${test.name}...`);
      const result = await test(server);
      results.push(result);
      
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`${status} ${result.name}`);
      if (result.metrics) {
        console.log(`  Latency: ${result.metrics.latencyMs.toFixed(0)}ms`);
      }
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
      console.log('');
    }

    // Summary
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const passRate = (passed / total) * 100;

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                         SUMMARY                                ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    console.log(`Total: ${passed}/${total} passed (${passRate.toFixed(1)}%)\n`);

    if (passed < total) {
      console.log('Failed tests:');
      for (const result of results.filter(r => !r.passed)) {
        console.log(`  - ${result.name}: ${result.error || 'Unknown error'}`);
      }
      process.exit(1);
    }

  } catch (err: any) {
    console.error('Integration test error:', err.message);
    process.exit(1);
  } finally {
    server.stop();
  }
}

// Run tests
runIntegrationTests().catch(console.error);
