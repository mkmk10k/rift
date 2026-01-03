import { ipcMain, app, BrowserWindow, clipboard, systemPreferences } from 'electron';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { TTSRequest, TTSResult, STTResult, ChunkedSTTResult, ModelCheckResult, AudioPlayRequest, AudioPlayResult } from '../../shared/types';

/**
 * Get the bundled ffmpeg path
 * ffmpeg-static bundles a pre-built ffmpeg binary
 */
function getFfmpegPath(): string {
  // In packaged app, ffmpeg is in the asar.unpacked folder
  if (app.isPackaged) {
    const unpackedPath = path.join(
      app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
      'node_modules',
      'ffmpeg-static',
      'ffmpeg'
    );
    
    if (fs.existsSync(unpackedPath)) {
      console.log('[Rift] Using bundled ffmpeg:', unpackedPath);
      return unpackedPath;
    }
    console.log('[Rift] Bundled ffmpeg not found at:', unpackedPath);
  }
  
  // In development, use ffmpeg-static directly
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      console.log('[Rift] Using ffmpeg-static:', ffmpegStatic);
      return ffmpegStatic;
    }
  } catch (e) {
    console.log('[Rift] ffmpeg-static not available');
  }
  
  // Fallback to system ffmpeg
  try {
    const systemPath = execSync('which ffmpeg', { encoding: 'utf-8' }).trim();
    if (systemPath) {
      console.log('[Rift] Using system ffmpeg:', systemPath);
      return systemPath;
    }
  } catch (e) {
    // System ffmpeg not found
  }
  
  console.error('[Rift] No ffmpeg found!');
  return 'ffmpeg'; // Last resort
}

let _ffmpegPath: string | null = null;

function getFfmpeg(): string {
  if (!_ffmpegPath) {
    _ffmpegPath = getFfmpegPath();
  }
  return _ffmpegPath;
}

// Legacy check for UI feedback (always true now since we bundle ffmpeg)
function checkFfmpeg(): boolean {
  return true; // We bundle ffmpeg, so it's always available
}

/**
 * Find Python 3.11 path - tries multiple locations
 * Lazily evaluated to avoid issues at module load time
 */
let _pythonPath: string | null = null;

function getPythonPath(): string {
  if (_pythonPath) return _pythonPath;
  
  const possiblePaths = [
    '/opt/homebrew/bin/python3.11',  // Apple Silicon Homebrew
    '/usr/local/bin/python3.11',      // Intel Mac Homebrew
    '/usr/bin/python3.11',            // System Python
    '/opt/homebrew/bin/python3',      // Generic Python 3 (Apple Silicon)
    '/usr/local/bin/python3',         // Generic Python 3 (Intel)
  ];

  // Try each path
  for (const pythonPath of possiblePaths) {
    if (fs.existsSync(pythonPath)) {
      console.log('[Rift] Found Python at:', pythonPath);
      _pythonPath = pythonPath;
      return _pythonPath;
    }
  }

  // Try using 'which' command as fallback
  try {
    const result = execSync('which python3.11 2>/dev/null || which python3 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (result && fs.existsSync(result)) {
      console.log('[Rift] Found Python via which:', result);
      _pythonPath = result;
      return _pythonPath;
    }
  } catch (e) {
    // which failed, continue
  }

  // Default fallback
  console.warn('[Rift] Could not find Python, using default path');
  _pythonPath = '/opt/homebrew/bin/python3.11';
  return _pythonPath;
}

// Text length limits for TTS
const TTS_MAX_CHARS = 50000;  // Hard limit to prevent memory exhaustion
const TTS_WARN_CHARS = 10000; // Soft limit for performance warning

/**
 * Persistent TTS Server Manager
 * Keeps Python process alive for fast TTS synthesis
 */
class TTSServer {
  private process: ChildProcess | null = null;
  private isReady = false;
  private modelLoaded = false;
  private pendingRequests: Map<number, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map();
  private requestId = 0;
  private buffer = '';

  async start(): Promise<void> {
    if (this.process && this.isReady) return;

    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'python', 'tts_server.py')
      : path.join(app.getAppPath(), 'python', 'tts_server.py');

    console.log('[TTS Server] Starting persistent server with Python:', getPythonPath());

    this.process = spawn(getPythonPath(), [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stdout?.on('data', (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr?.on('data', (data) => {
      console.log('[TTS Server]', data.toString().trim());
    });

    this.process.on('close', (code) => {
      console.log('[TTS Server] Process exited with code:', code);
      this.isReady = false;
      this.modelLoaded = false;
      this.process = null;
    });

    // Wait for ready signal
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('TTS Server startup timeout'));
      }, 30000); // 30s for model loading

      const checkReady = () => {
        if (this.modelLoaded) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        
        if (msg.type === 'ready') {
          this.isReady = true;
          console.log('[TTS Server] Server ready');
        } else if (msg.type === 'model_loaded') {
          this.modelLoaded = true;
          console.log('[TTS Server] Model loaded - fast synthesis enabled');
        } else if (msg.type === 'success' || msg.type === 'error') {
          // This is a response to a synthesis request
          const pending = this.pendingRequests.get(this.requestId - 1);
          if (pending) {
            this.pendingRequests.delete(this.requestId - 1);
            pending.resolve(msg);
          }
        }
      } catch (e) {
        console.error('[TTS Server] Failed to parse:', line);
      }
    }
  }

  async synthesize(text: string, voice: string, speed: number, outputPath: string): Promise<TTSResult> {
    // Health check and auto-restart if needed
    if (!this.process || !this.isReady) {
      console.log('[TTS Server] Not ready, starting/restarting...');
      try {
        await this.start();
      } catch (err) {
        return { success: false, error: 'Failed to start TTS server' };
      }
    }

    // Verify server is responsive with ping
    const isHealthy = await this.healthCheck();
    if (!isHealthy) {
      console.log('[TTS Server] Health check failed, restarting...');
      this.stop();
      try {
        await this.start();
      } catch (err) {
        return { success: false, error: 'TTS server restart failed' };
      }
    }

    const id = this.requestId++;
    const cmd = JSON.stringify({
      action: 'synthesize',
      text,
      voice,
      speed,
      output: outputPath
    });

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (msg) => {
          if (msg.type === 'success') {
            resolve({ success: true, audioPath: msg.output_file });
          } else {
            resolve({ success: false, error: msg.error });
          }
        },
        reject
      });

      this.process?.stdin?.write(cmd + '\n');
      
      // Timeout for individual request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          resolve({ success: false, error: 'TTS request timeout' });
        }
      }, 15000);
    });
  }

  private async healthCheck(): Promise<boolean> {
    if (!this.process) return false;
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, 2000);

      // Simple check - if process exists and is ready
      if (this.process && this.isReady && this.modelLoaded) {
        clearTimeout(timeout);
        resolve(true);
      } else {
        clearTimeout(timeout);
        resolve(false);
      }
    });
  }

  // Streaming synthesis - sends chunks to renderer as they're generated
  async synthesizeStream(
    text: string, 
    voice: string, 
    speed: number, 
    sender: Electron.WebContents
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.process || !this.isReady) {
      await this.start();
    }

    const requestId = String(this.requestId++);
    const outputDir = app.getPath('temp');
    
    const cmd = JSON.stringify({
      action: 'synthesize_stream',
      text,
      voice,
      speed,
      output_dir: outputDir,
      request_id: requestId
    });

    console.log('[TTS Server] Starting streaming synthesis, request:', requestId);

    return new Promise((resolve) => {
      // Set up temporary handler for streaming responses
      const handleStreamResponse = (msg: any) => {
        console.log('[TTS Streaming] Received message:', msg.type, 'request_id:', msg.request_id);
        
        if (msg.request_id !== requestId) {
          console.log('[TTS Streaming] Ignoring message for different request');
          return false;
        }
        
        if (msg.type === 'chunk') {
          console.log('[TTS Streaming] Processing chunk', msg.chunk_index + 1, '/', msg.total_chunks);
          // Read chunk file and send to renderer
          try {
            const audioBuffer = fs.readFileSync(msg.output_file);
            const base64Audio = audioBuffer.toString('base64');
            const dataUrl = `data:audio/wav;base64,${base64Audio}`;
            
            console.log('[TTS Streaming] Sending chunk to renderer, size:', audioBuffer.length);
            sender.send('audio:stream-chunk', {
              dataUrl,
              chunkIndex: msg.chunk_index,
              totalChunks: msg.total_chunks,
              duration: msg.duration,
              text: msg.text
            });
            
            // Clean up chunk file
            fs.unlinkSync(msg.output_file);
          } catch (err) {
            console.error('[TTS Server] Failed to process chunk:', err);
          }
          return false; // Keep listening
        } else if (msg.type === 'stream_complete') {
          console.log('[TTS Streaming] Stream complete, total chunks:', msg.total_chunks);
          sender.send('audio:stream-complete', {
            totalChunks: msg.total_chunks
          });
          resolve({ success: true });
          return true; // Done
        } else if (msg.type === 'error') {
          console.error('[TTS Streaming] Error:', msg.error);
          sender.send('audio:stream-error', { error: msg.error });
          resolve({ success: false, error: msg.error });
          return true; // Done
        }
        return false;
      };

      // Temporarily override processBuffer to handle streaming
      const originalProcessBuffer = this.processBuffer.bind(this);
      let streamingDone = false;
      
      this.processBuffer = () => {
        console.log('[TTS Streaming] processBuffer called, buffer length:', this.buffer.length);
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        
        console.log('[TTS Streaming] Processing', lines.length, 'lines');

        for (const line of lines) {
          if (!line.trim()) continue;
          console.log('[TTS Streaming] Raw line:', line.substring(0, 100));
          try {
            const msg = JSON.parse(line);
            
            // Try streaming handler first
            if (handleStreamResponse(msg)) {
              // Mark as done, but DON'T restore handler inside the loop
              // to avoid breaking processing of remaining lines in this batch
              streamingDone = true;
              continue;
            }
            
            // Fall back to original handling
            if (msg.type === 'ready') {
              this.isReady = true;
            } else if (msg.type === 'model_loaded') {
              this.modelLoaded = true;
            } else if (msg.type === 'success' || msg.type === 'error') {
              const pending = this.pendingRequests.get(this.requestId - 1);
              if (pending) {
                this.pendingRequests.delete(this.requestId - 1);
                pending.resolve(msg);
              }
            }
          } catch (e) {
            console.error('[TTS Server] Failed to parse:', line);
          }
        }
        
        // Restore original handler AFTER processing all lines in this batch
        if (streamingDone) {
          this.processBuffer = originalProcessBuffer;
        }
      };

      this.process?.stdin?.write(cmd + '\n');
      
      // Long timeout for streaming (can be very long text)
      setTimeout(() => {
        resolve({ success: false, error: 'Streaming timeout' });
      }, 120000); // 2 minutes
    });
  }

  /**
   * True realtime streaming synthesis - sends audio chunks immediately as Kokoro generates them.
   * No file I/O - audio is base64 encoded in Python and sent directly.
   * Uses sentence-level splitting for natural, fast playback start.
   */
  async synthesizeRealtime(
    text: string, 
    voice: string, 
    speed: number, 
    sender: Electron.WebContents
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.process || !this.isReady) {
      await this.start();
    }

    const requestId = String(this.requestId++);
    
    const cmd = JSON.stringify({
      action: 'synthesize_realtime',
      text,
      voice,
      speed,
      request_id: requestId
    });

    console.log('[TTS Realtime] Starting realtime synthesis, request:', requestId);
    console.log('[TTS Realtime] Text length:', text.length, 'chars');

    return new Promise((resolve) => {
      let chunkCount = 0;
      
      // Handler for realtime streaming responses
      const handleRealtimeResponse = (msg: any) => {
        if (msg.request_id !== requestId) {
          return false; // Not our request
        }
        
        if (msg.type === 'realtime_chunk') {
          chunkCount++;
          console.log(`[TTS Realtime] Chunk ${msg.chunk_index + 1} received (${msg.duration?.toFixed(2)}s)`);
          
          // Send audio directly to renderer - already base64 encoded!
          const dataUrl = `data:audio/wav;base64,${msg.audio_base64}`;
          
          sender.send('audio:realtime-chunk', {
            dataUrl,
            chunkIndex: msg.chunk_index,
            duration: msg.duration,
            textHint: msg.text_hint
          });
          
          return false; // Keep listening for more chunks
          
        } else if (msg.type === 'realtime_complete') {
          console.log(`[TTS Realtime] Complete: ${msg.total_chunks} chunks, ${msg.total_duration?.toFixed(2)}s`);
          sender.send('audio:realtime-complete', {
            totalChunks: msg.total_chunks,
            totalDuration: msg.total_duration
          });
          resolve({ success: true });
          return true; // Done
          
        } else if (msg.type === 'error') {
          console.error('[TTS Realtime] Error:', msg.error);
          sender.send('audio:realtime-error', { error: msg.error });
          resolve({ success: false, error: msg.error });
          return true; // Done
        }
        
        return false;
      };

      // Temporarily override processBuffer to handle realtime streaming
      const originalProcessBuffer = this.processBuffer.bind(this);
      let realtimeDone = false;
      
      this.processBuffer = () => {
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            
            // Try realtime handler first
            if (handleRealtimeResponse(msg)) {
              realtimeDone = true;
              continue;
            }
            
            // Fall back to standard handling for non-realtime messages
            if (msg.type === 'ready') {
              this.isReady = true;
            } else if (msg.type === 'model_loaded') {
              this.modelLoaded = true;
            } else if (msg.type === 'success' || msg.type === 'error') {
              const pending = this.pendingRequests.get(this.requestId - 1);
              if (pending) {
                this.pendingRequests.delete(this.requestId - 1);
                pending.resolve(msg);
              }
            }
          } catch (e) {
            console.error('[TTS Realtime] Failed to parse:', line.substring(0, 100));
          }
        }
        
        if (realtimeDone) {
          this.processBuffer = originalProcessBuffer;
        }
      };

      this.process?.stdin?.write(cmd + '\n');
      
      // Timeout for realtime streaming
      setTimeout(() => {
        if (!realtimeDone) {
          this.processBuffer = originalProcessBuffer;
          resolve({ success: false, error: 'Realtime streaming timeout' });
        }
      }, 120000); // 2 minutes max
    });
  }

  stop(): void {
    if (this.process) {
      this.process.stdin?.write(JSON.stringify({ action: 'quit' }) + '\n');
      this.process.kill();
      this.process = null;
      this.isReady = false;
      this.modelLoaded = false;
    }
  }
}

// Global TTS server instance
const ttsServer = new TTSServer();

/**
 * Persistent STT Server Manager
 * Keeps Whisper model loaded in memory for fast transcription
 */
interface STTModel {
  id: string;
  name: string;
  description: string;
  size_mb: number;
  installed: boolean;
  loaded: boolean;
  active: boolean;
}

class STTServer {
  private process: ChildProcess | null = null;
  private isReady = false;
  private modelLoaded = false;
  private buffer = '';
  private pendingRequest: { resolve: (value: any) => void; reject: (error: any) => void } | null = null;
  private currentModel = 'whisper';
  private availableModels: STTModel[] = [];
  private startingPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    // Already ready - return immediately
    if (this.process && this.isReady) return;
    
    // Already starting - return the existing promise to prevent duplicate spawns
    if (this.startingPromise) return this.startingPromise;

    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'python', 'stt_server.py')
      : path.join(app.getAppPath(), 'python', 'stt_server.py');

    console.log('[STT Server] Starting persistent server with Python:', getPythonPath());

    // Add FFmpeg directory to PATH for Parakeet and other libraries that need it
    const ffmpegPath = getFfmpeg();
    const ffmpegDir = path.dirname(ffmpegPath);
    const envPath = process.env.PATH || '';
    const modifiedPath = `${ffmpegDir}:${envPath}`;
    
    console.log('[STT Server] FFmpeg directory added to PATH:', ffmpegDir);

    this.process = spawn(getPythonPath(), [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: modifiedPath }
    });

    this.process.stdout?.on('data', (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr?.on('data', (data) => {
      console.log('[STT Server]', data.toString().trim());
    });

    this.process.on('close', (code) => {
      console.log('[STT Server] Process exited with code:', code);
      this.isReady = false;
      this.modelLoaded = false;
      this.process = null;
      this.startingPromise = null;
    });

    // Wait for ready signal - store promise to prevent duplicate spawns
    this.startingPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.startingPromise = null;
        reject(new Error('STT Server startup timeout'));
      }, 60000); // 60s for model loading

      const checkReady = () => {
        if (this.modelLoaded) {
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

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        
        if (msg.type === 'ready') {
          this.isReady = true;
          this.availableModels = msg.models || [];
          this.currentModel = msg.current_model || 'whisper';
          console.log('[STT Server] Server ready, models:', this.availableModels.map(m => m.id).join(', '));
        } else if (msg.type === 'model_loaded') {
          this.modelLoaded = true;
          console.log(`[STT Server] ${msg.model || 'Model'} loaded - fast transcription enabled`);
        } else if (msg.type === 'models') {
          // Response to get_models
          this.availableModels = msg.models || [];
          this.currentModel = msg.current_model || this.currentModel;
          if (this.pendingRequest) {
            this.pendingRequest.resolve(msg);
            this.pendingRequest = null;
          }
        } else if (msg.type === 'warmup_complete') {
          // Response to warmup request
          console.log(`[STT Server] Warmup complete for ${msg.model} in ${msg.warmup_time_ms}ms`);
          if (this.pendingRequest) {
            this.pendingRequest.resolve(msg);
            this.pendingRequest = null;
          }
        } else if (msg.type === 'success' || msg.type === 'error') {
          // Response to transcription or set_model request
          if (msg.current_model) {
            this.currentModel = msg.current_model;
          }
          if (this.pendingRequest) {
            this.pendingRequest.resolve(msg);
            this.pendingRequest = null;
          }
        }
      } catch (e) {
        console.error('[STT Server] Failed to parse:', line);
      }
    }
  }

  async transcribe(audioPath: string): Promise<STTResult> {
    if (!this.process || !this.isReady) {
      await this.start();
    }

    const cmd = JSON.stringify({
      action: 'transcribe_file',
      audio_path: audioPath
    });

    return new Promise((resolve) => {
      this.pendingRequest = {
        resolve: (msg) => {
          if (msg.type === 'success') {
            resolve({ 
              success: true, 
              transcription: msg.text,
              // Include performance stats
              audio_duration_ms: msg.audio_duration_ms,
              inference_time_ms: msg.inference_time_ms,
              processing_time_ms: msg.processing_time_ms,
              realtime_factor: msg.realtime_factor,
              model: msg.model
            });
          } else {
            resolve({ success: false, error: msg.error });
          }
        },
        reject: (err) => resolve({ success: false, error: err.message })
      };

      this.process?.stdin?.write(cmd + '\n');
      
      // Timeout for individual request
      setTimeout(() => {
        if (this.pendingRequest) {
          this.pendingRequest = null;
          resolve({ success: false, error: 'STT request timeout' });
        }
      }, 30000);
    });
  }

  async setModel(modelId: string): Promise<{ success: boolean; error?: string; currentModel?: string }> {
    if (!this.process || !this.isReady) {
      await this.start();
    }

    const cmd = JSON.stringify({
      action: 'set_model',
      model: modelId
    });

    return new Promise((resolve) => {
      this.pendingRequest = {
        resolve: (msg) => {
          if (msg.type === 'success') {
            this.currentModel = msg.current_model || modelId;
            resolve({ success: true, currentModel: this.currentModel });
          } else {
            resolve({ success: false, error: msg.error });
          }
        },
        reject: (err) => resolve({ success: false, error: err.message })
      };

      this.process?.stdin?.write(cmd + '\n');
      
      // Longer timeout for model loading (Parakeet is 2GB)
      setTimeout(() => {
        if (this.pendingRequest) {
          this.pendingRequest = null;
          resolve({ success: false, error: 'Model switch timeout' });
        }
      }, 120000); // 2 minutes for potential download
    });
  }

  async getModels(): Promise<{ models: STTModel[]; currentModel: string }> {
    if (!this.process || !this.isReady) {
      await this.start();
    }

    const cmd = JSON.stringify({ action: 'get_models' });

    return new Promise((resolve) => {
      this.pendingRequest = {
        resolve: (msg) => {
          resolve({
            models: msg.models || this.availableModels,
            currentModel: msg.current_model || this.currentModel
          });
        },
        reject: () => resolve({ models: this.availableModels, currentModel: this.currentModel })
      };

      this.process?.stdin?.write(cmd + '\n');
      
      setTimeout(() => {
        if (this.pendingRequest) {
          this.pendingRequest = null;
          resolve({ models: this.availableModels, currentModel: this.currentModel });
        }
      }, 5000);
    });
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  /**
   * Pre-warm a model by running dummy inference.
   * This compiles MLX kernels for faster first real transcription.
   */
  async warmup(modelId?: string): Promise<{ success: boolean; model?: string; warmupTimeMs?: number; error?: string }> {
    if (!this.process || !this.isReady) {
      await this.start();
    }

    const cmd = JSON.stringify({
      action: 'warmup',
      model: modelId || this.currentModel
    });

    return new Promise((resolve) => {
      this.pendingRequest = {
        resolve: (msg) => {
          if (msg.type === 'warmup_complete') {
            resolve({ 
              success: true, 
              model: msg.model,
              warmupTimeMs: msg.warmup_time_ms
            });
          } else {
            resolve({ success: false, error: msg.error || 'Warmup failed' });
          }
        },
        reject: (err) => resolve({ success: false, error: err.message })
      };

      this.process?.stdin?.write(cmd + '\n');
      
      // Warmup can take a while for first-time model loading
      setTimeout(() => {
        if (this.pendingRequest) {
          this.pendingRequest = null;
          resolve({ success: false, error: 'Warmup timeout' });
        }
      }, 120000); // 2 minutes
    });
  }

  /**
   * Transcribe from raw PCM float32 buffer (for streaming).
   * Audio should be 16kHz mono float32.
   * 
   * IMPORTANT: This is designed to be called sequentially (one at a time).
   * The isTranscribing flag in the streaming handler ensures this.
   * Each call sets up its own resolver and timeout.
   */
  async transcribeBuffer(pcmData: Float32Array): Promise<STTResult> {
    if (!this.process || !this.isReady) {
      await this.start();
    }

    // Convert Float32Array to base64
    const buffer = Buffer.from(pcmData.buffer);
    const pcmBase64 = buffer.toString('base64');

    const cmd = JSON.stringify({
      action: 'transcribe_buffer',
      pcm_base64: pcmBase64
    });

    return new Promise((resolve) => {
      // Set up timeout - 10 seconds is generous for a single transcription
      const timeoutId = setTimeout(() => {
        if (this.pendingRequest) {
          console.warn('[STT Server] Transcription timeout (10s)');
          this.pendingRequest = null;
          resolve({ success: false, error: 'Transcription timeout' });
        }
      }, 10000);
      
      this.pendingRequest = {
        resolve: (msg) => {
          clearTimeout(timeoutId);
          this.pendingRequest = null;
          
          if (msg.type === 'success') {
            resolve({ 
              success: true, 
              transcription: msg.text,
              audio_duration_ms: msg.audio_duration_ms,
              inference_time_ms: msg.inference_time_ms,
              realtime_factor: msg.realtime_factor,
              model: msg.model
            });
          } else {
            resolve({ success: false, error: msg.error });
          }
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          this.pendingRequest = null;
          resolve({ success: false, error: err.message });
        }
      };

      this.process?.stdin?.write(cmd + '\n');
    });
  }

  /**
   * Transcribe using chunk-and-commit architecture.
   * 
   * This is the NEW streaming transcription method that:
   * 1. Detects pauses for natural commit points
   * 2. Forces commits after ~18s of continuous speech
   * 3. Returns committed_text (immutable) + partial_text (may change)
   * 
   * The frontend only needs to:
   * - Append committed_text when isCommit=true
   * - Display partial_text as preview (will be replaced by next commit)
   */
  async transcribeBufferChunked(
    pcmData: Float32Array, 
    sessionId: string, 
    totalSamples: number
  ): Promise<ChunkedSTTResult> {
    if (!this.process || !this.isReady) {
      await this.start();
    }

    // Convert Float32Array to base64
    const buffer = Buffer.from(pcmData.buffer);
    const pcmBase64 = buffer.toString('base64');

    const cmd = JSON.stringify({
      action: 'transcribe_buffer_chunked',
      pcm_base64: pcmBase64,
      session_id: sessionId,
      total_samples: totalSamples
    });

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequest) {
          console.warn('[STT Server] Chunked transcription timeout (15s)');
          this.pendingRequest = null;
          resolve({ 
            success: false, 
            committed_text: '',
            partial_text: '',
            is_final: false,
            commit_sample: 0,
            error: 'Transcription timeout' 
          });
        }
      }, 15000);
      
      this.pendingRequest = {
        resolve: (msg) => {
          clearTimeout(timeoutId);
          this.pendingRequest = null;
          
          if (msg.type === 'success') {
            resolve({ 
              success: true, 
              committed_text: msg.committed_text || '',
              partial_text: msg.partial_text || '',
              is_final: msg.is_final || false,
              commit_sample: msg.commit_sample || 0,
              commit_reason: msg.commit_reason,
              audio_duration_ms: msg.audio_duration_ms,
              inference_time_ms: msg.inference_time_ms
            });
          } else {
            resolve({ 
              success: false, 
              committed_text: '',
              partial_text: '',
              is_final: false,
              commit_sample: 0,
              error: msg.error 
            });
          }
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          this.pendingRequest = null;
          resolve({ 
            success: false, 
            committed_text: '',
            partial_text: '',
            is_final: false,
            commit_sample: 0,
            error: err.message 
          });
        }
      };

      this.process?.stdin?.write(cmd + '\n');
    });
  }

  /**
   * Reset the chunk tracker for a new recording session.
   * Call this at stream-start to clear any state from previous sessions.
   */
  async resetSession(): Promise<void> {
    if (!this.process || !this.isReady) {
      await this.start();
    }

    const cmd = JSON.stringify({ action: 'reset_session' });
    
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.warn('[STT Server] Reset session timeout');
        resolve();
      }, 5000);
      
      this.pendingRequest = {
        resolve: () => {
          clearTimeout(timeoutId);
          this.pendingRequest = null;
          console.log('[STT Server] Session reset complete');
          resolve();
        },
        reject: () => {
          clearTimeout(timeoutId);
          this.pendingRequest = null;
          resolve();
        }
      };

      this.process?.stdin?.write(cmd + '\n');
    });
  }

  stop(): void {
    if (this.process) {
      this.process.stdin?.write(JSON.stringify({ action: 'quit' }) + '\n');
      this.process.kill();
      this.process = null;
      this.isReady = false;
      this.modelLoaded = false;
    }
  }
}

// Global STT server instance
const sttServer = new STTServer();

/**
 * Graceful shutdown - stop all Python servers
 */
export function shutdownServers(): void {
  console.log('[Rift] Shutting down Python servers...');
  ttsServer.stop();
  sttServer.stop();
  
  // Stop LLM server if running
  try {
    const { shutdownLLMServer } = require('../services/llmService');
    shutdownLLMServer();
    console.log('[Rift] LLM server stopped');
  } catch {
    // LLM service may not be loaded
  }
  
  console.log('[Rift] Python servers stopped');
}

/**
 * Register all IPC handlers for communication with renderer process
 */

export function registerIpcHandlers() {
  // Start TTS server in background (pre-warm)
  ttsServer.start().catch(err => {
    console.error('[TTS Server] Failed to pre-warm:', err);
  });
  
  // Start STT server in background
  // NOTE: The Python server already warms up with real speech audio during initialize()
  // We don't call warmup() from JS anymore - it was causing race conditions where
  // the user could start recording while the redundant JS warmup was in progress,
  // leading to 6+ second delays on the first transcription.
  sttServer.start().then(() => {
    console.log('[STT Server] Started - model already warmed up during Python init');
  }).catch(err => {
    console.error('[STT Server] Failed to start:', err);
  });
  
  // Start LLM server in background (pre-warm for faster first use)
  // The LLM is used for Phase 4 final polish and Phase 2/3 corrections
  const { llmServer } = require('../services/llmService');
  llmServer.start().then(() => {
    console.log('[LLM Server] Started - fast model pre-warmed');
  }).catch((err: Error) => {
    console.warn('[LLM Server] Failed to pre-start (will retry on first use):', err.message);
  });
  // Window: Resize window
  ipcMain.handle('window:resize', async (event, width: number, height: number) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      window.setSize(width, height);
    }
  });

  // Window: Hide window
  ipcMain.handle('window:hide', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      window.hide();
    }
  });

  // Window: Show window
  ipcMain.handle('window:show', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      window.showInactive();
    }
  });

  // Window: Start drag (for transparent windows with interactive content)
  ipcMain.handle('window:start-drag', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      // Get current mouse position on screen
      const { screen } = require('electron');
      const mousePos = screen.getCursorScreenPoint();
      const winPos = window.getPosition();
      return {
        startX: mousePos.x,
        startY: mousePos.y,
        winX: winPos[0],
        winY: winPos[1]
      };
    }
    return null;
  });

  // Window: Move during drag
  ipcMain.handle('window:drag-move', async (event, deltaX: number, deltaY: number) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && typeof deltaX === 'number' && typeof deltaY === 'number') {
      const [currentX, currentY] = window.getPosition();
      window.setPosition(Math.round(currentX + deltaX), Math.round(currentY + deltaY));
    }
  });

  // Window: Toggle DevTools
  ipcMain.handle('window:toggle-devtools', async (event) => {
    const webContents = event.sender;
    if (webContents.isDevToolsOpened()) {
      webContents.closeDevTools();
      return false;
    } else {
      webContents.openDevTools({ mode: 'detach' });
      return true;
    }
  });

  // Window: Open System Settings for keyboard shortcuts
  ipcMain.handle('window:open-keyboard-settings', async () => {
    const { shell } = require('electron');
    // Open macOS System Settings > Keyboard > Keyboard Shortcuts
    shell.openExternal('x-apple.systempreferences:com.apple.preference.keyboard?Shortcuts');
    return true;
  });

  // Window: Open System Settings for Accessibility
  ipcMain.handle('window:open-accessibility-settings', async () => {
    const { shell } = require('electron');
    // Open macOS System Settings > Privacy & Security > Accessibility
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    return true;
  });

  // TTS: Synthesize speech from text (single chunk mode)
  ipcMain.handle('tts:synthesize', async (event, request: TTSRequest): Promise<TTSResult> => {
    if (request.useLocal) {
      const result = await synthesizeLocalTTS(request);
      
      // Automatically trigger playback if synthesis was successful
      if (result.success && result.audioPath) {
        try {
          // Read the audio file and convert to base64 data URL
          const audioBuffer = await fs.promises.readFile(result.audioPath);
          const base64Audio = audioBuffer.toString('base64');
          const dataUrl = `data:audio/wav;base64,${base64Audio}`;
          
          // Send data URL to renderer to play
          event.sender.send('audio:play-file', dataUrl);
        } catch (error: any) {
          console.error('Failed to read TTS audio file:', error);
        }
      }
      
      return result;
    } else {
      return { success: false, error: 'Cloud TTS not yet implemented' };
    }
  });

  // TTS: Streaming synthesis for long texts
  ipcMain.handle('tts:synthesize-stream', async (event, request: TTSRequest): Promise<{ success: boolean; error?: string; warning?: string }> => {
    // Validate text length
    if (request.text.length > TTS_MAX_CHARS) {
      console.warn(`[TTS] Text too long: ${request.text.length} chars (max: ${TTS_MAX_CHARS})`);
      return { 
        success: false, 
        error: `Text too long (${request.text.length.toLocaleString()} characters). Maximum is ${TTS_MAX_CHARS.toLocaleString()} characters.` 
      };
    }

    let warning: string | undefined;
    if (request.text.length > TTS_WARN_CHARS) {
      warning = `Long text (${request.text.length.toLocaleString()} chars) - playback may take a while`;
      console.log(`[TTS] Warning: ${warning}`);
    }

    if (request.useLocal) {
      console.log('[TTS] Starting streaming synthesis');
      console.log('[TTS] Text length:', request.text.length, 'chars');
      console.log('[TTS] First 100 chars:', request.text.substring(0, 100));
      const result = await ttsServer.synthesizeStream(
        request.text,
        request.voice,
        request.speed,
        event.sender
      );
      if (warning && result.success) {
        return { ...result, warning };
      }
      return result;
    } else {
      return { success: false, error: 'Cloud TTS streaming not implemented' };
    }
  });

  // TTS: Realtime streaming synthesis - fastest possible start
  // Uses Kokoro's native sentence-level generator, no file I/O
  ipcMain.handle('tts:synthesize-realtime', async (event, request: TTSRequest): Promise<{ success: boolean; error?: string }> => {
    // Validate text length
    if (request.text.length > TTS_MAX_CHARS) {
      console.warn(`[TTS Realtime] Text too long: ${request.text.length} chars`);
      return { 
        success: false, 
        error: `Text too long (${request.text.length.toLocaleString()} characters)` 
      };
    }

    if (!request.useLocal) {
      return { success: false, error: 'Cloud TTS realtime not implemented' };
    }

    console.log('[TTS Realtime] Starting realtime synthesis');
    console.log('[TTS Realtime] Text length:', request.text.length, 'chars');
    
    const result = await ttsServer.synthesizeRealtime(
      request.text,
      request.voice,
      request.speed,
      event.sender
    );
    
    return result;
  });

  // Check if local models are available
  ipcMain.handle('models:check', async (): Promise<ModelCheckResult> => {
    return checkLocalModels();
  });

  // STT: Save audio blob and transcribe using persistent server
  ipcMain.handle('stt:transcribe', async (event, audioData: ArrayBuffer): Promise<STTResult> => {
    // Use single timestamp for both files to ensure consistency
    const timestamp = Date.now();
    const tempWebmPath = path.join(app.getPath('temp'), `recording_${timestamp}.webm`);
    const tempWavPath = path.join(app.getPath('temp'), `recording_${timestamp}.wav`);
    
    console.log(`[STT] Processing recording, audio data size: ${audioData.byteLength} bytes`);
    
    // Reject very small recordings (< 5KB) as they're likely noise
    if (audioData.byteLength < 5000) {
      console.warn('[STT] Recording too small, likely noise or silence');
      return { success: false, error: 'Recording too short. Please speak longer.' };
    }
    
    try {
      await fs.promises.writeFile(tempWebmPath, Buffer.from(audioData));
      console.log('[STT] Saved audio to:', tempWebmPath);
      
      // Convert WebM to WAV using bundled ffmpeg
      const ffmpegPath = getFfmpeg();
      console.log('[STT] Using ffmpeg:', ffmpegPath);
      
      await new Promise<void>((resolve, reject) => {
        const ffmpegProc = spawn(ffmpegPath, [
          '-i', tempWebmPath,
          '-ar', '16000',  // 16kHz sample rate for Whisper
          '-ac', '1',      // Mono
          '-y',            // Overwrite output
          tempWavPath
        ]);
        
        let stderr = '';
        ffmpegProc.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        
        ffmpegProc.on('close', (code) => {
          if (code === 0) {
            console.log('[STT] Converted to WAV:', tempWavPath);
            resolve();
          } else {
            console.error('[STT] ffmpeg error:', stderr);
            reject(new Error(`ffmpeg failed with code ${code}`));
          }
        });
        
        ffmpegProc.on('error', (error) => {
          console.error('[STT] ffmpeg spawn error:', error);
          reject(new Error(`ffmpeg error: ${error.message}`));
        });
      });
      
      // Transcribe using persistent STT server (much faster!)
      console.log('[STT] Transcribing with persistent server...');
      const startTime = Date.now();
      const result = await sttServer.transcribe(tempWavPath);
      console.log(`[STT] Transcription completed in ${Date.now() - startTime}ms`);
      
      // Clean up temp files immediately
      const cleanupFile = async (filePath: string) => {
        try {
          if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            console.log('[STT] Deleted temp file:', filePath);
          }
        } catch (e) {
          console.error('[STT] Failed to delete temp file:', filePath, e);
        }
      };
      
      await cleanupFile(tempWebmPath);
      await cleanupFile(tempWavPath);
      
      return result;
    } catch (error: any) {
      return { success: false, error: `Failed to process audio: ${error.message}` };
    }
  });

  // STT: Get available models
  ipcMain.handle('stt:get-models', async () => {
    try {
      const result = await sttServer.getModels();
      return { success: true, ...result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // STT: Set model
  ipcMain.handle('stt:set-model', async (event, modelId: string) => {
    console.log('[STT] Switching to model:', modelId);
    try {
      const result = await sttServer.setModel(modelId);
      if (result.success) {
        console.log('[STT] Model switched successfully to:', result.currentModel);
      } else {
        console.error('[STT] Model switch failed:', result.error);
      }
      return result;
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // STT: Warmup model (pre-compile MLX kernels for faster first inference)
  ipcMain.handle('stt:warmup', async (event, modelId?: string) => {
    console.log('[STT] Warming up model:', modelId || 'current');
    try {
      const result = await sttServer.warmup(modelId);
      if (result.success) {
        console.log(`[STT] Warmup complete for ${result.model} in ${result.warmupTimeMs}ms`);
      } else {
        console.error('[STT] Warmup failed:', result.error);
      }
      return result;
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  /*
   * ============================================================================
   * STREAMING STT WITH NATURAL HUMAN SPEECH SUPPORT
   * ============================================================================
   * 
   * This streaming implementation is designed to support ALL types of human
   * speech patterns, not just fluent continuous speech:
   * 
   * - PONDERERS: People who pause to think mid-sentence ("So I was... [3s] ...thinking")
   * - STUTTERERS: People who repeat words ("I... I... I want to")
   * - DYSFLUENT SPEAKERS: Lots of "um", "like", "you know"
   * - NON-NATIVE SPEAKERS: Longer pauses searching for words
   * - COMPLEX THINKERS: Back-and-forth ideas ("On one hand... but then...")
   * 
   * KEY DESIGN DECISIONS:
   * 
   * 1. NO AUTO-ENDPOINTING: We do NOT automatically end utterances on silence.
   *    The user explicitly controls when they're done via the stop button.
   *    This is crucial for ponderers who may pause for several seconds mid-thought.
   * 
   * 2. ROLLING CONTEXT WINDOW: Instead of transcribing the entire growing buffer
   *    (which would get slower over time), we use a rolling window of the last
   *    15 seconds. This provides enough context for accurate transcription while
   *    keeping latency bounded regardless of recording length.
   * 
   * 3. IMMEDIATE RE-TRANSCRIPTION: When transcription completes and more audio
   *    has arrived, we immediately start a new transcription instead of waiting
   *    for the next chunk. This ensures we never fall behind during pauses.
   * 
   * 4. STABILITY-AWARE PASTING: The frontend tracks text stability before pasting,
   *    handling cases where the model refines earlier words (common with stuttering).
   * 
   * FUTURE ENHANCEMENT (TODO):
   * After recording completes, we could optionally pass the final transcription
   * through a local LLM (e.g., Llama, Mistral) for cleanup:
   * - Fix grammar and spelling
   * - Improve sentence structure
   * - Convert to bullet points if requested
   * - Remove filler words ("um", "like") if desired
   * This would be a user preference, as some users want verbatim transcription.
   * ============================================================================
   */

  // STT Streaming session state
  let streamingSession: {
    id: string;
    audioBuffer: Float32Array[];
    totalSamples: number;
    lastTranscription: string;
    startTime: number;
    // Track transcription count for stability detection
    transcriptionCount: number;
    // Track when we last received audio (for pause detection)
    lastChunkTime: number;
    // CHUNK-AND-COMMIT: Track committed state
    lastCommittedText: string;
    lastCommitSample: number;
  } | null = null;

  // Track if transcription is in progress to avoid blocking
  let isTranscribing = false;
  let pendingTranscription = false;

  // Configuration for rolling context window - CRITICAL FOR LIVE PASTE RESPONSIVENESS
  // 
  // M4 OPTIMIZATION: The key insight is that STREAMING transcription needs to be FAST,
  // not complete. Transcribing 60 seconds of audio takes ~5+ seconds, during which
  // live paste is blocked. This causes the "cascading slowdown" bug where live paste
  // stops working after the app runs for a while.
  // 
  // FIX: Use a SHORT context window (10 seconds) for streaming. This ensures:
  // - Each transcription completes in <1 second
  // - Live paste remains responsive throughout
  // - The FINAL transcription (on stop) uses ALL audio for accuracy
  // 
  // The trade-off is that streaming transcription may lose early context for very
  // long recordings, but this is acceptable because:
  // 1. Live paste is append-only anyway (we only add new text)
  // 2. Final correction fixes any issues when recording stops
  // Rolling window for streaming transcription.
  // 
  // PERFORMANCE DATA (from actual testing on M4):
  // - 7s of audio → 1.1s transcription ✅
  // - 15s of audio → ~1.5s transcription ✅
  // - 27s of audio → 3.0s transcription 🟡
  // - 45s of audio → 4.5s+ transcription 🔴 (watchdog risk)
  // 
  // For responsive live paste, we need <2s transcription time, which means
  // limiting to ~20 seconds of audio. The tail-based extension detection
  // handles the case when beginning gets truncated.
  // 
  // IMPORTANT: Final transcription when you stop gets EVERYTHING - nothing lost.
  // Rolling context window - balance between response time and context
  // 30 seconds gives good accuracy while keeping transcription fast
  // Tail extension detection handles any truncation gracefully
  const CONTEXT_WINDOW_SECONDS = 30;
  const CONTEXT_WINDOW_SAMPLES = CONTEXT_WINDOW_SECONDS * 16000; // At 16kHz

  ipcMain.handle('stt:stream-start', async () => {
    if (streamingSession) {
      console.warn('[STT Streaming] Previous session not ended, cleaning up');
    }
    // Reset transcription state
    isTranscribing = false;
    pendingTranscription = false;
    
    // CHUNK-AND-COMMIT: Reset the Python-side chunk tracker
    await sttServer.resetSession();
    
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'handlers.ts:stream-start',message:'stream-start called (chunk-and-commit)',data:{hadPrevSession:!!streamingSession},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'CAC',runId:'chunk-commit'})}).catch(()=>{});
    
    // Pre-pad with 250ms of silence to give Parakeet audio context
    const LEAD_IN_SAMPLES = 4000; // 250ms at 16kHz
    const leadInSilence = new Float32Array(LEAD_IN_SAMPLES);
    
    streamingSession = {
      id: Date.now().toString(),
      audioBuffer: [leadInSilence],
      totalSamples: LEAD_IN_SAMPLES,
      lastTranscription: '',
      startTime: Date.now(),
      transcriptionCount: 0,
      lastChunkTime: Date.now(),
      // CHUNK-AND-COMMIT: Track committed text locally too
      lastCommittedText: '',
      lastCommitSample: 0
    };
    console.log('[STT Streaming] Session started (chunk-and-commit):', streamingSession.id);
    return { success: true, sessionId: streamingSession.id };
  });

  /**
   * Helper function to get ALL audio for chunk-and-commit transcription.
   * 
   * CHUNK-AND-COMMIT ARCHITECTURE:
   * Unlike the old rolling window approach, we send ALL audio to Python.
   * Python tracks committed vs uncommitted samples and only transcribes
   * uncommitted audio. This ensures:
   * 1. Committed text is immutable (no re-transcription)
   * 2. Fast transcription (only uncommitted portion)
   * 3. No "freeze" - committed chunks are final
   */
  function getAllAudioForTranscription(session: NonNullable<typeof streamingSession>): Float32Array {
    const totalLength = session.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
    
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const buf of session.audioBuffer) {
      combined.set(buf, offset);
      offset += buf.length;
    }
    return combined;
  }
  
  /**
   * Legacy: Rolling context window (kept for final transcription fallback).
   */
  function getAudioForTranscription(session: NonNullable<typeof streamingSession>): Float32Array {
    const totalLength = session.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
    
    if (totalLength <= CONTEXT_WINDOW_SAMPLES) {
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const buf of session.audioBuffer) {
        combined.set(buf, offset);
        offset += buf.length;
      }
      return combined;
    }
    
    console.log(`[STT Streaming] Rolling window: ${totalLength} -> ${CONTEXT_WINDOW_SAMPLES} samples`);
    
    const combined = new Float32Array(CONTEXT_WINDOW_SAMPLES);
    let samplesToSkip = totalLength - CONTEXT_WINDOW_SAMPLES;
    let offset = 0;
    
    for (const buf of session.audioBuffer) {
      if (samplesToSkip >= buf.length) {
        samplesToSkip -= buf.length;
      } else if (samplesToSkip > 0) {
        const startIndex = samplesToSkip;
        const portion = buf.subarray(startIndex);
        combined.set(portion, offset);
        offset += portion.length;
        samplesToSkip = 0;
      } else {
        combined.set(buf, offset);
        offset += buf.length;
      }
    }
    
    return combined;
  }

  /**
   * Trigger a transcription cycle. 
   * 
   * This is extracted into a function so it can be called both from chunk arrival 
   * AND from transcription completion (for immediate re-transcription when pending
   * audio exists). This is crucial for supporting ponderers who pause mid-thought -
   * when they resume speaking, we don't want to wait for a new chunk to trigger
   * transcription of the audio that arrived during the previous transcription.
   */
  // Track when transcription started for watchdog
  let transcriptionStartedAt = 0;
  // Watchdog timeout must be longer than worst-case transcription time:
  // - Cold start: ~7 seconds
  // - 45s audio: ~3-4 seconds
  // Watchdog timeout for stuck transcriptions
  // - Normal transcription: 200-500ms
  // - Cold start (first ever): ~2-3 seconds
  // - Worst case with long audio: ~5 seconds
  // Set to 20 seconds as safety net - should never hit this in normal operation
  const TRANSCRIPTION_WATCHDOG_MS = 20000;
  
  function triggerTranscription(
    session: NonNullable<typeof streamingSession>, 
    sender: Electron.WebContents, 
    sessionId: string
  ): void {
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'handlers.ts:triggerTranscription:entry',message:'triggerTranscription called',data:{isTranscribing,pendingTranscription,totalSamples:session.totalSamples},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B',runId:'post-fix4'})}).catch(()=>{});
    
    // WATCHDOG: If isTranscribing has been true for too long, force reset
    // This handles cases where the STT server promise never resolves (crash, hang)
    if (isTranscribing && transcriptionStartedAt > 0) {
      const stuckTime = Date.now() - transcriptionStartedAt;
      if (stuckTime > TRANSCRIPTION_WATCHDOG_MS) {
        console.warn(`[STT Streaming] WATCHDOG: Forcing reset after ${stuckTime}ms stuck`);
        fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'handlers.ts:watchdog',message:'Watchdog reset',data:{stuckTime},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'WATCHDOG',runId:'post-fix9'})}).catch(()=>{});
        isTranscribing = false;
        // Don't return - let this attempt proceed
      }
    }
    
    if (isTranscribing) {
      pendingTranscription = true;
      return;
    }
    
    isTranscribing = true;
    pendingTranscription = false;
    transcriptionStartedAt = Date.now();
    
    // CHUNK-AND-COMMIT: Send ALL audio - Python handles committed vs uncommitted
    const audioToTranscribe = getAllAudioForTranscription(session);
    
    console.log(`[STT Streaming] Chunk-and-commit: ${audioToTranscribe.length} samples (${session.totalSamples} total)`);
    
    const transcriptionStartTime = Date.now();
    
    // Use chunk-and-commit transcription
    sttServer.transcribeBufferChunked(
      audioToTranscribe, 
      sessionId, 
      session.totalSamples
    ).then(result => {
      isTranscribing = false;
      transcriptionStartedAt = 0;
      const transcriptionDuration = Date.now() - transcriptionStartTime;
      
      if (!streamingSession || streamingSession.id !== sessionId) {
        console.log(`[STT Streaming] Session ended during transcription`);
        return;
      }
      
      streamingSession.transcriptionCount++;
      
      if (result.success) {
        // CHUNK-AND-COMMIT: Combine committed + partial for full text
        const fullText = result.committed_text + 
          (result.partial_text ? (result.committed_text ? ' ' : '') + result.partial_text : '');
        
        // Track if anything changed
        const textChanged = fullText !== streamingSession.lastTranscription;
        const isNewCommit = result.is_final && result.committed_text !== streamingSession.lastCommittedText;
        
        if (isNewCommit) {
          // A new chunk was committed! Update local tracking
          streamingSession.lastCommittedText = result.committed_text;
          streamingSession.lastCommitSample = result.commit_sample;
          console.log(`[STT Streaming] COMMIT (${result.commit_reason}): "${result.committed_text.slice(-50)}..."`);
        }
        
        if (textChanged) {
          streamingSession.lastTranscription = fullText;
          console.log(`[STT Streaming] Partial #${streamingSession.transcriptionCount}: "${fullText.slice(0, 50)}..." [committed: ${result.committed_text.length}, partial: ${result.partial_text.length}]`);
          
          // Send with chunk-and-commit metadata
          sender.send('stt:partial-result', {
            // Legacy: full text for backward compatibility
            text: fullText,
            isFinal: false,
            sessionId: sessionId,
            transcriptionCount: streamingSession.transcriptionCount,
            // CHUNK-AND-COMMIT: New fields
            committedText: result.committed_text,
            partialText: result.partial_text,
            isCommit: isNewCommit
          });
        } else {
          console.log(`[STT Streaming] Skipping #${streamingSession.transcriptionCount} - unchanged`);
        }
      } else {
        console.warn(`[STT Streaming] Transcription failed: ${result.error}`);
      }
      
      // Re-transcribe if pending audio arrived during this transcription
      if (pendingTranscription && streamingSession && streamingSession.id === sessionId) {
        console.log(`[STT Streaming] Pending audio, re-transcribing...`);
        setImmediate(() => {
          if (streamingSession && streamingSession.id === sessionId) {
            triggerTranscription(streamingSession, sender, sessionId);
          }
        });
      }
    }).catch(error => {
      isTranscribing = false;
      transcriptionStartedAt = 0;
      console.error('[STT Streaming] Transcription error:', error.message);
      
      if (pendingTranscription && streamingSession && streamingSession.id === sessionId) {
        setImmediate(() => {
          if (streamingSession && streamingSession.id === sessionId) {
            triggerTranscription(streamingSession, sender, sessionId);
          }
        });
      }
    });
  }

  // STT Streaming: Receive a chunk of PCM audio
  ipcMain.handle('stt:stream-chunk', async (event, pcmData: ArrayBuffer) => {
    if (!streamingSession) {
      console.error('[STT Streaming] No active session for chunk');
      return { success: false, error: 'No active streaming session' };
    }

    // Convert ArrayBuffer to Float32Array
    let chunk: Float32Array;
    try {
      chunk = new Float32Array(pcmData);
    } catch (e) {
      console.error('[STT Streaming] Failed to convert chunk:', e);
      return { success: false, error: 'Invalid audio data' };
    }
    
    // Track timing for pause detection
    const now = Date.now();
    const timeSinceLastChunk = now - (streamingSession.lastChunkTime || now);
    streamingSession.lastChunkTime = now;
    
    if (timeSinceLastChunk > 2000 || streamingSession.totalSamples < 50000) {
      fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'handlers.ts:chunk',message:'Chunk received',data:{chunkLen:chunk.length,totalSamples:streamingSession.totalSamples,timeSinceLastChunk,sessionId:streamingSession.id},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'PAUSE',runId:'post-fix4'})}).catch(()=>{});
    }
    
    // Log if there was a significant gap (potential pause in speech)
    if (timeSinceLastChunk > 1000) {
      console.log(`[STT Streaming] Gap detected: ${timeSinceLastChunk}ms since last chunk`);
    }
    
    streamingSession.audioBuffer.push(chunk);
    streamingSession.totalSamples += chunk.length;

    // PHASE 1 OPTIMIZATION: Transcription triggering strategy for "blazing fast first words"
    // 
    // AudioWorklet now emits FIRST chunk faster (12000 samples at 48kHz = ~4000 at 16kHz).
    // With 4000 samples lead-in silence, first chunk gives us: 4000 + 4000 = 8000 samples.
    // 
    // Strategy:
    // - First transcription: 8000 samples (~500ms) - triggers on first audio chunk
    // - Subsequent: 8000 samples for consistent, quality updates
    //
    // This balances speed (first words in ~500ms) with quality (enough context).
    const isFirstTranscription = streamingSession.transcriptionCount === 0;
    const MIN_SAMPLES_FIRST = 8000; // ~500ms - enough context for quality
    const MIN_SAMPLES_SUBSEQUENT = 8000; // 500ms - consistent updates
    
    const minSamples = isFirstTranscription ? MIN_SAMPLES_FIRST : MIN_SAMPLES_SUBSEQUENT;
    
    // Check if we should transcribe
    // With lead-in silence (4000) + first chunk (8000) = 12000 >= 10000, first transcription triggers immediately
    const shouldTranscribe = streamingSession.totalSamples >= minSamples;
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'handlers.ts:transcribeCheck',message:'Checking transcription threshold',data:{totalSamples:streamingSession.totalSamples,minSamples,shouldTranscribe,isTranscribing,pendingTranscription},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A',runId:'post-fix4'})}).catch(()=>{});
    if (shouldTranscribe) {
      triggerTranscription(streamingSession, event.sender, streamingSession.id);
    }

    // Return immediately with last known partial (non-blocking)
    return { 
      success: true, 
      samples: streamingSession.totalSamples,
      partial: streamingSession.lastTranscription
    };
  });

  // STT Streaming: End session and get final transcription
  ipcMain.handle('stt:stream-end', async (event) => {
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'handlers.ts:streamEnd',message:'stream-end called',data:{hasSession:!!streamingSession,sessionId:streamingSession?.id,totalSamples:streamingSession?.totalSamples,lastTranscription:streamingSession?.lastTranscription?.slice(0,60)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'END',runId:'post-fix4'})}).catch(()=>{});
    
    if (!streamingSession) {
      return { success: false, error: 'No active streaming session' };
    }

    console.log(`[STT Streaming] Ending session ${streamingSession.id}, total samples: ${streamingSession.totalSamples}`);

    // Concatenate all buffers for final transcription
    const totalLength = streamingSession.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
    
    if (totalLength < 8000) { // Less than 0.5 seconds
      const session = streamingSession;
      streamingSession = null;
      return { 
        success: false, 
        error: 'Recording too short',
        sessionId: session.id
      };
    }

    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const buf of streamingSession.audioBuffer) {
      combined.set(buf, offset);
      offset += buf.length;
    }

    try {
      const result = await sttServer.transcribeBuffer(combined);
      const session = streamingSession;
      streamingSession = null;

      return {
        success: result.success,
        transcription: result.transcription || session.lastTranscription,
        sessionId: session.id,
        audio_duration_ms: result.audio_duration_ms,
        inference_time_ms: result.inference_time_ms,
        model: result.model
      };
    } catch (error: any) {
      const session = streamingSession;
      streamingSession = null;
      return { 
        success: false, 
        error: error.message,
        transcription: session?.lastTranscription || '',
        sessionId: session?.id || ''
      };
    }
  });

  // Text: Live paste - update text in target app as user speaks
  // Uses CGEvent keyboard simulation via type-text tool
  // 
  // Strategy: Type only the NEW characters (delta) to avoid retyping everything
  ipcMain.handle('text:live-paste', async (event, { text, previousLength }: { text: string; previousLength: number }) => {
    console.log(`[Live Paste] Called with text="${text.substring(0, 30)}..." (${text.length} chars), previousLength=${previousLength}`);
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'handlers.ts:live-paste',message:'Live paste handler called',data:{textLen:text.length,textPreview:text.substring(0,40),previousLength},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'PASTE',runId:'post-fix5'})}).catch(()=>{});
    
    try {
      if (text.length === 0) {
        console.log(`[Live Paste] Empty text, skipping`);
        return { success: true, pastedLength: 0, method: 'none' };
      }
      
      // Only type the new characters (delta from previous)
      const newText = text.substring(previousLength);
      if (newText.length === 0) {
        console.log(`[Live Paste] No new text to type`);
        return { success: true, pastedLength: text.length, method: 'none' };
      }
      
      console.log(`[Live Paste] Pasting delta: "${newText}" (${newText.length} chars)`);
      
      // Use paste-text tool (clipboard + Cmd+V) which is more reliable
      const pasteToolPath = app.isPackaged
        ? path.join(process.resourcesPath, 'tools', 'paste-text')
        : path.join(app.getAppPath(), 'tools', 'paste-text');
      
      if (!fs.existsSync(pasteToolPath)) {
        console.error(`[Live Paste] paste-text tool not found at ${pasteToolPath}`);
        return { success: false, error: 'paste-text tool not found' };
      }
      
      return new Promise((resolve) => {
        const proc = spawn(pasteToolPath, [newText]);
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout?.on('data', (data) => {
          stdout += data.toString();
        });
        
        proc.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        
        proc.on('close', (code) => {
          console.log(`[Live Paste] type-text exited with code ${code}, stdout: "${stdout.trim()}", stderr: "${stderr.trim()}"`);
          fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'handlers.ts:live-paste-done',message:'Paste tool completed',data:{exitCode:code,stdout:stdout.trim(),stderr:stderr.trim(),textLen:newText.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'PASTE',runId:'post-fix5'})}).catch(()=>{});
          if (code === 0) {
            // Send result back to renderer for logging
            event.sender.send('live-paste-debug', { success: true, stdout: stdout.trim(), chars: newText.length });
            resolve({ success: true, pastedLength: text.length, method: 'cgevent', debug: stdout.trim() });
          } else {
            event.sender.send('live-paste-debug', { success: false, stderr: stderr.trim(), code });
            resolve({ success: false, error: stderr || `Exit code ${code}` });
          }
        });
        
        proc.on('error', (err) => {
          console.error(`[Live Paste] spawn error:`, err);
          event.sender.send('live-paste-debug', { success: false, error: err.message });
          resolve({ success: false, error: err.message });
        });
        
        // Timeout after 3 seconds
        setTimeout(() => {
          proc.kill();
          resolve({ success: false, error: 'Timeout' });
        }, 3000);
      });
      
    } catch (error: any) {
      console.error('[Live Paste] Unexpected error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Text: Clear live paste state
  ipcMain.handle('text:live-paste-clear', async () => {
    const injectToolPath = app.isPackaged
      ? path.join(process.resourcesPath, 'tools', 'inject-text')
      : path.join(app.getAppPath(), 'tools', 'inject-text');
    
    if (fs.existsSync(injectToolPath)) {
      try {
        execSync(`"${injectToolPath}" --clear`, { timeout: 2000 });
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'inject-text tool not found' };
  });
  
  // Text: Send Enter key after live paste completes
  ipcMain.handle('text:live-paste-enter', async () => {
    const injectToolPath = app.isPackaged
      ? path.join(process.resourcesPath, 'tools', 'inject-text')
      : path.join(app.getAppPath(), 'tools', 'inject-text');
    
    if (fs.existsSync(injectToolPath)) {
      try {
        execSync(`"${injectToolPath}" --enter`, { timeout: 2000 });
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'inject-text tool not found' };
  });
  
  // Text: Correct live paste - select previously pasted text and replace with correct text
  // This is used for final reconciliation when the final transcription differs from what was live-pasted
  ipcMain.handle('text:correct-live-paste', async (event, { charsToReplace, correctText }: { charsToReplace: number; correctText: string }) => {
    console.log(`[Correct Live Paste] Selecting ${charsToReplace} chars to replace with "${correctText.substring(0, 30)}..."`);
    
    const startTime = Date.now();
    
    try {
      // Strategy: Use Cmd+Shift+Left Arrow to select by WORD (much faster than char by char)
      // Or use Cmd+A to select all in some contexts
      // For now, using character selection but batched
      
      // Build AppleScript to select text and paste correction
      // OPTIMIZATION: Use Shift+Cmd+Left to select by word when possible
      const script = `
        tell application "System Events"
          -- Select the text we previously pasted using Shift+Left Arrow
          repeat ${charsToReplace} times
            key code 123 using shift down
          end repeat
          delay 0.05
        end tell
      `;
      
      
      // First select the text
      await new Promise<void>((resolve, reject) => {
        const osascript = spawn('osascript', ['-e', script]);
        let stderr = '';
        
        osascript.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        
        osascript.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Selection failed: ${stderr}`));
          }
        });
        
        osascript.on('error', reject);
      });
      
      // Small delay to ensure selection is complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Now paste the correct text (replaces selection)
      const pasteToolPath = app.isPackaged
        ? path.join(process.resourcesPath, 'tools', 'paste-text')
        : path.join(app.getAppPath(), 'tools', 'paste-text');
      
      if (!fs.existsSync(pasteToolPath)) {
        return { success: false, error: 'paste-text tool not found' };
      }
      
      
      return new Promise((resolve) => {
        const proc = spawn(pasteToolPath, [correctText]);
        let stdout = '';
        let stderr = '';
        
        proc.stdout?.on('data', (data) => { stdout += data.toString(); });
        proc.stderr?.on('data', (data) => { stderr += data.toString(); });
        
        proc.on('close', (code) => {
          if (code === 0) {
            console.log(`[Correct Live Paste] Successfully replaced ${charsToReplace} chars`);
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `paste-text exited with code ${code}` });
          }
        });
        
        proc.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
        
        setTimeout(() => {
          proc.kill();
          resolve({ success: false, error: 'Timeout' });
        }, 5000);
      });
      
    } catch (error: any) {
      console.error('[Correct Live Paste] Error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Text: Undo and replace - reliable method for final text correction
  // Uses Cmd+Z to undo all paste operations, then pastes the corrected text once
  // This is much more reliable than the 846 Shift+Left Arrow approach
  ipcMain.handle('text:undo-and-replace', async (event, { undoCount, correctText }: { 
    undoCount: number; 
    correctText: string;
  }) => {
    console.log(`[Undo & Replace] Undoing ${undoCount} operations, then pasting "${correctText.substring(0, 30)}..."`);
    
    const startTime = Date.now();
    
    try {
      // Step 1: Undo all paste operations using Cmd+Z
      // We batch undos in groups for efficiency
      const batchSize = 20; // Undo up to 20 at a time
      let remaining = undoCount;
      
      while (remaining > 0) {
        const batch = Math.min(remaining, batchSize);
        const undoScript = `
          tell application "System Events"
            repeat ${batch} times
              keystroke "z" using command down
              delay 0.02
            end repeat
          end tell
        `;
        
        await new Promise<void>((resolve, reject) => {
          const osascript = spawn('osascript', ['-e', undoScript]);
          let stderr = '';
          
          osascript.stderr?.on('data', (data) => {
            stderr += data.toString();
          });
          
          osascript.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Undo failed: ${stderr}`));
            }
          });
          
          osascript.on('error', reject);
        });
        
        remaining -= batch;
        
        // Small delay between batches
        if (remaining > 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      
      
      // Small delay to ensure all undos are processed
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Step 2: Paste the corrected text
      const pasteToolPath = app.isPackaged
        ? path.join(process.resourcesPath, 'tools', 'paste-text')
        : path.join(app.getAppPath(), 'tools', 'paste-text');
      
      if (!fs.existsSync(pasteToolPath)) {
        return { success: false, error: 'paste-text tool not found' };
      }
      
      return new Promise((resolve) => {
        const proc = spawn(pasteToolPath, [correctText]);
        let stdout = '';
        let stderr = '';
        
        proc.stdout?.on('data', (data) => { stdout += data.toString(); });
        proc.stderr?.on('data', (data) => { stderr += data.toString(); });
        
        proc.on('close', (code) => {
          if (code === 0) {
            console.log(`[Undo & Replace] Successfully replaced text after ${undoCount} undos`);
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `paste-text exited with code ${code}` });
          }
        });
        
        proc.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
        
        setTimeout(() => {
          proc.kill();
          resolve({ success: false, error: 'Timeout' });
        }, 5000);
      });
      
    } catch (error: any) {
      console.error('[Undo & Replace] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // PHASE 3: Text: Correct a specific sentence - used for rolling sentence correction
  // This is called during recording when a previous sentence has been improved in transcription.
  // Silent correction: find the old sentence text and replace with the improved version.
  ipcMain.handle('text:correct-sentence', async (event, { sentenceIndex, oldText, newText }: { 
    sentenceIndex: number; 
    oldText: string; 
    newText: string;
  }) => {
    console.log(`[Correct Sentence ${sentenceIndex}] "${oldText.substring(0, 20)}..." → "${newText.substring(0, 20)}..."`);
    
    try {
      // Strategy: Use Find & Replace behavior with keyboard shortcuts
      // This is less reliable than the character-count approach but allows targeting specific text
      // For now, we use the same select-and-replace approach, but we need to find the sentence first
      
      // The most reliable approach is to count characters to the sentence start
      // However, this requires knowing the exact offset, which is complex
      
      // Simplified approach: If oldText and newText are similar lengths and differ only slightly,
      // skip the correction (final reconciliation will handle it)
      // This prevents jarring mid-recording corrections for minor changes
      
      const lengthDiff = Math.abs(oldText.length - newText.length);
      const normalizedOld = oldText.toLowerCase().replace(/[.,!?]/g, '').trim();
      const normalizedNew = newText.toLowerCase().replace(/[.,!?]/g, '').trim();
      
      if (normalizedOld === normalizedNew) {
        // Only punctuation/capitalization changed - not worth the disruption
        console.log(`[Correct Sentence ${sentenceIndex}] Skipping minor correction`);
        return { success: true, skipped: true };
      }
      
      // For significant changes, log but don't disrupt
      // The final reconciliation will fix everything at the end
      // This is a design decision: we prioritize smooth experience over perfect mid-stream accuracy
      console.log(`[Correct Sentence ${sentenceIndex}] Deferring to final reconciliation (${lengthDiff} char diff)`);
      return { success: true, deferred: true };
      
    } catch (error: any) {
      console.error('[Correct Sentence] Error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Input Method: Get status
  ipcMain.handle('input-method:status', async () => {
    const { getInputMethodStatus } = await import('../setup/inputMethodSetup');
    return getInputMethodStatus();
  });
  
  // Input Method: Install
  ipcMain.handle('input-method:install', async () => {
    const { installInputMethod } = await import('../setup/inputMethodSetup');
    return installInputMethod();
  });
  
  // Input Method: Open settings
  ipcMain.handle('input-method:open-settings', async () => {
    const { openInputSourceSettings } = await import('../setup/inputMethodSetup');
    openInputSourceSettings();
    return { success: true };
  });
  
  // Input Source: Get current input source ID
  ipcMain.handle('input-source:get-current', async () => {
    const switchToolPath = app.isPackaged
      ? path.join(process.resourcesPath, 'tools', 'switch-input')
      : path.join(app.getAppPath(), 'tools', 'switch-input');
    
    if (!fs.existsSync(switchToolPath)) {
      return { success: false, error: 'switch-input tool not found' };
    }
    
    try {
      const result = execSync(`"${switchToolPath}" --get`, { encoding: 'utf-8', timeout: 5000 });
      return { success: true, sourceId: result.trim() };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });
  
  // Input Source: Switch to specified input source
  ipcMain.handle('input-source:switch-to', async (event, sourceId: string) => {
    const switchToolPath = app.isPackaged
      ? path.join(process.resourcesPath, 'tools', 'switch-input')
      : path.join(app.getAppPath(), 'tools', 'switch-input');
    
    if (!fs.existsSync(switchToolPath)) {
      return { success: false, error: 'switch-input tool not found' };
    }
    
    try {
      execSync(`"${switchToolPath}" --to "${sourceId}"`, { encoding: 'utf-8', timeout: 5000 });
      console.log(`[Input Source] Switched to: ${sourceId}`);
      return { success: true };
    } catch (e: any) {
      console.error(`[Input Source] Switch failed:`, e.message);
      return { success: false, error: e.message };
    }
  });
  
  // Input Source: Switch to Outloud Input
  ipcMain.handle('input-source:switch-to-outloud', async () => {
    const switchToolPath = app.isPackaged
      ? path.join(process.resourcesPath, 'tools', 'switch-input')
      : path.join(app.getAppPath(), 'tools', 'switch-input');
    
    if (!fs.existsSync(switchToolPath)) {
      return { success: false, error: 'switch-input tool not found' };
    }
    
    try {
      execSync(`"${switchToolPath}" --to-outloud`, { encoding: 'utf-8', timeout: 5000 });
      console.log('[Input Source] Switched to Outloud Input');
      return { success: true };
    } catch (e: any) {
      console.error('[Input Source] Switch to Outloud failed:', e.message);
      return { success: false, error: e.message };
    }
  });

  // STT: Install Parakeet
  ipcMain.handle('stt:install-parakeet', async (event) => {
    console.log('[STT] Installing parakeet-mlx...');
    const pythonPath = getPythonPath();
    
    return new Promise((resolve) => {
      let lastProgress = '';
      
      // Send progress updates (debounced)
      const sendProgress = (message: string) => {
        if (message !== lastProgress) {
          lastProgress = message;
          event.sender.send('stt:install-progress', message);
          console.log('[STT Install]', message);
        }
      };
      
      sendProgress('Starting pip install...');
      
      // Run pip install with verbose output
      const pip = spawn(pythonPath, ['-m', 'pip', 'install', '--progress-bar', 'on', 'parakeet-mlx'], {
        env: { ...process.env, PYTHONUNBUFFERED: '1', PIP_PROGRESS_BAR: 'on' }
      });
      
      let output = '';
      let errorOutput = '';
      let downloadCount = 0;
      
      // Periodic progress update
      const progressInterval = setInterval(() => {
        if (downloadCount > 0) {
          sendProgress(`Downloading packages (${downloadCount} files)...`);
        }
      }, 3000);
      
      pip.stdout?.on('data', (data) => {
        const text = data.toString();
        output += text;
        console.log('[pip stdout]', text.substring(0, 100));
        
        // Parse progress from pip output
        if (text.includes('Collecting')) {
          sendProgress('Collecting dependencies...');
        } else if (text.includes('Downloading')) {
          downloadCount++;
          sendProgress(`Downloading packages...`);
        } else if (text.includes('Installing')) {
          sendProgress('Installing packages...');
        } else if (text.includes('Successfully installed')) {
          sendProgress('Installation complete!');
        }
      });
      
      pip.stderr?.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        console.log('[pip stderr]', text.substring(0, 100));
        
        // pip uses stderr for progress bars and warnings
        if (text.includes('Downloading')) {
          downloadCount++;
          // Try to extract size
          const sizeMatch = text.match(/(\d+(?:\.\d+)?\s*(?:kB|MB|GB))/i);
          if (sizeMatch) {
            sendProgress(`Downloading: ${sizeMatch[1]}...`);
          } else {
            sendProgress('Downloading packages...');
          }
        } else if (text.includes('%')) {
          // Progress percentage
          const match = text.match(/(\d+)%/);
          if (match) {
            sendProgress(`Downloading: ${match[1]}%...`);
          }
        } else if (text.includes('Requirement already satisfied')) {
          sendProgress('Checking dependencies...');
        }
      });
      
      pip.on('close', (code) => {
        clearInterval(progressInterval);
        
        if (code === 0) {
          console.log('[STT] parakeet-mlx installed successfully');
          console.log('[STT] Full output:', output.substring(0, 500));
          sendProgress('Parakeet installed successfully!');
          resolve({ success: true });
        } else {
          console.error('[STT] parakeet-mlx installation failed with code:', code);
          console.error('[STT] stderr:', errorOutput.substring(0, 500));
          sendProgress('Installation failed - check console');
          resolve({ 
            success: false, 
            error: errorOutput.substring(0, 200) || `pip exited with code ${code}`
          });
        }
      });
      
      pip.on('error', (error) => {
        clearInterval(progressInterval);
        console.error('[STT] pip spawn error:', error);
        sendProgress('Installation error');
        resolve({ success: false, error: error.message });
      });
      
      // Timeout after 10 minutes (large download)
      setTimeout(() => {
        clearInterval(progressInterval);
        pip.kill();
        sendProgress('Installation timed out (10 min)');
        resolve({ success: false, error: 'Installation timed out after 10 minutes' });
      }, 600000);
    });
  });

  // Audio: Play audio file
  ipcMain.handle('audio:play', async (event, request: AudioPlayRequest): Promise<AudioPlayResult> => {
    try {
      // Read the audio file and convert to base64 data URL
      const audioBuffer = await fs.promises.readFile(request.path);
      const base64Audio = audioBuffer.toString('base64');
      const dataUrl = `data:audio/wav;base64,${base64Audio}`;
      
      // Send data URL to renderer to play
      event.sender.send('audio:play-file', dataUrl);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Audio: Stop playback
  ipcMain.handle('audio:stop', async () => {
    return { success: true };
  });

  // Text: Get selected text from active application
  // Works globally across browsers, text editors, and other apps
  // Enhanced for Electron apps like Cursor with better clipboard handling
  let isGettingSelection = false;
  let lastSelectionTime = 0;
  
  ipcMain.handle('text:get-selection', async () => {
    // Debounce: if we're already processing or called too recently, skip
    const now = Date.now();
    if (isGettingSelection || now - lastSelectionTime < 500) {
      fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'handlers.ts:debounce',message:'Debounced - too rapid',data:{isGettingSelection,timeSinceLast:now-lastSelectionTime},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'M'})}).catch(()=>{});
      return { success: false, error: 'Already processing selection' };
    }
    isGettingSelection = true;
    lastSelectionTime = now;
    
    try {
      // Check for accessibility permissions on macOS
      if (process.platform === 'darwin') {
        const accessibilityEnabled = systemPreferences.isTrustedAccessibilityClient(true);
        if (!accessibilityEnabled) {
          console.log('Requesting accessibility permissions...');
          isGettingSelection = false;
          return { success: false, error: 'Accessibility permission required. Please grant access in System Settings.' };
        }
      }
      
      const clipboardStartTime = Date.now();
      
      // Store original clipboard content for restoration
      const originalClipboard = clipboard.readText();
      const originalFormats = clipboard.availableFormats();
      console.log('[Rift] Original clipboard formats:', originalFormats);
      
      // Clear clipboard first so we can detect if copy actually worked
      clipboard.clear();
      
      // Get the frontmost app FIRST (before any window operations)
      // This captures which app the user was in when they pressed the shortcut
      let sourceAppName = '';
      try {
        const getAppScript = `
          tell application "System Events"
            set frontApp to first application process whose frontmost is true
            return name of frontApp
          end tell
        `;
        const result = await new Promise<string>((resolve, reject) => {
          const proc = spawn('osascript', ['-e', getAppScript]);
          let stdout = '';
          proc.stdout?.on('data', (data) => { stdout += data.toString(); });
          proc.on('close', () => resolve(stdout.trim()));
          proc.on('error', reject);
        });
        sourceAppName = result;
        console.log('[Rift] Source app:', sourceAppName);
        fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'handlers.ts:sourceApp',message:'Source app detected',data:{sourceAppName,willActivate:sourceAppName && sourceAppName !== 'Electron'},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'L'})}).catch(()=>{});
      } catch (e) {
        console.error('[Rift] Failed to get source app:', e);
      }
      
      // Send copy command AND verify frontmost app in ONE AppleScript call
      // IMPORTANT: Don't use 'activate' for Safari - it clears text selection!
      // Safari and Brave need special handling - just send the keystroke directly
      const browserApps = ['Safari', 'Brave Browser', 'Google Chrome', 'Firefox', 'Arc'];
      const isBrowser = browserApps.some(b => sourceAppName?.includes(b));
      
      const fs2 = require('fs');
      
      const script = isBrowser
        ? `
          -- For browsers: DON'T activate - it clears selection!
          -- But DO ensure the browser is frontmost before copying
          tell application "System Events"
            delay 0.08
            set frontAppBefore to name of first application process whose frontmost is true
            -- Ensure browser has keyboard focus
            tell process frontAppBefore
              set frontmost to true
            end tell
            delay 0.05
            keystroke "c" using command down
            delay 0.15
            set frontAppAfter to name of first application process whose frontmost is true
            return frontAppBefore & "|" & frontAppAfter
          end tell
        `
        : sourceAppName && sourceAppName !== 'Electron'
          ? `
            tell application "${sourceAppName}" to activate
            delay 0.1
            tell application "System Events"
              set frontAppBefore to name of first application process whose frontmost is true
              keystroke "c" using command down
              delay 0.08
              set frontAppAfter to name of first application process whose frontmost is true
              return frontAppBefore & "|" & frontAppAfter
            end tell
          `
          : `
            tell application "System Events"
              delay 0.08
              set frontAppBefore to name of first application process whose frontmost is true
              keystroke "c" using command down
              delay 0.05
              set frontAppAfter to name of first application process whose frontmost is true
              return frontAppBefore & "|" & frontAppAfter
            end tell
          `;
      
      let appleScriptResult = '';
      await new Promise<void>((resolve, reject) => {
        const osascript = spawn('osascript', ['-e', script]);
        let stderr = '';
        let stdout = '';
        
        osascript.stdout?.on('data', (data) => {
          stdout += data.toString();
        });
        
        osascript.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        
        osascript.on('close', (code) => {
          appleScriptResult = stdout.trim();
          if (code === 0) {
            resolve();
          } else {
            console.error('[Rift] AppleScript error:', stderr);
            reject(new Error(`AppleScript failed: ${stderr || 'Unknown error'}`));
          }
        });
        
        osascript.on('error', (error) => {
          reject(error);
        });
      });
      
      const [frontBefore, frontAfter] = appleScriptResult.split('|');
      
      // Poll for clipboard content with exponential backoff (much faster for responsive apps)
      let clipboardContent = '';
      let attempts = 0;
      const maxAttempts = 10;
      const baseDelay = 15; // Start with 15ms
      
      while (attempts < maxAttempts) {
        const formats = clipboard.availableFormats();
        if (formats.length > 0) {
          clipboardContent = clipboard.readText();
          if (clipboardContent && clipboardContent.length > 0) {
            break; // Got content!
          }
        }
        // Exponential backoff: 15, 20, 30, 45, 67, 100, 150...
        const delay = Math.min(baseDelay * Math.pow(1.5, attempts), 200);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempts++;
      }
      
      // DEBUG: Log all available clipboard formats to diagnose issues
      const newFormats = clipboard.availableFormats();
      console.log('[Rift] Clipboard formats after copy:', newFormats);
      
      const clipboardTime = Date.now() - clipboardStartTime;
      
      // Try multiple clipboard formats in priority order
      let selectedText = '';
      
      // 1. Try plain text first (most reliable)
      const plainText = clipboard.readText();
      if (plainText && plainText.trim()) {
        selectedText = plainText;
        console.log('[Rift] Got plain text:', plainText.length, 'chars');
      }
      
      // 2. If plain text is empty or looks like metadata, try HTML
      if (!selectedText || selectedText.trim() === '' || selectedText.includes('{"')) {
        const html = clipboard.readHTML();
        if (html) {
          console.log('[Rift] Raw HTML length:', html.length);
          console.log('[Rift] HTML preview:', html.substring(0, 200));
          
          // Better HTML to text conversion:
          // - Replace block elements with newlines
          // - Remove scripts and styles
          // - Strip remaining tags
          let cleaned = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')  // Remove scripts
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')    // Remove styles
            .replace(/<br\s*\/?>/gi, '\n')                      // BR to newline
            .replace(/<\/p>/gi, '\n\n')                         // Close paragraph
            .replace(/<\/div>/gi, '\n')                         // Close div
            .replace(/<\/li>/gi, '\n')                          // Close list item
            .replace(/<li[^>]*>/gi, '• ')                       // List items
            .replace(/<[^>]+>/g, '')                            // Strip remaining tags
            .replace(/&nbsp;/g, ' ')                            // Non-breaking space
            .replace(/&amp;/g, '&')                             // Ampersand
            .replace(/&lt;/g, '<')                              // Less than
            .replace(/&gt;/g, '>')                              // Greater than
            .replace(/&quot;/g, '"')                            // Quote
            .replace(/&#39;/g, "'")                             // Apostrophe
            .replace(/\n\s*\n\s*\n/g, '\n\n')                   // Collapse multiple newlines
            .trim();
          
          if (cleaned && cleaned.length > selectedText.length) {
            selectedText = cleaned;
            console.log('[Rift] Extracted from HTML:', cleaned.length, 'chars');
          }
        }
      }
      
      // 3. Try RTF as fallback (some apps use this)
      if (!selectedText || selectedText.trim() === '') {
        const rtf = clipboard.readRTF();
        if (rtf) {
          console.log('[Rift] RTF length:', rtf.length);
          // Basic RTF to text - just strip RTF commands
          const rtfText = rtf
            .replace(/\\[a-z]+\d*\s?/g, '')  // RTF commands
            .replace(/[{}]/g, '')             // Braces
            .trim();
          if (rtfText) {
            selectedText = rtfText;
            console.log('[Rift] Extracted from RTF:', rtfText.length, 'chars');
          }
        }
      }
      
      // Restore original clipboard content after a delay
      setTimeout(() => {
        if (originalClipboard && originalClipboard !== selectedText) {
          clipboard.writeText(originalClipboard);
        }
      }, 500);
      
      // Check if we actually got new text
      if (!selectedText || selectedText.trim() === '') {
        console.log('[Rift] No text captured from clipboard');
        isGettingSelection = false;
        return { success: false, error: 'No text selected' };
      }
      
      // Filter out potential metadata/JSON that Cursor might put on clipboard
      if (selectedText.startsWith('{') && selectedText.includes('"')) {
        console.warn('[Rift] Clipboard contains JSON-like content, might be metadata');
        // Try to extract any visible text from the JSON
        try {
          const parsed = JSON.parse(selectedText);
          if (parsed.text) selectedText = parsed.text;
          else if (parsed.content) selectedText = parsed.content;
          else if (parsed.message) selectedText = parsed.message;
        } catch {
          // Not valid JSON, use as-is
        }
      }
      
      // Limit text length for TTS (very long text can be slow)
      const maxLength = 10000;  // Increased from 5000
      if (selectedText.length > maxLength) {
        selectedText = selectedText.substring(0, maxLength) + '...';
        console.log('[Rift] Text truncated to', maxLength, 'characters');
      }
      
      console.log('[Rift] Final selected text:', selectedText.substring(0, 100) + (selectedText.length > 100 ? '...' : ''));
      isGettingSelection = false;
      return { success: true, text: selectedText };
    } catch (error: any) {
      console.error('[Rift] Text selection error:', error);
      isGettingSelection = false;
      return { success: false, error: error.message };
    }
  });

  // Text: Inject text at cursor position
  // Works globally across browsers, text editors, and other apps
  // Options: { autoSend?: boolean } - if true, press Enter after paste
  ipcMain.handle('text:inject', async (event, text: string, options?: { autoSend?: boolean }) => {
    try {
      // Check for accessibility permissions on macOS
      if (process.platform === 'darwin') {
        const accessibilityEnabled = systemPreferences.isTrustedAccessibilityClient(true);
        if (!accessibilityEnabled) {
          console.log('Requesting accessibility permissions for text injection...');
          return { success: false, error: 'Accessibility permission required. Please grant access in System Settings.' };
        }
      }
      
      const autoSend = options?.autoSend === true;
      const hasText = text && text.length > 0;
      
      // If no text and just auto-send, only press Enter
      if (!hasText && autoSend) {
        const enterScript = `
          tell application "System Events"
            delay 0.05
            keystroke return
          end tell
        `;
        
        await new Promise<void>((resolve, reject) => {
          const osascript = spawn('osascript', ['-e', enterScript]);
          osascript.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error('Enter key failed'));
          });
          osascript.on('error', reject);
        });
        
        return { success: true };
      }
      
      // Store original clipboard content for restoration
      const originalClipboard = clipboard.readText();
      
      // Copy text to clipboard
      clipboard.writeText(text);
      
      // Small delay to ensure clipboard is ready
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Build AppleScript: paste and optionally send
      const script = `
        tell application "System Events"
          -- Small delay for target app to be ready
          delay 0.05
          keystroke "v" using command down
          -- Wait for paste to complete
          delay 0.1
          ${autoSend ? `
          -- Auto-send: press Enter
          delay 0.05
          keystroke return
          ` : ''}
        end tell
      `;
      
      await new Promise<void>((resolve, reject) => {
        const osascript = spawn('osascript', ['-e', script]);
        let stderr = '';
        
        osascript.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        
        osascript.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            console.error('[Rift] Text injection error:', stderr);
            reject(new Error(`AppleScript failed: ${stderr || 'Unknown error'}`));
          }
        });
        
        osascript.on('error', (error) => {
          reject(error);
        });
      });
      
      // Restore original clipboard after a delay (so paste completes first)
      setTimeout(() => {
        if (originalClipboard) {
          clipboard.writeText(originalClipboard);
        }
      }, 500);
      
      console.log('[Rift] Text injected:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));
      return { success: true };
    } catch (error: any) {
      console.error('[Rift] Text injection failed:', error);
      return { success: false, error: error.message };
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // LLM HANDLERS - Qwen3 Text Processing for Live Paste Enhancement
  // ═══════════════════════════════════════════════════════════════════════════════
  // 
  // These handlers provide intelligent text processing to enhance Live Paste:
  // 
  // Phase 2: Intelligent merge - when anchor detection fails during streaming
  // Phase 3: Rolling sentence correction - clean up previous sentences
  // Phase 4: Final polish - full cleanup when recording stops
  // 
  // The LLM runs locally on Apple Silicon via Qwen3 + MLX.
  // If LLM is unavailable or slow, Live Paste gracefully falls back to heuristics.
  // 
  // See python/llm_server.py for detailed documentation.
  // ═══════════════════════════════════════════════════════════════════════════════

  // LLM: Get status
  ipcMain.handle('llm:status', async () => {
    try {
      const { llmServer } = require('../services/llmService');
      return await llmServer.getStatus();
    } catch (err: any) {
      return {
        available: false,
        fastModelLoaded: false,
        qualityModelLoaded: false,
        error: err.message,
      };
    }
  });

  // LLM: Phase 2 - Intelligent text merge
  // Called when heuristic anchor detection fails during Live Paste
  ipcMain.handle('llm:merge-text', async (_, pasted: string, newText: string) => {
    try {
      const { llmServer } = require('../services/llmService');
      return await llmServer.mergeText(pasted, newText);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // LLM: Phase 3 - Sentence correction
  // Called during rolling correction while user speaks
  ipcMain.handle('llm:correct-sentence', async (_, original: string, latest: string) => {
    try {
      const { llmServer } = require('../services/llmService');
      return await llmServer.correctSentence(original, latest);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // LLM: Extract new words (for rolling window recovery)
  // Called when rolling window recovery needs to extract only truly new words
  ipcMain.handle('llm:extract-new-words', async (_, pastedEnd: string, tailWords: string) => {
    try {
      const { llmServer } = require('../services/llmService');
      return await llmServer.extractNewWords(pastedEnd, tailWords);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // LLM: Get metrics
  ipcMain.handle('llm:metrics', async () => {
    try {
      const { llmServer } = require('../services/llmService');
      return llmServer.getMetrics();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // SILENCE POLISH - BE-Driven Silence Detection
  // ═══════════════════════════════════════════════════════════════════════════════

  // LLM: Notify speech detected (resets silence timer)
  // Called when meaningful transcription activity happens
  ipcMain.on('llm:speech-detected', () => {
    try {
      const { llmServer } = require('../services/llmService');
      llmServer.onSpeechDetected();
    } catch (err) {
      // Non-critical
    }
  });

  // LLM: Update pasted text state (keeps BE in sync with FE)
  // Called after each paste operation
  ipcMain.on('llm:update-pasted-text', (_, text: string, pasteCount: number) => {
    try {
      const { llmServer } = require('../services/llmService');
      llmServer.updatePastedText(text, pasteCount);
    } catch (err) {
      // Non-critical
    }
  });

  // LLM: Start silence monitoring for a recording session
  // BE will push polish results when 5s+ silence detected
  ipcMain.on('llm:start-silence-monitoring', (event) => {
    try {
      const { llmServer } = require('../services/llmService');
      llmServer.startSilenceMonitoring((polished: string, undoCount: number, mode: string) => {
        // Push result to renderer
        event.sender.send('llm:silence-polish-result', { polished, undoCount, mode });
      });
      console.log('[LLM] Silence monitoring started');
    } catch (err) {
      console.error('[LLM] Failed to start silence monitoring:', err);
    }
  });

  // LLM: Stop silence monitoring
  // Called when recording stops
  ipcMain.on('llm:stop-silence-monitoring', () => {
    try {
      const { llmServer } = require('../services/llmService');
      llmServer.stopSilenceMonitoring();
      console.log('[LLM] Silence monitoring stopped');
    } catch (err) {
      console.error('[LLM] Failed to stop silence monitoring:', err);
    }
  });

  // LLM: Get silence polish status (for debugging)
  ipcMain.handle('llm:silence-polish-status', async () => {
    try {
      const { llmServer } = require('../services/llmService');
      return llmServer.getSilencePolishStatus();
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // LLM: Phase 4 - Final polish
  // Called when recording stops for full cleanup
  ipcMain.handle('llm:polish-text', async (_, pastedText: string, finalText: string, mode?: string) => {
    try {
      const { llmServer } = require('../services/llmService');
      const result = await llmServer.polishText(pastedText, finalText, mode || 'clean');
      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}

/**
 * Synthesize speech using persistent TTS server (fast!)
 */
async function synthesizeLocalTTS(request: TTSRequest): Promise<TTSResult> {
  const outputPath = path.join(app.getPath('temp'), `tts_${Date.now()}.wav`);
  
  console.log('[TTS] Synthesizing:', request.text.substring(0, 50) + '...');
  const startTime = Date.now();
  
  const result = await ttsServer.synthesize(
    request.text,
    request.voice,
    request.speed,
    outputPath
  );
  
  console.log(`[TTS] Synthesis completed in ${Date.now() - startTime}ms`);
  return result;
}

/**
 * Transcribe audio using local MLX Whisper model
 */
async function transcribeAudio(audioPath: string): Promise<STTResult> {
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'python', 'mlx_stt.py')
    : path.join(app.getAppPath(), 'python', 'mlx_stt.py');

  return new Promise((resolve) => {
    const python = spawn(getPythonPath(), [
      scriptPath,
      '--audio', audioPath,
      '--model', 'mlx-community/whisper-tiny'
    ]);

    let result = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      result += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0 && result.trim()) {
        try {
          const parsed = JSON.parse(result);
          if (parsed.error) {
            resolve({ success: false, error: parsed.error });
          } else {
            resolve({ success: true, transcription: parsed.text });
          }
        } catch (e) {
          resolve({ success: false, error: `Failed to parse output: ${e}` });
        }
      } else {
        resolve({ 
          success: false, 
          error: `STT failed with code ${code}: ${errorOutput || 'Unknown error'}` 
        });
      }
    });

    python.on('error', (error) => {
      resolve({ success: false, error: `Failed to spawn Python: ${error.message}` });
    });
  });
}

/**
 * Check if mlx-audio is installed and available
 */
async function checkLocalModels(): Promise<ModelCheckResult> {
  // Check ffmpeg availability
  const ffmpegAvailable = checkFfmpeg();
  
  // First check if Python exists
  try {
    await fs.promises.access(getPythonPath(), fs.constants.X_OK);
  } catch {
    return { available: false, error: `Python not found at ${getPythonPath()}`, ffmpegAvailable };
  }
  
  return new Promise((resolve) => {
    let timedOut = false;
    
    const timeout = setTimeout(() => {
      timedOut = true;
      if (python) {
        python.kill();
      }
      resolve({ available: false, error: 'Check timed out after 5 seconds' });
    }, 5000);
    
    const python = spawn(getPythonPath(), ['-c', 'import mlx_audio; print("OK")']);
    
    let output = '';
    let errorOutput = '';
    
    python.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
      
      if (code === 0 && output.includes('OK')) {
        // ffmpeg is now bundled with the app, so no warning needed
        resolve({ available: true, ffmpegAvailable: true });
      } else {
        const errorMsg = errorOutput || 'mlx-audio not installed';
        resolve({ available: false, error: errorMsg.substring(0, 200), ffmpegAvailable }); // Limit error length
      }
    });

    python.on('error', (err) => {
      clearTimeout(timeout);
      if (timedOut) return;
      resolve({ available: false, error: `Python error: ${err.message}` });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST CAPTURE MODE
// ═══════════════════════════════════════════════════════════════════════════════
// Enable/disable capture mode for end-to-end testing of the paste pipeline

let testCaptureMode = false;
let testCaptureEvents: Array<{
  timestamp: string;
  type: string;
  text: string;
  delta: string;
  previousLength: number;
  totalPasted: string;
  success: boolean;
}> = [];

export function setupTestCaptureHandlers() {
  ipcMain.handle('test:start-capture', async () => {
    console.log('[Test Capture] Starting capture mode');
    testCaptureMode = true;
    testCaptureEvents = [];
    return { success: true, message: 'Capture mode started' };
  });
  
  ipcMain.handle('test:stop-capture', async () => {
    console.log('[Test Capture] Stopping capture mode');
    testCaptureMode = false;
    
    // Analyze for issues
    const duplicates: string[] = [];
    for (let i = 1; i < testCaptureEvents.length; i++) {
      const prev = testCaptureEvents[i - 1];
      const curr = testCaptureEvents[i];
      
      // Check for duplicate content
      if (prev.delta.length > 20) {
        const regex = new RegExp(prev.delta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        const matches = curr.totalPasted.match(regex);
        if (matches && matches.length > 1) {
          duplicates.push(prev.delta.substring(0, 50));
        }
      }
    }
    
    const lastEvent = testCaptureEvents[testCaptureEvents.length - 1];
    
    return {
      success: true,
      summary: {
        totalEvents: testCaptureEvents.length,
        finalOutput: lastEvent?.totalPasted || '',
        duplicateCount: duplicates.length,
        duplicates,
      },
      events: testCaptureEvents,
    };
  });
  
  ipcMain.handle('test:get-capture-events', async () => {
    return { events: testCaptureEvents, active: testCaptureMode };
  });
  
  // Hook to record paste events when capture mode is on
  ipcMain.on('test:record-paste', (event, data: {
    type: string;
    text: string;
    delta: string;
    previousLength: number;
    totalPasted: string;
    success: boolean;
  }) => {
    if (testCaptureMode) {
      testCaptureEvents.push({
        ...data,
        timestamp: new Date().toISOString(),
      });
      console.log(`[Test Capture] Recorded ${data.type}: "${data.delta.substring(0, 30)}..." (total: ${testCaptureEvents.length} events)`);
    }
  });
}

export function isTestCaptureActive(): boolean {
  return testCaptureMode;
}

export function recordTestCaptureEvent(data: {
  type: string;
  text: string;
  delta: string;
  previousLength: number;
  totalPasted: string;
  success: boolean;
}): void {
  if (testCaptureMode) {
    testCaptureEvents.push({
      ...data,
      timestamp: new Date().toISOString(),
    });
    console.log(`[Test Capture] Recorded ${data.type}: "${data.delta.substring(0, 30)}..." (total: ${testCaptureEvents.length} events)`);
  }
}