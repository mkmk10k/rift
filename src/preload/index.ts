import { contextBridge, ipcRenderer } from 'electron';
import type { OutloudAPI, TTSRequest, AudioPlayRequest } from '../shared/types';

/**
 * Preload script - safely exposes IPC APIs to the renderer process
 */

const outloudAPI: OutloudAPI = {
  tts: {
    synthesize: (request: TTSRequest) => 
      ipcRenderer.invoke('tts:synthesize', request),
    synthesizeStream: (request: TTSRequest) =>
      ipcRenderer.invoke('tts:synthesize-stream', request),
    // Realtime streaming - fastest possible, sentence-by-sentence
    synthesizeRealtime: (request: TTSRequest) =>
      ipcRenderer.invoke('tts:synthesize-realtime', request),
    onStreamChunk: (callback: (chunk: any) => void) => {
      ipcRenderer.removeAllListeners('audio:stream-chunk');
      ipcRenderer.on('audio:stream-chunk', (_event, chunk) => callback(chunk));
    },
    onStreamComplete: (callback: (info: any) => void) => {
      ipcRenderer.removeAllListeners('audio:stream-complete');
      ipcRenderer.on('audio:stream-complete', (_event, info) => callback(info));
    },
    onStreamError: (callback: (error: any) => void) => {
      ipcRenderer.removeAllListeners('audio:stream-error');
      ipcRenderer.on('audio:stream-error', (_event, error) => callback(error));
    },
    // Realtime streaming callbacks
    onRealtimeChunk: (callback: (chunk: any) => void) => {
      ipcRenderer.removeAllListeners('audio:realtime-chunk');
      ipcRenderer.on('audio:realtime-chunk', (_event, chunk) => callback(chunk));
    },
    onRealtimeComplete: (callback: (info: any) => void) => {
      ipcRenderer.removeAllListeners('audio:realtime-complete');
      ipcRenderer.on('audio:realtime-complete', (_event, info) => callback(info));
    },
    onRealtimeError: (callback: (error: any) => void) => {
      ipcRenderer.removeAllListeners('audio:realtime-error');
      ipcRenderer.on('audio:realtime-error', (_event, error) => callback(error));
    },
  },
  stt: {
    transcribe: (audioData: ArrayBuffer) => 
      ipcRenderer.invoke('stt:transcribe', audioData),
    getModels: () =>
      ipcRenderer.invoke('stt:get-models'),
    setModel: (modelId: string) =>
      ipcRenderer.invoke('stt:set-model', modelId),
    installParakeet: () =>
      ipcRenderer.invoke('stt:install-parakeet'),
    onInstallProgress: (callback: (message: string) => void) => {
      const handler = (_event: any, message: string) => callback(message);
      ipcRenderer.on('stt:install-progress', handler);
      return () => ipcRenderer.removeListener('stt:install-progress', handler);
    },
    // Warmup: Pre-compile MLX kernels for faster first inference
    warmup: (modelId?: string) =>
      ipcRenderer.invoke('stt:warmup', modelId),
    // Streaming: Start a streaming session
    streamStart: () =>
      ipcRenderer.invoke('stt:stream-start'),
    // Streaming: Send a chunk of PCM audio
    streamChunk: (pcmData: ArrayBuffer) =>
      ipcRenderer.invoke('stt:stream-chunk', pcmData),
    // Streaming: End session and get final transcription
    streamEnd: () =>
      ipcRenderer.invoke('stt:stream-end'),
    // Streaming: Listen for partial transcription results
    onPartialResult: (callback: (data: { text: string; isFinal: boolean; sessionId: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('stt:partial-result', handler);
      return () => ipcRenderer.removeListener('stt:partial-result', handler);
    },
  },
  audio: {
    play: (path: string) => 
      ipcRenderer.invoke('audio:play', { path } as AudioPlayRequest),
    stop: () => 
      ipcRenderer.invoke('audio:stop'),
    onPlayFile: (callback: (path: string) => void) => {
      // Remove any existing listeners to prevent duplicates
      ipcRenderer.removeAllListeners('audio:play-file');
      ipcRenderer.on('audio:play-file', (_event, path: string) => callback(path));
    },
  },
  shortcuts: {
    onReadSelection: (callback: () => void) => {
      // Remove any existing listeners to prevent duplicates
      ipcRenderer.removeAllListeners('shortcut:read-selection');
      ipcRenderer.on('shortcut:read-selection', () => callback());
    },
    onVoiceDictation: (callback: () => void) => {
      // Remove any existing listeners to prevent duplicates
      ipcRenderer.removeAllListeners('shortcut:voice-dictation');
      ipcRenderer.on('shortcut:voice-dictation', () => callback());
    },
    onPauseAudio: (callback: () => void) => {
      ipcRenderer.removeAllListeners('shortcut:pause-audio');
      ipcRenderer.on('shortcut:pause-audio', () => callback());
    },
    onTestTTS: (callback: () => void) => {
      ipcRenderer.removeAllListeners('action:test-tts');
      ipcRenderer.on('action:test-tts', () => callback());
    },
  },
  text: {
    getSelection: () =>
      ipcRenderer.invoke('text:get-selection'),
    inject: (text: string, options?: { autoSend?: boolean }) =>
      ipcRenderer.invoke('text:inject', text, options),
    livePaste: (data: { text: string; previousLength: number }) =>
      ipcRenderer.invoke('text:live-paste', data),
    livePasteClear: () =>
      ipcRenderer.invoke('text:live-paste-clear'),
    livePasteEnter: () =>
      ipcRenderer.invoke('text:live-paste-enter'),
    // Final reconciliation: select pasted text and replace with correct text
    correctLivePaste: (data: { charsToReplace: number; correctText: string }) =>
      ipcRenderer.invoke('text:correct-live-paste', data),
    // Final reconciliation using undo: undo all pastes then paste corrected text
    // More reliable than character-by-character selection for large texts
    undoAndReplace: (data: { undoCount: number; correctText: string }) =>
      ipcRenderer.invoke('text:undo-and-replace', data),
    // PHASE 3: Rolling sentence correction - correct a specific sentence during recording
    correctSentence: (data: { sentenceIndex: number; oldText: string; newText: string }) =>
      ipcRenderer.invoke('text:correct-sentence', data),
  },
  inputMethod: {
    getStatus: () =>
      ipcRenderer.invoke('input-method:status'),
    install: () =>
      ipcRenderer.invoke('input-method:install'),
    openSettings: () =>
      ipcRenderer.invoke('input-method:open-settings'),
  },
  inputSource: {
    getCurrent: () =>
      ipcRenderer.invoke('input-source:get-current'),
    switchTo: (sourceId: string) =>
      ipcRenderer.invoke('input-source:switch-to', sourceId),
    switchToOutloud: () =>
      ipcRenderer.invoke('input-source:switch-to-outloud'),
  },
  models: {
    check: () => 
      ipcRenderer.invoke('models:check'),
  },
  window: {
    resize: (width: number, height: number) => 
      ipcRenderer.invoke('window:resize', width, height),
    hide: () =>
      ipcRenderer.invoke('window:hide'),
    show: () =>
      ipcRenderer.invoke('window:show'),
    toggleDevTools: () =>
      ipcRenderer.invoke('window:toggle-devtools'),
    openKeyboardSettings: () =>
      ipcRenderer.invoke('window:open-keyboard-settings'),
    openAccessibilitySettings: () =>
      ipcRenderer.invoke('window:open-accessibility-settings'),
    // Programmatic dragging for transparent windows
    startDrag: () =>
      ipcRenderer.invoke('window:start-drag'),
    dragMove: (deltaX: number, deltaY: number) =>
      ipcRenderer.invoke('window:drag-move', deltaX, deltaY),
  },
  dictation: {
    setMode: (mode: 'toggle' | 'hold') =>
      ipcRenderer.invoke('dictation:set-mode', mode),
    onHoldStart: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('hold-to-talk:start', handler);
      // Return cleanup function
      return () => ipcRenderer.removeListener('hold-to-talk:start', handler);
    },
    onHoldStop: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('hold-to-talk:stop', handler);
      // Return cleanup function
      return () => ipcRenderer.removeListener('hold-to-talk:stop', handler);
    },
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:get-all'),
    set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
    onUpdate: (callback: (key: string, value: any) => void) => {
      const handler = (_event: any, key: string, value: any) => callback(key, value);
      ipcRenderer.on('settings:updated', handler);
      return () => ipcRenderer.removeListener('settings:updated', handler);
    },
  },
  onSetupProgress: (callback: (message: string) => void) => {
    ipcRenderer.on('setup:progress', (_event, message) => callback(message));
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // LLM API - Qwen3 Text Processing for Live Paste Enhancement
  // ═══════════════════════════════════════════════════════════════════════════
  // 
  // Provides intelligent text processing to enhance Live Paste accuracy.
  // Phase 2: Intelligent merge when anchor detection fails
  // Phase 3: Rolling sentence correction during speech
  // Phase 4: Final polish when recording stops
  // 
  // See python/llm_server.py for detailed documentation.
  // ═══════════════════════════════════════════════════════════════════════════
  llm: {
    // Get LLM status (available, models loaded)
    getStatus: () => ipcRenderer.invoke('llm:status'),
    
    // Phase 2: Intelligent text merge
    // Called when heuristic anchor detection fails during Live Paste
    mergeText: (pasted: string, newText: string) => 
      ipcRenderer.invoke('llm:merge-text', pasted, newText),
    
    // Phase 3: Rolling sentence correction
    // Called during speech to correct previous sentences
    correctSentence: (original: string, latest: string) =>
      ipcRenderer.invoke('llm:correct-sentence', original, latest),
    
    // Phase 4: Final polish
    // Called when recording stops for full cleanup
    polishText: (pastedText: string, finalText: string, mode?: string) =>
      ipcRenderer.invoke('llm:polish-text', pastedText, finalText, mode),
    
    // Extract new words (for rolling window recovery)
    // Called when rolling window recovery needs to extract only truly new words
    extractNewWords: (pastedEnd: string, tailWords: string) =>
      ipcRenderer.invoke('llm:extract-new-words', pastedEnd, tailWords),
    
    // Get metrics
    getMetrics: () => ipcRenderer.invoke('llm:metrics'),
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SILENCE POLISH - BE-Driven Silence Detection
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Notify speech detected (resets BE silence timer)
    // Call when meaningful transcription activity happens
    notifySpeechDetected: () =>
      ipcRenderer.send('llm:speech-detected'),
    
    // Update pasted text state (keeps BE in sync with FE)
    // Call after each paste operation
    updatePastedText: (text: string, pasteCount: number) =>
      ipcRenderer.send('llm:update-pasted-text', text, pasteCount),
    
    // Start BE-driven silence monitoring (call when recording starts)
    // BE will push polish results when 5s+ silence detected
    startSilenceMonitoring: () =>
      ipcRenderer.send('llm:start-silence-monitoring'),
    
    // Stop BE-driven silence monitoring (call when recording stops)
    stopSilenceMonitoring: () =>
      ipcRenderer.send('llm:stop-silence-monitoring'),
    
    // Listen for BE-pushed silence polish results
    onSilencePolishResult: (callback: (result: { polished: string; undoCount: number; mode: string }) => void) => {
      const handler = (_: any, result: any) => callback(result);
      ipcRenderer.on('llm:silence-polish-result', handler);
      return () => ipcRenderer.removeListener('llm:silence-polish-result', handler);
    },
    
    // Get silence polish status (for debugging)
    getSilencePolishStatus: () =>
      ipcRenderer.invoke('llm:silence-polish-status'),
  },
  
  // Test capture API for end-to-end testing
  testCapture: {
    // Start recording all paste events
    startCapture: () =>
      ipcRenderer.invoke('test:start-capture'),
    
    // Stop recording and get analysis
    stopCapture: () =>
      ipcRenderer.invoke('test:stop-capture'),
    
    // Get current capture events (for live debugging)
    getEvents: () =>
      ipcRenderer.invoke('test:get-capture-events'),
    
    // Record a paste event from renderer side
    recordPaste: (data: {
      type: 'live-paste' | 'silence-polish' | 'final-polish' | 'correct-paste';
      text: string;
      delta: string;
      previousLength: number;
      totalPasted: string;
      success: boolean;
    }) => ipcRenderer.send('test:record-paste', data),
    
    // Listen for test commands from integration tests
    onInjectSpeech: (callback: (data: { text: string }) => void) => {
      const handler = (_event: any, data: { text: string }) => callback(data);
      ipcRenderer.on('test:inject-speech', handler);
      return () => ipcRenderer.removeListener('test:inject-speech', handler);
    },
    
    onStopRecording: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('test:stop-recording', handler);
      return () => ipcRenderer.removeListener('test:stop-recording', handler);
    },
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('outloud', outloudAPI);

