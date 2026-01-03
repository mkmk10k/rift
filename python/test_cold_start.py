#!/opt/homebrew/bin/python3.11
"""
Self-test for measuring STT cold start and warm transcription times.
Tests with both silence and speech-like audio to verify warmup effectiveness.
"""

import numpy as np
import tempfile
import time
import os
import sys

# Add parent directory to path
sys.path.insert(0, os.path.dirname(__file__))

print("=" * 60)
print("STT Cold Start Test")
print("=" * 60)

# Test 1: Load model fresh (simulates cold start)
print("\n[1] Loading Parakeet model from scratch...")
load_start = time.time()

from parakeet_mlx import from_pretrained
model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
load_time = (time.time() - load_start) * 1000
print(f"    Model load time: {load_time:.0f}ms")

# Helper function
def transcribe(audio_data):
    """Transcribe audio and return time + result."""
    import soundfile as sf
    temp_path = tempfile.mktemp(suffix='.wav')
    sf.write(temp_path, audio_data, 16000)
    
    start = time.time()
    result = model.transcribe(temp_path)
    elapsed = (time.time() - start) * 1000
    
    os.unlink(temp_path)
    # Handle AlignedResult object from parakeet-mlx
    if hasattr(result, 'text'):
        text = result.text.strip()
    elif isinstance(result, dict):
        text = result.get('text', '').strip()
    else:
        text = str(result)[:100] if result else ''
    return elapsed, text

# Test 2: First transcription with SILENCE (current baseline)
print("\n[2] First transcription with 1s SILENCE (cold Neural Engine)...")
silence = np.zeros(16000, dtype=np.float32)
time_silence, _ = transcribe(silence)
print(f"    Time with silence: {time_silence:.0f}ms")

# Test 3: Second transcription with SILENCE (should be faster - warm)
print("\n[3] Second transcription with 1s SILENCE (warm Neural Engine)...")
time_silence2, _ = transcribe(silence)
print(f"    Time with silence (warm): {time_silence2:.0f}ms")

# Test 4: Transcription with speech-like audio
print("\n[4] Transcription with 3s speech-like audio...")
warmup_path = os.path.join(os.path.dirname(__file__), 'warmup_audio.wav')
if os.path.exists(warmup_path):
    import soundfile as sf
    warmup_audio, rate = sf.read(warmup_path, dtype='float32')
    time_speech, text = transcribe(warmup_audio)
    print(f"    Time with speech audio: {time_speech:.0f}ms")
    print(f"    Transcribed as: '{text[:50]}...' (len={len(text)})")
else:
    print("    Warmup audio not found!")

# Test 5: Subsequent transcription (fully warm)
print("\n[5] Subsequent transcription (fully warm)...")
time_warm, text2 = transcribe(warmup_audio)
print(f"    Time (fully warm): {time_warm:.0f}ms")
print(f"    Transcribed as: '{text2[:50]}...' (len={len(text2)})")

# Summary
print("\n" + "=" * 60)
print("SUMMARY")
print("=" * 60)
print(f"Model load:            {load_time:>6.0f}ms")
print(f"1st transcription:     {time_silence:>6.0f}ms (silence - coldest)")
print(f"2nd transcription:     {time_silence2:>6.0f}ms (silence - warmer)")
print(f"3rd transcription:     {time_speech:>6.0f}ms (speech audio)")
print(f"4th transcription:     {time_warm:>6.0f}ms (fully warm)")
print()
print(f"Cold start penalty:    ~{time_silence - time_warm:.0f}ms")
print(f"Speech warmup benefit: ~{time_silence2 - time_speech:.0f}ms vs silence")
print("=" * 60)
