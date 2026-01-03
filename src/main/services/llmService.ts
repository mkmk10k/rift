/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LLM Service - Qwen3 Text Processing for Live Paste Enhancement
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This service manages the LLM Python subprocess (llm_server.py) which provides
 * intelligent text processing to enhance Live Paste accuracy.
 * 
 * ARCHITECTURE:
 * - Persistent subprocess with JSON stdin/stdout protocol (same as STT)
 * - Fast model (Qwen3-0.6B) for real-time operations (Phase 2, 3)
 * - Quality model (Qwen3-1.7B) for final polish and Silence Polish
 * - Lazy loading: quality model only loaded when first needed
 * 
 * SILENCE POLISH (BE-DRIVEN):
 * - Backend owns ALL silence detection - single source of truth
 * - Monitors for 5s+ silence during recording
 * - Triggers automatic text polish (list formatting, filler removal)
 * - Pushes results to frontend via IPC callback
 * 
 * AUTO-INSTALLATION:
 * - Dependencies installed automatically on first launch via pythonSetup.ts
 * - Models downloaded automatically on first use by mlx-lm
 * 
 * LATENCY TARGETS:
 * - Phase 2 (merge): 50ms target, 100ms max
 * - Phase 3 (correct): 100ms target, 200ms max
 * - Phase 4 (polish): 300ms target, 1000ms max
 * 
 * FALLBACK BEHAVIOR:
 * - If LLM unavailable or slow, Live Paste uses heuristics (still works well)
 * - Latency tracking: if consistently slow, skip LLM calls
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { spawn, ChildProcess } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as readline from 'readline';
import type { LLMMergeResult, LLMCorrectResult, LLMPolishResult, LLMPolishMode } from '../../shared/types';
import { findPythonPath, checkLLMInstalled } from '../setup/pythonSetup';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Maximum time to wait for LLM server startup */
const STARTUP_TIMEOUT_MS = 120_000; // 2 minutes (includes model download)

/** Maximum time to wait for a single request */
const REQUEST_TIMEOUT_MS = 30_000;

/** Latency thresholds - skip LLM if consistently slow */
const LATENCY_THRESHOLD_MERGE = 100;
const LATENCY_THRESHOLD_CORRECT = 200;
const LATENCY_THRESHOLD_POLISH = 1000;

/** Number of recent latencies to track */
const LATENCY_HISTORY_SIZE = 10;

/** Skip LLM if average latency exceeds this multiple of threshold */
const LATENCY_SKIP_MULTIPLIER = 1.5;

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SILENCE POLISH CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Backend-driven silence detection and automatic text polish.
 * This is the SINGLE source of truth for silence-based cleanup.
 * 
 * FUTURE IMPROVEMENTS:
 * - [ ] Add 4B model option for higher accuracy (memory permitting)
 * - [ ] Add sentence-level cleanup (currently does full text)
 * - [ ] Add configurable silence threshold via settings
 * - [ ] Add shorter silence triggers (1.5s, 3s) for progressive cleanup
 * - [ ] Add priority queue for longer sentences first
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/** Silence duration before triggering polish (ms) */
const SILENCE_POLISH_THRESHOLD_MS = 5000;

/** How often to check for silence (ms) */
const SILENCE_CHECK_INTERVAL_MS = 800;

/** Minimum text length to trigger polish */
const MIN_TEXT_LENGTH_FOR_POLISH = 20;

// ═══════════════════════════════════════════════════════════════════════════════
// LLM SERVER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

interface LLMResponse {
  type: string;
  [key: string]: any;
}

interface PendingRequest {
  resolve: (response: LLMResponse) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

class LLMServer {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private responseQueue: PendingRequest[] = [];
  private isReady = false;
  private fastModelLoaded = false;
  private qualityModelLoaded = false;
  private startingPromise: Promise<void> | null = null;
  
  // Latency tracking for adaptive fallback
  private mergeLatencies: number[] = [];
  private correctLatencies: number[] = [];
  private polishLatencies: number[] = [];
  private extractNewWordsLatencies: number[] = [];
  
  // Speech tracking for silence detection (SINGLE SOURCE OF TRUTH)
  private lastSpeechTime = Date.now();  // Initialize to now so initial "silence" is 0ms
  
  // Silence Polish state (BE-driven)
  private silenceCheckInterval: NodeJS.Timeout | null = null;
  private silencePolishDone = false;
  private silencePolishInProgress = false;
  private lastPolishedText = '';
  private currentPastedText = '';
  private currentPasteCount = 0;
  private polishResultCallback: ((polished: string, undoCount: number, mode: string) => void) | null = null;
  
  // Metrics tracking
  private metrics = {
    merge: { success: 0, failure: 0, latencies: [] as number[] },
    correct: { success: 0, failure: 0, latencies: [] as number[] },
    polish: { success: 0, failure: 0, latencies: [] as number[] },
    extractNewWords: { success: 0, failure: 0, latencies: [] as number[] },
    silencePolish: { triggered: 0, success: 0, failure: 0, latencies: [] as number[] },
    modelLoadTimes: {
      fast: 0,
      quality: 0,
      deep: 0,
    },
  };
  
  /**
   * Start the LLM server process
   */
  async start(): Promise<void> {
    // Already running
    if (this.process && !this.process.killed && this.isReady) {
      return;
    }
    
    // Already starting
    if (this.startingPromise) {
      return this.startingPromise;
    }
    
    const pythonPath = findPythonPath();
    if (!pythonPath) {
      throw new Error('Python not found. Please install Python 3.9+ via Homebrew.');
    }
    
    // Check if LLM dependencies are installed
    if (!checkLLMInstalled(pythonPath)) {
      console.log('[LLM] Dependencies not installed, will install on first use');
      // Dependencies will be installed by pythonSetup.ts on app launch
    }
    
    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'python', 'llm_server.py')
      : path.join(app.getAppPath(), 'python', 'llm_server.py');
    
    console.log('[LLM Server] Starting persistent server...');
    console.log('[LLM Server] Script:', scriptPath);
    console.log('[LLM Server] Python:', pythonPath);
    
    this.startingPromise = new Promise<void>((resolve, reject) => {
      this.process = spawn(pythonPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          MLX_DISABLE_METAL_WARNINGS: '1',
        },
      });
      
      this.rl = readline.createInterface({
        input: this.process.stdout!,
        crlfDelay: Infinity,
      });
      
      // Log stderr
      this.process.stderr?.on('data', (data) => {
        console.log('[LLM Server]', data.toString().trim());
      });
      
      // Handle process exit
      this.process.on('close', (code) => {
        console.log(`[LLM Server] Process exited with code ${code}`);
        this.cleanup();
      });
      
      this.process.on('error', (err) => {
        console.error('[LLM Server] Process error:', err);
        this.cleanup();
        reject(err);
      });
      
      // Handle responses
      this.rl.on('line', (line) => {
        this.handleResponse(line);
      });
      
      // Set startup timeout
      const timeout = setTimeout(() => {
        if (!this.isReady) {
          this.startingPromise = null;
          reject(new Error('LLM server startup timeout'));
        }
      }, STARTUP_TIMEOUT_MS);
      
      // Wait for ready signal
      const checkReady = () => {
        if (this.isReady) {
          clearTimeout(timeout);
          this.startingPromise = null;
          resolve();
        } else {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });
    
    return this.startingPromise;
  }
  
  /**
   * Handle a response line from the server
   */
  private handleResponse(line: string): void {
    try {
      const response = JSON.parse(line) as LLMResponse;
      
      // Ready signal
      if (response.type === 'ready') {
        this.isReady = true;
        this.fastModelLoaded = true;
        if (response.fast_model_load_time_ms) {
          this.metrics.modelLoadTimes.fast = response.fast_model_load_time_ms;
        }
        console.log('[LLM Server] Ready - fast model loaded');
        return;
      }
      
      // Model loaded signals - MUST return early to avoid matching to pending requests
      if (response.type === 'quality_model_loaded' && response.load_time_ms) {
        this.metrics.modelLoadTimes.quality = response.load_time_ms;
        this.qualityModelLoaded = true;
        console.log(`[LLM Server] Quality model loaded in ${response.load_time_ms}ms`);
        return;
      }
      
      // Deep model (4B) loaded signal - filter out to prevent response queue desync
      if (response.type === 'deep_model_loaded') {
        if (response.load_time_ms) {
          this.metrics.modelLoadTimes.deep = response.load_time_ms;
        }
        console.log(`[LLM Server] Deep model (4B) loaded in ${response.load_time_ms || 'unknown'}ms`);
        return;
      }
      
      // Dispatch to waiting request - only for actual action responses
      const pending = this.responseQueue.shift();
      if (pending) {
        clearTimeout(pending.timeoutId);
        pending.resolve(response);
      }
    } catch (e) {
      console.error('[LLM Server] Failed to parse response:', line);
    }
  }
  
  /**
   * Send a command to the server
   */
  private async send(command: object): Promise<LLMResponse> {
    if (!this.process || !this.isReady) {
      await this.start();
    }
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.responseQueue.findIndex(p => p.resolve === resolve);
        if (idx >= 0) {
          this.responseQueue.splice(idx, 1);
          reject(new Error('LLM request timeout'));
        }
      }, REQUEST_TIMEOUT_MS);
      
      this.responseQueue.push({ resolve, reject, timeoutId });
      
      const line = JSON.stringify(command) + '\n';
      this.process!.stdin!.write(line);
    });
  }
  
  /**
   * Track latency and check if we should skip LLM
   */
  private trackLatency(
    latencies: number[],
    latencyMs: number,
    threshold: number
  ): boolean {
    latencies.push(latencyMs);
    if (latencies.length > LATENCY_HISTORY_SIZE) {
      latencies.shift();
    }
    
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    return avg > threshold * LATENCY_SKIP_MULTIPLIER;
  }
  
  /**
   * Phase 2: Intelligent text merge
   */
  async mergeText(pasted: string, newText: string): Promise<LLMMergeResult> {
    // Check if we should skip due to high latency
    if (this.mergeLatencies.length >= 5) {
      const avg = this.mergeLatencies.reduce((a, b) => a + b, 0) / this.mergeLatencies.length;
      if (avg > LATENCY_THRESHOLD_MERGE * LATENCY_SKIP_MULTIPLIER) {
        console.log('[LLM] Skipping merge due to high latency');
        return { success: false, error: 'Skipped: high latency' };
      }
    }
    
    try {
      const response = await this.send({
        action: 'merge_text',
        pasted,
        new_text: newText,
      });
      
      if (response.type === 'error') {
        return { success: false, error: response.error };
      }
      
      const result: LLMMergeResult = {
        success: true,
        newWords: response.new_words || '',
        inferenceTimeMs: response.inference_time_ms,
        exceededLatency: response.exceeded_latency,
      };
      
      // Track metrics
      this.metrics.merge.success++;
      if (result.inferenceTimeMs) {
        this.metrics.merge.latencies.push(result.inferenceTimeMs);
        if (this.metrics.merge.latencies.length > 100) {
          this.metrics.merge.latencies.shift(); // Keep last 100
        }
        this.trackLatency(this.mergeLatencies, result.inferenceTimeMs, LATENCY_THRESHOLD_MERGE);
      }
      
      return result;
    } catch (err: any) {
      this.metrics.merge.failure++;
      console.error('[LLM Metrics] Merge failed:', err.message);
      return { success: false, error: err.message };
    }
  }
  
  /**
   * Phase 3: Sentence correction
   */
  async correctSentence(original: string, latest: string): Promise<LLMCorrectResult> {
    // Check latency history
    if (this.correctLatencies.length >= 5) {
      const avg = this.correctLatencies.reduce((a, b) => a + b, 0) / this.correctLatencies.length;
      if (avg > LATENCY_THRESHOLD_CORRECT * LATENCY_SKIP_MULTIPLIER) {
        console.log('[LLM] Skipping correction due to high latency');
        return { success: false, error: 'Skipped: high latency' };
      }
    }
    
    try {
      const response = await this.send({
        action: 'correct_sentence',
        original,
        latest,
      });
      
      if (response.type === 'error') {
        return { success: false, error: response.error };
      }
      
      const result: LLMCorrectResult = {
        success: true,
        corrected: response.corrected,
        changed: response.changed,
        inferenceTimeMs: response.inference_time_ms,
        exceededLatency: response.exceeded_latency,
      };
      
      // Track metrics
      this.metrics.correct.success++;
      if (result.inferenceTimeMs) {
        this.metrics.correct.latencies.push(result.inferenceTimeMs);
        if (this.metrics.correct.latencies.length > 100) {
          this.metrics.correct.latencies.shift();
        }
        this.trackLatency(this.correctLatencies, result.inferenceTimeMs, LATENCY_THRESHOLD_CORRECT);
      }
      
      return result;
    } catch (err: any) {
      this.metrics.correct.failure++;
      console.error('[LLM Metrics] Correct failed:', err.message);
      return { success: false, error: err.message };
    }
  }
  
  /**
   * Phase 4: Final polish
   */
  async polishText(
    pastedText: string,
    finalText: string,
    mode: LLMPolishMode = 'clean'
  ): Promise<LLMPolishResult> {
    try {
      const response = await this.send({
        action: 'polish_text',
        pasted_text: pastedText,
        final_text: finalText,
        mode,
      });
      
      if (response.type === 'error') {
        return { success: false, error: response.error };
      }
      
      const result: LLMPolishResult = {
        success: true,
        polished: response.polished,
        mode: response.mode,
        inferenceTimeMs: response.inference_time_ms,
        exceededLatency: response.exceeded_latency,
      };
      
      // Track metrics
      this.metrics.polish.success++;
      if (result.inferenceTimeMs) {
        this.metrics.polish.latencies.push(result.inferenceTimeMs);
        if (this.metrics.polish.latencies.length > 100) {
          this.metrics.polish.latencies.shift();
        }
        this.trackLatency(this.polishLatencies, result.inferenceTimeMs, LATENCY_THRESHOLD_POLISH);
      }
      
      // Track quality model loading
      if (!this.qualityModelLoaded && result.success) {
        this.qualityModelLoaded = true;
        console.log('[LLM Server] Quality model loaded');
      }
      
      return result;
    } catch (err: any) {
      this.metrics.polish.failure++;
      console.error('[LLM Metrics] Polish failed:', err.message);
      return { success: false, error: err.message };
    }
  }
  
  /**
   * Get server status
   */
  async getStatus(): Promise<{
    available: boolean;
    fastModelLoaded: boolean;
    qualityModelLoaded: boolean;
    error?: string;
  }> {
    try {
      if (!this.isReady) {
        await this.start();
      }
      
      const response = await this.send({ action: 'get_status' });
      
      return {
        available: this.isReady,
        fastModelLoaded: response.fast_model_loaded ?? this.fastModelLoaded,
        qualityModelLoaded: response.quality_model_loaded ?? this.qualityModelLoaded,
      };
    } catch (err: any) {
      return {
        available: false,
        fastModelLoaded: false,
        qualityModelLoaded: false,
        error: err.message,
      };
    }
  }
  
  /**
   * Check if server is ready
   */
  isAvailable(): boolean {
    return this.isReady && this.process !== null && !this.process.killed;
  }
  
  /**
   * Get comprehensive metrics
   */
  getMetrics(): {
    merge: { success: number; failure: number; avgLatency: number; p50: number; p95: number; p99: number };
    correct: { success: number; failure: number; avgLatency: number; p50: number; p95: number; p99: number };
    polish: { success: number; failure: number; avgLatency: number; p50: number; p95: number; p99: number };
    extractNewWords: { success: number; failure: number; avgLatency: number; p50: number; p95: number; p99: number };
    silencePolish: { triggered: number; success: number; failure: number; avgLatency: number; p50: number; p95: number; p99: number };
    modelLoadTimes: { fast: number; quality: number; deep: number };
  } {
    const calculatePercentiles = (latencies: number[]): { avg: number; p50: number; p95: number; p99: number } => {
      if (latencies.length === 0) {
        return { avg: 0, p50: 0, p95: 0, p99: 0 };
      }
      const sorted = [...latencies].sort((a, b) => a - b);
      const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
      const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
      return { avg, p50, p95, p99 };
    };
    
    const mergeStats = calculatePercentiles(this.metrics.merge.latencies);
    const correctStats = calculatePercentiles(this.metrics.correct.latencies);
    const polishStats = calculatePercentiles(this.metrics.polish.latencies);
    const extractStats = calculatePercentiles(this.metrics.extractNewWords.latencies);
    const silenceStats = calculatePercentiles(this.metrics.silencePolish.latencies);
    
    return {
      merge: {
        success: this.metrics.merge.success,
        failure: this.metrics.merge.failure,
        avgLatency: mergeStats.avg,
        p50: mergeStats.p50,
        p95: mergeStats.p95,
        p99: mergeStats.p99,
      },
      correct: {
        success: this.metrics.correct.success,
        failure: this.metrics.correct.failure,
        avgLatency: correctStats.avg,
        p50: correctStats.p50,
        p95: correctStats.p95,
        p99: correctStats.p99,
      },
      polish: {
        success: this.metrics.polish.success,
        failure: this.metrics.polish.failure,
        avgLatency: polishStats.avg,
        p50: polishStats.p50,
        p95: polishStats.p95,
        p99: polishStats.p99,
      },
      extractNewWords: {
        success: this.metrics.extractNewWords.success,
        failure: this.metrics.extractNewWords.failure,
        avgLatency: extractStats.avg,
        p50: extractStats.p50,
        p95: extractStats.p95,
        p99: extractStats.p99,
      },
      silencePolish: {
        triggered: this.metrics.silencePolish.triggered,
        success: this.metrics.silencePolish.success,
        failure: this.metrics.silencePolish.failure,
        avgLatency: silenceStats.avg,
        p50: silenceStats.p50,
        p95: silenceStats.p95,
        p99: silenceStats.p99,
      },
      modelLoadTimes: this.metrics.modelLoadTimes,
    };
  }
  
  /**
   * Extract new words from tail (for rolling window recovery)
   */
  async extractNewWords(pastedEnd: string, tailWords: string): Promise<{ success: boolean; newWords?: string; error?: string; inferenceTimeMs?: number }> {
    // Check latency history
    if (this.extractNewWordsLatencies.length >= 5) {
      const avg = this.extractNewWordsLatencies.reduce((a, b) => a + b, 0) / this.extractNewWordsLatencies.length;
      if (avg > LATENCY_THRESHOLD_MERGE * LATENCY_SKIP_MULTIPLIER) {
        console.log('[LLM] Skipping extractNewWords due to high latency');
        return { success: false, error: 'Skipped: high latency' };
      }
    }
    
    try {
      const response = await this.send({
        action: 'extract_new_words',
        pasted_end: pastedEnd,
        tail_words: tailWords,
      });
      
      if (response.type === 'error') {
        this.metrics.extractNewWords.failure++;
        return { success: false, error: response.error };
      }
      
      const result = {
        success: true,
        newWords: response.new_words || '',
        inferenceTimeMs: response.inference_time_ms,
      };
      
      // Track metrics
      this.metrics.extractNewWords.success++;
      if (result.inferenceTimeMs) {
        this.metrics.extractNewWords.latencies.push(result.inferenceTimeMs);
        if (this.metrics.extractNewWords.latencies.length > 100) {
          this.metrics.extractNewWords.latencies.shift();
        }
        this.trackLatency(this.extractNewWordsLatencies, result.inferenceTimeMs, LATENCY_THRESHOLD_MERGE);
      }
      
      return result;
    } catch (err: any) {
      this.metrics.extractNewWords.failure++;
      console.error('[LLM Metrics] ExtractNewWords failed:', err.message);
      return { success: false, error: err.message };
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // SILENCE POLISH - BE-Driven (Single Source of Truth)
  // ═══════════════════════════════════════════════════════════════════════════════
  
  /**
   * Mark speech as detected (called when user is speaking)
   * Resets the silence timer and allows Silence Polish to re-trigger.
   */
  onSpeechDetected(): void {
    const now = Date.now();
    const timeSinceLast = now - this.lastSpeechTime;
    this.lastSpeechTime = now;
    
    // Reset silence polish flag so it can trigger again after next silence
    this.silencePolishDone = false;
    
    // Log periodically (not every call to avoid spam)
    if (timeSinceLast > 1000) {
      console.log(`[LLM Silence] Speech detected (gap=${timeSinceLast}ms)`);
    }
  }
  
  /**
   * Update the current pasted text state (called by FE after each paste)
   * This keeps BE in sync with what text is currently in the document.
   */
  updatePastedText(text: string, pasteCount: number): void {
    this.currentPastedText = text;
    this.currentPasteCount = pasteCount;
  }
  
  /**
   * Start silence monitoring for a recording session.
   * Call this when recording starts.
   * 
   * @param onPolishResult - Callback when polish completes (polished text, undo count, mode)
   */
  startSilenceMonitoring(
    onPolishResult: (polished: string, undoCount: number, mode: string) => void
  ): void {
    // Stop any existing monitoring
    this.stopSilenceMonitoring();
    
    // Reset state
    this.silencePolishDone = false;
    this.silencePolishInProgress = false;
    this.lastPolishedText = '';
    this.currentPastedText = '';
    this.currentPasteCount = 0;
    this.lastSpeechTime = Date.now();
    this.polishResultCallback = onPolishResult;
    
    console.log('[LLM Silence] Started silence monitoring');
    
    // Start periodic silence check
    this.silenceCheckInterval = setInterval(() => {
      this.checkAndTriggerSilencePolish();
    }, SILENCE_CHECK_INTERVAL_MS);
  }
  
  /**
   * Stop silence monitoring.
   * Call this when recording stops.
   */
  stopSilenceMonitoring(): void {
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval);
      this.silenceCheckInterval = null;
      console.log('[LLM Silence] Stopped silence monitoring');
    }
    this.polishResultCallback = null;
  }
  
  /**
   * Check if silence threshold is met and trigger polish if so.
   * Called periodically by the silence check interval.
   */
  private checkAndTriggerSilencePolish(): void {
    const now = Date.now();
    const silenceDuration = now - this.lastSpeechTime;
    
    // Log approaching threshold for debugging
    if (silenceDuration >= 4000 && silenceDuration < 4800) {
      console.log(`[LLM Silence] Approaching threshold: ${silenceDuration}ms, done=${this.silencePolishDone}, inProgress=${this.silencePolishInProgress}, textLen=${this.currentPastedText.length}`);
    }
    
    // Check all conditions
    const shouldTrigger = 
      silenceDuration >= SILENCE_POLISH_THRESHOLD_MS &&
      !this.silencePolishDone &&
      !this.silencePolishInProgress &&
      this.currentPastedText.length >= MIN_TEXT_LENGTH_FOR_POLISH &&
      this.currentPastedText !== this.lastPolishedText;
    
    if (shouldTrigger) {
      console.log(`[LLM Silence] Triggering polish after ${silenceDuration}ms silence`);
      this.triggerSilencePolish();
    }
  }
  
  /**
   * Trigger the actual polish operation.
   */
  private async triggerSilencePolish(): Promise<void> {
    this.silencePolishInProgress = true;
    this.silencePolishDone = true;
    this.metrics.silencePolish.triggered++;
    
    const textToPolish = this.currentPastedText;
    const undoCount = this.currentPasteCount;
    const startTime = Date.now();
    
    try {
      // Use 'clean' mode for silence polish (removes fillers, formats lists)
      const result = await this.polishText(textToPolish, textToPolish, 'clean');
      
      const latency = Date.now() - startTime;
      this.metrics.silencePolish.latencies.push(latency);
      if (this.metrics.silencePolish.latencies.length > 100) {
        this.metrics.silencePolish.latencies.shift();
      }
      
      // Check if speech resumed during polish (abort)
      const silenceDuration = Date.now() - this.lastSpeechTime;
      if (silenceDuration < SILENCE_POLISH_THRESHOLD_MS) {
        console.log('[LLM Silence] Speech resumed during polish - discarding result');
        this.silencePolishDone = false; // Allow re-trigger
        return;
      }
      
      // Debug: Log comparison details with FULL INPUT visibility
      const polishedLen = result.polished?.length || 0;
      const originalLen = textToPolish.length;
      const areEqual = result.polished === textToPolish;
      const inputWords = textToPolish.split(/\s+/).length;
      const outputWords = result.polished?.split(/\s+/).length || 0;
      const wordRatio = inputWords > 0 ? (outputWords / inputWords).toFixed(2) : '0';
      
      // LOG INPUT for debugging garbage outputs
      console.log(`[LLM Silence] INPUT (first 300 chars): ${textToPolish.substring(0, 300)}`);
      console.log(`[LLM Silence] Compare: success=${result.success}, inputWords=${inputWords}, outputWords=${outputWords}, wordRatio=${wordRatio}`);
      
      // QUALITY CHECK: Flag suspicious reductions (>40% word loss is suspicious for clean mode)
      if (result.success && result.polished && outputWords < inputWords * 0.5) {
        console.warn(`[LLM Silence] ⚠️ SUSPICIOUS: Output lost ${Math.round((1 - outputWords/inputWords) * 100)}% of words - possible garbage output!`);
      }
      
      if (result.success && result.polished && result.polished !== textToPolish) {
        this.lastPolishedText = result.polished;
        this.metrics.silencePolish.success++;
        
        console.log(`[LLM Silence] Polish complete in ${latency}ms, pushing to FE`);
        console.log(`[LLM Silence] OUTPUT (first 300 chars): ${result.polished.substring(0, 300)}`);
        
        // Push result to frontend via callback
        if (this.polishResultCallback) {
          this.polishResultCallback(result.polished, undoCount, 'clean');
        }
      } else if (result.success) {
        // No changes needed - but log why
        console.log('[LLM Silence] No changes needed');
        console.log(`[LLM Silence] Debug: polished truthy=${!!result.polished}, different=${result.polished !== textToPolish}`);
      } else {
        this.metrics.silencePolish.failure++;
        console.warn('[LLM Silence] Polish failed:', result.error);
      }
    } catch (err: any) {
      this.metrics.silencePolish.failure++;
      console.error('[LLM Silence] Polish error:', err.message);
    } finally {
      this.silencePolishInProgress = false;
    }
  }
  
  /**
   * Get silence polish status for debugging
   */
  getSilencePolishStatus(): {
    monitoring: boolean;
    silenceDuration: number;
    done: boolean;
    inProgress: boolean;
    textLength: number;
  } {
    return {
      monitoring: this.silenceCheckInterval !== null,
      silenceDuration: Date.now() - this.lastSpeechTime,
      done: this.silencePolishDone,
      inProgress: this.silencePolishInProgress,
      textLength: this.currentPastedText.length,
    };
  }
  
  /**
   * Cleanup on shutdown
   */
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
    this.startingPromise = null;
  }
  
  /**
   * Stop the server
   */
  stop(): void {
    if (this.process) {
      console.log('[LLM Server] Stopping...');
      
      // Try graceful shutdown
      try {
        this.process.stdin?.write(JSON.stringify({ action: 'quit' }) + '\n');
      } catch {
        // Ignore
      }
      
      // Force kill after timeout
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGTERM');
          setTimeout(() => {
            if (this.process && !this.process.killed) {
              this.process.kill('SIGKILL');
            }
          }, 2000);
        }
      }, 1000);
    }
    
    this.cleanup();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

/** Global LLM server instance */
export const llmServer = new LLMServer();

/**
 * Pre-start the LLM server (call during app startup for faster first use)
 */
export async function preStartLLMServer(): Promise<void> {
  try {
    await llmServer.start();
    console.log('[LLM] Server pre-started successfully');
  } catch (err) {
    console.warn('[LLM] Failed to pre-start server (will retry on first use):', err);
  }
}

/**
 * Shutdown the LLM server (call during app quit)
 */
export function shutdownLLMServer(): void {
  llmServer.stop();
}
