/**
 * Shared types between main and renderer processes
 */

export interface TTSRequest {
  text: string;
  voice: string;
  speed: number;
  useLocal: boolean;
}

export interface TTSResult {
  success: boolean;
  audioPath?: string;
  audioData?: ArrayBuffer;
  error?: string;
}

export interface STTRequest {
  audioPath: string;
}

export interface STTResult {
  success: boolean;
  transcription?: string;
  error?: string;
  // Performance stats
  audio_duration_ms?: number;
  inference_time_ms?: number;
  processing_time_ms?: number;
  realtime_factor?: number;
  model?: string;
}

/**
 * Result from chunk-and-commit transcription.
 * 
 * Architecture:
 * - committed_text: Finalized text that will never change (append-only)
 * - partial_text: Current in-progress transcription (may change)
 * - is_final: True when a new chunk was just committed
 */
export interface ChunkedSTTResult {
  success: boolean;
  committed_text: string;      // Immutable, append-only
  partial_text: string;        // May change between calls
  is_final: boolean;           // True = new commit just happened
  commit_sample: number;       // Sample position of last commit
  commit_reason?: 'pause' | 'force';  // Why commit happened
  error?: string;
  // Performance stats
  audio_duration_ms?: number;
  inference_time_ms?: number;
}

export interface ModelCheckResult {
  available: boolean;
  error?: string;
  warning?: string;  // e.g., "ffmpeg not installed - STT won't work"
  ffmpegAvailable?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LLM TYPES - Qwen3 Text Processing for Live Paste Enhancement
// ═══════════════════════════════════════════════════════════════════════════════
// 
// The LLM enhances Live Paste in three phases:
// - Phase 2: Intelligent merge when anchor detection fails
// - Phase 3: Rolling sentence correction during speech
// - Phase 4: Final polish when recording stops
// 
// See python/llm_server.py for detailed documentation.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Phase 2: Intelligent text merge result
 * Called when heuristic anchor detection fails during Live Paste
 */
export interface LLMMergeResult {
  success: boolean;
  newWords?: string;          // Words to append (empty if nothing new)
  inferenceTimeMs?: number;   // Latency for monitoring
  exceededLatency?: boolean;  // True if >100ms (should use fallback next time)
  error?: string;
}

/**
 * Phase 3: Sentence correction result
 * Called during rolling correction while user speaks
 */
export interface LLMCorrectResult {
  success: boolean;
  corrected?: string;         // The corrected sentence
  changed?: boolean;          // Whether any changes were made
  inferenceTimeMs?: number;
  exceededLatency?: boolean;  // True if >200ms
  error?: string;
}

/**
 * Phase 4: Final polish result
 * Called when recording stops
 */
export interface LLMPolishResult {
  success: boolean;
  polished?: string;          // The polished full text
  mode?: 'verbatim' | 'clean' | 'professional';
  inferenceTimeMs?: number;
  exceededLatency?: boolean;  // True if >1000ms
  error?: string;
}

/**
 * Extract new words result (for rolling window recovery)
 * Called when rolling window recovery needs to extract only truly new words
 */
export interface LLMExtractNewWordsResult {
  success: boolean;
  newWords?: string;          // Words to append (empty if nothing new)
  inferenceTimeMs?: number;   // Latency for monitoring
  exceededLatency?: boolean;  // True if >100ms
  error?: string;
}

/**
 * Silence polish result (pushed from BE when 5s+ silence detected)
 */
export interface LLMSilencePolishResult {
  polished: string;           // Polished text
  undoCount: number;          // Number of undo operations to clear previous pastes
  mode: string;               // Polish mode used (e.g., 'clean')
}

/**
 * LLM polish modes for user preference
 * 
 * - verbatim: Minimal cleanup, keep filler words (legal, medical, interviews)
 * - clean: Remove filler words, fix punctuation (casual dictation)
 * - professional: Full grammar and style polish (business writing)
 */
export type LLMPolishMode = 'verbatim' | 'clean' | 'professional';

export interface AudioPlayRequest {
  path: string;
}

export interface AudioPlayResult {
  success: boolean;
  error?: string;
}

// IPC Channel definitions
export interface IpcChannels {
  'tts:synthesize': {
    request: TTSRequest;
    response: TTSResult;
  };
  'stt:start-recording': {
    request: Record<string, never>;
    response: { audioPath: string };
  };
  'stt:stop-recording': {
    request: Record<string, never>;
    response: STTResult;
  };
  'models:check': {
    request: Record<string, never>;
    response: ModelCheckResult;
  };
  'audio:play': {
    request: AudioPlayRequest;
    response: AudioPlayResult;
  };
  'audio:stop': {
    request: Record<string, never>;
    response: { success: boolean };
  };
}

// Streaming chunk info (legacy)
export interface StreamChunk {
  dataUrl: string;
  chunkIndex: number;
  totalChunks: number;
  duration: number;
  text: string;
}

// Realtime streaming chunk info
export interface RealtimeChunk {
  dataUrl: string;
  chunkIndex: number;
  duration: number;
  textHint: string;
}

// Window API exposed to renderer
export interface OutloudAPI {
  tts: {
    synthesize: (request: TTSRequest) => Promise<TTSResult>;
    synthesizeStream: (request: TTSRequest) => Promise<{ success: boolean; error?: string }>;
    // Realtime streaming - fastest possible, sentence-by-sentence
    synthesizeRealtime: (request: TTSRequest) => Promise<{ success: boolean; error?: string }>;
    // Legacy streaming callbacks
    onStreamChunk: (callback: (chunk: StreamChunk) => void) => void;
    onStreamComplete: (callback: (info: { totalChunks: number }) => void) => void;
    onStreamError: (callback: (error: { error: string }) => void) => void;
    // Realtime streaming callbacks
    onRealtimeChunk: (callback: (chunk: RealtimeChunk) => void) => void;
    onRealtimeComplete: (callback: (info: { totalChunks: number; totalDuration: number }) => void) => void;
    onRealtimeError: (callback: (error: { error: string }) => void) => void;
  };
  stt: {
    transcribe: (audioData: ArrayBuffer) => Promise<STTResult>;
    getModels: () => Promise<{
      success: boolean;
      models?: Array<{
        id: string;
        name: string;
        description: string;
        size_mb: number;
        installed: boolean;
        loaded: boolean;
        active: boolean;
      }>;
      currentModel?: string;
      error?: string;
    }>;
    setModel: (modelId: string) => Promise<{
      success: boolean;
      currentModel?: string;
      error?: string;
    }>;
    installParakeet: () => Promise<{
      success: boolean;
      error?: string;
    }>;
    onInstallProgress: (callback: (message: string) => void) => (() => void);
    // Warmup: Pre-compile MLX kernels
    warmup: (modelId?: string) => Promise<{
      success: boolean;
      model?: string;
      warmupTimeMs?: number;
      error?: string;
    }>;
    // Streaming transcription
    streamStart: () => Promise<{ success: boolean; sessionId?: string; error?: string }>;
    streamChunk: (pcmData: ArrayBuffer) => Promise<{ success: boolean; samples?: number; error?: string }>;
    streamEnd: () => Promise<STTResult & { sessionId?: string }>;
    onPartialResult: (callback: (data: { 
      text: string;  // Legacy: full transcription
      isFinal: boolean; 
      sessionId: string;
      // Chunk-and-commit fields (new):
      committedText?: string;   // Immutable committed text
      partialText?: string;     // In-progress text (may change)
      isCommit?: boolean;       // True when new chunk was just committed
      transcriptionCount?: number;
    }) => void) => (() => void);
  };
  audio: {
    play: (path: string) => Promise<AudioPlayResult>;
    stop: () => Promise<{ success: boolean }>;
    onPlayFile: (callback: (path: string) => void) => void;
  };
  models: {
    check: () => Promise<ModelCheckResult>;
  };
  window: {
    resize: (width: number, height: number) => Promise<void>;
    hide: () => Promise<void>;
    show: () => Promise<void>;
    toggleDevTools: () => Promise<boolean>;
    openKeyboardSettings: () => Promise<boolean>;
    openAccessibilitySettings: () => Promise<boolean>;
    startDrag: () => Promise<{ startX: number; startY: number; winX: number; winY: number } | null>;
    dragMove: (deltaX: number, deltaY: number) => Promise<void>;
  };
  dictation: {
    setMode: (mode: 'toggle' | 'hold') => Promise<{ success: boolean; mode: string }>;
    onHoldStart: (callback: () => void) => (() => void) | undefined;
    onHoldStop: (callback: () => void) => (() => void) | undefined;
  };
  shortcuts: {
    onReadSelection: (callback: () => void) => void;
    onVoiceDictation: (callback: () => void) => void;
    onPauseAudio: (callback: () => void) => void;
    onTestTTS: (callback: () => void) => void;
  };
  text: {
    getSelection: () => Promise<{ success: boolean; text?: string; error?: string }>;
    inject: (text: string, options?: { autoSend?: boolean }) => Promise<{ success: boolean; error?: string }>;
    livePaste: (data: { text: string; previousLength: number }) => Promise<{ success: boolean; pastedLength?: number; method?: string; error?: string }>;
    livePasteClear: () => Promise<{ success: boolean; error?: string }>;
    livePasteEnter: () => Promise<{ success: boolean; error?: string }>;
    // Final reconciliation: select pasted text and replace with correct text
    correctLivePaste: (data: { charsToReplace: number; correctText: string }) => Promise<{ success: boolean; error?: string }>;
    // Final reconciliation using undo: undo all pastes then paste corrected text
    undoAndReplace: (data: { undoCount: number; correctText: string }) => Promise<{ success: boolean; error?: string }>;
    // PHASE 3: Rolling sentence correction - correct a specific sentence during recording
    correctSentence: (data: { sentenceIndex: number; oldText: string; newText: string }) => Promise<{ success: boolean; skipped?: boolean; deferred?: boolean; error?: string }>;
  };
  inputMethod: {
    getStatus: () => Promise<{ installed: boolean; enabled: boolean; bundleExists: boolean }>;
    install: () => Promise<{ success: boolean; error?: string }>;
    openSettings: () => Promise<{ success: boolean }>;
  };
  inputSource: {
    getCurrent: () => Promise<{ success: boolean; sourceId?: string; error?: string }>;
    switchTo: (sourceId: string) => Promise<{ success: boolean; error?: string }>;
    switchToOutloud: () => Promise<{ success: boolean; error?: string }>;
  };
  settings: {
    getAll: () => Promise<AppSettings>;
    set: (key: string, value: any) => Promise<{ success: boolean }>;
    onUpdate: (callback: (key: string, value: any) => void) => (() => void) | undefined;
  };
  onSetupProgress: (callback: (message: string) => void) => void;
  
  // ═══════════════════════════════════════════════════════════════════════════
  // LLM API - Qwen3 Text Processing for Live Paste Enhancement
  // ═══════════════════════════════════════════════════════════════════════════
  // 
  // Provides intelligent text processing to enhance Live Paste accuracy.
  // Uses Qwen3-0.6B (fast) for real-time operations and Qwen3-1.7B (quality)
  // for final polish. All processing happens locally on Apple Silicon.
  // 
  // See python/llm_server.py for detailed documentation on each phase.
  // ═══════════════════════════════════════════════════════════════════════════
  llm?: {
    /**
     * Check if LLM is available and ready
     */
    getStatus: () => Promise<{
      available: boolean;
      fastModelLoaded: boolean;
      qualityModelLoaded: boolean;
      error?: string;
    }>;
    
    /**
     * Phase 2: Intelligent text merge
     * Called when heuristic anchor detection fails during Live Paste.
     * 
     * @param pasted - Text already pasted to target application
     * @param newText - Latest transcription from STT
     * @returns Words to append (empty if nothing new)
     * 
     * Edge cases handled:
     * - Punctuation changes: "Hello world" vs "Hello, world"
     * - Contractions: "I am" vs "I'm"
     * - Rolling window truncation
     * - STT revisions of earlier words
     */
    mergeText: (pasted: string, newText: string) => Promise<LLMMergeResult>;
    
    /**
     * Phase 3: Rolling sentence correction
     * Called during speech to correct previous sentences silently.
     * 
     * @param original - Sentence as it was pasted
     * @param latest - Latest version from STT
     * @returns Corrected sentence
     * 
     * Corrections made:
     * - Grammar fixes
     * - Stuttering removal ("I I I" → "I")
     * - Punctuation standardization
     * - Transcription artifacts
     */
    correctSentence: (original: string, latest: string) => Promise<LLMCorrectResult>;
    
    /**
     * Phase 4: Final text polish
     * Called when recording stops for full cleanup.
     * 
     * @param pastedText - What was live-pasted during dictation
     * @param finalText - Final transcription from full audio
     * @param mode - "verbatim" | "clean" | "professional"
     * @returns Polished text
     * 
     * Modes:
     * - verbatim: Minimal cleanup, keep filler words
     * - clean: Remove filler words, fix punctuation
     * - professional: Full grammar and style polish
     */
    polishText: (pastedText: string, finalText: string, mode?: LLMPolishMode) => Promise<LLMPolishResult>;
    
    /**
     * Extract new words (for rolling window recovery)
     * Called when rolling window recovery needs to extract only truly new words
     * 
     * @param pastedEnd - The end of text already pasted (last ~50 characters)
     * @param tailWords - New words that might be appended
     * @returns Only the words from tailWords that are NOT already at the end of pastedEnd
     */
    extractNewWords: (pastedEnd: string, tailWords: string) => Promise<LLMExtractNewWordsResult>;
    
    /**
     * Get comprehensive metrics
     * Returns success/failure counts, latency percentiles, and model load times
     */
    getMetrics: () => Promise<{
      merge: { success: number; failure: number; avgLatency: number; p50: number; p95: number; p99: number };
      correct: { success: number; failure: number; avgLatency: number; p50: number; p95: number; p99: number };
      polish: { success: number; failure: number; avgLatency: number; p50: number; p95: number; p99: number };
      extractNewWords: { success: number; failure: number; avgLatency: number; p50: number; p95: number; p99: number };
      silencePolish: { triggered: number; success: number; failure: number; avgLatency: number; p50: number; p95: number; p99: number };
      modelLoadTimes: { fast: number; quality: number };
    }>;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SILENCE POLISH - BE-Driven Silence Detection
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Notify that speech/transcription activity detected (resets BE silence timer)
     * Call when meaningful transcription activity happens
     */
    notifySpeechDetected: () => void;
    
    /**
     * Update pasted text state (keeps BE in sync with FE)
     * Call after each paste operation
     */
    updatePastedText: (text: string, pasteCount: number) => void;
    
    /**
     * Start BE-driven silence monitoring (call when recording starts)
     * BE will push polish results when 5s+ silence detected
     */
    startSilenceMonitoring: () => void;
    
    /**
     * Stop BE-driven silence monitoring (call when recording stops)
     */
    stopSilenceMonitoring: () => void;
    
    /**
     * Listen for BE-pushed silence polish results
     */
    onSilencePolishResult: (callback: (result: LLMSilencePolishResult) => void) => () => void;
    
    /**
     * Get silence polish status (for debugging)
     */
    getSilencePolishStatus: () => Promise<{
      monitoring: boolean;
      silenceDuration: number;
      done: boolean;
      inProgress: boolean;
      textLength: number;
    }>;
  };
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Test Capture API - End-to-End Testing
  // ═══════════════════════════════════════════════════════════════════════════
  testCapture?: {
    startCapture: () => Promise<{ success: boolean; message: string }>;
    stopCapture: () => Promise<{
      success: boolean;
      summary: {
        totalEvents: number;
        silencePolishCount: number;
        finalPolishCount: number;
        finalOutput: string;
        duplicateCount: number;
        duplicates: string[];
      };
      events: Array<{
        timestamp: string;
        type: string;
        text: string;
        delta: string;
        previousLength: number;
        totalPasted: string;
        success: boolean;
      }>;
    }>;
    getEvents: () => Promise<{
      events: Array<any>;
      active: boolean;
    }>;
    recordPaste: (data: {
      type: 'live-paste' | 'silence-polish' | 'final-polish' | 'correct-paste';
      text: string;
      delta: string;
      previousLength: number;
      totalPasted: string;
      success: boolean;
    }) => void;
    
    // Test event listeners for integration tests
    onInjectSpeech: (callback: (data: { text: string }) => void) => () => void;
    onStopRecording: (callback: () => void) => () => void;
  };
}

export interface AppSettings {
  playbackSpeed: number;
  dictationMode: 'toggle' | 'hold';
  launchAtLogin: boolean;
  setupComplete: boolean;
  pythonPath: string | null;
  // Streaming STT settings
  showLivePreview: boolean;
  livePasteMode: boolean;
  autoSendAfterDictation: boolean;
  
  // ═══════════════════════════════════════════════════════════════════════════
  // LLM SETTINGS - Qwen3 Text Enhancement for Live Paste
  // ═══════════════════════════════════════════════════════════════════════════
  // 
  // These settings control the AI-powered text enhancement features.
  // When disabled, Live Paste uses heuristic-only processing (still works well).
  // 
  // Phase 2: Intelligent merge - helps when anchor detection fails
  // Phase 3: Rolling correction - cleans up previous sentences during speech
  // Phase 4: Final polish - full cleanup when recording stops
  // ═══════════════════════════════════════════════════════════════════════════
  
  /** Enable AI-enhanced Live Paste (uses Qwen3 LLM locally) */
  llmEnabled: boolean;
  
  /** 
   * Polish mode for final cleanup:
   * - verbatim: Keep filler words, minimal changes (legal/medical)
   * - clean: Remove filler words, fix punctuation (default)
   * - professional: Full grammar and style polish (business writing)
   */
  llmPolishMode: LLMPolishMode;
  
  /** Remove filler words like "um", "uh", "like" */
  llmRemoveFillerWords: boolean;
  
  /** Enable rolling sentence correction during speech */
  llmRollingCorrection: boolean;
}

declare global {
  interface Window {
    outloud: OutloudAPI;
  }
}

