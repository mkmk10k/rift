#!/opt/homebrew/bin/python3.11
"""
REAL SCENARIO TEST: Simulates actual user experience

Measures:
1. App startup (model load + warmup)
2. Recording 1: Time from "audio received" to "first text available"
3. Recording 2: Same measurement (should be faster - warm)
4. Recording 3: Same measurement (should be consistently fast)

Goal: Make Recording 1 as fast as Recording 2/3
"""

import time
import numpy as np
import tempfile
import os
import soundfile as sf

os.environ['MLX_DISABLE_METAL_WARNINGS'] = '1'

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

print("=" * 70)
print("REAL USER SCENARIO TEST")
print("=" * 70)
print()

# === PHASE 1: APP STARTUP (happens once when user opens app) ===
print("[PHASE 1] APP STARTUP")
print("-" * 70)

startup_start = time.time()

# 1a. Load model
print("  Loading Parakeet model...", end=" ", flush=True)
load_start = time.time()
from parakeet_mlx import from_pretrained
model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
load_time = (time.time() - load_start) * 1000
print(f"{load_time:.0f}ms")

# 1b. Warmup with real speech
print("  Warming up with real speech...", end=" ", flush=True)
warmup_start = time.time()
warmup_path = os.path.join(SCRIPT_DIR, 'warmup_audio.wav')
warmup_audio, _ = sf.read(warmup_path, dtype='float32')
temp = tempfile.mktemp(suffix='.wav')
sf.write(temp, warmup_audio, 16000)
_ = model.transcribe(temp)
os.unlink(temp)
warmup_time = (time.time() - warmup_start) * 1000
print(f"{warmup_time:.0f}ms")

total_startup = (time.time() - startup_start) * 1000
print(f"  TOTAL STARTUP: {total_startup:.0f}ms")
print()

# === PHASE 2: USER RECORDINGS (simulates pressing record multiple times) ===
print("[PHASE 2] USER RECORDINGS")
print("-" * 70)
print()

# Load test audio (simulates user speaking)
test_audio, _ = sf.read(warmup_path, dtype='float32')

def simulate_recording(recording_num, audio_chunk_seconds=2.0):
    """
    Simulates a user recording session.
    
    Returns time from "first audio chunk received" to "first text available"
    This is what the user perceives as "lag" or "responsiveness"
    """
    # Simulate the first chunk of audio (like the AudioWorklet would send)
    chunk_samples = int(16000 * audio_chunk_seconds)
    audio_chunk = test_audio[:chunk_samples]
    
    # Write to temp file (simulates the streaming buffer)
    temp = tempfile.mktemp(suffix='.wav')
    sf.write(temp, audio_chunk, 16000)
    
    # === THIS IS THE KEY MEASUREMENT ===
    # Time from "audio ready" to "transcription available"
    transcribe_start = time.time()
    result = model.transcribe(temp)
    transcribe_time = (time.time() - transcribe_start) * 1000
    
    os.unlink(temp)
    
    text = result.text.strip() if hasattr(result, 'text') else ''
    
    return {
        'recording_num': recording_num,
        'audio_seconds': audio_chunk_seconds,
        'transcribe_ms': transcribe_time,
        'text_preview': text[:40] + '...' if len(text) > 40 else text
    }

# Simulate 5 recordings
results = []
for i in range(1, 6):
    print(f"  Recording {i}:", end=" ", flush=True)
    result = simulate_recording(i, audio_chunk_seconds=2.0)
    results.append(result)
    print(f"{result['transcribe_ms']:.0f}ms → \"{result['text_preview']}\"")

print()

# === PHASE 3: ANALYSIS ===
print("[PHASE 3] ANALYSIS")
print("-" * 70)
print()

first_time = results[0]['transcribe_ms']
subsequent_times = [r['transcribe_ms'] for r in results[1:]]
avg_subsequent = sum(subsequent_times) / len(subsequent_times)

print(f"  Recording 1 (first):     {first_time:.0f}ms")
print(f"  Recordings 2-5 (warm):   {subsequent_times} → avg {avg_subsequent:.0f}ms")
print()

gap = first_time - avg_subsequent
print(f"  GAP (1st vs avg warm):   {gap:+.0f}ms")
print()

if gap < 50:
    print("  ✓ EXCELLENT: First recording is as fast as subsequent ones!")
    print("    The warmup is working perfectly.")
elif gap < 150:
    print("  ≈ GOOD: First recording is slightly slower but acceptable.")
    print("    Gap is within acceptable range (<150ms).")
else:
    print("  ✗ PROBLEM: First recording is significantly slower.")
    print("    Warmup may not be compiling all necessary kernels.")

print()
print("=" * 70)
print("SUMMARY FOR USER EXPERIENCE")
print("=" * 70)
print()
print(f"  App startup time:        {total_startup:.0f}ms (~{total_startup/1000:.1f}s)")
print(f"  First recording latency: {first_time:.0f}ms")
print(f"  Subsequent latency:      {avg_subsequent:.0f}ms")
print()
print(f"  User perception:")
print(f"    - App ready in ~{total_startup/1000:.1f} seconds")
print(f"    - First text appears in ~{first_time:.0f}ms after speaking")
print(f"    - Subsequent text appears in ~{avg_subsequent:.0f}ms")
print()

# Output machine-readable results for iteration
print(f"METRICS:{total_startup:.0f}:{first_time:.0f}:{avg_subsequent:.0f}:{gap:.0f}")
