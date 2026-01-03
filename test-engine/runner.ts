/**
 * Test Runner - Executes scenarios through the STT pipeline
 * 
 * MEMORY-SAFE DESIGN:
 * - Single STT server instance with explicit lifecycle management
 * - Forced cleanup after each scenario (audio buffers cleared)
 * - Process health monitoring to prevent zombie processes
 * - Explicit GC hints after heavy operations
 * - Maximum test duration limits to prevent runaway tests
 * 
 * This runner:
 * 1. Generates audio from scenario text
 * 2. Feeds audio chunks through the STT server (via stdin/stdout)
 * 3. Captures all transcription results
 * 4. Measures timing at each step
 * 5. Returns metrics for analysis
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { TestScenario, scenarios } from './scenarios';
import { generateScenarioAudio, loadWavAsFloat32, chunkAudio } from './audio-generator';
import { calculateMetrics, PasteEvent, TestMetrics } from './metrics';

const STT_SERVER_PATH = path.join(__dirname, '..', 'python', 'stt_server.py');
const PYTHON_PATH = '/opt/homebrew/bin/python3.11';
const CHUNK_DURATION_MS = 500; // Match the real app's chunk size

// MEMORY SAFETY: Maximum test duration to prevent runaway tests
const MAX_SCENARIO_DURATION_MS = 120_000; // 2 minutes max per scenario
const MAX_AUDIO_BUFFER_SIZE = 50_000_000; // 50MB max audio buffer

export interface TestResult {
  scenario: TestScenario;
  metrics: TestMetrics;
  passed: boolean;
  failures: string[];
  diagnostics: string[];
}

interface STTResponse {
  type?: string;
  text?: string;
  error?: string;
}

/**
 * STT Server wrapper - manages the child process
 * 
 * MEMORY-SAFE DESIGN:
 * - Tracks process health (alive check before operations)
 * - Clears response queue to prevent memory leaks
 * - Force kills process on stop (SIGKILL after SIGTERM)
 * - Prevents duplicate starts
 */
class STTServerWrapper {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private responseQueue: Array<{ resolve: (response: STTResponse) => void; reject: (err: Error) => void; timeoutId: NodeJS.Timeout }> = [];
  private isReady = false;
  private readyPromise: Promise<void> | null = null;
  private startTime = 0;

  isAlive(): boolean {
    return this.process !== null && this.isReady && !this.process.killed;
  }

  getUptime(): number {
    return this.startTime > 0 ? Date.now() - this.startTime : 0;
  }

  async start(): Promise<void> {
    // MEMORY SAFETY: Don't start if already running
    if (this.process && !this.process.killed) {
      console.log('[STT Server] Already running, reusing...');
      return;
    }

    // Clean up any zombie state
    this.cleanup();

    this.readyPromise = new Promise((resolve, reject) => {
      console.log('[STT Server] Starting...');
      this.startTime = Date.now();
      
      this.process = spawn(PYTHON_PATH, [STT_SERVER_PATH], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });

      this.rl = readline.createInterface({
        input: this.process.stdout!,
        crlfDelay: Infinity,
      });

      this.rl.on('line', (line) => {
        try {
          const response = JSON.parse(line) as STTResponse;
          
          // Check for ready signal
          if (response.type === 'ready' || response.type === 'model_loaded') {
            if (!this.isReady && response.type === 'model_loaded') {
              this.isReady = true;
              console.log('[STT Server] Model loaded, ready for transcription');
              resolve();
            }
            return;
          }
          
          // Dispatch to waiting request
          const pending = this.responseQueue.shift();
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve(response);
          }
        } catch (e) {
          console.error('[STT Server] Failed to parse response:', line);
        }
      });

      this.process.on('error', (err) => {
        this.cleanup();
        reject(err);
      });

      this.process.on('exit', (code) => {
        if (code !== 0) {
          console.error(`[STT Server] Exited with code ${code}`);
        }
        this.cleanup();
      });

      // Timeout for startup
      const startupTimeout = setTimeout(() => {
        if (!this.isReady) {
          this.stop();
          reject(new Error('STT server startup timeout'));
        }
      }, 120000); // 2 minute timeout for model loading
      
      // Clear timeout if resolved
      this.readyPromise?.then(() => clearTimeout(startupTimeout)).catch(() => clearTimeout(startupTimeout));
    });

    return this.readyPromise;
  }

  async send(command: object): Promise<STTResponse> {
    // MEMORY SAFETY: Check process is alive
    if (!this.isAlive()) {
      throw new Error('STT server not running');
    }

    return new Promise((resolve, reject) => {
      // MEMORY SAFETY: Timeout with proper cleanup
      const timeoutId = setTimeout(() => {
        const idx = this.responseQueue.findIndex(p => p.resolve === resolve);
        if (idx >= 0) {
          this.responseQueue.splice(idx, 1);
          reject(new Error('STT request timeout'));
        }
      }, 30000);
      
      this.responseQueue.push({ resolve, reject, timeoutId });
      
      const line = JSON.stringify(command) + '\n';
      this.process!.stdin!.write(line);
    });
  }

  async transcribeBuffer(pcmBase64: string): Promise<STTResponse> {
    // MEMORY SAFETY: Check buffer size
    if (pcmBase64.length > MAX_AUDIO_BUFFER_SIZE) {
      throw new Error(`Audio buffer too large: ${pcmBase64.length} > ${MAX_AUDIO_BUFFER_SIZE}`);
    }
    return this.send({
      action: 'transcribe_buffer',
      pcm_base64: pcmBase64,
    });
  }

  /**
   * Chunk-and-commit transcription - uses the new architecture.
   * 
   * This method:
   * 1. Only transcribes uncommitted audio (fast!)
   * 2. Detects pauses for natural commit points
   * 3. Returns committed_text (immutable) + partial_text (may change)
   */
  async transcribeBufferChunked(
    pcmBase64: string, 
    sessionId: string, 
    totalSamples: number
  ): Promise<{
    type?: string;
    committed_text?: string;
    partial_text?: string;
    is_final?: boolean;
    commit_sample?: number;
    commit_reason?: 'pause' | 'force';
    error?: string;
    inference_time_ms?: number;
    audio_duration_ms?: number;
  }> {
    if (pcmBase64.length > MAX_AUDIO_BUFFER_SIZE) {
      throw new Error(`Audio buffer too large: ${pcmBase64.length} > ${MAX_AUDIO_BUFFER_SIZE}`);
    }
    return this.send({
      action: 'transcribe_buffer_chunked',
      pcm_base64: pcmBase64,
      session_id: sessionId,
      total_samples: totalSamples,
    });
  }

  /**
   * Reset session - clears chunk tracker for new recording.
   */
  async resetSession(): Promise<void> {
    await this.send({ action: 'reset_session' });
  }

  async warmup(): Promise<void> {
    const response = await this.send({ action: 'warmup' });
    if (response.type === 'error') {
      throw new Error(response.error);
    }
  }

  private cleanup(): void {
    // MEMORY SAFETY: Clear all pending requests
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
      // MEMORY SAFETY: Force kill after graceful attempt
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          console.log('[STT Server] Force killing...');
          this.process.kill('SIGKILL');
        }
      }, 2000);
    }
    this.cleanup();
  }
}

// Singleton server instance with lifecycle tracking
let sttServer: STTServerWrapper | null = null;
let scenariosRunSinceRestart = 0;
const MAX_SCENARIOS_BEFORE_RESTART = 5; // Restart server every N scenarios to prevent memory bloat

/**
 * Get or create the STT server instance
 * 
 * MEMORY SAFETY:
 * - Checks if server is still alive before returning
 * - Restarts server periodically to prevent memory accumulation in Python
 * - Forces restart after MAX_SCENARIOS_BEFORE_RESTART scenarios
 */
async function getServer(): Promise<STTServerWrapper> {
  // Check if we need to restart due to scenario count
  if (sttServer && scenariosRunSinceRestart >= MAX_SCENARIOS_BEFORE_RESTART) {
    console.log(`[Memory] Restarting STT server after ${scenariosRunSinceRestart} scenarios...`);
    sttServer.stop();
    sttServer = null;
    scenariosRunSinceRestart = 0;
    
    // Give Python time to fully exit and release memory
    await new Promise(r => setTimeout(r, 2000));
    
    // Hint to Node.js GC
    if (global.gc) {
      global.gc();
    }
  }
  
  // Check if existing server is dead
  if (sttServer && !sttServer.isAlive()) {
    console.log('[Memory] STT server died, restarting...');
    sttServer.stop();
    sttServer = null;
  }
  
  if (!sttServer) {
    sttServer = new STTServerWrapper();
    await sttServer.start();
    await sttServer.warmup();
    console.log('[STT Server] Warmup complete\n');
    scenariosRunSinceRestart = 0;
  }
  
  return sttServer;
}

/**
 * Run a single test scenario
 * 
 * MEMORY SAFETY:
 * - Tracks scenario count for periodic server restart
 * - Enforces max duration timeout
 * - Clears audio buffers after completion
 */
export async function runScenario(scenario: TestScenario): Promise<TestResult> {
  const scenarioStartTime = Date.now();
  
  const result: TestResult = {
    scenario,
    metrics: {} as TestMetrics,
    passed: true,
    failures: [],
    diagnostics: [],
  };

  const timeline: PasteEvent[] = [];
  let recordStartTime = 0;
  
  // FREEZE DETECTION: Track per-chunk transcription latencies
  const chunkLatencies: number[] = [];
  const FREEZE_THRESHOLD_MS = 5000; // 5 seconds = freeze
  
  // MEMORY SAFETY: Track for periodic restart
  scenariosRunSinceRestart++;

  // MEMORY SAFETY: Audio buffers that need explicit cleanup
  let audioData: Float32Array | null = null;
  let chunks: Float32Array[] = [];
  let audioBuffer: Float32Array[] = [];

  try {
    const server = await getServer();
    
    // CHUNK-AND-COMMIT: Reset session at start
    await server.resetSession();
    const sessionId = `test-${Date.now()}`;

    // Generate audio for this scenario
    result.diagnostics.push(`Generating audio for: ${scenario.name}`);
    const audio = await generateScenarioAudio(scenario);
    result.diagnostics.push(`Audio generated: ${audio.durationMs.toFixed(0)}ms`);

    // Load audio as Float32Array
    audioData = loadWavAsFloat32(audio.filePath);
    result.diagnostics.push(`Audio loaded: ${audioData.length} samples`);

    // Split into chunks
    chunks = chunkAudio(audioData, CHUNK_DURATION_MS);
    result.diagnostics.push(`Split into ${chunks.length} chunks`);

    // Simulate recording start
    recordStartTime = Date.now();

    // Add lead-in silence (as the real app does)
    const leadInSilence = new Float32Array(4000); // 250ms at 16kHz

    // Placeholder feedback (Phase 1)
    timeline.push({
      timestamp: Date.now(),
      text: '...',
      isPlaceholder: true,
    });

    // Accumulating buffer for streaming (like the real app)
    let accumulatedSamples = leadInSilence.length;
    audioBuffer = [leadInSilence];
    
    // CHUNK-AND-COMMIT: Track committed text
    let lastCommittedText = '';
    let commitCount = 0;

    // Process each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      audioBuffer.push(chunk);
      accumulatedSamples += chunk.length;

      // Simulate the MIN_SAMPLES threshold
      const MIN_SAMPLES = 8000;

      if (accumulatedSamples >= MIN_SAMPLES) {
        // Concatenate ALL audio for chunk-and-commit (no rolling window!)
        // Python-side handles committed vs uncommitted
        const totalLength = audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
        const combined = new Float32Array(totalLength);
        let offset = 0;
        for (const buf of audioBuffer) {
          combined.set(buf, offset);
          offset += buf.length;
        }

        // Convert to base64 for sending to STT
        const transcribeStart = Date.now();
        const buffer = Buffer.from(combined.buffer);
        const base64Audio = buffer.toString('base64');

        try {
          // Use chunk-and-commit transcription
          const response = await server.transcribeBufferChunked(
            base64Audio, 
            sessionId, 
            accumulatedSamples
          );
          const transcribeEnd = Date.now();
          const chunkLatency = transcribeEnd - transcribeStart;
          
          // FREEZE DETECTION: Track this chunk's latency
          chunkLatencies.push(chunkLatency);
          
          // Combine committed + partial for display
          const fullText = (response.committed_text || '') + 
            (response.partial_text ? ' ' + response.partial_text : '');
          const textSnippet = fullText ? fullText.slice(0, 40) : '(empty)';
          const freezeWarning = chunkLatency > FREEZE_THRESHOLD_MS ? ' ⚠️ FREEZE!' : '';
          const commitInfo = response.is_final ? ` [COMMIT ${response.commit_reason}]` : '';
          
          result.diagnostics.push(`Chunk ${i}: ${chunkLatency}ms${freezeWarning}${commitInfo}, text: "${textSnippet}..."`);

          // Track commits
          if (response.is_final && response.committed_text !== lastCommittedText) {
            lastCommittedText = response.committed_text || '';
            commitCount++;
          }

          if (fullText && fullText.length > 0) {
            timeline.push({
              timestamp: transcribeEnd,
              text: fullText,
              isPlaceholder: false,
            });
          }
        } catch (err) {
          result.diagnostics.push(`Chunk ${i} error: ${err}`);
        }
      }

      // Simulate real-time by waiting between chunks (sped up for testing)
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Final transcription (stream-end) - transcribe all remaining
    const totalLength = audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
    const finalBuffer = new Float32Array(totalLength);
    let offset = 0;
    for (const buf of audioBuffer) {
      finalBuffer.set(buf, offset);
      offset += buf.length;
    }

    const finalStart = Date.now();
    const base64Final = Buffer.from(finalBuffer.buffer).toString('base64');

    try {
      // Final uses chunk-and-commit too - should just return all committed text
      const finalResponse = await server.transcribeBufferChunked(
        base64Final,
        sessionId,
        totalLength
      );
      const finalEnd = Date.now();
      const finalLatency = finalEnd - finalStart;
      
      // FREEZE DETECTION: Track final chunk latency too
      chunkLatencies.push(finalLatency);
      
      const fullText = (finalResponse.committed_text || '') + 
        (finalResponse.partial_text ? ' ' + finalResponse.partial_text : '');
      const textSnippet = fullText ? fullText.slice(0, 60) : '(empty)';
      const freezeWarning = finalLatency > FREEZE_THRESHOLD_MS ? ' ⚠️ FREEZE!' : '';
      result.diagnostics.push(`Final: ${finalLatency}ms${freezeWarning}, commits: ${commitCount}, text: "${textSnippet}..."`);

      if (fullText) {
        timeline.push({
          timestamp: finalEnd,
          text: fullText,
          isPlaceholder: false,
        });
      }
    } catch (err) {
      result.diagnostics.push(`Final transcription error: ${err}`);
    }

    // Calculate metrics (now with freeze detection)
    result.metrics = calculateMetrics(timeline, scenario.groundTruth, recordStartTime, chunkLatencies, FREEZE_THRESHOLD_MS);
    
    // Log freeze detection summary
    if (chunkLatencies.length > 0) {
      result.diagnostics.push(`[Freeze Detection] Max latency: ${result.metrics.maxChunkLatency}ms, Avg: ${result.metrics.avgChunkLatency.toFixed(0)}ms, Freezes: ${result.metrics.freezeCount}`);
    }

    // Check thresholds
    const expected = scenario.expectedMetrics;

    if (expected.maxTimeToFirstFeedback !== undefined &&
        result.metrics.timeToFirstFeedback > expected.maxTimeToFirstFeedback) {
      result.passed = false;
      result.failures.push(`Time to first feedback: ${result.metrics.timeToFirstFeedback}ms > ${expected.maxTimeToFirstFeedback}ms`);
    }

    if (expected.maxTimeToFirstText !== undefined &&
        result.metrics.timeToFirstRealText > expected.maxTimeToFirstText) {
      result.passed = false;
      result.failures.push(`Time to first text: ${result.metrics.timeToFirstRealText}ms > ${expected.maxTimeToFirstText}ms`);
    }

    if (expected.maxFinalWER !== undefined &&
        result.metrics.finalWER > expected.maxFinalWER) {
      result.passed = false;
      result.failures.push(`Final WER: ${(result.metrics.finalWER * 100).toFixed(1)}% > ${(expected.maxFinalWER * 100).toFixed(1)}%`);
    }

    if (expected.minSentenceCorrectionRate !== undefined &&
        result.metrics.sentenceCorrectionRate < expected.minSentenceCorrectionRate) {
      result.passed = false;
      result.failures.push(`Sentence correction rate: ${(result.metrics.sentenceCorrectionRate * 100).toFixed(1)}% < ${(expected.minSentenceCorrectionRate * 100).toFixed(1)}%`);
    }

    // FREEZE DETECTION: Fail if any chunk froze
    if (result.metrics.freezeCount > 0) {
      result.passed = false;
      result.failures.push(
        `FREEZE DETECTED: ${result.metrics.freezeCount} chunk(s) exceeded ${FREEZE_THRESHOLD_MS}ms threshold. ` +
        `Max latency: ${result.metrics.maxChunkLatency}ms at chunk(s): [${result.metrics.frozenChunkIndices.join(', ')}]`
      );
    }

  } catch (error) {
    result.passed = false;
    result.failures.push(`Test execution error: ${error}`);
  } finally {
    // MEMORY SAFETY: Explicit cleanup of large buffers
    audioData = null;
    chunks = [];
    audioBuffer = [];
    
    // Check for timeout
    const duration = Date.now() - scenarioStartTime;
    if (duration > MAX_SCENARIO_DURATION_MS) {
      result.diagnostics.push(`⚠️ Scenario took ${duration}ms (exceeded ${MAX_SCENARIO_DURATION_MS}ms limit)`);
    }
    
    result.diagnostics.push(`[Memory] Scenario completed in ${duration}ms, buffers cleared`);
  }

  return result;
}

/**
 * Run all scenarios
 */
export async function runAllScenarios(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  console.log('\n=== Live Paste Test Suite ===\n');

  try {
    // Ensure STT server is started
    await getServer();

    for (const scenario of scenarios) {
      console.log(`Running: ${scenario.name} (Phase ${scenario.phase})`);
      console.log(`  ${scenario.description}`);

      const result = await runScenario(scenario);
      results.push(result);

      if (result.passed) {
        console.log(`  ✅ PASSED`);
      } else {
        console.log(`  ❌ FAILED:`);
        for (const failure of result.failures) {
          console.log(`     - ${failure}`);
        }
      }

      console.log(`  Metrics:`);
      console.log(`    - First feedback: ${result.metrics.timeToFirstFeedback}ms`);
      console.log(`    - First text: ${result.metrics.timeToFirstRealText}ms`);
      console.log(`    - Final WER: ${(result.metrics.finalWER * 100).toFixed(1)}%`);
      console.log(`    - Updates: ${result.metrics.updateCount}`);
      console.log();
    }
  } finally {
    // Clean up server
    if (sttServer) {
      sttServer.stop();
      sttServer = null;
    }
  }

  return results;
}

/**
 * Run scenarios for a specific phase
 */
export async function runPhaseScenarios(phase: 1 | 2 | 3 | 4): Promise<TestResult[]> {
  const phaseScenarios = scenarios.filter(s => s.phase === phase);
  const results: TestResult[] = [];

  console.log(`\n=== Phase ${phase} Tests ===\n`);

  try {
    await getServer();

    for (const scenario of phaseScenarios) {
      console.log(`Running: ${scenario.name}`);
      const result = await runScenario(scenario);
      results.push(result);

      console.log(result.passed ? '  ✅ PASSED' : '  ❌ FAILED');
      if (!result.passed) {
        result.failures.forEach(f => console.log(`     - ${f}`));
      }
      console.log();
    }
  } finally {
    if (sttServer) {
      sttServer.stop();
      sttServer = null;
    }
  }

  return results;
}

/**
 * Stop the server (for cleanup)
 */
export function stopServer(): void {
  if (sttServer) {
    sttServer.stop();
    sttServer = null;
  }
}
