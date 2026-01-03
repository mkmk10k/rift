/**
 * Audio Player Service for playing TTS audio files
 * Now with Web Audio API analysis for audio reactivity
 */

export type AudioLevelCallback = (level: number) => void;

export class AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private dataArray: Uint8Array | null = null;
  private animationFrame: number | null = null;
  private levelCallback: AudioLevelCallback | null = null;
  private _isPaused = false;  // Track pause state separately

  /**
   * Set callback to receive audio levels during playback (0-1 range)
   */
  setLevelCallback(callback: AudioLevelCallback | null) {
    this.levelCallback = callback;
  }

  async play(audioSource: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        console.log('[AudioPlayer] Attempting to play, source type:', 
          audioSource.startsWith('data:') ? 'data URL' : 
          audioSource.startsWith('file://') ? 'file URL' : 'path');
        
        // Stop any current playback and clean up
        this.stop();

        // Use audioSource directly (it's now a data URL from main process)
        this.audio = new Audio(audioSource);
        this.audio.crossOrigin = 'anonymous'; // Required for Web Audio API
        
        // Set up Web Audio API for level analysis
        this.setupAudioAnalysis();
        
        // Handle errors
        this.audio.onerror = (error) => {
          console.error('[AudioPlayer] Playback error:', error, this.audio?.error);
          this.cleanup();
          reject(error);
        };
        
        // Resolve when playback finishes
        this.audio.onended = () => {
          console.log('[AudioPlayer] Playback finished, isPaused:', this._isPaused);
          // Always cleanup and resolve - even if paused, the chunk is done
          // The queue will handle pausing before the next chunk
          this._isPaused = false; // Reset pause state since this chunk is done
          this.cleanup();
          resolve();
        };

        // Play the audio
        this.audio.play()
          .then(() => {
            console.log('[AudioPlayer] Playing successfully');
            this.startLevelMonitoring();
          })
          .catch((error) => {
            console.error('[AudioPlayer] Failed to start playback:', error);
            this.cleanup();
            reject(error);
          });
          
      } catch (error) {
        console.error('[AudioPlayer] Failed to play audio:', error);
        this.cleanup();
        reject(error);
      }
    });
  }

  /**
   * Set up Web Audio API analyser for audio level extraction
   */
  private setupAudioAnalysis(): void {
    if (!this.audio || !this.levelCallback) return;
    
    try {
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      
      this.sourceNode = this.audioContext.createMediaElementSource(this.audio);
      this.sourceNode.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
      
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      console.log('[AudioPlayer] Audio analysis set up');
    } catch (error) {
      console.warn('[AudioPlayer] Failed to set up audio analysis:', error);
      // Continue without analysis - playback still works
    }
  }

  /**
   * Start monitoring audio levels and calling the callback
   */
  private startLevelMonitoring(): void {
    if (!this.analyser || !this.dataArray || !this.levelCallback) return;
    
    const update = () => {
      if (!this.analyser || !this.dataArray || !this.levelCallback) return;
      
      this.analyser.getByteFrequencyData(this.dataArray);
      
      // Calculate average level (0-1 range)
      let sum = 0;
      for (let i = 0; i < this.dataArray.length; i++) {
        sum += this.dataArray[i];
      }
      const average = sum / this.dataArray.length / 255;
      
      // Boost for visibility (TTS output is often quieter than mic input)
      const boostedLevel = Math.min(1, average * 2.5);
      
      this.levelCallback(boostedLevel);
      this.animationFrame = requestAnimationFrame(update);
    };
    
    update();
  }

  /**
   * Clean up audio element to free memory
   */
  private cleanup(): void {
    // #region agent log
    const stack = new Error().stack?.split('\n').slice(1, 5).join(' <- ') || 'no stack';
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'audioPlayer.ts:cleanup',message:'Cleanup called',data:{hasAudio:!!this.audio,_isPaused:this._isPaused,stack:stack.substring(0,300)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'J'})}).catch(()=>{});
    // #endregion
    // Stop level monitoring
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    
    // Reset level to 0
    if (this.levelCallback) {
      this.levelCallback(0);
    }
    
    // Clean up Web Audio nodes
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch (e) { /* ignore */ }
      this.sourceNode = null;
    }
    
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch (e) { /* ignore */ }
      this.analyser = null;
    }
    
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (e) { /* ignore */ }
      this.audioContext = null;
    }
    
    this.dataArray = null;
    
    if (this.audio) {
      // Remove event listeners to prevent memory leaks
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.oncanplay = null;
      
      // Clear src to release memory (especially important for data URLs)
      this.audio.src = '';
      this.audio.load(); // Force browser to release the audio buffer
      
      this.audio = null;
    }
  }

  stop(): void {
    this._isPaused = false;
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.cleanup();
    }
  }

  pause(): void {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'audioPlayer.ts:pause',message:'AudioPlayer pause called',data:{hasAudio:!!this.audio,_isPaused:this._isPaused,currentTime:this.audio?.currentTime,duration:this.audio?.duration},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'I'})}).catch(()=>{});
    // #endregion
    if (this.audio) {
      this._isPaused = true;
      this.audio.pause();
      console.log('[AudioPlayer] Paused at', this.audio.currentTime);
    }
  }

  resume(): void {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'audioPlayer.ts:resume',message:'AudioPlayer resume called',data:{hasAudio:!!this.audio,_isPaused:this._isPaused,currentTime:this.audio?.currentTime,duration:this.audio?.duration,audioPaused:this.audio?.paused},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'I'})}).catch(()=>{});
    // #endregion
    // Try to resume if we have an audio element that's actually paused
    if (this.audio && this.audio.paused) {
      this._isPaused = false;
      console.log('[AudioPlayer] Resuming from', this.audio.currentTime);
      this.audio.play().catch(error => {
        console.error('Failed to resume audio:', error);
      });
    } else if (this.audio) {
      // Audio exists but isn't paused - maybe already playing or finished
      console.log('[AudioPlayer] Audio exists but not paused, currentTime:', this.audio.currentTime, 'duration:', this.audio.duration);
      this._isPaused = false;
    } else {
      // No audio element - it was cleaned up
      console.log('[AudioPlayer] No audio element to resume');
      this._isPaused = false;
    }
  }

  get isPlaying(): boolean {
    return this.audio !== null && !this.audio.paused;
  }

  get isPaused(): boolean {
    return this._isPaused && this.audio !== null;
  }

  get hasAudio(): boolean {
    return this.audio !== null;
  }
}

// Singleton instance
export const audioPlayer = new AudioPlayer();


