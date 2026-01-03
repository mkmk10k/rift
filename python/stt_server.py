#!/opt/homebrew/bin/python3.11
"""
═══════════════════════════════════════════════════════════════════════════════
OUTLOUD STT SERVER - CHUNK-AND-COMMIT ARCHITECTURE
═══════════════════════════════════════════════════════════════════════════════

Persistent Speech-to-Text server using MLX Parakeet model with production-grade
chunk-and-commit architecture for freeze-free live dictation.

═══════════════════════════════════════════════════════════════════════════════
THE CORE PROBLEM THIS SOLVES: "THE FREEZE"
═══════════════════════════════════════════════════════════════════════════════

Without chunk-and-commit, long dictation sessions freeze because:
1. MLX Parakeet uses a rolling context window (~25 seconds)
2. Transcription time grows O(n) with buffer size
3. At 30+ seconds, each call takes 500ms+ → blocks UI
4. Rolling window may truncate early text → frontend reconciliation fails
5. User speaks but nothing appears → "FREEZE"

═══════════════════════════════════════════════════════════════════════════════
HOW CHUNK-AND-COMMIT SOLVES THIS (Inspired by Google/Apple/AWS Streaming ASR)
═══════════════════════════════════════════════════════════════════════════════

Key insight: "Commit Early, Commit Often"

1. SEGMENT AUDIO INTO CHUNKS
   - Detect natural pause points (350ms silence = sentence boundary)
   - Force boundaries every 8s for continuous speech
   
2. COMMIT CHUNKS (Make Immutable)
   - Once committed, a chunk's text NEVER changes
   - Backend tracks committed_samples and committed_text
   
3. ONLY TRANSCRIBE UNCOMMITTED AUDIO
   - Next transcription starts AFTER last commit point
   - Small buffers = fast transcription (always <200ms)
   
4. RETURN STRUCTURED RESPONSE
   - committed_text: All finalized text (append-only, immutable)
   - partial_text: Current uncommitted transcription (may change)
   - is_final: True when a new chunk was just committed

═══════════════════════════════════════════════════════════════════════════════
TUNED PARAMETERS (Production Values)
═══════════════════════════════════════════════════════════════════════════════

These values were tuned through extensive testing for smooth live paste:

SILENCE_DURATION_FOR_COMMIT = 0.35 seconds (350ms)
  - Natural sentence pause is ~300-400ms
  - Shorter than Apple Dictation (~600ms) for faster response
  - Triggers commit at natural speech boundaries
  
FORCE_COMMIT_SECONDS = 8 seconds
  - Ensures progress during non-stop speaking
  - Prevents runaway buffer growth
  - User sees updates every 8s even without pauses

MIN_CHUNK_SECONDS = 0.8 seconds
  - Prevents tiny/fragmented commits
  - Ensures meaningful chunks for accuracy
  - Small enough for responsive feel

SILENCE_THRESHOLD = 0.015 RMS
  - More sensitive than default (was 0.02)
  - Better at detecting soft-spoken pauses
  - Works across different mic gains

═══════════════════════════════════════════════════════════════════════════════
DATA FLOW (Per Transcription Request)
═══════════════════════════════════════════════════════════════════════════════

1. Frontend sends: pcm_base64 (float32), session_id, total_samples
2. Backend decodes audio, calculates uncommitted portion:
   uncommitted_audio = full_audio[committed_samples:]
3. Check for silence at tail (last 1 second of uncommitted)
4. Transcribe ONLY uncommitted audio (fast!)
5. Decision: Should we commit?
   - YES if: (pause detected OR 8s elapsed) AND min_chunk met
   - Commit: Update committed_text, committed_samples
6. Return: committed_text, partial_text, is_final

═══════════════════════════════════════════════════════════════════════════════
SESSION MANAGEMENT
═══════════════════════════════════════════════════════════════════════════════

- One ChunkTracker instance per server (sessions are sequential)
- Reset on "reset_session" action (new recording starts)
- State: committed_text, committed_samples, silence_sample_count

═══════════════════════════════════════════════════════════════════════════════
INTEGRATION WITH FRONTEND (App.tsx)
═══════════════════════════════════════════════════════════════════════════════

Frontend receives this server's response and:
1. On new committed_text: Paste the difference immediately
2. On partial_text: Apply "stable word pasting" (paste words appearing 2+ times)
3. On is_final=True: Reset stable word tracking for next chunk

This hybrid approach gives word-by-word feel even during continuous speech!

═══════════════════════════════════════════════════════════════════════════════
TESTING VERIFICATION
═══════════════════════════════════════════════════════════════════════════════

Logs to look for:
- "[STT] COMMIT (pause)" → Natural pause triggered commit
- "[STT] COMMIT (force)" → 8s timeout triggered commit  
- "[STT] COMMITTED at sample X: text..." → Chunk finalized

Test scenarios:
- 5+ minute continuous dictation → No freezes
- Rapid counting 1-10 → Smooth word-by-word
- Natural speech with pauses → Commits align with sentences

═══════════════════════════════════════════════════════════════════════════════
"""

import sys
import json
import os
import platform
import time
import tempfile
import threading
from collections import deque

# Check for Apple Silicon - MLX only works on arm64
if platform.machine() != 'arm64':
    print(json.dumps({
        "type": "error", 
        "error": "Outloud requires Apple Silicon (M1/M2/M3/M4). Intel Macs are not supported."
    }), flush=True)
    sys.exit(1)

# Suppress MLX warnings for cleaner logs
os.environ['MLX_DISABLE_METAL_WARNINGS'] = '1'

# Import core dependencies
try:
    import soundfile as sf
    import numpy as np
except ImportError as e:
    print(json.dumps({"type": "error", "error": f"Missing dependency: {e}"}), flush=True)
    sys.exit(1)

# ═══════════════════════════════════════════════════════════════════════════════
# MODEL CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════
PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"

# ═══════════════════════════════════════════════════════════════════════════════
# CHUNK-AND-COMMIT PARAMETERS - TUNED FOR SMOOTH LIVE PASTE
# ═══════════════════════════════════════════════════════════════════════════════
#
# These parameters control the chunk-and-commit behavior. They were carefully
# tuned through extensive testing to balance:
# - RESPONSIVENESS: How fast text appears after speaking
# - ACCURACY: Ensuring chunks contain complete thoughts
# - SMOOTHNESS: Word-by-word feel with stable word pasting
#
# TUNING HISTORY:
# - Original: 800ms silence, 18s force, 1.5s min → Too slow, laggy feel
# - Current:  350ms silence, 8s force, 0.8s min → Smooth, responsive
# ═══════════════════════════════════════════════════════════════════════════════

SAMPLE_RATE = 16000  # Audio sample rate (standard for STT)

# SILENCE_THRESHOLD: RMS value below which audio is considered silence
# Lower = more sensitive (catches softer pauses)
# 0.015 works well across different microphones and speaking volumes
SILENCE_THRESHOLD = 0.015

# SILENCE_DURATION_FOR_COMMIT: Seconds of silence that triggers a commit
# This detects natural sentence/phrase boundaries
# 350ms is typical for inter-sentence pause in natural speech
SILENCE_DURATION_FOR_COMMIT = 0.35

# FORCE_COMMIT_SECONDS: Maximum seconds before forcing a commit
# Ensures progress during continuous speech without pauses
# 8s balances between responsiveness and chunk size for accuracy
FORCE_COMMIT_SECONDS = 8

# MIN_CHUNK_SECONDS: Minimum chunk size before allowing commit
# Prevents tiny fragments that may be transcribed inaccurately
# 0.8s ensures at least a few words per chunk
MIN_CHUNK_SECONDS = 0.8

# Derived values (in samples)
SILENCE_SAMPLES = int(SILENCE_DURATION_FOR_COMMIT * SAMPLE_RATE)
FORCE_COMMIT_SAMPLES = FORCE_COMMIT_SECONDS * SAMPLE_RATE
MIN_CHUNK_SAMPLES = int(MIN_CHUNK_SECONDS * SAMPLE_RATE)

# Global state
_model = None
_model_loaded = False

# ═══════════════════════════════════════════════════════════════════════════════
# CHUNK TRACKER - Core State Machine for Chunk-and-Commit
# ═══════════════════════════════════════════════════════════════════════════════
#
# This class is the heart of the chunk-and-commit architecture. It tracks:
# - What text has been COMMITTED (finalized, immutable, never re-transcribed)
# - How many audio samples are in committed chunks
# - Silence detection for natural pause-based commits
#
# LIFECYCLE:
# 1. User starts recording → reset() called
# 2. Each audio chunk → transcribe_buffer_chunked() updates state
# 3. Silence detected or 8s elapsed → commit() called
# 4. User stops recording → final state returned
#
# KEY INVARIANTS:
# - committed_text is APPEND-ONLY (never modified, only extended)
# - committed_samples marks the boundary between committed and uncommitted audio
# - Only audio AFTER committed_samples is transcribed (keeps it fast)
# ═══════════════════════════════════════════════════════════════════════════════

class ChunkTracker:
    """
    Tracks committed chunks and current partial for a recording session.
    
    This is the core state machine that enables freeze-free dictation.
    By tracking what audio has been committed, we ensure each transcription
    only processes the uncommitted portion (typically <8 seconds).
    """
    
    def __init__(self):
        # All committed text - IMMUTABLE once set
        # Frontend appends this, never reconciles it
        self.committed_text = ""
        
        # Total samples in all committed chunks
        # Used to slice audio: uncommitted = full_audio[committed_samples:]
        self.committed_samples = 0
        
        # Sample position of most recent commit
        # Used to calculate time since last commit for force-commit
        self.last_commit_sample = 0
        
        # Consecutive silence samples detected
        # When this exceeds SILENCE_SAMPLES, we have a pause
        self.silence_sample_count = 0
        
        # (Unused but kept for potential future use)
        self.pending_audio = None
        
        # Low-volume detection: track normal speech RMS to detect background noise
        # If audio is above silence threshold but far below normal speech, skip it
        self.speech_rms_history = []
        self.average_speech_rms = 0.08  # Initial estimate (good speech is ~0.05-0.15)
        
    def reset(self):
        """Reset for new recording session."""
        self.committed_text = ""
        self.committed_samples = 0
        self.last_commit_sample = 0
        self.silence_sample_count = 0
        self.pending_audio = None
        # Keep speech RMS history across resets for better calibration
        # Only clear if history is stale (>100 samples)
        if len(self.speech_rms_history) > 100:
            self.speech_rms_history = self.speech_rms_history[-50:]
        
    def should_force_commit(self, current_sample: int) -> bool:
        """Check if we should force commit due to duration."""
        samples_since_commit = current_sample - self.last_commit_sample
        return samples_since_commit >= FORCE_COMMIT_SAMPLES
    
    def detect_silence(self, audio_chunk: np.ndarray) -> bool:
        """Detect if chunk is silence and track consecutive silence."""
        rms = np.sqrt(np.mean(audio_chunk ** 2))
        is_silence = rms < SILENCE_THRESHOLD
        
        if is_silence:
            self.silence_sample_count += len(audio_chunk)
        else:
            self.silence_sample_count = 0
            # Update speech RMS average when we have actual speech
            if rms > SILENCE_THRESHOLD * 2:  # Clear speech, not borderline
                self.speech_rms_history.append(rms)
                if len(self.speech_rms_history) > 50:
                    self.speech_rms_history.pop(0)
                self.average_speech_rms = sum(self.speech_rms_history) / len(self.speech_rms_history)
            
        return self.silence_sample_count >= SILENCE_SAMPLES
    
    def is_low_volume_noise(self, audio_chunk: np.ndarray) -> bool:
        """
        Detect if audio is low-volume background noise (above silence, below speech).
        
        This catches background TV, distant conversations, etc. that Parakeet might
        transcribe as gibberish fragments like "Yeah. No, no, no."
        
        Returns:
            True if audio is likely background noise (should skip transcription)
        """
        rms = np.sqrt(np.mean(audio_chunk ** 2))
        
        # Above silence threshold (not silence)
        if rms <= SILENCE_THRESHOLD:
            return False  # It's silence, not noise
        
        # ABSOLUTE MINIMUM: Real speech is typically RMS 0.03-0.15
        # Background noise causing hallucinations is often 0.02-0.04
        # If below 0.025, it's likely noise even if above silence threshold
        MINIMUM_SPEECH_RMS = 0.025
        if rms < MINIMUM_SPEECH_RMS:
            sys.stderr.write(f"[STT] Low-volume noise (absolute): rms={rms:.4f} < min={MINIMUM_SPEECH_RMS}\n")
            sys.stderr.flush()
            return True
        
        # RELATIVE: Below 40% of average speech volume = likely background noise
        # (Increased from 30% to be more aggressive)
        low_volume_threshold = self.average_speech_rms * 0.4
        
        if rms < low_volume_threshold:
            sys.stderr.write(f"[STT] Low-volume noise (relative): rms={rms:.4f} < threshold={low_volume_threshold:.4f}\n")
            sys.stderr.flush()
            return True
        
        return False
    
    def should_commit(self, current_sample: int, has_pause: bool) -> bool:
        """
        Determine if we should commit the current chunk.
        
        Commit when:
        1. Natural pause detected (800ms+ silence) AND minimum chunk size met
        2. Force commit after 18s of continuous speech
        """
        samples_since_commit = current_sample - self.last_commit_sample
        
        # Check minimum chunk size
        if samples_since_commit < MIN_CHUNK_SAMPLES:
            return False
            
        # Commit on pause or force
        return has_pause or self.should_force_commit(current_sample)
    
    def commit(self, text: str, sample_position: int):
        """
        Commit current chunk, making it IMMUTABLE.
        
        This is the key operation that prevents freezing. Once committed:
        - The text is FINAL and will never change
        - Future transcriptions start AFTER sample_position
        - Frontend can safely append without reconciliation
        
        Args:
            text: The transcribed text for this chunk
            sample_position: Audio sample position marking end of this chunk
        
        Side effects:
            - committed_text extended (append-only)
            - committed_samples updated (moves the boundary forward)
            - silence_sample_count reset (new chunk starts fresh)
        """
        if text.strip():
            # Ensure space between chunks
            if self.committed_text and not self.committed_text.endswith(' '):
                self.committed_text += ' '
            self.committed_text += text.strip()
        
        # Move the committed boundary forward
        self.committed_samples = sample_position
        self.last_commit_sample = sample_position
        
        # Reset silence tracking for next chunk
        self.silence_sample_count = 0
        self.pending_audio = None
        
        sys.stderr.write(f"[STT] COMMITTED at sample {sample_position}: \"{text[:50]}...\"\n")
        sys.stderr.flush()

# Global tracker (one per server - sessions are sequential)
_chunk_tracker = ChunkTracker()


def initialize():
    """Load and warm up the Parakeet model."""
    global _model, _model_loaded
    
    if _model_loaded:
        return True
    
    try:
        from parakeet_mlx import from_pretrained
        
        sys.stderr.write("[STT] Loading Parakeet model...\n")
        sys.stderr.flush()
        
        load_start = time.time()
        _model = from_pretrained(PARAKEET_MODEL)
        load_time = (time.time() - load_start) * 1000
        
        sys.stderr.write(f"[STT] Model loaded in {load_time:.0f}ms\n")
        sys.stderr.flush()
        
        # Warm up
        sys.stderr.write("[STT] Warming up Neural Engine with speech audio...\n")
        sys.stderr.flush()
        
        warmup_start = time.time()
        
        warmup_path = os.path.join(os.path.dirname(__file__), 'warmup_audio.wav')
        if os.path.exists(warmup_path):
            try:
                warmup_audio, rate = sf.read(warmup_path, dtype='float32')
                if rate != 16000:
                    import librosa
                    warmup_audio = librosa.resample(warmup_audio, orig_sr=rate, target_sr=16000)
            except Exception as e:
                warmup_audio = np.zeros(16000 * 3, dtype=np.float32)
        else:
            warmup_audio = np.zeros(16000 * 3, dtype=np.float32)
        
        _transcribe_audio(warmup_audio)
        warmup_time = (time.time() - warmup_start) * 1000
        
        sys.stderr.write(f"[STT] Warmup complete in {warmup_time:.0f}ms - ready\n")
        sys.stderr.flush()
        
        _model_loaded = True
        return True
        
    except ImportError:
        sys.stderr.write("[STT] ERROR: parakeet_mlx not installed. Run: pip install parakeet-mlx\n")
        sys.stderr.flush()
        return False
    except Exception as e:
        sys.stderr.write(f"[STT] ERROR: Failed to load model: {e}\n")
        sys.stderr.flush()
        return False


def _filter_unk_tokens(text: str) -> str:
    """
    Remove <unk> tokens from Parakeet output.
    These appear when the model can't recognize audio (noise, silence, unclear speech).
    """
    import re
    # Remove <unk> tokens and normalize whitespace
    filtered = re.sub(r'<unk>', '', text)
    # Clean up multiple spaces left by removal
    filtered = re.sub(r'\s+', ' ', filtered)
    return filtered.strip()


def _transcribe_audio(audio: np.ndarray) -> str:
    """Internal transcription using Parakeet."""
    global _model
    
    if _model is None:
        raise RuntimeError("Model not loaded")
    
    temp_path = tempfile.mktemp(suffix='.wav')
    try:
        sf.write(temp_path, audio, 16000)
        result = _model.transcribe(temp_path)
        raw_text = result.text.strip() if hasattr(result, 'text') else str(result).strip()
        # Filter out <unk> tokens before returning
        return _filter_unk_tokens(raw_text)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def transcribe_buffer_chunked(pcm_base64: str, session_id: str, total_samples: int) -> dict:
    """
    Transcribe with chunk-and-commit architecture.
    
    This is the NEW transcription method that:
    1. Tracks committed vs uncommitted audio
    2. Detects pauses for natural commit points
    3. Forces commits after 18s of continuous speech
    4. Returns is_final=True for committed chunks
    
    Args:
        pcm_base64: Base64-encoded float32 PCM audio at 16kHz
        session_id: Unique session identifier (for session reset detection)
        total_samples: Total samples in the recording so far
    
    Returns:
        dict with:
        - committed_text: All committed text (immutable, append-only)
        - partial_text: Current uncommitted transcription (may change)
        - is_final: True if a new chunk was just committed
        - commit_sample: Sample position of latest commit
    """
    import base64
    global _chunk_tracker
    
    if not _model_loaded:
        if not initialize():
            return {"type": "error", "error": "Model not available"}
    
    try:
        # Decode audio
        pcm_bytes = base64.b64decode(pcm_base64)
        full_audio = np.frombuffer(pcm_bytes, dtype=np.float32)
        
        if len(full_audio) < 4000:  # Less than 250ms
            return {"type": "error", "error": "Audio too short"}
        
        # Calculate audio only since last commit
        uncommitted_start = _chunk_tracker.committed_samples
        uncommitted_audio = full_audio[uncommitted_start:] if uncommitted_start < len(full_audio) else full_audio
        
        # Minimum uncommitted audio check
        if len(uncommitted_audio) < 4000:
            # Not enough new audio - return existing state
            return {
                "type": "success",
                "committed_text": _chunk_tracker.committed_text,
                "partial_text": "",
                "is_final": False,
                "commit_sample": _chunk_tracker.committed_samples,
                "inference_time_ms": 0,
                "audio_duration_ms": int(len(full_audio) / 16000 * 1000)
            }
        
        # Check for pause (silence at end of uncommitted audio)
        # Look at last 1 second of uncommitted audio
        tail_samples = min(SAMPLE_RATE, len(uncommitted_audio))
        tail_audio = uncommitted_audio[-tail_samples:]
        has_pause = _chunk_tracker.detect_silence(tail_audio)
        
        # Check for low-volume background noise (above silence, below normal speech)
        # Skip transcription if audio is likely background noise - prevents gibberish
        if _chunk_tracker.is_low_volume_noise(uncommitted_audio):
            return {
                "type": "success",
                "committed_text": _chunk_tracker.committed_text,
                "partial_text": "",
                "is_final": False,
                "commit_sample": _chunk_tracker.committed_samples,
                "inference_time_ms": 0,
                "audio_duration_ms": int(len(full_audio) / 16000 * 1000),
                "skipped_low_volume": True
            }
        
        # Transcribe ONLY uncommitted audio (fast!)
        inference_start = time.time()
        partial_text = _transcribe_audio(uncommitted_audio)
        inference_time_ms = int((time.time() - inference_start) * 1000)
        
        # Check if we should commit
        should_commit = _chunk_tracker.should_commit(total_samples, has_pause)
        
        if should_commit and partial_text.strip():
            # COMMIT the chunk
            commit_reason = "pause" if has_pause else "force"
            sys.stderr.write(f"[STT] COMMIT ({commit_reason}) at sample {total_samples}\n")
            sys.stderr.flush()
            
            _chunk_tracker.commit(partial_text, total_samples)
            
            return {
                "type": "success",
                "committed_text": _chunk_tracker.committed_text,
                "partial_text": "",
                "is_final": True,
                "commit_sample": total_samples,
                "commit_reason": commit_reason,
                "inference_time_ms": inference_time_ms,
                "audio_duration_ms": int(len(uncommitted_audio) / 16000 * 1000)
            }
        else:
            # Partial result (may change)
            return {
                "type": "success",
                "committed_text": _chunk_tracker.committed_text,
                "partial_text": partial_text,
                "is_final": False,
                "commit_sample": _chunk_tracker.committed_samples,
                "inference_time_ms": inference_time_ms,
                "audio_duration_ms": int(len(uncommitted_audio) / 16000 * 1000)
            }
        
    except Exception as e:
        sys.stderr.write(f"[STT] Transcription error: {e}\n")
        sys.stderr.flush()
        return {"type": "error", "error": str(e)}


def transcribe_buffer(pcm_base64: str) -> dict:
    """
    Legacy transcribe from raw PCM float32 bytes.
    Still supported for compatibility.
    """
    import base64
    
    if not _model_loaded:
        if not initialize():
            return {"type": "error", "error": "Model not available"}
    
    try:
        pcm_bytes = base64.b64decode(pcm_base64)
        audio = np.frombuffer(pcm_bytes, dtype=np.float32)
        
        audio_duration_ms = int(len(audio) / 16000 * 1000)
        
        if len(audio) < 4000:
            return {"type": "error", "error": "Audio too short"}
        
        inference_start = time.time()
        text = _transcribe_audio(audio)
        inference_time_ms = int((time.time() - inference_start) * 1000)
        
        realtime_factor = round(audio_duration_ms / inference_time_ms, 1) if inference_time_ms > 0 else 0
        sys.stderr.write(f"[STT] {audio_duration_ms}ms audio → {inference_time_ms}ms ({realtime_factor}x)\n")
        sys.stderr.flush()
        
        return {
            "type": "success",
            "text": text,
            "inference_time_ms": inference_time_ms,
            "audio_duration_ms": audio_duration_ms,
            "realtime_factor": realtime_factor
        }
        
    except Exception as e:
        sys.stderr.write(f"[STT] Transcription error: {e}\n")
        sys.stderr.flush()
        return {"type": "error", "error": str(e)}


def transcribe_file(audio_path: str) -> dict:
    """Transcribe audio file."""
    if not _model_loaded:
        if not initialize():
            return {"type": "error", "error": "Model not available"}
    
    try:
        if not os.path.exists(audio_path):
            return {"type": "error", "error": f"File not found: {audio_path}"}
        
        audio, sr = sf.read(audio_path)
        
        if len(audio.shape) > 1:
            audio = audio.mean(axis=1)
        
        if sr != 16000:
            duration = len(audio) / sr
            target_length = int(duration * 16000)
            audio = np.interp(
                np.linspace(0, len(audio), target_length),
                np.arange(len(audio)),
                audio
            ).astype(np.float32)
        else:
            audio = audio.astype(np.float32)
        
        audio_duration_ms = int(len(audio) / 16000 * 1000)
        
        inference_start = time.time()
        text = _transcribe_audio(audio)
        inference_time_ms = int((time.time() - inference_start) * 1000)
        
        realtime_factor = round(audio_duration_ms / inference_time_ms, 1) if inference_time_ms > 0 else 0
        
        return {
            "type": "success",
            "text": text,
            "inference_time_ms": inference_time_ms,
            "audio_duration_ms": audio_duration_ms,
            "realtime_factor": realtime_factor
        }
        
    except Exception as e:
        sys.stderr.write(f"[STT] File transcription error: {e}\n")
        sys.stderr.flush()
        return {"type": "error", "error": str(e)}


def reset_session():
    """Reset chunk tracker for new recording session."""
    global _chunk_tracker
    _chunk_tracker.reset()
    sys.stderr.write("[STT] Session reset - chunk tracker cleared\n")
    sys.stderr.flush()
    return {"type": "success", "message": "Session reset"}


def main():
    """Main server loop - reads JSON commands from stdin."""
    global _chunk_tracker
    
    sys.stderr.write("[STT] Starting Parakeet STT Server (Chunk-and-Commit)...\n")
    sys.stderr.flush()
    
    if initialize():
        print(json.dumps({
            "type": "ready",
            "model": "parakeet",
            "status": "loaded",
            "architecture": "chunk-and-commit"
        }), flush=True)
        
        print(json.dumps({
            "type": "model_loaded",
            "model": "parakeet"
        }), flush=True)
    else:
        print(json.dumps({
            "type": "error",
            "error": "Failed to load Parakeet model"
        }), flush=True)
        sys.exit(1)
    
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        
        try:
            cmd = json.loads(line)
            action = cmd.get("action")
            
            if action == "transcribe_buffer_chunked":
                # NEW: Chunk-and-commit transcription
                result = transcribe_buffer_chunked(
                    cmd.get("pcm_base64", ""),
                    cmd.get("session_id", "default"),
                    cmd.get("total_samples", 0)
                )
                print(json.dumps(result), flush=True)
            
            elif action == "transcribe_buffer":
                # Legacy: Simple buffer transcription
                result = transcribe_buffer(cmd.get("pcm_base64", ""))
                print(json.dumps(result), flush=True)
            
            elif action == "transcribe_file":
                result = transcribe_file(cmd.get("audio_path", ""))
                print(json.dumps(result), flush=True)
            
            elif action == "reset_session":
                # Reset chunk tracker for new recording
                result = reset_session()
                print(json.dumps(result), flush=True)
            
            elif action == "warmup":
                warmup_path = os.path.join(os.path.dirname(__file__), 'warmup_audio.wav')
                if os.path.exists(warmup_path):
                    try:
                        warmup_audio, rate = sf.read(warmup_path, dtype='float32')
                    except:
                        warmup_audio = np.zeros(16000 * 3, dtype=np.float32)
                else:
                    warmup_audio = np.zeros(16000 * 3, dtype=np.float32)
                
                warmup_start = time.time()
                _transcribe_audio(warmup_audio)
                warmup_time = int((time.time() - warmup_start) * 1000)
                print(json.dumps({
                    "type": "warmup_complete",
                    "model": "parakeet",
                    "warmup_time_ms": warmup_time
                }), flush=True)
            
            elif action == "ping":
                print(json.dumps({"type": "pong"}), flush=True)
            
            elif action == "quit":
                print(json.dumps({"type": "goodbye"}), flush=True)
                break
            
            elif action == "get_models":
                print(json.dumps({
                    "type": "models",
                    "models": [{
                        "id": "parakeet",
                        "name": "Parakeet TDT",
                        "installed": True,
                        "loaded": _model_loaded,
                        "active": True
                    }],
                    "current_model": "parakeet",
                    "architecture": "chunk-and-commit"
                }), flush=True)
            
            elif action == "set_model":
                print(json.dumps({
                    "type": "success",
                    "message": "Parakeet is the only model",
                    "current_model": "parakeet"
                }), flush=True)
            
            else:
                print(json.dumps({
                    "type": "error",
                    "error": f"Unknown action: {action}"
                }), flush=True)
                
        except json.JSONDecodeError as e:
            print(json.dumps({"type": "error", "error": f"Invalid JSON: {e}"}), flush=True)
        except Exception as e:
            print(json.dumps({"type": "error", "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
