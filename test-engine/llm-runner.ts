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
import {
  TTSTransformScenario,
  ContextDetectionScenario,
  ttsTransformScenarios,
  contextDetectionScenarios,
  getTTSTransformTestSummary,
} from './tts-transform-scenarios';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const LLM_SERVER_PATH = path.join(__dirname, '..', 'python', 'llm_server.py');

function resolveDefaultLlmRunnerPython(): string {
  const bundlePy = path.join(__dirname, '..', 'python-bundle', 'bin', 'python3.11');
  if (fs.existsSync(bundlePy)) return bundlePy;
  const candidates = [
    '/opt/homebrew/bin/python3.11',
    '/usr/local/bin/python3.11',
    '/opt/homebrew/bin/python3',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '/tmp/rift-mlx-env/bin/python3';
}

const PYTHON_PATH = process.env.RIFT_PYTHON_PATH || resolveDefaultLlmRunnerPython();

// Model config name, overridable via --model CLI flag
let MODEL_CONFIG = process.env.RIFT_MODEL_CONFIG || 'gemma4-e4b';

// Latency thresholds (ms) - tests fail if exceeded
// Note: With adaptive model switching, worst case is fast + quality model time
// Production uses adaptive fallback to heuristics if latency is too high
const LATENCY_THRESHOLD_MERGE = 1500;   // Phase 2: adaptive retry + quality model fallback takes 1-1.5s
const LATENCY_THRESHOLD_CORRECT = 500;  // Phase 3: fast model only
const LATENCY_THRESHOLD_POLISH = 6500;  // Phase 4: 4B model takes 5-6s, allow buffer
const LATENCY_THRESHOLD_DEEP = 10000;   // Deep cleanup: 4B model, can take longer
const LATENCY_THRESHOLD_TTS_TRANSFORM = 16000;  // TTS transform: 4B model, complex transforms take 12-15s

// Environment variable to enable/disable deep cleanup tests (disabled by default due to memory)
const RUN_DEEP_CLEANUP_TESTS = process.env.RUN_DEEP_CLEANUP === '1';

// Environment variable to enable/disable TTS transform tests (enabled by default)
const RUN_TTS_TRANSFORM_TESTS = process.env.SKIP_TTS_TRANSFORM !== '1';

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
  // Input context for clear failure display
  input?: string;  // Human-readable description of the test input
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

interface TTSTransformSummary {
  totalTests: number;
  passed: number;
  failed: number;
  passRate: number;
  avgLatencyMs: number;
}

interface LLMTestReport {
  timestamp: string;
  modelConfig: string;
  serverStartupMs: number;
  phaseResults: PhaseResults[];
  allResults: TestResult[];
  summary: {
    totalTests: number;
    totalPassed: number;
    totalFailed: number;
    passRate: number;
  };
  ttsTransform?: TTSTransformSummary;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TTS TRANSFORM / CODE TALK RESULT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TTSTransformResult {
  id: string;
  name: string;
  passed: boolean;
  latencyMs: number;
  latencyExceeded: boolean;
  input: string;
  transformed: string;
  conceptsPreserved: string[];
  conceptsMissing: string[];
  patternsFound: string[];
  patternsMissing: string[];
  forbiddenFound: string[];
  wordRatio: number;
  ratioValid: boolean;
  error?: string;
}

interface ContextDetectionResult {
  id: string;
  name: string;
  passed: boolean;
  context: { appName: string; windowTitle: string; url: string };
  expectedMode: string;
  actualMode: string;
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
        env: { ...process.env, RIFT_MODEL_CONFIG: MODEL_CONFIG },
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
            console.log(`[LLM Server] Config: ${response.model_config || MODEL_CONFIG} (${response.model_family || 'unknown'})`);
            console.log(`[LLM Server] Fast:    ${response.fast_model || '?'}`);
            console.log(`[LLM Server] Quality: ${response.quality_model || '?'}`);
            console.log(`[LLM Server] Deep:    ${response.deep_model || '?'}`);
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
      // 4B polish + first deep load can exceed 30s on CI; align with eval guidance (~2m cap)
      const timeoutId = setTimeout(() => {
        const idx = this.responseQueue.findIndex(p => p.resolve === resolve);
        if (idx >= 0) {
          this.responseQueue.splice(idx, 1);
          reject(new Error('LLM request timeout'));
        }
      }, 120000);

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

  /**
   * Transform text for TTS (Code Talk feature)
   */
  async transformForTTS(text: string, mode: string = 'developer'): Promise<{
    type: string;
    transformed?: string;
    original?: string;
    mode?: string;
    skipped?: boolean;
    reason?: string;
    inference_time_ms?: number;
    word_ratio?: number;
    error?: string;
  }> {
    return this.send({
      action: 'transform_for_tts',
      text,
      mode,
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
 * Calculate similarity between two strings (word Jaccard)
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

/** Expand contractions so "They're" vs "They are" compare fairly in polish evals */
function expandContractions(s: string): string {
  return s
    .replace(/\bthey're\b/gi, 'they are')
    .replace(/\byou're\b/gi, 'you are')
    .replace(/\bwe're\b/gi, 'we are')
    .replace(/\bdon't\b/gi, 'do not')
    .replace(/\bwon't\b/gi, 'will not')
    .replace(/\bcan't\b/gi, 'cannot')
    .replace(/\bwouldn't\b/gi, 'would not')
    .replace(/\bshouldn't\b/gi, 'should not')
    .replace(/\bit's\b/gi, 'it is')
    .replace(/\bi'm\b/gi, 'i am');
}

/** Normalize for Phase 4 polish similarity: contractions, backticks, punctuation */
function normalizePolishForSimilarity(s: string): string {
  let t = s.toLowerCase();
  t = expandContractions(t);
  t = t.replace(/`/g, '');
  t = t.replace(/[.,!?;:'"]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function tokenMultisetF1(tokensA: string[], tokensB: string[]): number {
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const w of tokensA) countA.set(w, (countA.get(w) || 0) + 1);
  for (const w of tokensB) countB.set(w, (countB.get(w) || 0) + 1);
  let intersection = 0;
  for (const [w, ca] of countA) {
    const cb = countB.get(w) || 0;
    intersection += Math.min(ca, cb);
  }
  const sumA = tokensA.length;
  const sumB = tokensB.length;
  if (sumA === 0 || sumB === 0) return 0;
  const precision = intersection / sumA;
  const recall = intersection / sumB;
  return (2 * precision * recall) / (precision + recall + 1e-9);
}

function jaccardWordSetSimilarity(normA: string, normB: string): number {
  const wordsA = new Set(normA.split(' ').filter(Boolean));
  const wordsB = new Set(normB.split(' ').filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

/**
 * Polish eval similarity: max over reference strings; uses max(Jaccard, token F1)
 * after contraction expansion and backtick stripping.
 */
function calculatePolishSimilarity(expected: string | string[], actual: string): number {
  const refs = Array.isArray(expected) ? expected : [expected];
  let best = 0;
  for (const ref of refs) {
    const normE = normalizePolishForSimilarity(ref);
    const normA = normalizePolishForSimilarity(actual);
    if (normE === normA) {
      best = 1;
      break;
    }
    if (normE.length === 0 || normA.length === 0) continue;
    const wa = normE.split(' ').filter(Boolean);
    const wb = normA.split(' ').filter(Boolean);
    const j = jaccardWordSetSimilarity(normE, normA);
    const f1 = tokenMultisetF1(wa, wb);
    const sim = Math.max(j, f1);
    if (sim > best) best = sim;
  }
  return best;
}

function formatExpectedPolishedDisplay(expected: string | string[]): string {
  return Array.isArray(expected) ? expected.join(' | ') : expected;
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
  const inputContext = `Already typed: "${scenario.pasted}" → User said: "${scenario.newText}"`;

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
        input: inputContext,
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
      input: inputContext,
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
      input: inputContext,
    };
  }
}

/**
 * Run Phase 3 correction test
 */
async function runCorrectionTest(scenario: CorrectionTestScenario): Promise<TestResult> {
  const server = await getServer();
  const inputContext = `Original: "${scenario.original}" → Latest STT: "${scenario.latest}"`;

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
        input: inputContext,
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
      input: inputContext,
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
      input: inputContext,
    };
  }
}

/**
 * Run Phase 4 polish test
 */
async function runPolishTest(scenario: PolishTestScenario): Promise<TestResult> {
  const server = await getServer();
  const inputContext = `[${scenario.mode.toUpperCase()}] Input: "${scenario.finalText}"`;

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
        expectedOutput: formatExpectedPolishedDisplay(scenario.expectedPolished),
        actualOutput: '',
        similarity: 0,
        error: response.error,
        input: inputContext,
      };
    }

    const actualOutput = response.polished || '';
    const latencyMs = response.inference_time_ms || 0;
    const similarity = calculatePolishSimilarity(scenario.expectedPolished, actualOutput);
    const latencyExceeded = latencyMs > LATENCY_THRESHOLD_POLISH;
    const passed = similarity >= SIMILARITY_THRESHOLD && !latencyExceeded;
    const expectedDisplay = formatExpectedPolishedDisplay(scenario.expectedPolished);

    return {
      id: scenario.id,
      name: scenario.name,
      phase: 4,
      passed,
      latencyMs,
      latencyExceeded,
      expectedOutput: expectedDisplay,
      actualOutput,
      similarity,
      input: inputContext,
    };
  } catch (err: any) {
    return {
      id: scenario.id,
      name: scenario.name,
      phase: 4,
      passed: false,
      latencyMs: 0,
      latencyExceeded: false,
      expectedOutput: formatExpectedPolishedDisplay(scenario.expectedPolished),
      actualOutput: '',
      similarity: 0,
      error: err.message,
      input: inputContext,
    };
  }
}

/**
 * Run list detection test (critical for Silence Polish)
 */
async function runListDetectionTest(scenario: ListDetectionScenario): Promise<TestResult> {
  const server = await getServer();
  const inputContext = `[${scenario.mode.toUpperCase()}] Input: "${scenario.input}"`;

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
        input: inputContext,
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
      input: inputContext,
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
      input: inputContext,
    };
  }
}

/**
 * Run extract new words test
 */
async function runExtractNewWordsTest(scenario: ExtractNewWordsTestScenario): Promise<TestResult> {
  const server = await getServer();
  const inputContext = `Pasted end: "${scenario.pastedEnd}" → Tail words: "${scenario.tailWords}"`;

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
        input: inputContext,
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
      input: inputContext,
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
      input: inputContext,
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
// CODE TALK / TTS TRANSFORM TESTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Import the detectSpeechMode function for context detection tests.
 * This function is PURE and can be tested without AppleScript.
 * Import from context-detection.ts to avoid Electron dependencies.
 */
import { detectSpeechMode, AppContext, TTSSpeechMode } from '../src/main/ipc/context-detection';

/**
 * Run a single TTS transform test
 */
async function runTTSTransformTest(scenario: TTSTransformScenario): Promise<TTSTransformResult> {
  const server = await getServer();

  try {
    const response = await server.transformForTTS(scenario.input, scenario.mode);

    if (response.type === 'error' || response.skipped) {
      return {
        id: scenario.id,
        name: scenario.name,
        passed: false,
        latencyMs: response.inference_time_ms || 0,
        latencyExceeded: false,
        input: scenario.input,
        transformed: response.transformed || '',
        conceptsPreserved: [],
        conceptsMissing: scenario.mustPreserve,
        patternsFound: [],
        patternsMissing: scenario.expectedPatterns,
        forbiddenFound: [],
        wordRatio: 0,
        ratioValid: false,
        error: response.error || response.reason || 'Unknown error',
      };
    }

    const transformed = (response.transformed || '').toLowerCase();
    const latencyMs = response.inference_time_ms || 0;
    const latencyExceeded = latencyMs > LATENCY_THRESHOLD_TTS_TRANSFORM;

    // Check concept preservation (case-insensitive)
    const conceptsPreserved: string[] = [];
    const conceptsMissing: string[] = [];
    for (const concept of scenario.mustPreserve) {
      if (transformed.includes(concept.toLowerCase())) {
        conceptsPreserved.push(concept);
      } else {
        conceptsMissing.push(concept);
      }
    }

    // Check expected patterns
    const patternsFound: string[] = [];
    const patternsMissing: string[] = [];
    for (const pattern of scenario.expectedPatterns) {
      if (transformed.includes(pattern.toLowerCase())) {
        patternsFound.push(pattern);
      } else {
        patternsMissing.push(pattern);
      }
    }

    // Check forbidden patterns
    const forbiddenFound: string[] = [];
    const forbiddenPatterns = scenario.forbiddenPatterns || [];
    for (const forbidden of forbiddenPatterns) {
      if (transformed.includes(forbidden.toLowerCase())) {
        forbiddenFound.push(forbidden);
      }
    }

    // Check word ratio
    const inputWords = scenario.input.split(/\s+/).length;
    const outputWords = (response.transformed || '').split(/\s+/).length;
    const wordRatio = outputWords / Math.max(inputWords, 1);
    const maxRatio = scenario.maxExpansionRatio || 3.0;  // Default: allow 3x expansion for natural speech
    const ratioValid = wordRatio <= maxRatio && wordRatio >= 0.3;

    // Pass if: concepts preserved, no forbidden patterns, valid ratio
    // Expected patterns are nice-to-have but not required for pass
    const conceptsOk = conceptsMissing.length === 0;
    const forbiddenOk = forbiddenFound.length === 0;
    const passed = conceptsOk && forbiddenOk && ratioValid && !latencyExceeded;

    return {
      id: scenario.id,
      name: scenario.name,
      passed,
      latencyMs,
      latencyExceeded,
      input: scenario.input,
      transformed: response.transformed || '',
      conceptsPreserved,
      conceptsMissing,
      patternsFound,
      patternsMissing,
      forbiddenFound,
      wordRatio,
      ratioValid,
    };
  } catch (err: any) {
    return {
      id: scenario.id,
      name: scenario.name,
      passed: false,
      latencyMs: 0,
      latencyExceeded: false,
      input: scenario.input,
      transformed: '',
      conceptsPreserved: [],
      conceptsMissing: scenario.mustPreserve,
      patternsFound: [],
      patternsMissing: scenario.expectedPatterns,
      forbiddenFound: [],
      wordRatio: 0,
      ratioValid: false,
      error: err.message,
    };
  }
}

/**
 * Run a single context detection test (pure function, no LLM needed)
 */
function runContextDetectionTest(scenario: ContextDetectionScenario): ContextDetectionResult {
  const actualMode = detectSpeechMode(scenario.context);
  const passed = actualMode === scenario.expectedMode;

  return {
    id: scenario.id,
    name: scenario.name,
    passed,
    context: scenario.context,
    expectedMode: scenario.expectedMode,
    actualMode,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function runAllTests(): Promise<LLMTestReport> {
  const allResults: TestResult[] = [];
  const startTime = Date.now();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    LLM TEST RUNNER                             ');
  console.log(`                  Model: ${MODEL_CONFIG}`);
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

  // Full polish warmup so the first scenario is not penalized for deep-model cold start
  try {
    const s = await getServer();
    console.log('[Phase 4] Warming up deep polish model (dummy request)...');
    const warm = await s.polishText('Warmup.', 'Warmup.', 'clean');
    if (warm.type === 'error') {
      console.log(`[Phase 4] Warmup returned error (continuing): ${warm.error}`);
    } else {
      console.log(
        `[Phase 4] Warmup complete in ${warm.inference_time_ms ?? '?'}ms — starting scenarios\n`
      );
    }
  } catch (e: any) {
    console.log(`[Phase 4] Warmup failed (continuing): ${e?.message || e}`);
  }

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

  // Run Context Detection tests (pure function, no LLM needed)
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('CONTEXT DETECTION (Code Talk Mode Detection)');
  console.log('─────────────────────────────────────────────────────────────\n');

  const contextResults: ContextDetectionResult[] = [];
  for (const scenario of contextDetectionScenarios) {
    const result = runContextDetectionTest(scenario);
    contextResults.push(result);
    
    const status = result.passed ? '✅' : '❌';
    console.log(`${status} ${scenario.id}: ${scenario.name}`);
    
    if (!result.passed) {
      console.log(`   App: ${result.context.appName}`);
      console.log(`   Expected: ${result.expectedMode}, Got: ${result.actualMode}`);
    }
  }

  const ctxPassed = contextResults.filter(r => r.passed).length;
  console.log(`\n  Context detection: ${ctxPassed}/${contextResults.length} passed`);

  // Run TTS Transform tests (Code Talk)
  const ttsTransformResults: TTSTransformResult[] = [];
  
  if (RUN_TTS_TRANSFORM_TESTS) {
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log('TTS TRANSFORM (Code Talk Feature)');
    console.log('─────────────────────────────────────────────────────────────\n');

    for (const scenario of ttsTransformScenarios) {
      const result = await runTTSTransformTest(scenario);
      ttsTransformResults.push(result);
      
      const status = result.passed ? '✅' : '❌';
      const latencyInfo = result.latencyExceeded ? ` ⚠️ ${result.latencyMs}ms` : ` ${result.latencyMs}ms`;
      console.log(`${status} ${scenario.id}: ${scenario.name}${latencyInfo}`);
      
      if (!result.passed) {
        if (result.conceptsMissing.length > 0) {
          console.log(`   Missing concepts: ${result.conceptsMissing.join(', ')}`);
        }
        if (result.forbiddenFound.length > 0) {
          console.log(`   Forbidden found: ${result.forbiddenFound.join(', ')}`);
        }
        if (!result.ratioValid) {
          console.log(`   Word ratio: ${result.wordRatio.toFixed(2)} (max: ${scenario.maxExpansionRatio || 3.0})`);
        }
        if (result.error) {
          console.log(`   Error: ${result.error}`);
        }
        console.log(`   Input: "${result.input.substring(0, 60)}..."`);
        console.log(`   Output: "${result.transformed.substring(0, 60)}..."`);
      }
    }

    const ttsPassed = ttsTransformResults.filter(r => r.passed).length;
    console.log(`\n  TTS transform: ${ttsPassed}/${ttsTransformResults.length} passed`);
  } else {
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log('TTS TRANSFORM: SKIPPED (set SKIP_TTS_TRANSFORM=0 to enable)');
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

  // Generate failure analysis
  const failureAnalysis = generateFailureAnalysis(allResults);
  
  // Print failure analysis
  printFailureAnalysis(failureAnalysis);
  
  const reportForSave: LLMTestReport = {
    timestamp: new Date().toISOString(),
    modelConfig: MODEL_CONFIG,
    serverStartupMs,
    phaseResults: [],
    allResults,
    summary: {
      totalTests: allResults.length,
      totalPassed: allResults.filter(r => r.passed).length,
      totalFailed: allResults.filter(r => !r.passed).length,
      passRate: allResults.filter(r => r.passed).length / allResults.length,
    },
  };
  saveLatestResults(reportForSave, contextResults, ttsTransformResults, failureAnalysis);

  // Calculate TTS Transform summary if tests were run
  let ttsTransformSummary: TTSTransformSummary | undefined;
  if (ttsTransformResults.length > 0) {
    const ttsPassed = ttsTransformResults.filter(r => r.passed).length;
    const ttsLatencies = ttsTransformResults.map(r => r.latencyMs).filter(l => l > 0);
    ttsTransformSummary = {
      totalTests: ttsTransformResults.length,
      passed: ttsPassed,
      failed: ttsTransformResults.length - ttsPassed,
      passRate: ttsPassed / ttsTransformResults.length,
      avgLatencyMs: ttsLatencies.length > 0 
        ? ttsLatencies.reduce((a, b) => a + b, 0) / ttsLatencies.length 
        : 0,
    };
  }

  return {
    timestamp: new Date().toISOString(),
    modelConfig: MODEL_CONFIG,
    serverStartupMs,
    phaseResults,
    allResults,
    summary: {
      totalTests: allResults.length,
      totalPassed,
      totalFailed,
      passRate,
    },
    ttsTransform: ttsTransformSummary,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

const HISTORY_FILE = path.join(__dirname, 'history.jsonl');
const LATEST_RESULTS_FILE = path.join(__dirname, 'latest-results.json');

interface HistoryEntry {
  timestamp: string;
  label: string;
  modelConfig: string;
  totalTests: number;
  passed: number;
  failed: number;
  passRate: number;
  avgLatencyMs: number;
  phase2PassRate: number;
  phase3PassRate: number;
  phase4PassRate: number;
  ttsTransformPassed?: number;
  ttsTransformTotal?: number;
  ttsTransformPassRate?: number;
  ttsTransformAvgLatencyMs?: number;
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
    modelConfig: MODEL_CONFIG,
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
    // Include TTS Transform results if available
    ...(report.ttsTransform && {
      ttsTransformPassed: report.ttsTransform.passed,
      ttsTransformTotal: report.ttsTransform.totalTests,
      ttsTransformPassRate: report.ttsTransform.passRate,
      ttsTransformAvgLatencyMs: report.ttsTransform.avgLatencyMs,
    }),
  };
  
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(HISTORY_FILE, line);
  console.log(`\n[History] Appended to ${HISTORY_FILE}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FAILURE ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

interface FailureDetail {
  id: string;
  name: string;
  category: string;
  similarity: number;
  reason: string;
  actual: string;
  expected: string;
  input?: string;  // Human-readable input context for the test
}

interface FailureAnalysis {
  totalFailures: number;
  byCategory: Record<string, string[]>;
  failureDetails: FailureDetail[];
  recommendations: string[];
  cursorPrompt: string;
}

/**
 * Categorize a test result into a failure category
 */
function categorizeFailure(result: TestResult): string {
  const id = result.id.toLowerCase();
  
  if (id.startsWith('punct-') || id.includes('punctuation')) return 'punctuation';
  if (id.startsWith('contract-') || id.includes('contraction')) return 'contraction';
  if (id.startsWith('truncate-') || id.includes('truncation')) return 'truncation';
  if (id.startsWith('revision-') || id.includes('revision')) return 'revision';
  if (id.startsWith('edge-') || id.includes('edge')) return 'edge-case';
  if (id.startsWith('extract-')) return 'extract';
  if (id.startsWith('stutter-')) return 'stutter';
  if (id.startsWith('grammar-')) return 'grammar';
  if (id.startsWith('homo-') || id.includes('homophone')) return 'homophone';
  if (id.startsWith('format-')) return 'format';
  if (id.startsWith('tech-')) return 'technical';
  if (id.startsWith('filler-')) return 'filler';
  if (id.startsWith('list-')) return 'list';
  
  // Fallback to phase-based category
  if (result.phase === 2) return 'merge';
  if (result.phase === 3) return 'correction';
  if (result.phase === 4) return 'polish';
  
  return 'other';
}

/**
 * Infer a human-readable reason for why the test failed
 * Analyzes actual vs expected output to provide specific, actionable feedback
 */
function inferFailureReason(result: TestResult): string {
  const id = result.id.toLowerCase();
  const sim = result.similarity;
  const actual = (result.actualOutput || '').toLowerCase().trim();
  const expected = (result.expectedOutput || '').toLowerCase().trim();
  
  // Analyze the actual difference between expected and actual
  const actualWords = new Set(actual.split(/\s+/).filter(Boolean));
  const expectedWords = new Set(expected.split(/\s+/).filter(Boolean));
  
  // Find what's missing and what's extra
  const missing: string[] = [];
  const extra: string[] = [];
  
  for (const word of expectedWords) {
    if (!actualWords.has(word)) missing.push(word);
  }
  for (const word of actualWords) {
    if (!expectedWords.has(word)) extra.push(word);
  }
  
  // Specific known patterns (more detailed)
  if (id.includes('contract')) {
    if (id.includes('would-have')) {
      return 'Model didn\'t recognize "would\'ve" as equivalent to "would have" — treated contraction as new content';
    }
    if (id.includes('do-not')) {
      return 'Model didn\'t recognize "don\'t" as equivalent to "do not" — failed to find overlap';
    }
    return `Contraction handling failed — model can't match contracted vs expanded forms`;
  }
  
  if (id.includes('truncate')) {
    if (missing.length > 0) {
      return `Lost content during truncation — missing: "${missing.slice(0, 3).join(', ')}"`;
    }
    return 'Truncated text confused the overlap detection — couldn\'t find matching point';
  }
  
  if (id.includes('complete-rewrite') || id.includes('edge-complete')) {
    return 'When user rewrites entirely (same meaning, different words), model should detect this — it didn\'t';
  }
  
  if (id.includes('nothing-new') || id.includes('edge-nothing')) {
    if (actual.length > 0) {
      return `Should output nothing (no new words), but model returned: "${actual.slice(0, 30)}..."`;
    }
    return 'Failed to recognize that revised text contains no new content';
  }
  
  if (id.includes('number-format') || id.includes('revision-number')) {
    return 'Number format changed (e.g., "three thirty" → "3:30") — model saw format change as new content';
  }
  
  if (id.includes('homo') || id.includes('homophone')) {
    return 'Homophone not corrected — model should fix their/they\'re, your/you\'re based on context';
  }
  
  if (id.includes('phone') || id.includes('url') || id.includes('format')) {
    return 'Format should be preserved (phone numbers, URLs) — model converted to spoken words';
  }
  
  if (id.includes('stutter')) {
    return 'Repeated/stuttered words should be cleaned up — model left repetitions in place';
  }
  
  if (id.includes('extract') && id.includes('edge')) {
    if (missing.length > 0 && extra.length === 0) {
      return `Edge case extraction — output too short, missing: "${missing.join(', ')}"`;
    }
    return 'Edge case in word extraction — boundary detection failed';
  }
  
  if (id.includes('extract') && id.includes('punct')) {
    return 'Punctuation affected word extraction — model included/excluded wrong words at sentence boundary';
  }
  
  // Analyze based on actual differences found
  if (actual.length === 0 && expected.length > 0) {
    return `Model returned empty output — expected: "${expected.slice(0, 40)}${expected.length > 40 ? '...' : ''}"`;
  }
  
  if (missing.length > 0 && extra.length === 0) {
    return `Output truncated — missing: "${missing.slice(0, 4).join(', ')}"`;
  }
  
  if (extra.length > 0 && missing.length === 0) {
    return `Output too long — included extra: "${extra.slice(0, 4).join(', ')}"`;
  }
  
  if (missing.length > 0 && extra.length > 0) {
    return `Wrong content — missing "${missing[0]}", got "${extra[0]}" instead`;
  }
  
  // Fallback based on similarity
  if (sim === 0) {
    return `Output completely wrong — expected "${expected.slice(0, 30)}...", got "${actual.slice(0, 30)}..."`;
  }
  if (sim < 0.3) {
    return 'Very low match — model misunderstood what new content to extract';
  }
  if (sim < 0.5) {
    return 'Partial match only — model found some but not all new words';
  }
  if (sim < 0.7) {
    return 'Close but threshold not met (need 70% word overlap) — minor extraction error';
  }
  
  // Check for error
  if (result.error) {
    return `Error: ${result.error}`;
  }
  
  return `Similarity ${(sim * 100).toFixed(0)}% below 70% threshold`;
}

/**
 * Generate recommendations based on failure patterns
 */
function generateRecommendations(byCategory: Record<string, string[]>): string[] {
  const recommendations: string[] = [];
  
  if (byCategory['contraction']?.length > 0) {
    recommendations.push('Add few-shot examples for contraction pairs (would have/would\'ve, do not/don\'t) to merge prompt');
  }
  if (byCategory['truncation']?.length > 0) {
    recommendations.push('Improve truncation detection - consider semantic similarity for heavily truncated inputs');
  }
  if (byCategory['extract']?.length > 0) {
    recommendations.push('Review extract_new_words prompt - edge cases with partial overlap need better handling');
  }
  if (byCategory['edge-case']?.length > 0) {
    recommendations.push('Add edge case handling for complete rewrites and empty new content');
  }
  if (byCategory['homophone']?.length > 0) {
    recommendations.push('Consider context-aware homophone correction in polish prompt');
  }
  if (byCategory['format']?.length > 0) {
    recommendations.push('Format preservation needs improvement - phone numbers/URLs being expanded to words');
  }
  if (byCategory['punctuation']?.length > 0) {
    recommendations.push('Review punctuation handling in merge detection');
  }
  if (byCategory['stutter']?.length > 0) {
    recommendations.push('Improve stutter pattern detection in correction phase');
  }
  
  if (recommendations.length === 0) {
    recommendations.push('Review failing test scenarios for common patterns');
  }
  
  return recommendations;
}

/**
 * Generate a Cursor-ready prompt for fixing failures
 */
function generateCursorPrompt(
  failureDetails: FailureDetail[],
  byCategory: Record<string, string[]>,
  recommendations: string[]
): string {
  const categoryList = Object.entries(byCategory)
    .filter(([_, ids]) => ids.length > 0)
    .map(([cat, ids]) => `  - ${cat}: ${ids.join(', ')}`)
    .join('\n');
  
  const topFailures = failureDetails
    .slice(0, 5)
    .map(f => `  - ${f.id}: ${f.reason}`)
    .join('\n');
  
  const recList = recommendations
    .map((r, i) => `${i + 1}. ${r}`)
    .join('\n');
  
  return `I need to improve the failing LLM eval scenarios in Rift.

Failed tests (${failureDetails.length} total):
${categoryList}

Top failures:
${topFailures}

Recommendations:
${recList}

Please analyze these failures in test-engine/llm-scenarios.ts and python/prompts.json, then propose improvements to either:
1. The test expectations (if they're too strict)
2. The LLM prompts (if the model can do better with better guidance)
3. Add few-shot examples for problematic patterns

Focus on the highest-impact fixes first.`;
}

/**
 * Generate comprehensive failure analysis
 */
function generateFailureAnalysis(allResults: TestResult[]): FailureAnalysis {
  const failures = allResults.filter(r => !r.passed);
  
  // Group by category
  const byCategory: Record<string, string[]> = {};
  for (const f of failures) {
    const cat = categorizeFailure(f);
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(f.id);
  }
  
  // Generate detailed failure info
  const failureDetails: FailureDetail[] = failures.map(f => ({
    id: f.id,
    name: f.name,
    category: categorizeFailure(f),
    similarity: f.similarity,
    reason: inferFailureReason(f),
    actual: f.actualOutput,
    expected: f.expectedOutput,
    input: f.input,  // Include test input context
  }));
  
  // Generate recommendations
  const recommendations = generateRecommendations(byCategory);
  
  // Generate Cursor prompt
  const cursorPrompt = generateCursorPrompt(failureDetails, byCategory, recommendations);
  
  return {
    totalFailures: failures.length,
    byCategory,
    failureDetails,
    recommendations,
    cursorPrompt,
  };
}

/**
 * Print failure analysis to console
 */
function printFailureAnalysis(analysis: FailureAnalysis): void {
  if (analysis.totalFailures === 0) {
    console.log('\n✅ All tests passed - no failure analysis needed.');
    return;
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    FAILURE ANALYSIS                            ');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // By category
  console.log('By Category:');
  for (const [cat, ids] of Object.entries(analysis.byCategory)) {
    if (ids.length > 0) {
      console.log(`  ${cat} (${ids.length}): ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? '...' : ''}`);
    }
  }
  
  // Top issues
  console.log('\nTop Issues:');
  const topIssues = analysis.failureDetails.slice(0, 5);
  for (let i = 0; i < topIssues.length; i++) {
    const f = topIssues[i];
    console.log(`  ${i + 1}. ${f.id}: ${f.reason}`);
  }
  
  // Recommendations
  console.log('\nRecommendations:');
  for (const rec of analysis.recommendations) {
    console.log(`  • ${rec}`);
  }
  
  console.log('\n[Cursor Prompt available in latest-results.json]');
}

/**
 * Save latest results to JSON for website export
 * Includes per-scenario pass/fail results
 */
function saveLatestResults(
  report: LLMTestReport,
  contextResults: ContextDetectionResult[],
  ttsTransformResults: TTSTransformResult[],
  failureAnalysis?: FailureAnalysis
): void {
  const latestResults = {
    timestamp: report.timestamp,
    modelConfig: report.modelConfig,
    llmResults: report.allResults.map(r => ({
      id: r.id,
      name: r.name,
      phase: r.phase,
      passed: r.passed,
      latencyMs: r.latencyMs,
      similarity: r.similarity,
      actual: r.actualOutput,
      expected: r.expectedOutput,
      error: r.error,
    })),
    // Context detection results
    contextResults: contextResults.map(r => ({
      id: r.id,
      name: r.name,
      passed: r.passed,
      expectedMode: r.expectedMode,
      actualMode: r.actualMode,
    })),
    // TTS Transform results
    ttsTransformResults: ttsTransformResults.map(r => ({
      id: r.id,
      name: r.name,
      passed: r.passed,
      latencyMs: r.latencyMs,
      conceptsMissing: r.conceptsMissing,
      error: r.error,
    })),
    // Failure analysis
    failureAnalysis: failureAnalysis || null,
  };
  
  fs.writeFileSync(LATEST_RESULTS_FILE, JSON.stringify(latestResults, null, 2));
  console.log(`\n[Results] Saved to ${LATEST_RESULTS_FILE}`);
}

/**
 * Print agent-friendly summary for parsing
 */
function printAgentSummary(report: LLMTestReport): void {
  console.log('\n=== EVALS SUMMARY FOR AGENT ===');
  console.log(`TIMESTAMP: ${report.timestamp}`);
  console.log(`MODEL_CONFIG: ${report.modelConfig}`);
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

const MODEL_CONFIGS_LIST = ['qwen3', 'gemma4-e4b', 'gemma4-e4b-6bit', 'gemma4-moe'];

function printHelp(): void {
  console.log(`
LLM Test Runner for Live Paste Enhancement
═══════════════════════════════════════════

Usage:
  npx ts-node test-engine/llm-runner.ts [options]

Options:
  --phase <2|3|4>     Run tests for a specific phase only
  --category <name>   Run tests for a specific category
  --model <config>    Model config to use (default: qwen3)
                      Available: ${MODEL_CONFIGS_LIST.join(', ')}
  --label <name>      Label for history entry (default: run)
  --benchmark         Run latency benchmarks (10 iterations per test)
  --help              Show this help message

Phases:
  2  Intelligent text merge (when anchor detection fails)
  3  Rolling sentence correction (during speech)
  4  Final text polish (when recording stops)

Model Configs:
  qwen3              Qwen3 0.6B fast + 4B deep (default)
  gemma4-e4b         Gemma 4 E4B-4bit as deep model
  gemma4-e4b-6bit    Gemma 4 E4B-6bit as deep model
  gemma4-moe         Gemma 4 26B MoE-4bit as deep model
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

  // Get model config from args (e.g., --model gemma4-e4b)
  const modelIdx = args.indexOf('--model');
  if (modelIdx >= 0 && args[modelIdx + 1]) {
    const requestedModel = args[modelIdx + 1];
    if (!MODEL_CONFIGS_LIST.includes(requestedModel)) {
      console.error(`Unknown model config: ${requestedModel}`);
      console.error(`Available: ${MODEL_CONFIGS_LIST.join(', ')}`);
      process.exit(1);
    }
    MODEL_CONFIG = requestedModel;
    console.log(`[Config] Using model config: ${MODEL_CONFIG}`);
  }

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
