#!/usr/bin/env npx ts-node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LLM Test Runner - Tests Qwen3 Integration for Live Paste Enhancement
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * USAGE:
 *   npx ts-node test-engine/llm-runner.ts                    # Run all LLM tests
 *   npx ts-node test-engine/llm-runner.ts --phase 2          # Phase 2 only (merge)
 *   npx ts-node test-engine/llm-runner.ts --phase 3          # Phase 3 only (correct)
 *   npx ts-node test-engine/llm-runner.ts --phase 4          # Phase 4 only (polish)
 *   npx ts-node test-engine/llm-runner.ts --category filler  # Specific category
 *   npx ts-node test-engine/llm-runner.ts --benchmark        # Latency benchmarks
 * 
 * WHAT IT TESTS:
 * - Phase 2: Intelligent text merge (when anchor detection fails)
 * - Phase 3: Rolling sentence correction
 * - Phase 4: Final text polish
 * 
 * OUTPUT:
 * - Pass/fail for each scenario
 * - Latency measurements
 * - Similarity scores (fuzzy matching for expected vs actual)
 * - Aggregate metrics per phase
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';
import {
  MergeTestScenario,
  CorrectionTestScenario,
  PolishTestScenario,
  ExtractNewWordsTestScenario,
  DeepCleanupTestScenario,
  ListDetectionScenario,
  mergeScenarios,
  correctionScenarios,
  polishScenarios,
  extractNewWordsScenarios,
  deepCleanupScenarios,
  listDetectionScenarios,
  getLLMTestSummary,
} from './llm-scenarios';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const LLM_SERVER_PATH = path.join(__dirname, '..', 'python', 'llm_server.py');
const PYTHON_PATH = '/opt/homebrew/bin/python3.11';

// Latency thresholds (ms) - tests fail if exceeded
// Note: With adaptive model switching, worst case is fast + quality model time
// Production uses adaptive fallback to heuristics if latency is too high
const LATENCY_THRESHOLD_MERGE = 800;    // Phase 2: allows for adaptive retry (200ms + 500ms)
const LATENCY_THRESHOLD_CORRECT = 500;  // Phase 3: fast model only
const LATENCY_THRESHOLD_POLISH = 5000;  // Phase 4: now using 4B model for better quality
const LATENCY_THRESHOLD_DEEP = 10000;   // Deep cleanup: 4B model, can take longer

// Environment variable to enable/disable deep cleanup tests (disabled by default due to memory)
const RUN_DEEP_CLEANUP_TESTS = process.env.RUN_DEEP_CLEANUP === '1';

// Similarity threshold for fuzzy matching (0-1)
// Note: LLM outputs may vary in wording but preserve meaning
const SIMILARITY_THRESHOLD = 0.7;

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TestResult {
  id: string;
  name: string;
  phase: 2 | 3 | 4;
  passed: boolean;
  latencyMs: number;
  latencyExceeded: boolean;
  expectedOutput: string;
  actualOutput: string;
  similarity: number;
  error?: string;
}

interface PhaseResults {
  phase: 2 | 3 | 4;
  total: number;
  passed: number;
  failed: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  minLatencyMs: number;
  latencyExceededCount: number;
}

interface LLMTestReport {
  timestamp: string;
  serverStartupMs: number;
  phaseResults: PhaseResults[];
  allResults: TestResult[];
  summary: {
    totalTests: number;
    totalPassed: number;
    totalFailed: number;
    passRate: number;
  };
}

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
  private startupTimeMs = 0;

  async start(): Promise<number> {
    if (this.process && !this.process.killed) {
      return this.startupTimeMs;
    }

    const startTime = Date.now();
    console.log('[LLM Server] Starting...');

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
            this.startupTimeMs = Date.now() - startTime;
            console.log(`[LLM Server] Ready in ${this.startupTimeMs}ms`);
            console.log(`[LLM Server] Fast model: ${response.fast_model}`);
            console.log(`[LLM Server] Quality model: ${response.quality_model}`);
            resolve(this.startupTimeMs);
            return;
          }

          // Ignore status messages that aren't responses to commands
          if (response.type === 'quality_model_loaded') {
            console.log(`[LLM Server] Quality model loaded in ${response.load_time_ms}ms`);
            return;
          }
          
          if (response.type === 'deep_model_loaded') {
            console.log(`[LLM Server] Deep model (4B) loaded in ${response.load_time_ms}ms`);
            return;
          }

          // Dispatch to waiting request
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

      this.process.on('exit', (code) => {
        if (code !== 0) {
          console.error(`[LLM Server] Exited with code ${code}`);
        }
        this.cleanup();
      });

      // Timeout for startup
      setTimeout(() => {
        if (!this.isReady) {
          this.stop();
          reject(new Error('LLM server startup timeout'));
        }
      }, 120000); // 2 minutes for model loading
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

  /**
   * Phase 2: Merge text
   */
  async mergeText(pasted: string, newText: string): Promise<{
    type: string;
    new_words?: string;
    inference_time_ms?: number;
    error?: string;
  }> {
    return this.send({
      action: 'merge_text',
      pasted,
      new_text: newText,
    });
  }

  /**
   * Phase 3: Correct sentence
   */
  async correctSentence(original: string, latest: string): Promise<{
    type: string;
    corrected?: string;
    changed?: boolean;
    inference_time_ms?: number;
    error?: string;
  }> {
    return this.send({
      action: 'correct_sentence',
      original,
      latest,
    });
  }

  /**
   * Phase 4: Polish text
   */
  async polishText(pastedText: string, finalText: string, mode: string): Promise<{
    type: string;
    polished?: string;
    inference_time_ms?: number;
    error?: string;
  }> {
    return this.send({
      action: 'polish_text',
      pasted_text: pastedText,
      final_text: finalText,
      mode,
    });
  }

  /**
   * Extract new words (for rolling window recovery)
   */
  async extractNewWords(pastedEnd: string, tailWords: string): Promise<{
    type: string;
    new_words?: string;
    inference_time_ms?: number;
    error?: string;
  }> {
    return this.send({
      action: 'extract_new_words',
      pasted_end: pastedEnd,
      tail_words: tailWords,
    });
  }

  /**
   * Deep cleanup (4B model - Cleanup Crew)
   */
  async deepCleanup(sentence: string, checksum: string): Promise<{
    type: string;
    cleaned?: string;
    original?: string;
    checksum?: string;
    skipped?: boolean;
    reason?: string;
    has_changes?: boolean;
    inference_time_ms?: number;
    error?: string;
  }> {
    return this.send({
      action: 'deep_cleanup',
      sentence,
      checksum,
      gpu_busy: false,
    });
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMILARITY CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate similarity between two strings (Levenshtein-based)
 * Returns 0-1 where 1 is identical
 */
function calculateSimilarity(a: string, b: string): number {
  // Normalize strings
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[.,!?;:'"]/g, '').replace(/\s+/g, ' ').trim();

  const normA = normalize(a);
  const normB = normalize(b);

  if (normA === normB) return 1;
  if (normA.length === 0 || normB.length === 0) return 0;

  // Simple word-based Jaccard similarity
  const wordsA = new Set(normA.split(' '));
  const wordsB = new Set(normB.split(' '));

  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST RUNNERS
// ═══════════════════════════════════════════════════════════════════════════════

let llmServer: LLMServerWrapper | null = null;

async function getServer(): Promise<LLMServerWrapper> {
  if (!llmServer) {
    llmServer = new LLMServerWrapper();
    await llmServer.start();
  }
  return llmServer;
}

/**
 * Run Phase 2 merge test
 */
async function runMergeTest(scenario: MergeTestScenario): Promise<TestResult> {
  const server = await getServer();

  try {
    const response = await server.mergeText(scenario.pasted, scenario.newText);

    if (response.type === 'error') {
      return {
        id: scenario.id,
        name: scenario.name,
        phase: 2,
        passed: false,
        latencyMs: 0,
        latencyExceeded: false,
        expectedOutput: scenario.expectedNewWords,
        actualOutput: '',
        similarity: 0,
        error: response.error,
      };
    }

    const actualOutput = response.new_words || '';
    const latencyMs = response.inference_time_ms || 0;
    const similarity = calculateSimilarity(scenario.expectedNewWords, actualOutput);
    const latencyExceeded = latencyMs > LATENCY_THRESHOLD_MERGE;
    const passed = similarity >= SIMILARITY_THRESHOLD && !latencyExceeded;

    return {
      id: scenario.id,
      name: scenario.name,
      phase: 2,
      passed,
      latencyMs,
      latencyExceeded,
      expectedOutput: scenario.expectedNewWords,
      actualOutput,
      similarity,
    };
  } catch (err: any) {
    return {
      id: scenario.id,
      name: scenario.name,
      phase: 2,
      passed: false,
      latencyMs: 0,
      latencyExceeded: false,
      expectedOutput: scenario.expectedNewWords,
      actualOutput: '',
      similarity: 0,
      error: err.message,
    };
  }
}

/**
 * Run Phase 3 correction test
 */
async function runCorrectionTest(scenario: CorrectionTestScenario): Promise<TestResult> {
  const server = await getServer();

  try {
    const response = await server.correctSentence(scenario.original, scenario.latest);

    if (response.type === 'error') {
      return {
        id: scenario.id,
        name: scenario.name,
        phase: 3,
        passed: false,
        latencyMs: 0,
        latencyExceeded: false,
        expectedOutput: scenario.expectedCorrected,
        actualOutput: '',
        similarity: 0,
        error: response.error,
      };
    }

    const actualOutput = response.corrected || '';
    const latencyMs = response.inference_time_ms || 0;
    const similarity = calculateSimilarity(scenario.expectedCorrected, actualOutput);
    const latencyExceeded = latencyMs > LATENCY_THRESHOLD_CORRECT;
    const passed = similarity >= SIMILARITY_THRESHOLD && !latencyExceeded;

    return {
      id: scenario.id,
      name: scenario.name,
      phase: 3,
      passed,
      latencyMs,
      latencyExceeded,
      expectedOutput: scenario.expectedCorrected,
      actualOutput,
      similarity,
    };
  } catch (err: any) {
    return {
      id: scenario.id,
      name: scenario.name,
      phase: 3,
      passed: false,
      latencyMs: 0,
      latencyExceeded: false,
      expectedOutput: scenario.expectedCorrected,
      actualOutput: '',
      similarity: 0,
      error: err.message,
    };
  }
}

/**
 * Run Phase 4 polish test
 */
async function runPolishTest(scenario: PolishTestScenario): Promise<TestResult> {
  const server = await getServer();

  try {
    const response = await server.polishText(
      scenario.pastedText,
      scenario.finalText,
      scenario.mode
    );

    if (response.type === 'error') {
      return {
        id: scenario.id,
        name: scenario.name,
        phase: 4,
        passed: false,
        latencyMs: 0,
        latencyExceeded: false,
        expectedOutput: scenario.expectedPolished,
        actualOutput: '',
        similarity: 0,
        error: response.error,
      };
    }

    const actualOutput = response.polished || '';
    const latencyMs = response.inference_time_ms || 0;
    const similarity = calculateSimilarity(scenario.expectedPolished, actualOutput);
    const latencyExceeded = latencyMs > LATENCY_THRESHOLD_POLISH;
    const passed = similarity >= SIMILARITY_THRESHOLD && !latencyExceeded;

    return {
      id: scenario.id,
      name: scenario.name,
      phase: 4,
      passed,
      latencyMs,
      latencyExceeded,
      expectedOutput: scenario.expectedPolished,
      actualOutput,
      similarity,
    };
  } catch (err: any) {
    return {
      id: scenario.id,
      name: scenario.name,
      phase: 4,
      passed: false,
      latencyMs: 0,
      latencyExceeded: false,
      expectedOutput: scenario.expectedPolished,
      actualOutput: '',
      similarity: 0,
      error: err.message,
    };
  }
}

/**
 * Run list detection test (critical for Silence Polish)
 */
async function runListDetectionTest(scenario: ListDetectionScenario): Promise<TestResult> {
  const server = await getServer();

  try {
    // Use polish endpoint with the input text
    const response = await server.polishText(
      scenario.input,  // pastedText
      scenario.input,  // finalText (same for silence polish)
      scenario.mode
    );

    if (response.type === 'error') {
      return {
        id: scenario.id,
        name: scenario.name,
        phase: 4,
        passed: false,
        latencyMs: 0,
        latencyExceeded: false,
        expectedOutput: scenario.expectedPatterns.join(', '),
        actualOutput: '',
        similarity: 0,
        error: response.error,
      };
    }

    const actualOutput = response.polished || '';
    const latencyMs = response.inference_time_ms || 0;
    const latencyExceeded = latencyMs > LATENCY_THRESHOLD_POLISH;

    // Check expected patterns
    const missingPatterns: string[] = [];
    for (const pattern of scenario.expectedPatterns) {
      if (!actualOutput.includes(pattern)) {
        missingPatterns.push(pattern);
      }
    }

    // Check forbidden patterns
    const foundForbidden: string[] = [];
    for (const pattern of scenario.forbiddenPatterns) {
      if (actualOutput.toLowerCase().includes(pattern.toLowerCase())) {
        foundForbidden.push(pattern);
      }
    }

    // Check word ratio
    const inputWords = scenario.input.split(/\s+/).length;
    const outputWords = actualOutput.split(/\s+/).length;
    const wordRatio = outputWords / inputWords;
    const ratioValid = wordRatio >= scenario.minWordRatio && wordRatio <= scenario.maxWordRatio;

    // Pass if all checks pass
    const patternsOk = missingPatterns.length === 0;
    const forbiddenOk = foundForbidden.length === 0;
    const passed = patternsOk && forbiddenOk && ratioValid && !latencyExceeded;

    // Build error message for debugging
    let errorMsg = '';
    if (!patternsOk) errorMsg += `Missing: ${missingPatterns.join(', ')}. `;
    if (!forbiddenOk) errorMsg += `Forbidden: ${foundForbidden.join(', ')}. `;
    if (!ratioValid) errorMsg += `Ratio ${wordRatio.toFixed(2)} outside [${scenario.minWordRatio}, ${scenario.maxWordRatio}]. `;

    return {
      id: scenario.id,
      name: scenario.name,
      phase: 4,
      passed,
      latencyMs,
      latencyExceeded,
      expectedOutput: scenario.expectedPatterns.join(', '),
      actualOutput,
      similarity: patternsOk ? 1.0 : 0.5,  // Use similarity to indicate pattern match
      error: errorMsg || undefined,
    };
  } catch (err: any) {
    return {
      id: scenario.id,
      name: scenario.name,
      phase: 4,
      passed: false,
      latencyMs: 0,
      latencyExceeded: false,
      expectedOutput: scenario.expectedPatterns.join(', '),
      actualOutput: '',
      similarity: 0,
      error: err.message,
    };
  }
}

/**
 * Run extract new words test
 */
async function runExtractNewWordsTest(scenario: ExtractNewWordsTestScenario): Promise<TestResult> {
  const server = await getServer();

  try {
    const response = await server.extractNewWords(scenario.pastedEnd, scenario.tailWords);

    if (response.type === 'error') {
      return {
        id: scenario.id,
        name: scenario.name,
        phase: 2, // Same phase as merge (rolling window recovery)
        passed: false,
        latencyMs: 0,
        latencyExceeded: false,
        expectedOutput: scenario.expectedNewWords,
        actualOutput: '',
        similarity: 0,
        error: response.error,
      };
    }

    const actualOutput = response.new_words || '';
    const latencyMs = response.inference_time_ms || 0;
    const similarity = calculateSimilarity(scenario.expectedNewWords, actualOutput);
    const latencyExceeded = latencyMs > LATENCY_THRESHOLD_MERGE;
    const passed = similarity >= SIMILARITY_THRESHOLD && !latencyExceeded;

    return {
      id: scenario.id,
      name: scenario.name,
      phase: 2,
      passed,
      latencyMs,
      latencyExceeded,
      expectedOutput: scenario.expectedNewWords,
      actualOutput,
      similarity,
    };
  } catch (err: any) {
    return {
      id: scenario.id,
      name: scenario.name,
      phase: 2,
      passed: false,
      latencyMs: 0,
      latencyExceeded: false,
      expectedOutput: scenario.expectedNewWords,
      actualOutput: '',
      similarity: 0,
      error: err.message,
    };
  }
}

/**
 * Run deep cleanup test (4B model)
 */
async function runDeepCleanupTest(scenario: DeepCleanupTestScenario): Promise<TestResult & { usedDeepModel?: boolean }> {
  const server = await getServer();

  // Generate checksum for the sentence
  let hash = 0;
  for (let i = 0; i < scenario.sentence.length; i++) {
    const char = scenario.sentence.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const checksum = hash.toString(16);

  try {
    const response = await server.deepCleanup(scenario.sentence, checksum);

    if (response.type === 'error' || response.skipped) {
      return {
        id: scenario.id,
        name: scenario.name,
        phase: 4, // Cleanup crew is background polish
        passed: false,
        latencyMs: response.inference_time_ms || 0,
        latencyExceeded: false,
        expectedOutput: scenario.expectedCleaned,
        actualOutput: response.cleaned || scenario.sentence,
        similarity: 0,
        error: response.error || response.reason || 'Skipped',
        usedDeepModel: false,
      };
    }

    const actualOutput = response.cleaned || scenario.sentence;
    const latencyMs = response.inference_time_ms || 0;
    const similarity = calculateSimilarity(scenario.expectedCleaned, actualOutput);
    const latencyExceeded = latencyMs > LATENCY_THRESHOLD_DEEP;
    const passed = similarity >= SIMILARITY_THRESHOLD && !latencyExceeded;

    return {
      id: scenario.id,
      name: scenario.name,
      phase: 4,
      passed,
      latencyMs,
      latencyExceeded,
      expectedOutput: scenario.expectedCleaned,
      actualOutput,
      similarity,
      usedDeepModel: true,
    };
  } catch (err: any) {
    return {
      id: scenario.id,
      name: scenario.name,
      phase: 4,
      passed: false,
      latencyMs: 0,
      latencyExceeded: false,
      expectedOutput: scenario.expectedCleaned,
      actualOutput: '',
      similarity: 0,
      error: err.message,
      usedDeepModel: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function runAllTests(): Promise<LLMTestReport> {
  const allResults: TestResult[] = [];
  const startTime = Date.now();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    LLM TEST RUNNER                             ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Print test summary
  const summary = getLLMTestSummary();
  console.log('Test Scenarios:');
  console.log(`  Phase 2 (Merge):      ${summary.phase2_merge.total} scenarios`);
  console.log(`  Extract New Words:    ${summary.extract_new_words.total} scenarios`);
  console.log(`  Phase 3 (Correct):    ${summary.phase3_correction.total} scenarios`);
  console.log(`  Phase 4 (Polish):     ${summary.phase4_polish.total} scenarios`);
  if (RUN_DEEP_CLEANUP_TESTS) {
    console.log(`  Deep Cleanup (4B):    ${summary.deep_cleanup.total} scenarios`);
  } else {
    console.log(`  Deep Cleanup (4B):    SKIPPED (set RUN_DEEP_CLEANUP=1 to enable)`);
  }
  console.log('');

  // Start server
  let serverStartupMs = 0;
  try {
    serverStartupMs = await getServer().then(() => llmServer!['startupTimeMs']);
  } catch (err: any) {
    console.error('Failed to start LLM server:', err.message);
    process.exit(1);
  }

  // Run Phase 2 tests
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('PHASE 2: Intelligent Text Merge');
  console.log('─────────────────────────────────────────────────────────────\n');

  for (const scenario of mergeScenarios) {
    const result = await runMergeTest(scenario);
    allResults.push(result);
    
    const status = result.passed ? '✅' : '❌';
    const latencyInfo = result.latencyExceeded ? ` ⚠️ ${result.latencyMs}ms` : ` ${result.latencyMs}ms`;
    console.log(`${status} ${scenario.id}: ${scenario.name}${latencyInfo}`);
    
    if (!result.passed && !result.error) {
      console.log(`   Expected: "${result.expectedOutput}"`);
      console.log(`   Actual:   "${result.actualOutput}"`);
      console.log(`   Similarity: ${(result.similarity * 100).toFixed(1)}%`);
    }
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  }

  // Run Phase 3 tests
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('PHASE 3: Rolling Sentence Correction');
  console.log('─────────────────────────────────────────────────────────────\n');

  for (const scenario of correctionScenarios) {
    const result = await runCorrectionTest(scenario);
    allResults.push(result);
    
    const status = result.passed ? '✅' : '❌';
    const latencyInfo = result.latencyExceeded ? ` ⚠️ ${result.latencyMs}ms` : ` ${result.latencyMs}ms`;
    console.log(`${status} ${scenario.id}: ${scenario.name}${latencyInfo}`);
    
    if (!result.passed && !result.error) {
      console.log(`   Expected: "${result.expectedOutput}"`);
      console.log(`   Actual:   "${result.actualOutput}"`);
      console.log(`   Similarity: ${(result.similarity * 100).toFixed(1)}%`);
    }
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  }

  // Run Extract New Words tests
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('EXTRACT NEW WORDS: Rolling Window Recovery');
  console.log('─────────────────────────────────────────────────────────────\n');

  for (const scenario of extractNewWordsScenarios) {
    const result = await runExtractNewWordsTest(scenario);
    allResults.push(result);
    
    const status = result.passed ? '✅' : '❌';
    const latencyInfo = result.latencyExceeded ? ` ⚠️ ${result.latencyMs}ms` : ` ${result.latencyMs}ms`;
    console.log(`${status} ${scenario.id}: ${scenario.name}${latencyInfo}`);
    
    if (!result.passed && !result.error) {
      console.log(`   Expected: "${result.expectedOutput}"`);
      console.log(`   Actual:   "${result.actualOutput}"`);
      console.log(`   Similarity: ${(result.similarity * 100).toFixed(1)}%`);
    }
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  }

  // Run Phase 4 tests
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('PHASE 4: Final Text Polish');
  console.log('─────────────────────────────────────────────────────────────\n');

  for (const scenario of polishScenarios) {
    const result = await runPolishTest(scenario);
    allResults.push(result);
    
    const status = result.passed ? '✅' : '❌';
    const latencyInfo = result.latencyExceeded ? ` ⚠️ ${result.latencyMs}ms` : ` ${result.latencyMs}ms`;
    console.log(`${status} ${scenario.id}: ${scenario.name} (${scenario.mode})${latencyInfo}`);
    
    if (!result.passed && !result.error) {
      console.log(`   Expected: "${result.expectedOutput}"`);
      console.log(`   Actual:   "${result.actualOutput}"`);
      console.log(`   Similarity: ${(result.similarity * 100).toFixed(1)}%`);
    }
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  }

  // Run List Detection tests (critical for Silence Polish)
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('LIST DETECTION TESTS (Silence Polish Critical)');
  console.log('─────────────────────────────────────────────────────────────\n');

  for (const scenario of listDetectionScenarios) {
    const result = await runListDetectionTest(scenario);
    allResults.push(result);
    
    const status = result.passed ? '✅' : '❌';
    const latencyInfo = result.latencyExceeded ? ` ⚠️ ${result.latencyMs}ms` : ` ${result.latencyMs}ms`;
    console.log(`${status} ${scenario.id}: ${scenario.name} (${scenario.mode})${latencyInfo}`);
    
    if (!result.passed) {
      console.log(`   Expected patterns: ${result.expectedOutput}`);
      console.log(`   Actual:   "${result.actualOutput}"`);
      if (result.error) {
        console.log(`   Reason: ${result.error}`);
      }
    }
  }

  // Run Deep Cleanup tests (4B model - Cleanup Crew) - OPTIONAL
  const deepCleanupResults: (TestResult & { usedDeepModel?: boolean })[] = [];
  
  if (RUN_DEEP_CLEANUP_TESTS) {
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log('DEEP CLEANUP (4B Model - Cleanup Crew)');
    console.log('─────────────────────────────────────────────────────────────\n');

    for (const scenario of deepCleanupScenarios) {
      const result = await runDeepCleanupTest(scenario);
      deepCleanupResults.push(result);
      allResults.push(result);
      
      const status = result.passed ? '✅' : '❌';
      const latencyInfo = result.latencyExceeded ? ` ⚠️ ${result.latencyMs}ms` : ` ${result.latencyMs}ms`;
      const modelInfo = result.usedDeepModel ? ' [4B]' : ' [skipped]';
      console.log(`${status} ${scenario.id}: ${scenario.name}${modelInfo}${latencyInfo}`);
      
      if (!result.passed && !result.error) {
        console.log(`   Expected: "${result.expectedOutput}"`);
        console.log(`   Actual:   "${result.actualOutput}"`);
        console.log(`   Similarity: ${(result.similarity * 100).toFixed(1)}%`);
      }
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    }

    // Deep cleanup specific stats
    const deepPassed = deepCleanupResults.filter(r => r.passed).length;
    const deepUsed4B = deepCleanupResults.filter(r => r.usedDeepModel).length;
    console.log(`\n  Deep cleanup: ${deepPassed}/${deepCleanupResults.length} passed, ${deepUsed4B} used 4B model`);
  } else {
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log('DEEP CLEANUP: SKIPPED (set RUN_DEEP_CLEANUP=1 to enable)');
    console.log('─────────────────────────────────────────────────────────────\n');
  }

  // Calculate phase results
  const phase2Results = allResults.filter(r => r.phase === 2);
  const phase3Results = allResults.filter(r => r.phase === 3);
  const phase4Results = allResults.filter(r => r.phase === 4);

  const calculatePhaseResults = (results: TestResult[], phase: 2 | 3 | 4): PhaseResults => {
    const latencies = results.map(r => r.latencyMs).filter(l => l > 0);
    return {
      phase,
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      avgLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
      minLatencyMs: latencies.length > 0 ? Math.min(...latencies) : 0,
      latencyExceededCount: results.filter(r => r.latencyExceeded).length,
    };
  };

  const phaseResults: PhaseResults[] = [
    calculatePhaseResults(phase2Results, 2),
    calculatePhaseResults(phase3Results, 3),
    calculatePhaseResults(phase4Results, 4),
  ];

  // Print summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                         SUMMARY                                ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const totalPassed = allResults.filter(r => r.passed).length;
  const totalFailed = allResults.filter(r => !r.passed).length;
  const passRate = totalPassed / allResults.length;

  console.log(`Server startup: ${serverStartupMs}ms`);
  console.log(`Total runtime:  ${Date.now() - startTime}ms\n`);

  for (const pr of phaseResults) {
    console.log(`Phase ${pr.phase}: ${pr.passed}/${pr.total} passed (${((pr.passed / pr.total) * 100).toFixed(1)}%)`);
    console.log(`  Latency: avg=${pr.avgLatencyMs.toFixed(0)}ms, min=${pr.minLatencyMs}ms, max=${pr.maxLatencyMs}ms`);
    if (pr.latencyExceededCount > 0) {
      console.log(`  ⚠️ ${pr.latencyExceededCount} tests exceeded latency threshold`);
    }
  }

  console.log('');
  console.log(`TOTAL: ${totalPassed}/${allResults.length} passed (${(passRate * 100).toFixed(1)}%)`);
  console.log('');

  if (totalFailed > 0) {
    console.log('Failed tests:');
    for (const result of allResults.filter(r => !r.passed)) {
      console.log(`  - ${result.id}: ${result.error || `similarity ${(result.similarity * 100).toFixed(1)}%`}`);
    }
  }

  // Stop server
  if (llmServer) {
    llmServer.stop();
    llmServer = null;
  }

  return {
    timestamp: new Date().toISOString(),
    serverStartupMs,
    phaseResults,
    allResults,
    summary: {
      totalTests: allResults.length,
      totalPassed,
      totalFailed,
      passRate,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

const HISTORY_FILE = path.join(__dirname, 'history.jsonl');

interface HistoryEntry {
  timestamp: string;
  label: string;
  totalTests: number;
  passed: number;
  failed: number;
  passRate: number;
  avgLatencyMs: number;
  phase2PassRate: number;
  phase3PassRate: number;
  phase4PassRate: number;
}

/**
 * Append a summary entry to history.jsonl for tracking progress over time
 */
function appendToHistory(report: LLMTestReport, label: string = 'run'): void {
  const phase2 = report.phaseResults.find(p => p.phase === 2);
  const phase3 = report.phaseResults.find(p => p.phase === 3);
  const phase4 = report.phaseResults.find(p => p.phase === 4);
  
  const allLatencies = report.allResults
    .map(r => r.latencyMs)
    .filter(l => l > 0);
  
  const entry: HistoryEntry = {
    timestamp: report.timestamp,
    label,
    totalTests: report.summary.totalTests,
    passed: report.summary.totalPassed,
    failed: report.summary.totalFailed,
    passRate: report.summary.passRate,
    avgLatencyMs: allLatencies.length > 0 
      ? allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length 
      : 0,
    phase2PassRate: phase2 ? phase2.passed / phase2.total : 0,
    phase3PassRate: phase3 ? phase3.passed / phase3.total : 0,
    phase4PassRate: phase4 ? phase4.passed / phase4.total : 0,
  };
  
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(HISTORY_FILE, line);
  console.log(`\n[History] Appended to ${HISTORY_FILE}`);
}

/**
 * Print agent-friendly summary for parsing
 */
function printAgentSummary(report: LLMTestReport): void {
  console.log('\n=== EVALS SUMMARY FOR AGENT ===');
  console.log(`TIMESTAMP: ${report.timestamp}`);
  console.log(`PASS_RATE: ${(report.summary.passRate * 100).toFixed(1)}%`);
  console.log(`TOTAL: ${report.summary.totalPassed}/${report.summary.totalTests}`);
  
  for (const pr of report.phaseResults) {
    console.log(`PHASE_${pr.phase}: ${pr.passed}/${pr.total} (${((pr.passed / pr.total) * 100).toFixed(1)}%)`);
  }
  
  console.log(`AVG_LATENCY_MS: ${report.phaseResults.reduce((sum, p) => sum + p.avgLatencyMs, 0) / report.phaseResults.length}`);
  
  if (report.summary.totalFailed > 0) {
    console.log('FAILURES:');
    for (const result of report.allResults.filter(r => !r.passed)) {
      const reason = result.error || `similarity ${(result.similarity * 100).toFixed(1)}%`;
      console.log(`  - ${result.id}: ${reason}`);
    }
  }
  console.log('=== END SUMMARY ===');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════════

function printHelp(): void {
  console.log(`
LLM Test Runner for Live Paste Enhancement
═══════════════════════════════════════════

Usage:
  npx ts-node test-engine/llm-runner.ts [options]

Options:
  --phase <2|3|4>     Run tests for a specific phase only
  --category <name>   Run tests for a specific category
  --benchmark         Run latency benchmarks (10 iterations per test)
  --help              Show this help message

Phases:
  2  Intelligent text merge (when anchor detection fails)
  3  Rolling sentence correction (during speech)
  4  Final text polish (when recording stops)

Categories (Phase 2):
  punctuation, contraction, truncation, revision, edge-case

Categories (Phase 3):
  grammar, stuttering, punctuation, artifact

Categories (Phase 4):
  filler, homophone, grammar, technical, formatting
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  // Get label from args (e.g., --label baseline-1.7b)
  const labelIdx = args.indexOf('--label');
  const label = labelIdx >= 0 && args[labelIdx + 1] ? args[labelIdx + 1] : 'run';

  try {
    const report = await runAllTests();

    // Append to history for tracking over time
    appendToHistory(report, label);
    
    // Print agent-friendly summary
    printAgentSummary(report);

    // Exit with error code if tests failed
    if (report.summary.totalFailed > 0) {
      process.exit(1);
    }
  } catch (err: any) {
    console.error('Test runner error:', err.message);
    process.exit(1);
  } finally {
    if (llmServer) {
      llmServer.stop();
    }
  }
}

// Handle cleanup on signals
process.on('SIGINT', () => {
  console.log('\nInterrupted, cleaning up...');
  if (llmServer) {
    llmServer.stop();
  }
  process.exit(1);
});

process.on('SIGTERM', () => {
  if (llmServer) {
    llmServer.stop();
  }
  process.exit(1);
});

main().catch(console.error);
