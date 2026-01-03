/**
 * Audio Recorder Service using Web Audio API
 * Captures microphone input and provides real-time audio levels
 */

export type AudioLevelCallback = (levels: number[]) => void;

export type StreamingChunkCallback = (pcmData: Float32Array, sampleRate: number) => void;

export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  
  // Audio analysis for live visualization
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private animationFrame: number | null = null;
  private levelCallback: AudioLevelCallback | null = null;
  
  // Streaming recording
  private isStreamingMode = false;
  private streamingCallback: StreamingChunkCallback | null = null;
  private streamBuffer: Float32Array[] = [];
  private streamSampleCount = 0;

  async startRecording(onAudioLevel?: AudioLevelCallback): Promise<void> {
    try {
      // IMPORTANT: Aggressively clean up any previous state
      // This prevents stale data from previous recordings
      if (this.mediaRecorder) {
        console.warn('[AudioRecorder] Previous recorder still exists, cleaning up...');
        try {
          if (this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.stop();
          }
        } catch (e) { /* ignore */ }
        this.mediaRecorder = null;
      }
      if (this.stream) {
        console.warn('[AudioRecorder] Previous stream still exists, stopping tracks...');
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
      }
      this.audioChunks = []; // Clear any stale chunks
      await this.stopVisualization();
      
      this.levelCallback = onAudioLevel || null;
      
      // Request fresh microphone access
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        } 
      });

      // Set up audio analysis for live visualization
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 32; // Small FFT for 16 frequency bins
      this.analyser.smoothingTimeConstant = 0.5;
      source.connect(this.analyser);
      
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      
      // Start the visualization loop
      if (this.levelCallback) {
        this.startVisualization();
      }

      // Create MediaRecorder with best available format
      const mimeType = MediaRecorder.isTypeSupported('audio/wav')
        ? 'audio/wav'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')
        ? 'audio/webm;codecs=pcm'
        : 'audio/webm;codecs=opus';
      
      console.log('Using audio format:', mimeType);
      
      // IMPORTANT: Clear chunks BEFORE creating recorder
      this.audioChunks = [];
      
      this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
      
      // Create a fresh reference to avoid closure issues
      const currentChunks = this.audioChunks;
      const currentRecorder = this.mediaRecorder;

      // Collect audio data - only push if this is still the current recorder
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && this.mediaRecorder === currentRecorder) {
          currentChunks.push(event.data);
          console.log(`[AudioRecorder] Chunk received: ${event.data.size} bytes, total chunks: ${currentChunks.length}`);
        }
      };

      // Longer delay to let the stream stabilize before recording
      // This helps avoid capturing mic initialization noise that causes hallucinations
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Double-check chunks are still empty
      if (this.audioChunks.length > 0) {
        console.warn('[AudioRecorder] Chunks not empty before start, clearing!');
        this.audioChunks = [];
      }

      // Start recording
      this.mediaRecorder.start(100); // Request data every 100ms for better control
      console.log('Recording started');
    } catch (error) {
      console.error('Failed to start recording:', error);
      throw error;
    }
  }

  private startVisualization(): void {
    const update = () => {
      if (!this.analyser || !this.dataArray || !this.levelCallback) return;
      
      this.analyser.getByteFrequencyData(this.dataArray);
      
      // Convert to normalized levels (0-1) for 12 bars
      const levels: number[] = [];
      const barsCount = 12;
      const binSize = Math.floor(this.dataArray.length / barsCount);
      
      for (let i = 0; i < barsCount; i++) {
        let sum = 0;
        for (let j = 0; j < binSize; j++) {
          sum += this.dataArray[i * binSize + j];
        }
        // Normalize to 0-1 range with some boost for visibility
        levels.push(Math.min(1, (sum / binSize / 255) * 2.5));
      }
      
      this.levelCallback(levels);
      this.animationFrame = requestAnimationFrame(update);
    };
    
    update();
  }

  private async stopVisualization(): Promise<void> {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch (e) {
        console.warn('[AudioRecorder] Error closing audio context:', e);
      }
      this.audioContext = null;
    }
    this.analyser = null;
    this.dataArray = null;
    this.levelCallback = null;
  }

  async stopRecording(): Promise<Blob> {
    // Stop visualization immediately for snappy feedback
    await this.stopVisualization();
    
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('No recording in progress'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        // Create audio blob with the mime type that was used
        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
        const audioBlob = new Blob(this.audioChunks, { type: mimeType });
        
        console.log(`[AudioRecorder] Recording stopped, chunks: ${this.audioChunks.length}, blob size: ${audioBlob.size} bytes`);
        
        // Stop all tracks IMMEDIATELY to release mic
        if (this.stream) {
          this.stream.getTracks().forEach(track => {
            track.stop();
            console.log(`[AudioRecorder] Track stopped: ${track.kind}, state: ${track.readyState}`);
          });
        }
        
        // Clean up
        this.mediaRecorder = null;
        this.stream = null;
        this.audioChunks = [];
        
        // Validate blob size - reject if too small (< 5KB likely noise/silence)
        if (audioBlob.size < 5000) {
          console.warn(`[AudioRecorder] Recording too short (${audioBlob.size} bytes), may be noise`);
        }
        
        resolve(audioBlob);
      };

      this.mediaRecorder.stop();
    });
  }

  get isRecording(): boolean {
    return this.mediaRecorder !== null && this.mediaRecorder.state === 'recording';
  }

  async cancel(): Promise<void> {
    await this.stopVisualization();
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try {
        this.mediaRecorder.stop();
      } catch (e) {
        console.warn('[AudioRecorder] Error stopping MediaRecorder:', e);
      }
    }
    // Clean up AudioWorklet
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'stop' });
        this.workletNode.disconnect();
      } catch (e) {
        console.warn('[AudioRecorder] Error stopping worklet:', e);
      }
      this.workletNode = null;
    }
    // Clean up blob URL
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    // Clean up keep-alive oscillator
    if (this.keepAliveOscillator) {
      try {
        this.keepAliveOscillator.stop();
        this.keepAliveOscillator.disconnect();
      } catch (e) { /* ignore */ }
      this.keepAliveOscillator = null;
    }
    if (this.keepAliveGain) {
      try {
        this.keepAliveGain.disconnect();
      } catch (e) { /* ignore */ }
      this.keepAliveGain = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (e) {
          console.warn('[AudioRecorder] Error stopping track:', e);
        }
      });
    }
    this.mediaRecorder = null;
    this.stream = null;
    this.audioChunks = [];
    this.isStreamingMode = false;
    this.streamingCallback = null;
    this.streamBuffer = [];
    this.streamSampleCount = 0;
  }

  // AudioWorklet node reference for cleanup
  private workletNode: AudioWorkletNode | null = null;
  private workletBlobUrl: string | null = null;
  
  // Promise resolver for capturing final flush audio during stop
  private flushResolve: ((buffer: Float32Array | null) => void) | null = null;
  private finalFlushBuffer: Float32Array | null = null;
  
  // Keep-alive oscillator to prevent browser from suspending audio during pauses
  // Without this, long pauses (5+ seconds) can cause the browser to suspend
  // the AudioWorklet, causing audio loss when the user resumes speaking.
  private keepAliveOscillator: OscillatorNode | null = null;
  private keepAliveGain: GainNode | null = null;
  
  // Pre-warm state - saves ~300-400ms on first recording
  private isPreWarmed = false;
  private preWarmPromise: Promise<void> | null = null;

  /**
   * Pre-warm the audio subsystem for faster first recording.
   * 
   * PHASE 1 OPTIMIZATION: By pre-creating the AudioContext and loading
   * the AudioWorklet on app start, we save 300-400ms when the user
   * triggers their first recording. This makes first words appear faster.
   * 
   * Call this on app mount:
   *   useEffect(() => { audioRecorder.preWarm().catch(() => {}) }, [])
   */
  async preWarm(): Promise<void> {
    // Already pre-warmed
    if (this.isPreWarmed) return;
    
    // Already pre-warming, return the existing promise
    if (this.preWarmPromise) return this.preWarmPromise;
    
    this.preWarmPromise = (async () => {
      try {
        console.log('[AudioRecorder] Pre-warming audio subsystem...');
        
        // Create AudioContext (can be done without microphone permission)
        if (!this.audioContext) {
          this.audioContext = new AudioContext();
        }
        
        // Pre-load AudioWorklet module
        if (!this.workletBlobUrl) {
          this.workletBlobUrl = this.createWorkletBlobUrl();
          await this.audioContext.audioWorklet.addModule(this.workletBlobUrl);
        }
        
        this.isPreWarmed = true;
        console.log('[AudioRecorder] Pre-warm complete. First recording will be faster.');
      } catch (error) {
        console.warn('[AudioRecorder] Pre-warm failed (non-critical):', error);
        // Non-critical - will just be slower on first recording
      }
    })();
    
    return this.preWarmPromise;
  }

  /**
   * Create an inline AudioWorklet processor as a Blob URL
   * This avoids ASAR archive issues in packaged Electron apps
   */
  private createWorkletBlobUrl(): string {
    // AUDIO CAPTURE WORKLET for Live Dictation
    // 
    // Key design decisions for natural human speech:
    // 1. Consistent 500ms chunks (24000 samples at 48kHz) for predictable latency
    // 2. Always emit chunks even during silence - prevents transcription stalls during pauses
    // 3. Time-based fallback ensures chunks are sent even if sample counting fails
    // 4. Supports ponderers, stutterers, and people who pause mid-thought
    const workletCode = `
      class PCMProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.buffer = [];
          this.sampleCount = 0;
          this.isActive = true;
          this.startTime = currentTime;
          this.lastEmitTime = currentTime;
          this.totalEmitted = 0;
          
          this.port.onmessage = (event) => {
            if (event.data.type === 'stop') {
              this.isActive = false;
              if (this.sampleCount > 0) {
                this.port.postMessage({ type: 'audio', buffer: this.flush(), sampleRate: sampleRate });
              }
              this.port.postMessage({ type: 'stopped' });
            } else if (event.data.type === 'flush') {
              if (this.sampleCount > 0) {
                this.port.postMessage({ type: 'audio', buffer: this.flush(), sampleRate: sampleRate });
              }
            }
          };
        }

        flush() {
          const totalLength = this.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
          const combined = new Float32Array(totalLength);
          let offset = 0;
          for (const chunk of this.buffer) {
            combined.set(chunk, offset);
            offset += chunk.length;
          }
          this.buffer = [];
          this.sampleCount = 0;
          this.lastEmitTime = currentTime;
          this.totalEmitted++;
          return combined;
        }

        process(inputs, outputs, parameters) {
          if (!this.isActive) return false;
          
          const input = inputs[0];
          if (input && input.length > 0) {
            const channelData = input[0];
            if (channelData && channelData.length > 0) {
              const chunk = new Float32Array(channelData.length);
              chunk.set(channelData);
              this.buffer.push(chunk);
              this.sampleCount += channelData.length;
            }
          }
          
          // Emit logic - three strategies for PHASE 1 "blazing fast first words":
          // 1. FIRST CHUNK: Emit faster (12000 samples = 250ms at 48kHz)
          //    Balance between speed and having enough audio for quality transcription
          // 2. SUBSEQUENT CHUNKS: Standard 24000 samples (500ms at 48kHz)
          // 3. TIME FALLBACK: Every 600ms regardless (handles browser throttling)
          const FIRST_CHUNK_SAMPLES = 12000;  // 250ms at 48kHz - balanced speed/quality
          const NORMAL_CHUNK_SAMPLES = 24000; // 500ms at 48kHz - smooth updates
          const TIME_FALLBACK = 0.6; // 600ms in seconds
          
          const chunkThreshold = this.totalEmitted === 0 ? FIRST_CHUNK_SAMPLES : NORMAL_CHUNK_SAMPLES;
          const timeSinceEmit = currentTime - this.lastEmitTime;
          
          const shouldEmitBySamples = this.sampleCount >= chunkThreshold;
          const shouldEmitByTime = timeSinceEmit >= TIME_FALLBACK && this.sampleCount > 0;
          
          if (shouldEmitBySamples || shouldEmitByTime) {
            this.port.postMessage({ type: 'audio', buffer: this.flush(), sampleRate: sampleRate });
          }
          
          return true;
        }
      }
      registerProcessor('pcm-processor', PCMProcessor);
    `;
    
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  }

  /**
   * Start streaming recording with real-time PCM chunks using AudioWorklet
   * AudioWorklet runs on a separate audio thread for stable, low-latency capture
   */
  async startStreamingRecording(
    onChunk: StreamingChunkCallback,
    onAudioLevel?: AudioLevelCallback
  ): Promise<void> {
    try {
      // Clean up any previous state
      await this.cancel();
      
      this.isStreamingMode = true;
      this.streamingCallback = onChunk;
      this.levelCallback = onAudioLevel || null;
      this.streamBuffer = [];
      this.streamSampleCount = 0;
      
      // Request microphone access
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });

      // PHASE 1 OPTIMIZATION: Reuse pre-warmed AudioContext if available
      // This saves ~100-200ms on the first recording
      if (!this.audioContext || this.audioContext.state === 'closed') {
        this.audioContext = new AudioContext();
        console.log('[AudioRecorder Streaming] Created new AudioContext');
      } else if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        console.log('[AudioRecorder Streaming] Resumed suspended AudioContext');
      } else {
        console.log('[AudioRecorder Streaming] Reusing pre-warmed AudioContext');
      }
      
      const source = this.audioContext.createMediaStreamSource(this.stream);
      const nativeSampleRate = this.audioContext.sampleRate;
      
      console.log(`[AudioRecorder Streaming] Native sample rate: ${nativeSampleRate}Hz`);

      // BROWSER SUSPENSION PREVENTION:
      // Create a silent oscillator that keeps the audio context active.
      // Without this, long pauses (5+ seconds of silence) can cause the browser
      // to suspend the AudioWorklet to save power. When the user resumes speaking,
      // audio is lost until the context wakes up. This is critical for ponderers!
      this.keepAliveGain = this.audioContext.createGain();
      this.keepAliveGain.gain.value = 0; // Completely silent
      this.keepAliveOscillator = this.audioContext.createOscillator();
      this.keepAliveOscillator.frequency.value = 1; // Very low frequency
      this.keepAliveOscillator.connect(this.keepAliveGain);
      this.keepAliveGain.connect(this.audioContext.destination);
      this.keepAliveOscillator.start();
      console.log('[AudioRecorder Streaming] Keep-alive oscillator started');

      // Set up analyser for visualization
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 32;
      this.analyser.smoothingTimeConstant = 0.5;
      source.connect(this.analyser);
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      if (this.levelCallback) {
        this.startVisualization();
      }

      // PHASE 1 OPTIMIZATION: Reuse pre-loaded AudioWorklet if available
      // This saves ~100-300ms on the first recording
      try {
        if (!this.workletBlobUrl || !this.isPreWarmed) {
          // Need to create and load the worklet
          if (this.workletBlobUrl) {
            URL.revokeObjectURL(this.workletBlobUrl);
          }
          this.workletBlobUrl = this.createWorkletBlobUrl();
          await this.audioContext.audioWorklet.addModule(this.workletBlobUrl);
          console.log('[AudioRecorder Streaming] AudioWorklet loaded from blob');
        } else {
          // Worklet already loaded during pre-warm - but we need a fresh blob for new context
          // If audioContext changed, we need to re-add the module
          try {
            // Try to create the node - if worklet not loaded, this will fail
            new AudioWorkletNode(this.audioContext, 'pcm-processor').disconnect();
            console.log('[AudioRecorder Streaming] Reusing pre-loaded AudioWorklet');
          } catch {
            // Worklet not in this context, reload it
            await this.audioContext.audioWorklet.addModule(this.workletBlobUrl);
            console.log('[AudioRecorder Streaming] Reloaded AudioWorklet for new context');
          }
        }
      } catch (moduleError) {
        console.error('[AudioRecorder Streaming] Failed to load AudioWorklet:', moduleError);
        if (this.workletBlobUrl) {
          URL.revokeObjectURL(this.workletBlobUrl);
          this.workletBlobUrl = null;
        }
        throw moduleError;
      }

      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
      
      // Handle audio chunks from the worklet
      // CRITICAL: This handler must work during both normal streaming AND shutdown flush
      this.workletNode.port.onmessage = (event) => {
        if (event.data.type === 'audio') {
          const { buffer, sampleRate: sourceSampleRate } = event.data;
          
          // Resample to 16kHz for the STT model
          const resampled = this.resampleTo16k(buffer, sourceSampleRate);
          
          console.log(`[AudioRecorder Streaming] Chunk: ${buffer.length} samples @ ${sourceSampleRate}Hz -> ${resampled.length} samples @ 16kHz`);
          
          // Check if we're in shutdown mode (waiting for final flush)
          if (this.flushResolve) {
            // This is the final flush audio during shutdown - capture it!
            console.log(`[AudioRecorder Streaming] Captured final flush: ${resampled.length} samples`);
            this.finalFlushBuffer = resampled;
            // Don't resolve yet - wait for 'stopped' message to ensure worklet is done
          } else if (this.isStreamingMode && this.streamingCallback) {
            // Normal streaming mode - emit the chunk
            Promise.resolve(this.streamingCallback(resampled, 16000))
              .catch(err => console.error('[AudioRecorder Streaming] Chunk callback error:', err));
          }
        } else if (event.data.type === 'stopped') {
          console.log('[AudioRecorder Streaming] Worklet confirmed stopped');
          // Resolve the flush promise now that we know worklet is done
          if (this.flushResolve) {
            this.flushResolve(this.finalFlushBuffer);
            this.flushResolve = null;
            this.finalFlushBuffer = null;
          }
        }
      };

      // Connect: source -> worklet
      source.connect(this.workletNode);
      // Note: We don't connect to destination (no playback needed)
      
      // Minimal delay to ensure the audio graph is connected
      // The audio cue plays AFTER this function returns, so users won't
      // start speaking until the system is truly ready.
      await new Promise(resolve => setTimeout(resolve, 20));
      
      console.log('[AudioRecorder Streaming] Started with AudioWorklet, ready to capture');
    } catch (error) {
      console.error('[AudioRecorder Streaming] Failed to start:', error);
      this.isStreamingMode = false;
      this.workletNode = null;
      throw error;
    }
  }

  /**
   * Stop streaming recording and return the final audio chunk.
   * 
   * CRITICAL FIX: This method now properly waits for the worklet to flush
   * and send back any remaining audio BEFORE setting isStreamingMode = false.
   * This prevents the race condition that was causing last words to be lost.
   */
  async stopStreamingRecording(): Promise<Float32Array> {
    console.log('[AudioRecorder Streaming] Stopping...');
    
    // IMPORTANT: Do NOT set isStreamingMode = false yet!
    // We need the message handler to still process the final flush audio.
    
    // Stop visualization immediately for snappy UI feedback
    await this.stopVisualization();
    
    let finalBuffer: Float32Array = new Float32Array(0);
    
    if (this.workletNode) {
      // Set up a promise to wait for the worklet's final audio and stop confirmation
      const flushPromise = new Promise<Float32Array | null>((resolve) => {
        this.flushResolve = resolve;
        this.finalFlushBuffer = null;
        
        // Timeout fallback - don't wait forever if worklet is unresponsive
        setTimeout(() => {
          if (this.flushResolve) {
            console.warn('[AudioRecorder Streaming] Flush timeout - proceeding without final audio');
            this.flushResolve(null);
            this.flushResolve = null;
          }
        }, 500); // 500ms is plenty for the round-trip
      });
      
      // Request flush first (captures remaining audio), then stop
      this.workletNode.port.postMessage({ type: 'flush' });
      this.workletNode.port.postMessage({ type: 'stop' });
      
      // Wait for the worklet to respond with flushed audio and 'stopped' confirmation
      const flushedAudio = await flushPromise;
      
      if (flushedAudio && flushedAudio.length > 0) {
        finalBuffer = flushedAudio;
        console.log(`[AudioRecorder Streaming] Captured final flush: ${finalBuffer.length} samples`);
      }
      
      // NOW it's safe to disconnect - we have the audio
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    
    // NOW set streaming mode to false - all audio has been captured
    this.isStreamingMode = false;
    
    // Cleanup blob URL
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    
    // Stop mic and cleanup
    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        track.stop();
        console.log(`[AudioRecorder Streaming] Track stopped: ${track.kind}`);
      });
    }
    
    // Stop keep-alive oscillator
    if (this.keepAliveOscillator) {
      try {
        this.keepAliveOscillator.stop();
        this.keepAliveOscillator.disconnect();
      } catch (e) {
        // Ignore - oscillator may already be stopped
      }
      this.keepAliveOscillator = null;
    }
    if (this.keepAliveGain) {
      try {
        this.keepAliveGain.disconnect();
      } catch (e) {
        // Ignore
      }
      this.keepAliveGain = null;
    }
    
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch (e) {
        console.warn('[AudioRecorder Streaming] Error closing audio context:', e);
      }
    }
    
    this.stream = null;
    this.audioContext = null;
    this.streamBuffer = [];
    this.streamSampleCount = 0;
    this.streamingCallback = null;
    
    console.log(`[AudioRecorder Streaming] Stopped, final buffer: ${finalBuffer.length} samples`);
    return finalBuffer;
  }

  /**
   * Request the AudioWorklet to flush any buffered audio.
   * Used during pauses to ensure transcription continues.
   * Essential for natural speech patterns with pondering pauses.
   */
  requestFlush(): void {
    if (this.workletNode && this.isStreamingMode) {
      this.workletNode.port.postMessage({ type: 'flush' });
    }
  }

  /**
   * Resample audio to 16kHz using linear interpolation
   */
  private resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
    const targetRate = 16000;
    
    if (inputRate === targetRate) {
      return input;
    }
    
    const ratio = targetRate / inputRate;
    const outputLength = Math.floor(input.length * ratio);
    const output = new Float32Array(outputLength);
    
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i / ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const frac = srcIndex - srcIndexFloor;
      
      if (srcIndexFloor + 1 < input.length) {
        output[i] = input[srcIndexFloor] * (1 - frac) + input[srcIndexFloor + 1] * frac;
      } else {
        output[i] = input[srcIndexFloor] || 0;
      }
    }
    
    return output;
  }

  get isStreamingRecording(): boolean {
    return this.isStreamingMode;
  }
}

// Singleton instance
export const audioRecorder = new AudioRecorder();


