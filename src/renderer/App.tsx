import { useState, useEffect, useRef, useCallback } from 'react'
import { audioPlayer } from './services/audioPlayer'
import { audioRecorder } from './services/audioRecorder'
import { StreamingAudioQueue, RealtimeAudioQueue } from './services/StreamingAudioQueue'
import { audioCues } from './services/AudioCues'
import { BlackHoleOrb, OrbState } from './components/BlackHoleOrb'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OUTLOUD LIVE PASTE ENGINE - COMPREHENSIVE FEATURE DOCUMENTATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This file contains the complete Live Paste engine that turns MLX Parakeet STT
 * output into a smooth, real-time typing experience. The model alone is NOT enough
 * - significant frontend engineering was required to achieve production quality.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CORE ARCHITECTURE: CHUNK-AND-COMMIT + STABLE WORD PASTING
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * We use a HYBRID approach combining two complementary strategies:
 * 
 * 1. CHUNK-AND-COMMIT (Backend - stt_server.py)
 *    - Backend segments audio into immutable "chunks" at natural pause points
 *    - Chunks are COMMITTED (finalized) and never re-transcribed
 *    - Eliminates the "freeze" problem where re-transcription blocks new text
 *    - Trigger: 350ms silence OR 8s force-commit during continuous speech
 * 
 * 2. STABLE WORD PASTING (Frontend - this file)
 *    - Words appearing 2+ times at same position are "stable" and pasted
 *    - Provides word-by-word feel even DURING continuous speech (before commits)
 *    - Resets on each commit, tracking fresh partials thereafter
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROBLEM SOLVED: THE "FREEZE" ISSUE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * ORIGINAL PROBLEM:
 * - MLX Parakeet uses a rolling context window (~25 seconds)
 * - As user speaks longer, transcription time grows with buffer size
 * - At ~30+ seconds, each transcription takes 500ms+
 * - Frontend must reconcile old text with new (may have shifted/truncated)
 * - Reconciliation fails → no text appears → "FREEZE"
 * 
 * HOW WE SOLVED IT:
 * - Committed chunks are IMMUTABLE - never included in next transcription
 * - Only uncommitted audio (few seconds) is transcribed → always fast
 * - Stable words paste before commit → smooth word-by-word feel
 * - Force commit every 8s ensures progress even without pauses
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEATURE: IMMEDIATE PLACEHOLDER FEEDBACK
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * When recording starts, we immediately paste "..." to show the system is working.
 * This provides <100ms perceived latency. The placeholder is then replaced with
 * actual text using correctLivePaste (select-and-overwrite).
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEATURE: ANCHOR-BASED TEXT RECONCILIATION (Legacy Fallback)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * When chunk-and-commit is not active (fallback mode), we use anchor-based
 * reconciliation to handle the rolling window:
 * 
 * 1. Find last 2-3 words of locked text in new transcription (the "anchor")
 * 2. Append words that appear AFTER the anchor
 * 3. If no anchor found, use fallback strategies:
 *    - Tail overlap detection
 *    - Never-freeze safety net (append last new word)
 *    - Re-anchor recovery
 * 
 * This is robust against rolling window truncation where early text disappears.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEATURE: SENTENCE-LEVEL CORRECTION (Phase 3)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Track pasted sentences separately for surgical corrections:
 * - Split text into sentences by punctuation (. ! ?)
 * - Track which sentences are "locked" (finalized)
 * - Allows correcting recent sentences without retyping entire text
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEATURE: SILENCE DETECTION CATCH-UP (Phase 4)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * When user pauses speaking:
 * - Detect silence via lack of new words for extended period
 * - Trigger final reconciliation to catch up any lagging text
 * - Useful for correcting errors accumulated during rapid speech
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * STATE TRACKING REFS (Performance Critical)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * - pastedTextRef: The actual pasted text (source of truth)
 * - lastPastedLengthRef: Length tracking for delta calculations
 * - lastCommittedTextRef: Backend's committed text (immutable, append-only)
 * - wordStabilityRef: Map<position, {word, count}> for stable word detection
 * - lockedWordCountRef: How many partial words have been pasted as "stable"
 * - lockedTextRef: The locked text string for anchor-based reconciliation
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TUNED PARAMETERS (Tested Values)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * BACKEND (stt_server.py):
 * - SILENCE_DURATION_FOR_COMMIT: 350ms (triggers commit on natural pause)
 * - FORCE_COMMIT_SECONDS: 8s (ensures progress during continuous speech)
 * - MIN_CHUNK_SECONDS: 0.8s (allows smaller commits for responsiveness)
 * - SILENCE_THRESHOLD: 0.015 RMS (more sensitive silence detection)
 * 
 * FRONTEND (this file):
 * - STABILITY_THRESHOLD: 2 (word must appear 2x to be stable)
 * - WORD_STABILITY_THRESHOLD: 2 (same, used in chunk-and-commit handler)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * DATA FLOW DURING DICTATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * 1. User speaks → audioRecorder captures chunks (50ms intervals)
 * 2. Chunks sent to backend via IPC → transcribe_buffer_chunked()
 * 3. Backend detects silence/force-commit, returns:
 *    - committedText: Immutable, append-only
 *    - partialText: Current uncommitted transcription
 *    - is_final: True if new chunk just committed
 * 4. Frontend receives partial result:
 *    a. If new committedText → paste difference immediately
 *    b. If partialText → track word stability, paste stable words
 * 5. On recording stop → final correction pass
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TESTING NOTES
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Test scenarios that validate this engine:
 * - 5+ minute continuous dictation (no freezes)
 * - Rapid counting: "one two three four five..." (smooth word-by-word)
 * - Natural speech with pauses (commits on pause points)
 * - Mixed fast/slow speech (force commits + pause commits)
 * 
 * Look for these log patterns in DevTools:
 * - "[Live Paste C&C] Committed:" → Backend committed a chunk
 * - "[Live Paste Stable] Pasting X stable word(s):" → Stable words pasted
 * - "[STT] COMMIT (pause)" → Silence-triggered commit
 * - "[STT] COMMIT (force)" → Duration-triggered commit
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

function App() {
  // Core state
  const [orbState, setOrbState] = useState<OrbState>('idle')
  const [isVisible, setIsVisible] = useState(false)
  
  // Settings (loaded from store, controlled via tray)
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [showLivePreview, setShowLivePreview] = useState(true)
  const [livePasteMode, setLivePasteMode] = useState(true)
  const [autoSendAfterDictation, setAutoSendAfterDictation] = useState(false)
  const [dictationMode, setDictationMode] = useState<'toggle' | 'hold'>('toggle')
  
  // Internal state
  const [modelReady, setModelReady] = useState(false)
  const [partialText, setPartialText] = useState('')
  
  // Refs for performance (avoid re-renders from audio levels)
  const audioLevelRef = useRef(0)
  const [audioLevelForRender, setAudioLevelForRender] = useState(0)
  const streamQueueRef = useRef<StreamingAudioQueue | null>(null)
  const realtimeQueueRef = useRef<RealtimeAudioQueue | null>(null)
  const playbackSpeedRef = useRef(1.0)
  const isRecordingRef = useRef(false)
  const modelReadyRef = useRef(false)
  // ═══════════════════════════════════════════════════════════════════════════
  // LIVE PASTE STATE TRACKING
  // ═══════════════════════════════════════════════════════════════════════════
  // These refs are critical for the paste engine. They track:
  // - What has been pasted (source of truth for delta calculations)
  // - What the backend has committed (immutable chunks from stt_server.py)
  // Using refs (not state) for performance - avoids re-renders on each update.
  // ═══════════════════════════════════════════════════════════════════════════
  
  // The actual text that has been pasted to the target application
  // This is the FRONTEND source of truth - includes both committed chunks
  // AND stable words that were pasted before their chunk was committed.
  const pastedTextRef = useRef('')
  
  // Legacy length tracking (keep for backward compatibility with heuristic mode)
  const lastPastedLengthRef = useRef(0)
  
  // CHUNK-AND-COMMIT: The committed text from the backend
  // This is IMMUTABLE and append-only. Once the backend commits a chunk,
  // it NEVER changes. We use this to calculate what portion is NEW
  // when the backend sends updated committed_text.
  const lastCommittedTextRef = useRef('')
  
  const handleRecordToggleRef = useRef<(() => Promise<void>) | null>(null)
  
  // PHASE 3: Sentence-level tracking for rolling correction
  // Track pasted sentences separately from full text for surgical corrections
  const pastedSentencesRef = useRef<string[]>([])
  // Track which sentences have been "locked" (corrected and finalized)
  const lockedSentenceCountRef = useRef(0)
  // Track latest STT transcription (for comparison during silence correction)
  const latestTranscriptionRef = useRef('')
  const latestSentencesRef = useRef<string[]>([])
  
  // Track the polished text from Silence Polish to prevent duplicate formatting
  // When Silence Polish runs, we store the polished text here. Final Polish then
  // only processes NEW text spoken after the silence polish, preventing duplicates.
  const silencePolishedTextRef = useRef('')
  
  // Misc state refs
  const shouldAutoHideRef = useRef(false)
  const audioLevelUpdateRef = useRef<number>(0)
  
  // PASTE COUNT: Track how many paste operations we've done during this session
  // Used for undo-and-replace final correction strategy
  const pasteCountRef = useRef(0)
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE: STABLE WORD PASTING (APPLE-STYLE)
  // ═══════════════════════════════════════════════════════════════════════════
  // 
  // WHAT IT DOES:
  // Words appearing consistently at the same position become "stable" and are
  // pasted immediately, even BEFORE the backend commits them. This gives the
  // smooth word-by-word typing feel like Apple Dictation.
  //
  // HOW IT WORKS:
  // 1. For each partial transcription, track word at each position
  // 2. If word at position N appears 2+ times consecutively → it's STABLE
  // 3. Paste stable words immediately
  // 4. On backend commit → reset stability tracking for fresh partials
  //
  // WHY IT'S NEEDED:
  // Without this, text only appears on commits (every 8s or at pauses).
  // With this, words appear as you speak them, ~200-400ms after speaking.
  //
  // EXAMPLE:
  // Partial 1: "Hello world"     → "Hello" stable (count=1), "world" (count=1)
  // Partial 2: "Hello world how" → "Hello" (count=2) PASTE, "world" (count=2) PASTE
  // Partial 3: "Hello world how are" → "how" (count=2) PASTE, "are" (count=1)
  // ═══════════════════════════════════════════════════════════════════════════
  
  // Strategy selector: 'stable-prefix' (Apple) or 'heuristic' (legacy)
  const livePasteStrategy = useRef<'stable-prefix' | 'heuristic'>('stable-prefix')
  
  // Word stability tracking: Map<position, {normalized_word, consecutive_count}>
  // Position is word index in the partial transcription
  // Reset on each backend commit (new partial context begins)
  const wordStabilityRef = useRef<Map<number, { word: string; count: number }>>(new Map())
  
  // How many words from start of current partial have been pasted as "stable"
  // This prevents re-pasting already-stable words
  const lockedWordCountRef = useRef(0)
  
  // The locked text (used in legacy anchor-based mode)
  const lockedTextRef = useRef('')
  
  // Stability threshold: word must appear this many times to be considered stable
  // Lower = faster but more risk of incorrect words, Higher = slower but safer
  // 2 is a good balance - catches most stable words quickly
  const STABILITY_THRESHOLD = 2
  
  // Helper: Tracked live paste that increments paste count and updates BE state
  // This enables reliable undo-based final correction and BE-driven silence polish
  const trackedLivePaste = useCallback(async (text: string, previousLength: number) => {
    const result = await window.outloud?.text?.livePaste?.({ text, previousLength })
    if (result?.success) {
      pasteCountRef.current++
      // Keep BE in sync with pasted text for silence polish
      window.outloud?.llm?.updatePastedText?.(text, pasteCountRef.current)
      // New paste = speech activity, reset BE silence timer
      window.outloud?.llm?.notifySpeechDetected?.()
      
      // Record for test capture (if enabled)
      window.outloud?.testCapture?.recordPaste?.({
        type: 'live-paste',
        text: text,
        delta: text.substring(previousLength),
        previousLength: previousLength,
        totalPasted: text,
        success: true
      })
    }
    return result
  }, [])
  
  // Helper: Tracked correction that also counts as a paste (for undo)
  const trackedCorrectLivePaste = useCallback(async (charsToReplace: number, correctText: string) => {
    const result = await window.outloud?.text?.correctLivePaste?.({ charsToReplace, correctText })
    if (result?.success) {
      pasteCountRef.current++ // Correction replaces, but still adds 1 paste
      // Keep BE in sync with corrected text
      window.outloud?.llm?.updatePastedText?.(correctText, pasteCountRef.current)
      window.outloud?.llm?.notifySpeechDetected?.()
    }
    return result
  }, [])
  
  // Sync refs with state
  useEffect(() => { playbackSpeedRef.current = playbackSpeed }, [playbackSpeed])
  useEffect(() => { modelReadyRef.current = modelReady }, [modelReady])
  useEffect(() => { isRecordingRef.current = orbState === 'listening' }, [orbState])
  
  // Initialize streaming queues and connect audio level callback
  useEffect(() => {
    // Connect audio player level callback to drive orb during TTS playback
    // Note: Using refs inside the callback, so no dependency needed
    audioPlayer.setLevelCallback((level) => {
      audioLevelRef.current = level
      const now = performance.now()
      if (now - audioLevelUpdateRef.current > 33) {
        audioLevelUpdateRef.current = now
        setAudioLevelForRender(level)
      }
    })
    
    // Legacy streaming queue
    streamQueueRef.current = new StreamingAudioQueue(
      (playing) => setOrbState(playing ? 'playing' : 'idle'),
      () => {} // Status changes handled by orb state
    )
    
    // New realtime queue for faster TTS playback
    realtimeQueueRef.current = new RealtimeAudioQueue(
      (playing) => setOrbState(playing ? 'playing' : 'idle')
    )
    
    return () => {
      audioPlayer.setLevelCallback(null)
    }
  }, [])
  
  // Throttled audio level updates (30fps max, not 60)
  const updateAudioLevel = useCallback((level: number) => {
    audioLevelRef.current = level
    
    // Throttle visual updates to 30fps
    const now = performance.now()
    if (now - audioLevelUpdateRef.current > 33) {
      audioLevelUpdateRef.current = now
      setAudioLevelForRender(level)
    }
  }, [])
  
  // Entrance animation
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50)
    
    const handleVisibilityChange = () => {
      if (!document.hidden) setIsVisible(true)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    
    // Escape key to hide widget (local, not global)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsVisible(false)
        setTimeout(() => window.outloud?.window?.hide(), 150)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SILENCE POLISH: Listen for BE-pushed polish results
  // BE monitors for 5s+ silence and triggers polish automatically
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!window.outloud?.llm?.onSilencePolishResult) return
    
    const cleanup = window.outloud.llm.onSilencePolishResult((result) => {
      console.log('[Silence Polish] Received from BE:', result.polished?.slice(0, 50) + '...')
      
      // Record for test capture (if enabled)
      const previousText = pastedTextRef.current
      window.outloud?.testCapture?.recordPaste?.({
        type: 'silence-polish',
        text: result.polished,
        delta: result.polished,  // Entire replacement
        previousLength: previousText.length,
        totalPasted: result.polished,
        success: true
      })
      
      // Apply the polish via undo-and-replace
      window.outloud?.text?.undoAndReplace?.({
        undoCount: result.undoCount,
        correctText: result.polished
      }).then((correctionResult) => {
        if (correctionResult?.success) {
          // Update ALL tracking state to keep Live Paste in sync
          pastedTextRef.current = result.polished
          lastPastedLengthRef.current = result.polished.length  // CRITICAL: sync Live Paste position
          pasteCountRef.current = 1  // Reset to 1 (polished text counts as single paste)
          
          // Update stable prefix state to match polished text
          lockedTextRef.current = result.polished
          lockedWordCountRef.current = result.polished.split(/\s+/).length
          
          // Also update the pasted sentences array to match the polished text
          const polishedSentences = result.polished.split(/(?<=[.!?])\s+/).filter(s => s.trim())
          pastedSentencesRef.current = polishedSentences
          lockedSentenceCountRef.current = polishedSentences.length
          
          // Notify BE of new text state
          window.outloud?.llm?.updatePastedText?.(result.polished, 1)
          
          // CRITICAL: Track this polished text to prevent Final Polish from
          // re-processing it and creating duplicates
          silencePolishedTextRef.current = result.polished
          
          console.log('[Silence Polish] Applied successfully, synced Live Paste state')
        } else {
          console.warn('[Silence Polish] Failed to apply:', correctionResult?.error)
        }
      }).catch((err) => {
        console.error('[Silence Polish] Apply error:', err)
      })
    })
    
    return cleanup
  }, [])
  
  // Check models on mount + pre-warm audio subsystem
  useEffect(() => {
    const checkModels = async () => {
      try {
        if (!window.outloud) {
          setTimeout(checkModels, 1000)
          return
        }
        const result = await window.outloud.models.check()
        setModelReady(result.available)
        
        if (result.available) {
          // Warmup for faster first inference
          await window.outloud?.stt?.warmup()
        }
      } catch (error) {
        console.error('Model check failed:', error)
      }
    }
    setTimeout(checkModels, 500)
    
    // PHASE 1: Pre-warm audio subsystem for faster first recording
    // This pre-creates AudioContext and loads AudioWorklet, saving ~300-400ms
    // on the first recording when user presses Ctrl+2.
    audioRecorder.preWarm().catch((err) => {
      console.warn('[App] Audio pre-warm failed (non-critical):', err)
    })
  }, [])
  
  // Load settings
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await window.outloud?.settings?.getAll()
        if (settings) {
          if (settings.playbackSpeed) {
            setPlaybackSpeed(settings.playbackSpeed)
            playbackSpeedRef.current = settings.playbackSpeed
          }
          if (settings.dictationMode) setDictationMode(settings.dictationMode)
          if (typeof settings.showLivePreview === 'boolean') setShowLivePreview(settings.showLivePreview)
          if (typeof settings.livePasteMode === 'boolean') setLivePasteMode(settings.livePasteMode)
          if (typeof settings.autoSendAfterDictation === 'boolean') setAutoSendAfterDictation(settings.autoSendAfterDictation)
        }
      } catch (err) {
        console.error('[Settings] Failed to load:', err)
      }
    }
    loadSettings()
    
    // Listen for settings changes from tray menu
    const cleanup = window.outloud?.settings?.onUpdate?.((key: string, value: any) => {
      if (key === 'playbackSpeed') {
        setPlaybackSpeed(value)
        playbackSpeedRef.current = value
      }
      if (key === 'dictationMode') setDictationMode(value)
      if (key === 'showLivePreview') setShowLivePreview(value)
      if (key === 'livePasteMode') setLivePasteMode(value)
      if (key === 'autoSendAfterDictation') setAutoSendAfterDictation(value)
    })
    
    return cleanup
  }, [])
  
  // Audio playback listener
  useEffect(() => {
    if (window.outloud?.audio?.onPlayFile) {
      window.outloud.audio.onPlayFile(async (audioPath: string) => {
        try {
          setOrbState('playing')
          await audioPlayer.play(audioPath)
          setOrbState('idle')
          
          // Auto-dissolve after playback
          if (shouldAutoHideRef.current) {
            shouldAutoHideRef.current = false
            setTimeout(() => {
              setIsVisible(false)
              setTimeout(() => window.outloud?.window?.hide(), 200)
            }, 300)
          }
        } catch (error) {
          setOrbState('idle')
          shouldAutoHideRef.current = false
          console.error('Audio playback error:', error)
        }
      })
    }
  }, [])
  
  // Streaming TTS listeners (legacy)
  useEffect(() => {
    if (window.outloud?.tts?.onStreamChunk) {
      window.outloud.tts.onStreamChunk((chunk) => {
        streamQueueRef.current?.addChunk(chunk.dataUrl, chunk.chunkIndex, chunk.totalChunks)
      })
    }
    
    if (window.outloud?.tts?.onStreamComplete) {
      window.outloud.tts.onStreamComplete(() => {
        streamQueueRef.current?.markComplete()
      })
    }
    
    if (window.outloud?.tts?.onStreamError) {
      window.outloud.tts.onStreamError((error) => {
        console.error('[Streaming] Error:', error.error)
        setOrbState('idle')
      })
    }
  }, [])
  
  // Realtime TTS listeners - for faster streaming playback
  useEffect(() => {
    if (window.outloud?.tts?.onRealtimeChunk) {
      window.outloud.tts.onRealtimeChunk((chunk) => {
        // First chunk triggers playing state immediately
        if (chunk.chunkIndex === 0) {
          setOrbState('playing')
        }
        realtimeQueueRef.current?.addRealtimeChunk(chunk.dataUrl, chunk.chunkIndex)
      })
    }
    
    if (window.outloud?.tts?.onRealtimeComplete) {
      window.outloud.tts.onRealtimeComplete(() => {
        realtimeQueueRef.current?.markComplete()
      })
    }
    
    if (window.outloud?.tts?.onRealtimeError) {
      window.outloud.tts.onRealtimeError((error) => {
        console.error('[Realtime TTS] Error:', error.error)
        setOrbState('idle')
      })
    }
  }, [])
  
  // Read-selection shortcut (Cmd+Option+V) - Uses REALTIME TTS for fast playback
  useEffect(() => {
    let isProcessing = false
    
    if (window.outloud?.shortcuts?.onReadSelection) {
      window.outloud.shortcuts.onReadSelection(async () => {
        if (isProcessing || !modelReadyRef.current) return
        isProcessing = true
        
        try {
          const result = await window.outloud.text.getSelection()
          
          if (result.success && result.text?.trim()) {
            // Show the orb window for TTS playback
            setIsVisible(true)
            await window.outloud?.window?.show?.()
            
            // ALWAYS stop any previous playback first - user wants fresh start
            realtimeQueueRef.current?.stop()
            streamQueueRef.current?.stop()
            
            setOrbState('processing')
            
            // Reset queue for new playback
            realtimeQueueRef.current?.reset()
            
            // Auto-dissolve when playback finishes
            realtimeQueueRef.current?.setOnFinish(() => {
              setTimeout(() => {
                setIsVisible(false)
                setTimeout(() => window.outloud?.window?.hide(), 200)
              }, 300)
            })
            
            // Use REALTIME TTS for faster streaming playback
            const ttsResult = await window.outloud.tts.synthesizeRealtime({
              text: result.text,
              voice: 'af_heart',
              speed: playbackSpeedRef.current,
              useLocal: true
            }) as { success: boolean; error?: string }
            
            if (!ttsResult.success) {
              console.error('[Read Selection] TTS failed:', ttsResult.error)
              setOrbState('idle')
              realtimeQueueRef.current?.setOnFinish(null)
            }
          }
        } catch (error) {
          console.error('Read selection error:', error)
          setOrbState('idle')
        } finally {
          isProcessing = false
        }
      })
    }
  }, [])
  
  // Voice dictation shortcut (Cmd+Shift+S)
  useEffect(() => {
    if (window.outloud?.shortcuts?.onVoiceDictation) {
      window.outloud.shortcuts.onVoiceDictation(() => {
        console.log(`[Shortcut] Voice dictation pressed: dictationMode=${dictationMode}, isRecording=${isRecordingRef.current}, orbState=${orbState}`)
        if (dictationMode === 'toggle') {
          console.log('[Shortcut] Calling handleRecordToggle...')
          handleRecordToggleRef.current?.()
        } else {
          console.log('[Shortcut] Not in toggle mode, ignoring')
        }
      })
    }
  }, [dictationMode, orbState])

  // Pause audio shortcut (Cmd+Shift+W when hiding widget)
  useEffect(() => {
    if (window.outloud?.shortcuts?.onPauseAudio) {
      window.outloud.shortcuts.onPauseAudio(() => {
        if (orbState === 'playing') {
          realtimeQueueRef.current?.pause()
          setOrbState('paused')
        }
      })
    }
  }, [orbState])
  
  // Test TTS handler (from tray menu)
  useEffect(() => {
    if (window.outloud?.shortcuts?.onTestTTS) {
      window.outloud.shortcuts.onTestTTS(async () => {
        if (!modelReadyRef.current) return
        
        setOrbState('processing')
        try {
          await window.outloud.tts.synthesize({
            text: 'Hello! Rift is working perfectly.',
            voice: 'af_heart',
            speed: playbackSpeedRef.current,
            useLocal: true
          })
        } catch (error) {
          console.error('Test TTS error:', error)
          setOrbState('idle')
        }
      })
    }
  }, [])
  
  // Hold-to-talk listeners
  useEffect(() => {
    let cleanupStart: (() => void) | undefined
    let cleanupStop: (() => void) | undefined
    
    if (window.outloud?.dictation?.onHoldStart) {
      cleanupStart = window.outloud.dictation.onHoldStart(() => {
        if (dictationMode === 'hold' && modelReadyRef.current && !isRecordingRef.current) {
          handleRecordToggleRef.current?.()
        }
      })
    }
    
    if (window.outloud?.dictation?.onHoldStop) {
      cleanupStop = window.outloud.dictation.onHoldStop(() => {
        if (dictationMode === 'hold' && isRecordingRef.current) {
          handleRecordToggleRef.current?.()
        }
      })
    }
    
    return () => {
      cleanupStart?.()
      cleanupStop?.()
    }
  }, [dictationMode])
  
  // NOTE: Partial STT results are handled by inline handler in handleRecordToggle
  // This ensures the handler is only active during recording and avoids race conditions
  // with isRecordingRef.current which depends on async React state updates
  
  // Main record toggle handler
  const handleRecordToggle = useCallback(async () => {
    console.log(`[handleRecordToggle] Entry: isRecording=${isRecordingRef.current}, modelReady=${modelReadyRef.current}, orbState=${orbState}`)
    
    if (!modelReadyRef.current) return
    
    // Don't start a new recording while still processing the previous one
    if (orbState === 'processing') {
      console.log('[handleRecordToggle] Ignoring - still processing previous recording')
      return
    }
    
    if (isRecordingRef.current) {
      // Stop recording
      console.log('[handleRecordToggle] STOPPING recording')
      isRecordingRef.current = false // Sync update to prevent toggle race condition
      setOrbState('processing')
      audioCues.playRecordStop()
      
      let transcription = ''
      
      try {
        // Clean up partial result handler
        const partialCleanup = (window as any).__partialCleanup
        if (partialCleanup) {
          partialCleanup()
          ;(window as any).__partialCleanup = null
        }
        
        // Clean up the periodic flush interval
        const flushInterval = (window as any).__flushInterval
        if (flushInterval) {
          clearInterval(flushInterval)
          ;(window as any).__flushInterval = null
        }
        
        // Stop BE-driven silence monitoring
        window.outloud?.llm?.stopSilenceMonitoring?.()
        
        if (showLivePreview && audioRecorder.isStreamingRecording) {
          const finalBuffer = await audioRecorder.stopStreamingRecording()
          
          
          if (finalBuffer.length > 0) {
            const arrayBuffer = finalBuffer.buffer.slice(
              finalBuffer.byteOffset,
              finalBuffer.byteOffset + finalBuffer.byteLength
            )
            await window.outloud?.stt?.streamChunk?.(arrayBuffer)
          }
          
          const streamEnd = await window.outloud?.stt?.streamEnd?.()
          
          
          if (streamEnd?.success && streamEnd.transcription) {
            transcription = streamEnd.transcription
            setPartialText(transcription)
          }
        } else {
          const audioBlob = await audioRecorder.stopRecording()
          const arrayBuffer = await audioBlob.arrayBuffer()
          const result = await window.outloud.stt.transcribe(arrayBuffer)
          
          if (result.success && result.transcription) {
            transcription = result.transcription
            if (showLivePreview) setPartialText(transcription)
          }
        }
      } catch (error) {
        console.error('Recording stop error:', error)
        audioCues.playError()
      } finally {
        await audioRecorder.cancel().catch(() => {})
        setIsVisible(true)
        await window.outloud?.window?.show?.().catch(() => {})
        updateAudioLevel(0)
      }
      
      if (transcription) {
        setOrbState('success')
        audioCues.playSuccess()
        
        await new Promise(resolve => setTimeout(resolve, 200))
        
        // Keep orb visible during LLM polish - user sees "processing" state
        // We'll hide the orb AFTER polish is complete (not before)
        setOrbState('processing')
        
        try {
          // ═══════════════════════════════════════════════════════════════════════
          // FINAL RECONCILIATION for live paste mode
          // ═══════════════════════════════════════════════════════════════════════
          // 
          // PHASE 4: LLM-ENHANCED FINAL POLISH
          // 
          // When recording stops, we compare pasted text with final transcription.
          // If LLM is enabled, we use Qwen3-1.7B for intelligent cleanup:
          // - Fix grammar and punctuation
          // - Remove filler words (um, uh, like) based on mode
          // - Resolve homophones using full context
          // - Preserve technical vocabulary
          // 
          // If LLM is unavailable or slow, we fall back to simple replacement.
          // ═══════════════════════════════════════════════════════════════════════
          const pastedText = pastedTextRef.current
          
          if (livePasteMode && pastedText.length > 0) {
            // We already live-pasted some text
            let finalText = transcription
            
            // Try LLM polish if enabled
            const settings = await window.outloud?.settings?.getAll?.()
            const llmEnabled = settings?.llmEnabled ?? true
            const polishMode = settings?.llmPolishMode ?? 'clean'
            
            // DUPLICATE PREVENTION: If Silence Polish already ran, only polish NEW text
            // The STT transcription still contains the original unformatted text, but
            // we've already polished it. We need to:
            // 1. Keep the silence-polished prefix
            // 2. Only send the NEW text (delta) to Final Polish
            // 3. Combine them at the end
            const silencePolished = silencePolishedTextRef.current
            let textToPolish = transcription
            let polishedPrefix = ''
            
            if (silencePolished && pastedText.startsWith(silencePolished)) {
              // Silence Polish ran - extract only the delta to polish
              polishedPrefix = silencePolished
              const deltaStartIndex = silencePolished.length
              textToPolish = pastedText.slice(deltaStartIndex).trim()
              
              if (textToPolish.length < 10) {
                // Very little new text - skip Final Polish, just use what we have
                console.log('[Final Polish] Skipping - very little new text after Silence Polish')
                finalText = pastedText
                textToPolish = '' // Signal to skip polish
              } else {
                console.log(`[Final Polish] Delta mode: keeping ${polishedPrefix.length} chars, polishing ${textToPolish.length} new chars`)
              }
            }
            
            if (llmEnabled && window.outloud?.llm?.polishText && textToPolish.length > 0) {
              try {
                console.log('[Live Paste] Using LLM for final polish (mode:', polishMode, ')')
                const polishResult = await window.outloud.llm.polishText(
                  polishedPrefix ? textToPolish : pastedText,  // Only polish delta if we have prefix
                  polishedPrefix ? textToPolish : transcription,
                  polishMode
                )
                
                if (polishResult.success && polishResult.polished) {
                  // If we have a polished prefix from Silence Polish, combine it with the new polished delta
                  if (polishedPrefix) {
                    // Add appropriate spacing between prefix and delta
                    const needsSpace = polishedPrefix.length > 0 && 
                      !polishedPrefix.endsWith('\n') && 
                      !polishedPrefix.endsWith(' ') &&
                      polishResult.polished.length > 0 &&
                      !polishResult.polished.startsWith('\n') &&
                      !polishResult.polished.startsWith(' ')
                    finalText = polishedPrefix + (needsSpace ? '\n' : '') + polishResult.polished
                    console.log(`[Final Polish] Combined: ${polishedPrefix.length} prefix + ${polishResult.polished.length} delta`)
                  } else {
                    finalText = polishResult.polished
                  }
                  console.log(`[Live Paste] LLM polish complete in ${polishResult.inferenceTimeMs}ms`)
                  
                  if (polishResult.exceededLatency) {
                    console.warn('[Live Paste] LLM polish exceeded latency threshold')
                  }
                } else {
                  console.warn('[Live Paste] LLM polish failed, using raw transcription:', polishResult.error)
                }
              } catch (err) {
                console.warn('[Live Paste] LLM error, using raw transcription:', err)
              }
            }
            
            
            if (pastedText === finalText) {
              // Perfect match - nothing to do! Already pasted correctly.
              console.log('[Live Paste] Final matches pasted text, no correction needed')
            } else {
              // Correction needed - undo all pastes and paste correct text
              console.log('[Live Paste] Correcting:', pastedText.slice(0, 30), '→', finalText.slice(0, 30))
              console.log(`[Live Paste] Paste count for undo: ${pasteCountRef.current}`)
              
              // Record for test capture (if enabled)
              window.outloud?.testCapture?.recordPaste?.({
                type: 'final-polish',
                text: finalText,
                delta: finalText,
                previousLength: pastedText.length,
                totalPasted: finalText,
                success: true
              })
              
              // Use undo-and-replace: more reliable than character selection
              const correctionResult = await window.outloud?.text?.undoAndReplace?.({
                undoCount: pasteCountRef.current,
                correctText: finalText
              })
              
              
              if (!correctionResult?.success) {
                console.error('[Live Paste] Undo & Replace failed, falling back to correctLivePaste')
                // Fallback to character-based selection
                const fallbackResult = await window.outloud?.text?.correctLivePaste?.({
                  charsToReplace: pastedText.length,
                  correctText: finalText
                })
                if (!fallbackResult?.success) {
                  console.error('[Live Paste] All correction methods failed, falling back to inject')
                  await window.outloud.text.inject(finalText, { autoSend: false })
                }
              }
            }
          } else {
            // No live paste happened, inject normally
            await window.outloud.text.inject(transcription, { autoSend: false })
          }
          
          // Handle auto-send if enabled
          if (autoSendAfterDictation) {
            await new Promise(resolve => setTimeout(resolve, 400))
            await window.outloud.text.inject('', { autoSend: true })
          }
        } catch (error) {
          console.error('Text injection error:', error)
        }
        
        // Polish complete - now hide the orb
        setOrbState('idle')
        setIsVisible(false)
        await new Promise(resolve => setTimeout(resolve, 150))
        await window.outloud?.window?.hide?.().catch(() => {})
        
        pastedTextRef.current = ''
        lastPastedLengthRef.current = 0
        lastCommittedTextRef.current = ''  // Reset chunk-and-commit state
        // Reset Apple-style stable prefix state on recording stop
        wordStabilityRef.current.clear()
        lockedWordCountRef.current = 0
        lockedTextRef.current = ''
      } else {
        // No transcription - still need to hide the orb!
        setOrbState('idle')
        pastedTextRef.current = ''
        lastPastedLengthRef.current = 0
        lastCommittedTextRef.current = ''  // Reset chunk-and-commit state
        // Reset Apple-style stable prefix state on recording stop
        wordStabilityRef.current.clear()
        lockedWordCountRef.current = 0
        lockedTextRef.current = ''
        
        // Hide the orb even when transcription failed/empty
        setIsVisible(false)
        await new Promise(resolve => setTimeout(resolve, 150))
        await window.outloud?.window?.hide?.().catch(() => {})
      }
    } else {
      // Start recording
      try {
        // CRITICAL: Do NOT play audio cue yet - recording hasn't started!
        // Playing the cue before recording starts causes users to speak
        // during initialization, losing their first words.
        
        if (livePasteMode) {
          // Keep the orb visible during live paste for visual feedback
          setIsVisible(true)
        }
        
        if (showLivePreview) {
          const startResult = await window.outloud?.stt?.streamStart?.()
          if (!startResult?.success) {
            if (livePasteMode) {
              setIsVisible(true)
              await window.outloud?.window?.show?.()
            }
            audioCues.playError()
            return
          }
          
          setPartialText('')
          pastedTextRef.current = ''
          lastPastedLengthRef.current = 0
          lastCommittedTextRef.current = ''  // Reset chunk-and-commit state
          
          // Reset Phase 3 state
          pastedSentencesRef.current = []
          lockedSentenceCountRef.current = 0
          latestTranscriptionRef.current = ''
          latestSentencesRef.current = []
          
          // Reset Silence Polish tracking (prevents duplicate detection between sessions)
          silencePolishedTextRef.current = ''
          
          // Start BE-driven silence monitoring (handles all silence detection)
          window.outloud?.llm?.startSilenceMonitoring?.()
          
          // Reset Apple-style stable prefix state
          wordStabilityRef.current.clear()
          lockedWordCountRef.current = 0
          lockedTextRef.current = ''
          
          // Reset paste count for undo-based final correction
          pasteCountRef.current = 0
          
          // PHASE 1: Immediate visual feedback via placeholder
          // Paste "..." immediately when recording starts to show system is responsive.
          // This gives users instant feedback (<100ms) that something is happening,
          // even though real transcription takes ~2 seconds to appear.
          // The placeholder will be replaced by real text when first transcription arrives.
          if (livePasteMode) {
            window.outloud?.text?.livePaste?.({
              text: '...',
              previousLength: 0
            }).then((result: any) => {
              if (result?.success) {
                pasteCountRef.current++ // Track paste for undo
                // Track placeholder so it gets replaced, not extended
                pastedTextRef.current = '...'
                lastPastedLengthRef.current = 3
                console.log('[Live Paste] Placeholder displayed')
              }
            }).catch(() => {
              // Non-critical - placeholder is just for UX
            })
          }
          
          /*
           * LIVE PASTE HANDLER - Designed for Natural Human Speech Patterns
           * 
           * This handler supports various speech styles:
           * - Stutterers: "I... I... I want" -> waits for stable output
           * - Ponderers: Long pauses mid-thought are fine
           * - Dysfluent speakers: "um", "like" handled gracefully
           * - Non-native speakers: Pauses for word search
           * 
           * We use LENGTH-BASED comparison instead of strict string matching.
           * This is more forgiving when Parakeet adjusts punctuation or
           * capitalization between transcriptions, which is common with
           * stuttering or self-corrections.
           * 
           * PHASE 3: Rolling Sentence Correction
           * While speaking sentence N, sentence N-1 gets silently corrected.
           * This creates a "trail of refinement" where the user sees previous
           * sentences improve while the current sentence is still being formed.
           * 
           * PHASE 4: Silence Correction Catch-Up
           * When user pauses for 3+ seconds, all sentences get corrected.
           * This means when they finally stop recording, text is already clean.
           * 
          * Final reconciliation (when recording stops) handles any
          * discrepancies, so we prioritize SMOOTH EXPERIENCE over
          * perfect mid-stream accuracy.
          * 
          * ═══════════════════════════════════════════════════════════════════════════
          * FUTURE: LOCAL LLM INTEGRATION (Qwen3) FOR INTELLIGENT LIVE PASTE
          * ═══════════════════════════════════════════════════════════════════════════
          * 
          * The current implementation uses heuristics (anchor detection, fuzzy matching,
          * character extension) to determine what's new in each transcription. These
          * work well but have edge cases that cause freezes or duplicates.
          * 
          * A local LLM (Qwen3-0.6B or similar) could replace/augment this logic with
          * semantic understanding. Here's the integration plan:
          * 
          * ───────────────────────────────────────────────────────────────────────────
          * PHASE 1: TIME TO FIRST WORDS (Blazing Fast)
          * ───────────────────────────────────────────────────────────────────────────
          * - LLM NOT USED: First paste must be instant (<300ms)
          * - Keep current: immediate paste of first transcription
          * - LLM warmup can happen in background during this phase
          * 
          * ───────────────────────────────────────────────────────────────────────────
          * PHASE 2: INCREMENTAL CONTINUATION (Buttery Smooth)
          * ───────────────────────────────────────────────────────────────────────────
          * - LLM TASK: Intelligent diff/merge between pasted and new text
          * - Prompt:
          *     "Given previously pasted: '{pastedText}'
          *      And new transcription: '{newText}'
          *      Return ONLY the new words to append. Handle:
          *      - Overlaps (same content at different positions)
          *      - Minor revisions (punctuation, contractions, capitalization)
          *      - Rolling window truncation (new text may start mid-sentence)
          *      Respond with just the words to append, or EMPTY if nothing new."
          * - Latency target: <100ms on M4 with Qwen3-0.6B
          * - Run in parallel with next audio chunk processing
          * 
          * ───────────────────────────────────────────────────────────────────────────
          * PHASE 3: ROLLING SENTENCE CORRECTION (Self-Healing Trail)
          * ───────────────────────────────────────────────────────────────────────────
          * - LLM TASK: Clean up previously pasted sentences
          * - When sentence N is forming, LLM corrects sentence N-2, N-1
          * - Prompt:
          *     "The following sentence was live-pasted with possible errors:
          *      Original: '{pastedSentence}'
          *      Latest transcription: '{newSentence}'
          *      Return the corrected sentence. Fix: grammar, punctuation,
          *      repeated words, transcription artifacts. Keep meaning intact."
          * - Silent replacement via AppleScript (user sees smooth corrections)
          * - Can batch multiple sentences in single LLM call
          * 
          * ───────────────────────────────────────────────────────────────────────────
          * PHASE 4: SILENCE/END CORRECTION (Final Polish)
          * ───────────────────────────────────────────────────────────────────────────
          * - LLM TASK: Full text cleanup on recording stop OR 3s+ silence
          * - Prompt:
          *     "Clean up this dictated text. Fix all errors while preserving
          *      the speaker's voice and intent:
          *      '{fullPastedText}'
          *      Final transcription for reference: '{finalTranscription}'
          *      Return the polished text."
          * - Replaces current character-level final reconciliation
          * - Can handle complex edits (sentence reordering, deduplication)
          * 
          * ───────────────────────────────────────────────────────────────────────────
          * ARCHITECTURE
          * ───────────────────────────────────────────────────────────────────────────
          * 
          * Option A: Ollama (easiest, local server)
          *   - Electron spawns `ollama serve` on startup
          *   - IPC handler calls `http://localhost:11434/api/generate`
          *   - Model: qwen3:0.6b or llama3.2:1b
          *   - Pros: Simple, well-maintained, hot-swappable models
          *   - Cons: Extra process, slight overhead
          * 
          * Option B: llama.cpp bindings (fastest, embedded)
          *   - Native Node addon (node-llama-cpp)
          *   - Load model once at startup
          *   - Pros: No extra process, minimal latency
          *   - Cons: More complex build, model locked at compile time
          * 
          * Option C: MLX Swift/Python (Apple-optimized)
          *   - Use same MLX framework as Parakeet
          *   - Run LLM in Python subprocess alongside STT server
          *   - Pros: Shares MLX optimization, single runtime
          *   - Cons: Python subprocess complexity
          * 
          * RECOMMENDATION: Start with Ollama (Option A) for easy iteration,
          * migrate to llama.cpp (Option B) for production optimization.
          * 
          * ───────────────────────────────────────────────────────────────────────────
          * IMPLEMENTATION STEPS
          * ───────────────────────────────────────────────────────────────────────────
          * 1. Add LLM service (src/main/services/llmService.ts)
          *    - Start Ollama on app launch
          *    - Pre-warm model with dummy request
          *    - Provide async `generate(prompt: string): Promise<string>`
          * 
          * 2. Add IPC handlers (src/main/ipc/handlers.ts)
          *    - 'llm:merge-text' - Phase 2 intelligent merge
          *    - 'llm:correct-sentence' - Phase 3 rolling correction
          *    - 'llm:polish-text' - Phase 4 final cleanup
          * 
          * 3. Modify Live Paste logic (this file)
          *    - Replace heuristics with LLM calls where latency allows
          *    - Keep NEVER-FREEZE fallback as safety net
          *    - Add latency tracking to dynamically skip LLM if too slow
          * 
          * 4. Add user preference
          *    - Settings toggle: "Use AI for improved accuracy"
          *    - Falls back to current heuristics if disabled or LLM unavailable
          * 
          * ───────────────────────────────────────────────────────────────────────────
          * EXPECTED IMPROVEMENTS
          * ───────────────────────────────────────────────────────────────────────────
          * - Eliminates anchor detection failures (LLM understands semantics)
          * - Handles complex revisions (contractions, rewordings)
          * - Cleaner rolling corrections (grammar-aware)
          * - Better final polish (understands context, not just character diff)
          * - Graceful degradation: falls back to heuristics if LLM unavailable
          * 
          * ═══════════════════════════════════════════════════════════════════════════
          * RESEARCH: HOW APPLE DOES LIVE TRANSCRIPTION
          * ═══════════════════════════════════════════════════════════════════════════
          * 
          * Apple's approach (iOS Dictation, Siri, Voice Memos transcription):
          * 
          * 1. ON-DEVICE MODEL: Uses a compact neural network optimized for Neural Engine
          *    - Streaming architecture with ~200ms chunks
          *    - Runs entirely on-device (no cloud for basic dictation)
          * 
          * 2. STABLE PREFIX: Apple's dictation shows "finalized" text that NEVER changes
          *    - Only the last few words are "tentative" (shown in lighter color)
          *    - Once a word passes the tentative threshold, it's locked
          *    - This prevents the "jumping text" problem we're experiencing
          * 
          * 3. CONFIDENCE SCORING: Each word has a confidence score
          *    - High confidence → immediately finalized
          *    - Low confidence → kept tentative, may be revised
          *    - Parakeet doesn't expose confidence scores (limitation)
          * 
          * 4. LANGUAGE MODEL INTEGRATION: Uses on-device LM for context
          *    - Helps resolve ambiguous phonemes ("their" vs "there")
          *    - Integrated at the ASR level, not post-processing
          * 
          * TAKEAWAY FOR US:
          * - Implement a "stable prefix" approach: lock words after N transcriptions
          * - Only allow appending, never revising live (defer to final reconciliation)
          * - Consider showing tentative words in different style (future UX)
          * 
          * ═══════════════════════════════════════════════════════════════════════════
          * RESEARCH: HOW YOUTUBE DOES LIVE CAPTIONS
          * ═══════════════════════════════════════════════════════════════════════════
          * 
          * YouTube Live's auto-captions approach:
          * 
          * 1. CHUNKED STREAMING: Audio sent in ~5 second chunks
          *    - Longer chunks = more context = better accuracy
          *    - Trade-off: higher latency (not suitable for dictation)
          * 
          * 2. BEAM SEARCH WITH REVISION WINDOW:
          *    - Uses beam search to explore multiple transcription hypotheses
          *    - Maintains a "revision window" of last N seconds
          *    - Text outside revision window is finalized
          * 
          * 3. PUNCTUATION & FORMATTING MODEL:
          *    - Separate model adds punctuation after transcription
          *    - Runs as post-processing, not inline
          *    - Could be good approach for our final reconciliation
          * 
          * 4. SPEAKER DIARIZATION: (not relevant for single-user dictation)
          * 
          * TAKEAWAY FOR US:
          * - Consider slightly longer chunks for better accuracy
          * - Implement a revision window concept (our rolling window is similar)
          * - Use LLM for punctuation/formatting in final reconciliation
          * 
          * ═══════════════════════════════════════════════════════════════════════════
          * RESEARCH: HUGGINGFACE STT ALTERNATIVES TO PARAKEET
          * ═══════════════════════════════════════════════════════════════════════════
          * 
          * Search HuggingFace for local streaming STT models that might be more accurate:
          * 
          * CANDIDATES TO EVALUATE:
          * 
          * 1. Whisper.cpp (OpenAI Whisper, C++ port)
          *    - URL: https://github.com/ggerganov/whisper.cpp
          *    - Pros: Very accurate, multiple model sizes, active community
          *    - Cons: Not designed for streaming (processes full audio)
          *    - Streaming workaround: whisper-streaming project
          * 
          * 2. Faster-Whisper (CTranslate2 optimized)
          *    - URL: https://github.com/SYSTRAN/faster-whisper
          *    - Pros: 4x faster than vanilla Whisper, Python API
          *    - Cons: Still not true streaming
          * 
          * 3. Distil-Whisper (Hugging Face)
          *    - URL: https://huggingface.co/distil-whisper
          *    - Pros: 6x faster, 49% smaller, similar accuracy
          *    - Cons: English-only, not streaming
          * 
          * 4. Moonshine (Useful Sensors)
          *    - URL: https://github.com/usefulsensors/moonshine
          *    - Pros: Designed for real-time, very fast, small model
          *    - Cons: Less accurate than Whisper
          * 
          * 5. Vosk (offline, streaming)
          *    - URL: https://alphacephei.com/vosk/
          *    - Pros: True streaming, offline, multiple languages
          *    - Cons: Less accurate than Whisper/Parakeet
          * 
          * 6. SpeechBrain (research models)
          *    - URL: https://huggingface.co/speechbrain
          *    - Pros: State-of-the-art research models
          *    - Cons: Complex setup, not optimized for production
          * 
          * 7. NeMo Parakeet variants (NVIDIA)
          *    - URL: https://huggingface.co/nvidia/parakeet-*
          *    - Current: parakeet-tdt-0.6b (what we use via MLX)
          *    - Larger: parakeet-ctc-1.1b (more accurate, slower)
          * 
          * EVALUATION CRITERIA:
          * - Streaming support (process audio chunks, not full file)
          * - Apple Silicon optimization (MLX, Metal, CoreML)
          * - Accuracy on conversational English
          * - Latency (<500ms per chunk)
          * - Model size (<1GB for fast loading)
          * 
          * NEXT STEPS:
          * 1. Benchmark current Parakeet accuracy with test corpus
          * 2. Test whisper.cpp with streaming wrapper on M4
          * 3. Evaluate Moonshine for speed vs accuracy trade-off
          * 4. Consider hybrid: fast model for live + accurate for reconciliation
          * ═══════════════════════════════════════════════════════════════════════════
          */
          
          // Helper: Split text into sentences
          const splitIntoSentences = (text: string): string[] => {
            // Split on sentence-ending punctuation followed by space or end
            // Handle common abbreviations to avoid false splits
            const cleaned = text
              .replace(/Mr\./g, 'Mr')
              .replace(/Mrs\./g, 'Mrs')
              .replace(/Dr\./g, 'Dr')
              .replace(/Ms\./g, 'Ms')
              .replace(/Jr\./g, 'Jr')
              .replace(/Sr\./g, 'Sr')
            
            return cleaned
              .split(/(?<=[.!?])\s+/)
              .map(s => s.trim())
              .filter(s => s.length > 0)
          }
          
          // Helper: Compare sentences for correction
          const normalizeForComparison = (text: string): string => {
            return text.toLowerCase().replace(/[.,!?;:'"]+/g, '').trim()
          }
          
          // ═══════════════════════════════════════════════════════════════════════
          // APPLE-STYLE STABLE PREFIX HANDLER (V2 - Anchor-Based)
          // ═══════════════════════════════════════════════════════════════════════
          // Instead of tracking stability by position (breaks with rolling window),
          // we use anchor-based detection:
          // 1. First paste: immediately paste the transcription
          // 2. Subsequent: find last 2-3 words of locked text in new transcription
          // 3. Append any words that appear AFTER the anchor
          // This is robust against rolling window truncation and Parakeet revisions.
          // ═══════════════════════════════════════════════════════════════════════
          const handleStablePrefixPaste = async (newText: string) => {
            const newWords = newText.trim().split(/\s+/).filter(w => w)
            if (newWords.length === 0) return
            
            const currentLockedText = lockedTextRef.current
            const isFirstPaste = currentLockedText === ''
            const isPlaceholder = pastedTextRef.current === '...'
            
            // Normalize for comparison
            const normalize = (w: string) => w.toLowerCase().replace(/[.,!?;:'"]+$/, '')
            
            
            // FIRST PASTE: Paste immediately for fast feedback
            if (isFirstPaste) {
              const textToAppend = newWords.join(' ')
              console.log(`[Stable Prefix V2] First paste: "${textToAppend.slice(0, 50)}..."`)
              
              
              lockedTextRef.current = textToAppend
              pastedTextRef.current = textToAppend
              pastedSentencesRef.current = splitIntoSentences(textToAppend)
              lastPastedLengthRef.current = textToAppend.length
              lockedWordCountRef.current = newWords.length
              
              if (isPlaceholder) {
                await trackedCorrectLivePaste(3, textToAppend)
              } else {
                await trackedLivePaste(textToAppend, 0)
              }
              return
            }
            
            // SUBSEQUENT PASTES: Find anchor and append new words
            const lockedWords = currentLockedText.trim().split(/\s+/).filter(w => w)
            
            // Try anchor sizes: 3, 2, 1 words
            const anchorSizes = [3, 2, 1]
            let newTailWords: string[] = []
            let anchorFound = false
            
            for (const anchorSize of anchorSizes) {
              if (lockedWords.length < anchorSize) continue
              
              const anchorWords = lockedWords.slice(-anchorSize)
              const anchorPattern = anchorWords.map(normalize)
              
              // Find anchor in new transcription
              for (let i = 0; i <= newWords.length - anchorSize; i++) {
                let match = true
                for (let j = 0; j < anchorSize; j++) {
                  if (normalize(newWords[i + j]) !== anchorPattern[j]) {
                    match = false
                    break
                  }
                }
                
                if (match) {
                  // Found anchor! Get words after it
                  const tailStartIndex = i + anchorSize
                  if (tailStartIndex < newWords.length) {
                    newTailWords = newWords.slice(tailStartIndex)
                    anchorFound = true
                  }
                  break
                }
              }
              
              if (anchorFound) break
            }
            
            
            // If anchor found and there are new words, append them
            if (anchorFound && newTailWords.length > 0) {
              const wordsToAppend = newTailWords.join(' ')
              
              // Check for duplicates (already in locked text)
              const normalizedTail = newTailWords.map(normalize).join(' ')
              const lockedEnd = lockedWords.slice(-newTailWords.length).map(normalize).join(' ')
              if (normalizedTail === lockedEnd) {
                // Already appended, skip
                return
              }
              
              console.log(`[Stable Prefix V2] Appending: "${wordsToAppend.slice(0, 40)}..."`)
              
              
              const newLockedText = currentLockedText + ' ' + wordsToAppend
              const previousLength = currentLockedText.length
              
              lockedTextRef.current = newLockedText
              pastedTextRef.current = newLockedText
              pastedSentencesRef.current = splitIntoSentences(newLockedText)
              lastPastedLengthRef.current = newLockedText.length
              lockedWordCountRef.current = lockedWords.length + newTailWords.length
              
              await trackedLivePaste(newLockedText, previousLength)
              return
            }
            
            // FALLBACK 1: If anchor not found but new text is much longer,
            // this might be a rolling window shift. Use the new text as new anchor.
            if (!anchorFound && newWords.length > lockedWords.length + 3) {
              console.log(`[Stable Prefix V2] Divergence detected, checking tail match`)
              
              // Check if new text ends with words beyond our locked text
              // by comparing normalized word sequences
              const normalizedNew = newWords.map(normalize)
              const normalizedLocked = lockedWords.map(normalize)
              
              // Find overlap at the end
              let overlapEnd = -1
              for (let i = 0; i < normalizedLocked.length; i++) {
                const lockedSuffix = normalizedLocked.slice(i)
                const newPrefix = normalizedNew.slice(0, lockedSuffix.length)
                
                if (lockedSuffix.every((w, idx) => w === newPrefix[idx])) {
                  overlapEnd = lockedSuffix.length
                  break
                }
              }
              
              if (overlapEnd > 0 && overlapEnd < newWords.length) {
                const tailWords = newWords.slice(overlapEnd)
                const wordsToAppend = tailWords.join(' ')
                
                console.log(`[Stable Prefix V2] Fallback append: "${wordsToAppend.slice(0, 40)}..."`)
                
                
                const newLockedText = currentLockedText + ' ' + wordsToAppend
                const previousLength = currentLockedText.length
                
                lockedTextRef.current = newLockedText
                pastedTextRef.current = newLockedText
                pastedSentencesRef.current = splitIntoSentences(newLockedText)
                lastPastedLengthRef.current = newLockedText.length
                lockedWordCountRef.current += tailWords.length
                
                await trackedLivePaste(newLockedText, previousLength)
                return
              }
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // FALLBACK 2: NEVER-FREEZE SAFETY NET
            // ═══════════════════════════════════════════════════════════════════
            // If anchor wasn't found but new transcription has more words than we've locked,
            // the last word of the new transcription is probably genuinely new.
            // Append it if it's different from our last locked word.
            // This prevents the "freeze" where no content appears even though user is speaking.
            if (!anchorFound && newWords.length > lockedWords.length) {
              const lastNewWord = newWords[newWords.length - 1]
              const lastLockedWord = lockedWords[lockedWords.length - 1] || ''
              
              // Only append if the last word is genuinely different
              if (normalize(lastNewWord) !== normalize(lastLockedWord)) {
                console.log(`[Stable Prefix V2] Never-freeze fallback: appending "${lastNewWord}"`)
                
                
                const newLockedText = currentLockedText + ' ' + lastNewWord
                const previousLength = currentLockedText.length
                
                lockedTextRef.current = newLockedText
                pastedTextRef.current = newLockedText
                pastedSentencesRef.current = splitIntoSentences(newLockedText)
                lastPastedLengthRef.current = newLockedText.length
                lockedWordCountRef.current += 1
                
                await trackedLivePaste(newLockedText, previousLength)
                return
              }
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // FALLBACK 3: RE-ANCHOR RECOVERY
            // ═══════════════════════════════════════════════════════════════════
            // If we still haven't found anything and transcription keeps coming,
            // the rolling window may have completely shifted. Check if ANY of the
            // new words appear at the very end of the new transcription and are
            // not in our locked text.
            if (!anchorFound && newWords.length >= 2) {
              // Get last 2 words from new transcription
              const lastTwoNew = newWords.slice(-2)
              const normalizedLastTwo = lastTwoNew.map(normalize).join(' ')
              const normalizedLockedEnd = lockedWords.slice(-2).map(normalize).join(' ')
              
              // If they're different from our locked end, and we have at least one more word
              if (normalizedLastTwo !== normalizedLockedEnd) {
                // Check if any of the locked words appear in the middle of new text
                const normalizedNew = newWords.map(normalize)
                const normalizedLocked = lockedWords.map(normalize)
                
                // Find the last position where locked text ends in new text
                let lastMatchPos = -1
                for (let i = 0; i < normalizedNew.length; i++) {
                  if (normalizedLocked.length > 0 && 
                      normalizedNew[i] === normalizedLocked[normalizedLocked.length - 1]) {
                    // Check if previous words also match
                    let matches = true
                    const checkLen = Math.min(3, normalizedLocked.length)
                    for (let j = 1; j < checkLen && i - j >= 0; j++) {
                      if (normalizedNew[i - j] !== normalizedLocked[normalizedLocked.length - 1 - j]) {
                        matches = false
                        break
                      }
                    }
                    if (matches) {
                      lastMatchPos = i
                    }
                  }
                }
                
                if (lastMatchPos >= 0 && lastMatchPos < newWords.length - 1) {
                  const tailWords = newWords.slice(lastMatchPos + 1)
                  const wordsToAppend = tailWords.join(' ')
                  
                  console.log(`[Stable Prefix V2] Re-anchor recovery: "${wordsToAppend.slice(0, 40)}..."`)
                  
                  
                  const newLockedText = currentLockedText + ' ' + wordsToAppend
                  const previousLength = currentLockedText.length
                  
                  lockedTextRef.current = newLockedText
                  pastedTextRef.current = newLockedText
                  pastedSentencesRef.current = splitIntoSentences(newLockedText)
                  lastPastedLengthRef.current = newLockedText.length
                  lockedWordCountRef.current += tailWords.length
                  
                  await trackedLivePaste(newLockedText, previousLength)
                }
              }
            }
            // Otherwise: genuinely no new content detected, skip (but log it)
            console.log(`[Stable Prefix V2] No action: anchorFound=${anchorFound}, newWords=${newWords.length}, lockedWords=${lockedWords.length}`)
          }
          
          const partialCleanup = window.outloud?.stt?.onPartialResult?.((data) => {
            setPartialText(data.text)
            
            if (livePasteMode && data.text) {
              // ═══════════════════════════════════════════════════════════════════════
              // CHUNK-AND-COMMIT + STABLE WORD PASTING (APPLE-STYLE)
              // ═══════════════════════════════════════════════════════════════════════
              // Hybrid approach for smooth, fast live paste:
              // 1. Committed text → paste immediately (immutable)
              // 2. Partial text → paste words that have STABILIZED (appeared 2+ times)
              // This gives word-by-word feel even during continuous speech!
              // ═══════════════════════════════════════════════════════════════════════
              if (data.committedText !== undefined) {
                const currentCommitted = lastCommittedTextRef.current
                const newCommitted = data.committedText
                const partialText = data.partialText || ''
                
                // PART 1: Handle committed text (immediate paste)
                if (newCommitted.length > currentCommitted.length) {
                  let newPortion = ''
                  if (newCommitted.startsWith(currentCommitted)) {
                    newPortion = newCommitted.slice(currentCommitted.length)
                  } else {
                    console.warn('[Live Paste C&C] Unexpected: committed text changed mid-stream')
                    newPortion = newCommitted
                  }
                  
                  if (newPortion.trim()) {
                    lastCommittedTextRef.current = newCommitted
                    
                    const currentPastedText = pastedTextRef.current
                    
                    // CRITICAL: Check if newPortion overlaps with what's already pasted
                    // (from stable word pasting). Only paste the truly NEW part.
                    const normalizedPasted = currentPastedText.toLowerCase().replace(/[.,!?;:'"]+/g, '').replace(/\s+/g, ' ').trim()
                    const normalizedPortion = newPortion.trim().toLowerCase().replace(/[.,!?;:'"]+/g, '').replace(/\s+/g, ' ').trim()
                    
                    // Find the overlap between what's already pasted and what's being committed
                    let actualNewPortion = newPortion.trim()
                    if (normalizedPasted && normalizedPortion) {
                      // Check if the end of pasted text overlaps with the start of new portion
                      const words = normalizedPortion.split(' ')
                      let overlapLength = 0
                      for (let i = words.length; i > 0; i--) {
                        const prefix = words.slice(0, i).join(' ')
                        if (normalizedPasted.endsWith(prefix)) {
                          overlapLength = i
                          break
                        }
                      }
                      if (overlapLength > 0) {
                        // Remove overlapping words from newPortion
                        const portionWords = newPortion.trim().split(/\s+/)
                        actualNewPortion = portionWords.slice(overlapLength).join(' ')
                        console.log(`[Live Paste C&C] Removed ${overlapLength} overlapping words`)
                      }
                    }
                    
                    if (actualNewPortion.trim()) {
                      console.log(`[Live Paste C&C] Committed: "${actualNewPortion.slice(0, 40)}..."`)
                      const newTotalText = currentPastedText + (currentPastedText ? ' ' : '') + actualNewPortion.trim()
                    
                      lastPastedLengthRef.current = newTotalText.length
                      pastedTextRef.current = newTotalText
                      pastedSentencesRef.current = splitIntoSentences(newTotalText)
                    
                      // Reset stable word tracking since we just committed
                      // The partial words will be tracked fresh
                      wordStabilityRef.current.clear()
                      lockedWordCountRef.current = 0
                    
                      trackedLivePaste(newTotalText, currentPastedText.length).catch((err) => {
                        console.error('[Live Paste C&C] Append error:', err)
                      })
                    }
                  }
                }
                
                // PART 2: Handle partial text with STABLE WORD PASTING
                // Paste words that have appeared consistently (stability threshold)
                if (partialText.trim()) {
                  const partialWords = partialText.trim().split(/\s+/).filter(w => w)
                  const WORD_STABILITY_THRESHOLD = 2 // Word must appear 2x to be stable
                  
                  let newStableWords: string[] = []
                  let currentLocked = lockedWordCountRef.current
                  
                  // Check each word's stability
                  for (let i = 0; i < partialWords.length; i++) {
                    const word = partialWords[i]
                    const normalizedWord = word.toLowerCase().replace(/[.,!?;:'"]+$/, '')
                    
                    const existing = wordStabilityRef.current.get(i)
                    
                    if (existing && existing.word === normalizedWord) {
                      // Same word at same position - increment count
                      existing.count++
                      
                      // If word just became stable and is beyond our locked count, add it
                      if (existing.count >= WORD_STABILITY_THRESHOLD && i >= currentLocked) {
                        newStableWords.push(word)
                      }
                    } else {
                      // Different word or new position - reset
                      wordStabilityRef.current.set(i, { word: normalizedWord, count: 1 })
                    }
                  }
                  
                  // Paste newly stable words
                  if (newStableWords.length > 0) {
                    const stableText = newStableWords.join(' ')
                    console.log(`[Live Paste Stable] Pasting ${newStableWords.length} stable word(s): "${stableText.slice(0, 30)}..."`)
                    
                    const currentPastedText = pastedTextRef.current
                    const newTotalText = currentPastedText + (currentPastedText ? ' ' : '') + stableText
                    
                    lastPastedLengthRef.current = newTotalText.length
                    pastedTextRef.current = newTotalText
                    pastedSentencesRef.current = splitIntoSentences(newTotalText)
                    lockedWordCountRef.current = currentLocked + newStableWords.length
                    
                    trackedLivePaste(newTotalText, currentPastedText.length).catch((err) => {
                      console.error('[Live Paste Stable] Error:', err)
                    })
                  }
                }
                
                return // Don't run legacy heuristic logic
              }
              
              // ═══════════════════════════════════════════════════════════════
              // LEGACY STRATEGY BRANCH: Apple Style vs Heuristic
              // (for backwards compatibility when chunk-and-commit not active)
              // ═══════════════════════════════════════════════════════════════
              if (livePasteStrategy.current === 'stable-prefix') {
                // Apple-style: words lock after appearing consistently
                handleStablePrefixPaste(data.text)
                return // Don't run heuristic logic
              }
              
              // ═══════════════════════════════════════════════════════════════
              // HEURISTIC MODE (existing logic below)
              // ═══════════════════════════════════════════════════════════════
              const newText = data.text
              const currentPastedLength = lastPastedLengthRef.current
              const currentPastedText = pastedTextRef.current
              
              // TAIL-BASED LIVE PASTE STRATEGY
              // 
              // The rolling window may truncate the BEGINNING of transcription after ~45 seconds.
              // So instead of comparing from the start, we detect NEW WORDS at the END:
              // 
              // 1. FIRST PASTE: Paste immediately for fast feedback
              // 2. TAIL EXTENSION: Find the last few words we pasted in the new text,
              //    then append any words that come AFTER them
              // 3. EARLY CORRECTIONS: When pasted text is very short, allow replacement
              // 4. FINAL RECONCILIATION: Correct all issues when recording stops
              
              // Helper: Find new words at the tail by looking for anchor words
              const findNewTailWords = (pastedText: string, newText: string): string | null => {
                const pastedWords = pastedText.trim().split(/\s+/).filter(w => w)
                const newWords = newText.trim().split(/\s+/).filter(w => w)
                
                if (pastedWords.length === 0 || newWords.length === 0) return null
                if (newWords.length <= pastedWords.length) return null // No new words
                
                // Get last 3 words from pasted text as anchor
                const anchorWords = pastedWords.slice(-3)
                const anchorPattern = anchorWords.map(w => w.toLowerCase().replace(/[.,!?;:'"]+$/, ''))
                
                // Find where anchor appears in new text
                for (let i = 0; i <= newWords.length - anchorWords.length; i++) {
                  let match = true
                  for (let j = 0; j < anchorWords.length; j++) {
                    const newWord = newWords[i + j].toLowerCase().replace(/[.,!?;:'"]+$/, '')
                    if (newWord !== anchorPattern[j]) {
                      match = false
                      break
                    }
                  }
                  if (match) {
                    // Found anchor! Get words after it
                    const tailStartIndex = i + anchorWords.length
                    if (tailStartIndex < newWords.length) {
                      return newWords.slice(tailStartIndex).join(' ')
                    }
                    return null // Anchor found but no new words after
                  }
                }
                return null // Anchor not found
              }
              
              // Check if this is the first real paste (or placeholder replacement)
              const isPlaceholder = currentPastedText === '...'
              const isFirstPaste = (currentPastedLength === 0 || isPlaceholder) && newText.length > 0
              
              // Fallback: exact character-level extension (works when window hasn't truncated)
              const isPureExtension = newText.startsWith(currentPastedText) && newText.length > currentPastedLength
              
              // FUZZY EXTENSION: Handle minor revisions (punctuation, capitalization, contractions)
              // Normalizes both strings before comparison to catch cases like:
              // - "What is" → "What's" (contraction)
              // - "Hello." → "Hello," (punctuation)
              // - "I Think" → "I think" (capitalization)
              const normalizeFuzzy = (s: string) => 
                s.toLowerCase().replace(/[.,!?;:'"]/g, '').replace(/\s+/g, ' ').trim()
              const isPureExtensionFuzzy = !isPureExtension && 
                normalizeFuzzy(newText).startsWith(normalizeFuzzy(currentPastedText)) && 
                newText.length > currentPastedLength
              
              // Tail-based extension detection (works even when beginning is truncated)
              const newTailWords = findNewTailWords(currentPastedText, newText)
              const hasTailExtension = newTailWords !== null && newTailWords.length > 0
              
              // Allow early corrections when pasted text is very short (< 20 chars)
              const isEarlyCorrection = currentPastedLength > 0 && currentPastedLength < 20 && 
                                        newText.length > currentPastedLength && !newText.startsWith(currentPastedText)
              
              // Legacy word analysis for logging
              const pastedWordCount = currentPastedText.trim().split(/\s+/).filter(w => w).length
              const newWordCount = newText.trim().split(/\s+/).filter(w => w).length
              
              // PHASE 4: Reset silence correction when new words arrive
              // MUST happen early, before any early returns in paste branches
              if (newWordCount > pastedWordCount) {
              }
              
              // Detect meaningful transcription activity (not just any callback)
              const hasTranscriptionActivity = newText.length > 3 && (
                isFirstPaste || isPureExtension || isPureExtensionFuzzy || 
                hasTailExtension || newWordCount > pastedWordCount
              )
              
              // Notify BE of speech activity - this resets the BE silence timer
              // and allows Silence Polish to retrigger after next silence period
              if (hasTranscriptionActivity) {
                window.outloud?.llm?.notifySpeechDetected?.()
              }
              
              
              if (isFirstPaste) {
                // First paste (or placeholder replacement) - immediate feedback
                console.log(`[Live Paste] First paste: "${newText.slice(0, 30)}..."${isPlaceholder ? ' (replacing placeholder)' : ''}`)
                
                
                lastPastedLengthRef.current = newText.length
                pastedTextRef.current = newText
                
                if (isPlaceholder) {
                  // Replace "..." placeholder with real text
                  trackedCorrectLivePaste(3, newText).then((result: any) => {
                    if (!result?.success) {
                      console.warn('[Live Paste] Placeholder replacement failed, rolling back')
                      lastPastedLengthRef.current = 3
                      pastedTextRef.current = '...'
                    }
                  }).catch((err) => {
                    console.error('[Live Paste] Placeholder replacement error:', err)
                    lastPastedLengthRef.current = 3
                    pastedTextRef.current = '...'
                  })
                } else {
                  // Normal first paste (no placeholder was shown)
                  trackedLivePaste(newText, 0).then((result: any) => {
                    if (!result?.success) {
                      console.warn('[Live Paste] First paste failed, rolling back')
                      lastPastedLengthRef.current = 0
                      pastedTextRef.current = ''
                    }
                  }).catch((err) => {
                    console.error('[Live Paste] First paste error:', err)
                    lastPastedLengthRef.current = 0
                    pastedTextRef.current = ''
                  })
                }
              } else if (isEarlyCorrection) {
                // Early correction - select short pasted text and replace with better transcription
                // This fixes hallucinations like "Yeah." → "I am testing..."
                console.log(`[Live Paste] Early correction: replacing "${currentPastedText.slice(0, 20)}" with "${newText.slice(0, 30)}..."`)
                
                
                lastPastedLengthRef.current = newText.length
                pastedTextRef.current = newText
                
                trackedCorrectLivePaste(currentPastedLength, newText).then((result: any) => {
                  if (!result?.success) {
                    console.warn('[Live Paste] Early correction failed, rolling back')
                    lastPastedLengthRef.current = currentPastedLength
                    pastedTextRef.current = currentPastedText
                  }
                }).catch((err) => {
                  console.error('[Live Paste] Early correction error:', err)
                  lastPastedLengthRef.current = currentPastedLength
                  pastedTextRef.current = currentPastedText
                })
              } else if (isPureExtension || isPureExtensionFuzzy) {
                // Pure character-level extension - just append the new characters
                // Works for both exact match AND fuzzy match (handles minor revisions)
                const appendText = newText.slice(currentPastedLength)
                console.log(`[Live Paste] ${isPureExtensionFuzzy ? 'Fuzzy' : 'Char'} extension: +${appendText.length} chars`)
                
                
                lastPastedLengthRef.current = newText.length
                pastedTextRef.current = newText
                
                trackedLivePaste(newText, currentPastedLength).then((result: any) => {
                  if (!result?.success) {
                    console.warn('[Live Paste] Append failed, rolling back')
                    lastPastedLengthRef.current = currentPastedLength
                    pastedTextRef.current = currentPastedText
                  }
                }).catch((err) => {
                  console.error('[Live Paste] Append error:', err)
                  lastPastedLengthRef.current = currentPastedLength
                  pastedTextRef.current = currentPastedText
                })
              } else if (hasTailExtension && newTailWords) {
                // TAIL EXTENSION: Found new words at the end, append them
                // This works even when rolling window truncates the beginning
                
                // Use LLM to extract only truly new words from tail extension
                const pastedEndForTail = currentPastedText.slice(-100) // Last ~100 chars for context
                
                window.outloud?.llm?.extractNewWords?.(pastedEndForTail, newTailWords).then((result) => {
                  if (result?.success && result.newWords && result.newWords.trim() && result.newWords.toUpperCase() !== 'EMPTY') {
                    const newWordsOnly = result.newWords.trim()
                    console.log(`[Live Paste] LLM extracted new words (tail extension): "${newWordsOnly}"`)
                    
                    
                    const textToAppend = ' ' + newWordsOnly
                    const updatedPastedText = currentPastedText + textToAppend
                    
                    lastPastedLengthRef.current = updatedPastedText.length
                    pastedTextRef.current = updatedPastedText
                    pastedSentencesRef.current = splitIntoSentences(updatedPastedText)
                    
                    trackedLivePaste(updatedPastedText, currentPastedLength).catch(() => {})
                  } else {
                    console.log(`[Live Paste] LLM extract (tail extension): no new words, skipping`)
                  }
                }).catch((err) => {
                  // LLM failed - fallback to heuristic (conservative)
                  console.warn('[Live Paste] LLM extract failed (tail extension), using conservative heuristic:', err)
                  
                  const normalizeTailCheck = (s: string) => s.toLowerCase().replace(/[.,!?;:'"]+/g, '').replace(/\s+/g, ' ').trim()
                  const normalizedNewTail = normalizeTailCheck(newTailWords)
                  const pastedEndCheck = normalizeTailCheck(currentPastedText.slice(-newTailWords.length - 20))
                  const tailAlreadyAppended = pastedEndCheck.endsWith(normalizedNewTail) || pastedEndCheck.includes(normalizedNewTail)
                  
                  
                  if (!tailAlreadyAppended) {
                    console.log(`[Live Paste] Tail extension (fallback): +"${newTailWords.slice(0, 30)}..."`)
                    
                    
                    // Append the new tail words with a space
                    const textToAppend = ' ' + newTailWords
                    const updatedPastedText = currentPastedText + textToAppend
                    
                    lastPastedLengthRef.current = updatedPastedText.length
                    pastedTextRef.current = updatedPastedText
                    pastedSentencesRef.current = splitIntoSentences(updatedPastedText)
                    
                    // Use livePaste to just type the new words
                    trackedLivePaste(updatedPastedText, currentPastedLength).then((result: any) => {
                      if (!result?.success) {
                        console.warn('[Live Paste] Tail extension failed, rolling back')
                        lastPastedLengthRef.current = currentPastedLength
                        pastedTextRef.current = currentPastedText
                      }
                    }).catch((err) => {
                      console.error('[Live Paste] Tail extension error:', err)
                      lastPastedLengthRef.current = currentPastedLength
                      pastedTextRef.current = currentPastedText
                    })
                  } else {
                    console.log(`[Live Paste] Tail extension (fallback): tail already exists, skipping`)
                  }
                })
              } else if (!hasTailExtension && newWordCount >= pastedWordCount + 1 && newText.length > currentPastedLength) {
                // PHASE 2 - DIVERGENCE RECOVERY:
                // Tail extension failed (anchor words not found), but transcription grew.
                // This happens when:
                // 1. Parakeet hallucinated words that got pasted, then corrected itself
                // 2. Rolling window truncated differently
                // 3. Anchor words were revised (e.g., "is" → "'s")
                // 
                // Solution: Replace the entire pasted text with the new transcription.
                // This may cause a visible "jump" but prevents live paste from stopping.
                //
                // Guard: Only do this if new text has 1+ more words AND is longer.
                // CHANGED from +3 to +1 to catch more revision cases and prevent freezes.
                console.log(`[Live Paste] Divergence recovery: ${pastedWordCount} words → ${newWordCount} words`)
                
                
                // Use correctLivePaste to select pasted text and replace with new transcription
                trackedCorrectLivePaste(currentPastedLength, newText).then((result: any) => {
                  if (result?.success) {
                    lastPastedLengthRef.current = newText.length
                    pastedTextRef.current = newText
                    // Update sentence tracking
                    pastedSentencesRef.current = splitIntoSentences(newText)
                  } else {
                    console.warn('[Live Paste] Divergence recovery failed')
                  }
                }).catch((err) => {
                  console.error('[Live Paste] Divergence recovery error:', err)
                })
              } else if (newText.length >= currentPastedLength && newWordCount >= pastedWordCount && currentPastedLength > 0) {
                // REVISION FALLBACK: None of the smart detections worked, but transcription
                // is same length or longer. This means Parakeet revised earlier words in a
                // way we couldn't track (all detection methods failed).
                //
                // This is the CRITICAL SAFETY NET that prevents freezes.
                // We replace all pasted text with the new transcription.
                // Brief visual "update" but NEVER freezes.
                //
                // Only triggers if:
                // - Not first paste (currentPastedLength > 0)
                // - New text is at least as long
                // - Same or more words
                console.log(`[Live Paste] Revision fallback: replacing ${currentPastedLength} chars with ${newText.length} chars`)
                
                
                trackedCorrectLivePaste(currentPastedLength, newText).then((result: any) => {
                  if (result?.success) {
                    lastPastedLengthRef.current = newText.length
                    pastedTextRef.current = newText
                    pastedSentencesRef.current = splitIntoSentences(newText)
                  } else {
                    console.warn('[Live Paste] Revision fallback failed')
                  }
                }).catch((err) => {
                  console.error('[Live Paste] Revision fallback error:', err)
                })
              } else if (newText.length < currentPastedLength && newWordCount > 0) {
                // ROLLING WINDOW RECOVERY: The new transcription is SHORTER because
                // the rolling window has truncated the beginning of the audio.
                // 
                // Example:
                // - Pasted: "one two three four five six seven eight nine ten eleven"
                // - New (after truncation): "eight nine ten eleven twelve thirteen"
                //
                // Strategy: Find the LAST few words of PASTED text in the NEW text.
                // If found, check if NEW text has words AFTER the anchor.
                // If so, append those new words.
                
                const pastedWords = currentPastedText.trim().split(/\s+/).filter(w => w)
                const newWords = newText.trim().split(/\s+/).filter(w => w)
                
                // Get last 2-3 words of PASTED text to use as anchor
                const anchorCount = Math.min(3, pastedWords.length - 1)
                const pastedAnchorWords = pastedWords.slice(-anchorCount - 1, -1) // Second to last N words
                const pastedAnchorPattern = pastedAnchorWords.map(w => w.toLowerCase().replace(/[.,!?;:'"]+$/, ''))
                
                // Find where this anchor appears in NEW text
                let anchorFoundAt = -1
                for (let i = 0; i <= newWords.length - pastedAnchorWords.length; i++) {
                  let match = true
                  for (let j = 0; j < pastedAnchorWords.length; j++) {
                    const newWord = newWords[i + j]?.toLowerCase().replace(/[.,!?;:'"]+$/, '') || ''
                    if (newWord !== pastedAnchorPattern[j]) {
                      match = false
                      break
                    }
                  }
                  if (match) {
                    anchorFoundAt = i + pastedAnchorWords.length
                    break
                  }
                }
                
                if (anchorFoundAt >= 0 && anchorFoundAt < newWords.length) {
                  // Anchor found! Get words AFTER the anchor in the new text
                  const wordsAfterAnchor = newWords.slice(anchorFoundAt)
                  const tailWords = wordsAfterAnchor.join(' ')
                  
                  // Use LLM to extract only truly new words (handles partial overlaps intelligently)
                  const pastedEnd = currentPastedText.slice(-100) // Last ~100 chars for context
                  
                  window.outloud?.llm?.extractNewWords?.(pastedEnd, tailWords).then((result) => {
                    if (result?.success && result.newWords && result.newWords.trim() && result.newWords.toUpperCase() !== 'EMPTY') {
                      const newWordsOnly = result.newWords.trim()
                      console.log(`[Live Paste] LLM extracted new words: "${newWordsOnly}" (from tail: "${tailWords.slice(0, 40)}...")`)
                      
                      
                      const textToAppend = ' ' + newWordsOnly
                      const updatedPastedText = currentPastedText + textToAppend
                      
                      lastPastedLengthRef.current = updatedPastedText.length
                      pastedTextRef.current = updatedPastedText
                      pastedSentencesRef.current = splitIntoSentences(updatedPastedText)
                      
                      trackedLivePaste(updatedPastedText, currentPastedLength).catch(() => {})
                    } else {
                      // LLM determined no new words (all overlap) - skip to prevent duplicates
                      console.log(`[Live Paste] LLM extract: no new words (all overlap), skipping`)
                    }
                  }).catch((err) => {
                    // LLM failed - fallback to heuristic (but be conservative to avoid duplicates)
                    console.warn('[Live Paste] LLM extract failed, using conservative heuristic:', err)
                    
                    const normalizeTail = (s: string) => s.toLowerCase().replace(/[.,!?;:'"]+/g, '').replace(/\s+/g, ' ').trim()
                    const normalizedTail = normalizeTail(tailWords)
                    const normalizedPastedEnd = normalizeTail(currentPastedText.slice(-tailWords.length - 20))
                    
                    // Conservative check: only append if tail is clearly not in pasted end
                    const alreadyAppended = normalizedPastedEnd.endsWith(normalizedTail) || 
                                            normalizedPastedEnd.includes(normalizedTail)
                    
                    if (!alreadyAppended && wordsAfterAnchor.length > 0) {
                      console.log(`[Live Paste] Rolling window recovery (fallback): appending "${tailWords.slice(0, 40)}..."`)
                      const textToAppend = ' ' + tailWords
                      const updatedPastedText = currentPastedText + textToAppend
                      
                      lastPastedLengthRef.current = updatedPastedText.length
                      pastedTextRef.current = updatedPastedText
                      pastedSentencesRef.current = splitIntoSentences(updatedPastedText)
                      
                      trackedLivePaste(updatedPastedText, currentPastedLength).catch(() => {})
                    } else {
                      console.log(`[Live Paste] Rolling window: skipping append (conservative fallback)`)
                    }
                  })
                } else {
                  // Anchor not found - pasted text diverged significantly from new transcription
                  // This can happen if Parakeet completely re-interpreted earlier speech
                  // In this case, we should try a more aggressive recovery: look for ANY overlap
                  
                  // Try with just the last word of pasted text
                  const lastPastedWord = pastedWords[pastedWords.length - 1]?.toLowerCase().replace(/[.,!?;:'"]+$/, '') || ''
                  let lastWordFoundAt = -1
                  for (let i = 0; i < newWords.length; i++) {
                    if (newWords[i].toLowerCase().replace(/[.,!?;:'"]+$/, '') === lastPastedWord) {
                      lastWordFoundAt = i
                    }
                  }
                  
                  if (lastWordFoundAt >= 0 && lastWordFoundAt < newWords.length - 1) {
                    // Found last pasted word in new text, append everything after it
                    const tailWords = newWords.slice(lastWordFoundAt + 1).join(' ')
                    
                    // Use LLM to extract only truly new words (handles partial overlaps intelligently)
                    const pastedEnd = currentPastedText.slice(-100) // Last ~100 chars for context
                    
                    window.outloud?.llm?.extractNewWords?.(pastedEnd, tailWords).then((result) => {
                      if (result?.success && result.newWords && result.newWords.trim() && result.newWords.toUpperCase() !== 'EMPTY') {
                        const newWordsOnly = result.newWords.trim()
                        console.log(`[Live Paste] LLM extracted new words (single-word anchor): "${newWordsOnly}"`)
                        
                        
                        const textToAppend = ' ' + newWordsOnly
                        const updatedPastedText = currentPastedText + textToAppend
                        
                        lastPastedLengthRef.current = updatedPastedText.length
                        pastedTextRef.current = updatedPastedText
                        pastedSentencesRef.current = splitIntoSentences(updatedPastedText)
                        
                        trackedLivePaste(updatedPastedText, currentPastedLength).catch(() => {})
                      } else {
                        console.log(`[Live Paste] LLM extract (single-word): no new words, skipping`)
                      }
                    }).catch((err) => {
                      // LLM failed - fallback to heuristic (conservative)
                      console.warn('[Live Paste] LLM extract failed (single-word), using conservative heuristic:', err)
                      
                      const normalizeTail = (s: string) => s.toLowerCase().replace(/[.,!?;:'"]+/g, '').replace(/\s+/g, ' ').trim()
                      const normalizedTail = normalizeTail(tailWords)
                      const normalizedPastedEnd = normalizeTail(currentPastedText.slice(-tailWords.length - 20))
                      const alreadyAppended = normalizedPastedEnd.endsWith(normalizedTail) || normalizedPastedEnd.includes(normalizedTail)
                      
                      if (!alreadyAppended) {
                        console.log(`[Live Paste] Single-word anchor recovery (fallback): appending "${tailWords.slice(0, 40)}..."`)
                        const textToAppend = ' ' + tailWords
                        const updatedPastedText = currentPastedText + textToAppend
                        
                        lastPastedLengthRef.current = updatedPastedText.length
                        pastedTextRef.current = updatedPastedText
                        pastedSentencesRef.current = splitIntoSentences(updatedPastedText)
                        
                        trackedLivePaste(updatedPastedText, currentPastedLength).catch(() => {})
                      } else {
                        console.log(`[Live Paste] Single-word recovery: skipping append (conservative fallback)`)
                      }
                    })
                  } else {
                    // Complete divergence - try LLM merge (Phase 2)
                    console.log(`[Live Paste] Complete divergence, trying LLM merge`)
                    
                    // Call LLM to extract new words (async, non-blocking for UI)
                    window.outloud?.llm?.mergeText?.(currentPastedText, newText).then((result) => {
                      if (result?.success && result.newWords && result.newWords.trim() && result.newWords.toUpperCase() !== 'EMPTY') {
                        const newWordsText = result.newWords.trim()
                        console.log(`[Live Paste] LLM merge found new words: "${newWordsText}"`)
                        
                        const updatedPastedText = currentPastedText + ' ' + newWordsText
                        lastPastedLengthRef.current = updatedPastedText.length
                        pastedSentencesRef.current = splitIntoSentences(updatedPastedText)
                        pastedTextRef.current = updatedPastedText
                        
                        trackedLivePaste(updatedPastedText, currentPastedLength).catch(() => {})
                      } else {
                        console.log(`[Live Paste] LLM merge returned no new words, skipping`)
                      }
                    }).catch((err) => {
                      console.warn('[Live Paste] LLM merge failed:', err)
                      // Fallback: skip this partial, final reconciliation will fix
                    })
                  }
                }
              } else {
                // ═══════════════════════════════════════════════════════════════════════
                // NEVER-FREEZE FALLBACK: Last-resort word append
                // ═══════════════════════════════════════════════════════════════════════
                // 
                // If we reach here, ALL detection strategies failed:
                // - Not first paste
                // - Not pure extension (character or fuzzy)
                // - No tail extension (anchor words not found)
                // - Not divergence recovery (not enough new words)
                // - Not revision fallback (new text shorter)
                // - Not rolling window recovery (anchor not found)
                //
                // Rather than freeze, append the LAST WORD of new transcription
                // if it's different from the last word we pasted. This keeps the
                // live paste flowing. Final reconciliation will clean up any mess.
                //
                // This is a "best effort" approach that prioritizes CONTINUITY
                // over perfect accuracy. The self-correction phases will fix it.
                // ═══════════════════════════════════════════════════════════════════════
                
                const pastedWords = currentPastedText.trim().split(/\s+/).filter(w => w)
                const newWords = newText.trim().split(/\s+/).filter(w => w)
                
                const lastNewWord = newWords[newWords.length - 1] || ''
                const lastPastedWord = pastedWords[pastedWords.length - 1] || ''
                
                const lastNewNorm = lastNewWord.toLowerCase().replace(/[.,!?;:'"]+$/, '')
                const lastPastedNorm = lastPastedWord.toLowerCase().replace(/[.,!?;:'"]+$/, '')
                
                if (lastNewNorm && lastNewNorm !== lastPastedNorm && newWords.length > 0) {
                  // Last word is different - append it
                  console.log(`[Live Paste] NEVER-FREEZE fallback: appending last word "${lastNewWord}"`)
                  
                  
                  const textToAppend = ' ' + lastNewWord
                  const updatedPastedText = currentPastedText + textToAppend
                  
                  lastPastedLengthRef.current = updatedPastedText.length
                  pastedTextRef.current = updatedPastedText
                  pastedSentencesRef.current = splitIntoSentences(updatedPastedText)
                  
                  trackedLivePaste(updatedPastedText, currentPastedLength).catch(() => {})
                } else {
                  // True skip - same last word or empty, nothing to do
                  console.log(`[Live Paste] Skip: last word unchanged or empty`)
                }
              }
              
              // PHASE 3: Rolling Sentence Correction
              // Check if any completed sentences differ between pasted and new transcription.
              // "Completed" = all sentences except the last one (still being formed).
              // Only correct sentences we haven't locked yet.
              if (currentPastedLength > 0 && newText.length > 20) {
                const newSentences = splitIntoSentences(newText)
                const pastedSentences = pastedSentencesRef.current
                const lockedCount = lockedSentenceCountRef.current
                
                // Store latest for silence correction to use
                latestTranscriptionRef.current = newText
                latestSentencesRef.current = newSentences
                
                // Only check completed sentences (exclude last which is still forming)
                const completedCount = Math.max(0, newSentences.length - 1)
                
                for (let i = lockedCount; i < completedCount && i < pastedSentences.length; i++) {
                  const pastedSentence = pastedSentences[i]
                  const newSentence = newSentences[i]
                  
                  // Compare normalized versions
                  if (normalizeForComparison(pastedSentence) !== normalizeForComparison(newSentence)) {
                    // Sentence changed - this is a correction!
                    console.log(`[Live Paste] Sentence ${i} correction: "${pastedSentence.slice(0, 30)}" → "${newSentence.slice(0, 30)}"`)
                    
                    
                    // Silent correction via AppleScript
                    // Note: This is best-effort. If it fails, final reconciliation will fix it.
                    window.outloud?.text?.correctSentence?.({
                      sentenceIndex: i,
                      oldText: pastedSentence,
                      newText: newSentence
                    }).catch(() => {
                      // Non-critical - final reconciliation will handle it
                    })
                    
                    // Update our tracking
                    pastedSentencesRef.current[i] = newSentence
                  }
                }
                
                // Lock sentences that are 2+ behind current (unlikely to change further)
                // Note: Deep cleanup queue removed - all polish is now handled BE-driven
                if (completedCount > 1 && lockedCount < completedCount - 1) {
                  const newLockedCount = completedCount - 1
                  lockedSentenceCountRef.current = newLockedCount
                }
              }
              
              // Note: PHASE 4 silence reset moved to top of handler (before early returns)
              // See "Reset silence correction when new words arrive" above
            }
          })
          
          await audioRecorder.startStreamingRecording(
            async (pcmData: Float32Array) => {
              const arrayBuffer = pcmData.buffer.slice(
                pcmData.byteOffset,
                pcmData.byteOffset + pcmData.byteLength
              )
              await window.outloud?.stt?.streamChunk?.(arrayBuffer)
            },
            (levels) => {
              const avg = levels.reduce((a, b) => a + b, 0) / levels.length
              updateAudioLevel(avg)
            }
          )
          
          ;(window as any).__partialCleanup = partialCleanup
          
          // PAUSE HANDLING: Periodic flush to ensure transcription continues during pauses.
          // The AudioWorklet has its own time-based fallback, but browsers can throttle
          // background audio processing. This interval ensures we keep the pipeline flowing.
          // Essential for ponderers who may pause for 5+ seconds mid-thought.
          //
          // Note: ALL silence detection is now handled by the backend (llmService.ts).
          // FE just sends audio and receives polish results via IPC when ready.
          const flushInterval = setInterval(() => {
            if (audioRecorder.isStreamingRecording) {
              audioRecorder.requestFlush?.()
            } else {
              clearInterval(flushInterval)
            }
          }, 800) // Slightly longer than worklet's 600ms to avoid conflicts
          ;(window as any).__flushInterval = flushInterval
          
          // CRITICAL: Play audio cue ONLY AFTER recording is fully initialized!
          // This ensures the user doesn't start speaking during the ~600ms
          // initialization window. The cue signals "NOW you can speak".
          audioCues.playRecordStart()
        } else {
          await audioRecorder.startRecording((levels) => {
            const avg = levels.reduce((a, b) => a + b, 0) / levels.length
            updateAudioLevel(avg)
          })
          
          // Play audio cue after non-streaming recording starts too
          audioCues.playRecordStart()
        }
        
        setOrbState('listening')
        isRecordingRef.current = true // Sync update to prevent toggle race condition
      } catch (error) {
        console.error('Failed to start recording:', error)
        audioCues.playError()
        setOrbState('idle')
        
        // Clean up handlers on error
        const partialCleanup = (window as any).__partialCleanup
        if (partialCleanup) {
          partialCleanup()
          ;(window as any).__partialCleanup = null
        }
        const flushInterval = (window as any).__flushInterval
        if (flushInterval) {
          clearInterval(flushInterval)
          ;(window as any).__flushInterval = null
        }
        
        setIsVisible(true)
        await window.outloud?.window?.show?.()
        await audioRecorder.cancel().catch(() => {})
      }
    }
  }, [showLivePreview, livePasteMode, autoSendAfterDictation, updateAudioLevel])
  
  // Keep ref updated
  handleRecordToggleRef.current = handleRecordToggle
  
  // Orb tap handler - pause/resume playback only
  // Dictation is triggered via keyboard shortcuts (Cmd+Shift+S), not orb tap
  const handleOrbTap = useCallback(() => {
    if (orbState === 'playing') {
      // Pause playback
      realtimeQueueRef.current?.pause()
      setOrbState('paused')
    } else if (orbState === 'paused') {
      // Resume playback - returns false if nothing left to play
      const resumed = realtimeQueueRef.current?.resume()
      if (resumed) {
        setOrbState('playing')
      } else {
        // Nothing to resume, go back to idle
      setOrbState('idle')
      }
    }
    // Idle state: no action - orb is just a visual indicator
  }, [orbState])
  
  // Long-press opens tray (no action in widget - use tray menu)
  const handleLongPress = useCallback(() => {
    // Settings are in the tray menu
  }, [])
  
  return (
    <div
      className="orb-container"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'scale(1)' : 'scale(0.95)',
        transition: 'opacity 0.2s ease-out, transform 0.2s ease-out',
        // Make the entire container draggable
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {/* The Black Hole - a mesmerizing singularity */}
      <BlackHoleOrb
        state={orbState}
        audioLevel={audioLevelForRender}
        size={360}
        onTap={handleOrbTap}
        onLongPress={handleLongPress}
        className="orb-canvas"
      />
      
    </div>
  )
}

export default App
