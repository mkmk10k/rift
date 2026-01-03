import { audioPlayer } from './audioPlayer'

/**
 * RealtimeAudioQueue - Optimized for immediate playback with minimal latency
 * 
 * Designed for true realtime TTS streaming where audio chunks arrive
 * sentence-by-sentence and need to play immediately.
 * 
 * Key optimizations:
 * - No delays between chunks
 * - Starts playback on first chunk arrival
 * - Uses tight polling when waiting for more chunks
 */
export class RealtimeAudioQueue {
  private queue: string[] = []
  private isPlaying = false
  private isStopped = false
  private isPaused = false
  private onPlayingChange: (playing: boolean) => void
  private onPauseChange: ((paused: boolean) => void) | null = null
  private onFinish: (() => void) | null = null
  private currentChunk = 0
  private streamComplete = false

  constructor(onPlayingChange: (playing: boolean) => void) {
    this.onPlayingChange = onPlayingChange
  }

  setOnPauseChange(callback: ((paused: boolean) => void) | null) {
    this.onPauseChange = callback
  }

  setOnFinish(callback: (() => void) | null) {
    this.onFinish = callback
  }

  /**
   * Add a realtime audio chunk - starts playback immediately on first chunk
   */
  addRealtimeChunk(dataUrl: string, chunkIndex: number) {
    if (this.isStopped) {
      return
    }
    
    this.queue.push(dataUrl)
    console.log(`[RealtimeQueue] Chunk ${chunkIndex} queued, queue size: ${this.queue.length}`)
    
    // Start playing immediately on first chunk - no waiting!
    if (!this.isPlaying && !this.isStopped) {
      this.playNextRealtime()
    }
  }

  markComplete() {
    this.streamComplete = true
    console.log('[RealtimeQueue] Stream marked complete')
  }

  private async playNextRealtime() {
    // If stopped (by user starting new playback), just exit silently
    // DON'T call finish() - that would trigger the old onFinish callback
    if (this.isStopped) {
      return
    }

    // If paused, wait until resumed - DON'T start any new audio
    if (this.isPaused) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StreamingAudioQueue.ts:polling',message:'Waiting for resume',data:{isPaused:this.isPaused,queueLength:this.queue.length,streamComplete:this.streamComplete},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H'})}).catch(()=>{});
      // #endregion
      setTimeout(() => this.playNextRealtime(), 50)
      return
    }

    // If queue is empty, either finish or wait (tight polling - 20ms)
    if (this.queue.length === 0) {
      if (this.streamComplete) {
        this.finish()
      } else {
        // Tight polling for more responsive playback
        setTimeout(() => this.playNextRealtime(), 20)
      }
      return
    }

    this.isPlaying = true
    this.onPlayingChange(true)
    this.currentChunk++

    const dataUrl = this.queue.shift()!
    
    try {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StreamingAudioQueue.ts:playChunk',message:'Playing chunk',data:{chunkNum:this.currentChunk,queueLength:this.queue.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H'})}).catch(()=>{});
      // #endregion
      console.log(`[RealtimeQueue] Playing chunk ${this.currentChunk}`)
      await audioPlayer.play(dataUrl)
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StreamingAudioQueue.ts:chunkDone',message:'Chunk finished',data:{chunkNum:this.currentChunk,isPaused:this.isPaused},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H'})}).catch(()=>{});
      // #endregion
    } catch (error) {
      console.error('[RealtimeQueue] Playback error:', error)
    }
    
    // Immediately try to play next - no delay!
    Promise.resolve().then(() => this.playNextRealtime())
  }

  private finish() {
    // #region agent log
    const stack = new Error().stack?.split('\n').slice(1, 4).join(' <- ') || 'no stack';
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StreamingAudioQueue.ts:finish',message:'Finish called',data:{hasOnFinish:!!this.onFinish,queueLength:this.queue.length,stack:stack.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'O'})}).catch(()=>{});
    // #endregion
    console.log('[RealtimeQueue] Finished playback')
    this.queue.length = 0
    this.isPlaying = false
    this.onPlayingChange(false)
    if (this.onFinish) {
      this.onFinish()
    }
  }

  /**
   * Pause playback - can be resumed later
   */
  pause() {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StreamingAudioQueue.ts:pause',message:'Pause called',data:{isPlaying:this.isPlaying,isPaused:this.isPaused,queueLength:this.queue.length,audioIsPlaying:audioPlayer.isPlaying},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B'})}).catch(()=>{});
    // #endregion
    if (this.isPlaying && !this.isPaused) {
      console.log('[RealtimeQueue] Pause requested')
      this.isPaused = true
      // Pause the current audio - it will stay paused until resume
      audioPlayer.pause()
      this.onPauseChange?.(true)
    }
  }

  /**
   * Resume playback from where it was paused
   * Returns true if successfully resumed, false if nothing to resume
   */
  resume(): boolean {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StreamingAudioQueue.ts:resume',message:'Resume called',data:{isPaused:this.isPaused,isPlaying:this.isPlaying,queueLength:this.queue.length,audioPlayerIsPlaying:audioPlayer.isPlaying,audioPlayerIsPaused:audioPlayer.isPaused,audioPlayerHasAudio:audioPlayer.hasAudio,streamComplete:this.streamComplete},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B,C'})}).catch(()=>{});
    // #endregion
    if (this.isPaused) {
      // Check if there's anything to resume - including the CURRENT chunk!
      // audioPlayer.isPaused means there's a paused audio chunk we can resume
      const hasCurrentChunk = audioPlayer.isPaused || audioPlayer.hasAudio
      const hasMoreInQueue = this.queue.length > 0 || !this.streamComplete
      
      if (!hasCurrentChunk && !hasMoreInQueue) {
        // Nothing left to play - finish up
        console.log('[RealtimeQueue] Nothing to resume - playback was complete')
        this.isPaused = false
        this.finish()
        return false
      }
      
      console.log('[RealtimeQueue] Resume requested, queue has', this.queue.length, 'chunks')
      this.isPaused = false
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StreamingAudioQueue.ts:resume:flagSet',message:'isPaused set to false, calling audioPlayer.resume()',data:{isPaused:this.isPaused,queueLength:this.queue.length,hasMoreInQueue,hasCurrentChunk},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H'})}).catch(()=>{});
      // #endregion
      
      // ALWAYS try to resume the audio player - this will unblock the await
      audioPlayer.resume()
      
      this.onPauseChange?.(false)
      return true
    }
    return false
  }

  /**
   * Toggle between pause and resume
   */
  togglePause(): boolean {
    if (this.isPaused) {
      this.resume()
      return false // Not paused anymore
    } else if (this.isPlaying) {
      this.pause()
      return true // Now paused
    }
    return false
  }

  get paused(): boolean {
    return this.isPaused
  }

  stop() {
    // #region agent log
    const stack = new Error().stack?.split('\n').slice(1, 5).join(' <- ') || 'no stack';
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StreamingAudioQueue.ts:stop',message:'Stop called',data:{stack:stack.substring(0,300)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'K'})}).catch(()=>{});
    // #endregion
    console.log('[RealtimeQueue] Stop requested')
    this.isStopped = true
    this.isPaused = false
    this.queue.length = 0
    audioPlayer.stop()
    this.isPlaying = false
    this.currentChunk = 0
    this.streamComplete = false
    this.onPlayingChange(false)
    this.onPauseChange?.(false)
  }

  reset() {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2b23957f-9b12-46c7-8588-a208ce0ca914',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StreamingAudioQueue.ts:reset',message:'Reset called',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'K'})}).catch(()=>{});
    // #endregion
    console.log('[RealtimeQueue] Reset')
    this.queue.length = 0
    this.queue = []
    this.isPlaying = false
    this.isStopped = false
    this.isPaused = false
    this.currentChunk = 0
    this.streamComplete = false
  }
}

/**
 * StreamingAudioQueue - Manages sequential playback of audio chunks (legacy)
 * 
 * Handles streaming TTS where audio arrives in chunks that need to be
 * played in order while more chunks are still being generated.
 */
export class StreamingAudioQueue {
  private queue: string[] = []
  private isPlaying = false
  private isStopped = false
  private onPlayingChange: (playing: boolean) => void
  private onStatusChange: (status: string) => void
  private onFinish: (() => void) | null = null
  private currentChunk = 0
  private totalChunks = 0
  private streamComplete = false

  constructor(
    onPlayingChange: (playing: boolean) => void,
    onStatusChange: (status: string) => void
  ) {
    this.onPlayingChange = onPlayingChange
    this.onStatusChange = onStatusChange
  }

  setOnFinish(callback: (() => void) | null) {
    this.onFinish = callback
  }

  addChunk(dataUrl: string, chunkIndex: number, totalChunks: number) {
    if (this.isStopped) {
      console.log('[StreamQueue] Ignoring chunk - queue stopped')
      return
    }
    
    this.totalChunks = totalChunks
    this.queue.push(dataUrl)
    console.log(`[StreamQueue] Added chunk ${chunkIndex + 1}/${totalChunks}, queue size: ${this.queue.length}`)
    
    // Start playing if not already
    if (!this.isPlaying && !this.isStopped) {
      this.playNext()
    }
  }

  markComplete() {
    this.streamComplete = true
    console.log('[StreamQueue] Stream marked complete')
  }

  private async playNext() {
    // Check if we should stop
    if (this.isStopped) {
      this.finish()
      return
    }

    // If queue is empty but stream isn't complete, wait for more chunks
    if (this.queue.length === 0) {
      if (this.streamComplete) {
        this.finish()
      } else {
        // Wait a bit and check again
        setTimeout(() => this.playNext(), 100)
      }
      return
    }

    this.isPlaying = true
    this.onPlayingChange(true)
    this.currentChunk++
    this.onStatusChange(`Playing ${this.currentChunk}/${this.totalChunks}...`)

    const dataUrl = this.queue.shift()!
    
    try {
      console.log(`[StreamQueue] Playing chunk ${this.currentChunk}`)
      await audioPlayer.play(dataUrl)
      console.log(`[StreamQueue] Chunk ${this.currentChunk} finished`)
    } catch (error) {
      console.error('[StreamQueue] Playback error:', error)
      // Continue anyway
    }
    
    // Play next chunk (with small delay to prevent audio glitches)
    setTimeout(() => this.playNext(), 50)
  }

  private finish() {
    console.log('[StreamQueue] Finished playback')
    // Clear any remaining items in queue to free memory
    this.queue.length = 0
    this.isPlaying = false
    this.onPlayingChange(false)
    this.onStatusChange('Ready')
    // Call onFinish callback (e.g., to hide window)
    if (this.onFinish) {
      this.onFinish()
    }
  }

  stop() {
    console.log('[StreamQueue] Stop requested')
    this.isStopped = true
    // Clear queue to free memory (data URLs can be large)
    this.queue.length = 0
    audioPlayer.stop()
    this.isPlaying = false
    this.currentChunk = 0
    this.totalChunks = 0
    this.streamComplete = false
    this.onPlayingChange(false)
    this.onStatusChange('Stopped')
  }

  reset() {
    console.log('[StreamQueue] Reset')
    // Clear queue to free memory
    this.queue.length = 0
    this.queue = []
    this.isPlaying = false
    this.isStopped = false
    this.currentChunk = 0
    this.totalChunks = 0
    this.streamComplete = false
  }
}
