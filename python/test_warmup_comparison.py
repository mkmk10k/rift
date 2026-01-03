#!/opt/homebrew/bin/python3.11
"""
A/B Test: Silence Warmup vs Real Speech Warmup

Measures actual impact on time-to-first-transcription by running
fresh Python processes for each test case.
"""

import subprocess
import sys
import os

PYTHON = "/opt/homebrew/bin/python3.11"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Test script that will be run in fresh processes
TEST_SCRIPT = '''
import time
import numpy as np
import tempfile
import os
import soundfile as sf

# Suppress warnings
os.environ['MLX_DISABLE_METAL_WARNINGS'] = '1'

WARMUP_TYPE = "{warmup_type}"
SCRIPT_DIR = "{script_dir}"

print(f"Testing: {{WARMUP_TYPE}} warmup")

# === Phase 1: Load Model ===
load_start = time.time()
from parakeet_mlx import from_pretrained
model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
load_time = (time.time() - load_start) * 1000
print(f"  Model load: {{load_time:.0f}}ms")

# === Phase 2: Warmup (the variable we're testing) ===
warmup_start = time.time()
temp = tempfile.mktemp(suffix='.wav')

if WARMUP_TYPE == "silence":
    # Current baseline: 1 second of silence
    warmup_audio = np.zeros(16000, dtype=np.float32)
elif WARMUP_TYPE == "real_speech":
    # New approach: real TTS speech
    warmup_path = os.path.join(SCRIPT_DIR, 'warmup_audio.wav')
    warmup_audio, _ = sf.read(warmup_path, dtype='float32')

sf.write(temp, warmup_audio, 16000)
_ = model.transcribe(temp)
os.unlink(temp)
warmup_time = (time.time() - warmup_start) * 1000
print(f"  Warmup: {{warmup_time:.0f}}ms")

# === Phase 3: Simulate user's first recording ===
# This is what matters - how fast is the FIRST real transcription after warmup?
# We use a 2-second clip of the warmup audio to simulate ~2s of user speech

test_start = time.time()
temp = tempfile.mktemp(suffix='.wav')

# Use real speech for the test (simulating user speaking)
test_path = os.path.join(SCRIPT_DIR, 'warmup_audio.wav')
test_audio, _ = sf.read(test_path, dtype='float32')
test_audio = test_audio[:32000]  # First 2 seconds

sf.write(temp, test_audio, 16000)
result = model.transcribe(temp)
first_transcription_time = (time.time() - test_start) * 1000
os.unlink(temp)

text = result.text.strip() if hasattr(result, 'text') else str(result)
print(f"  First transcription: {{first_transcription_time:.0f}}ms")
print(f"  Result: \\"{{text[:50]}}...\\"")

# === Phase 4: Second transcription (should be consistently fast) ===
temp = tempfile.mktemp(suffix='.wav')
sf.write(temp, test_audio, 16000)
second_start = time.time()
_ = model.transcribe(temp)
second_time = (time.time() - second_start) * 1000
os.unlink(temp)
print(f"  Second transcription: {{second_time:.0f}}ms")

# Output summary for parsing
print(f"RESULT:{{WARMUP_TYPE}}:{{load_time:.0f}}:{{warmup_time:.0f}}:{{first_transcription_time:.0f}}:{{second_time:.0f}}")
'''

def run_test(warmup_type):
    """Run a test in a fresh Python process."""
    script = TEST_SCRIPT.format(warmup_type=warmup_type, script_dir=SCRIPT_DIR)
    
    result = subprocess.run(
        [PYTHON, "-c", script],
        capture_output=True,
        text=True,
        cwd=SCRIPT_DIR
    )
    
    output = result.stdout + result.stderr
    print(output)
    
    # Parse results
    for line in output.split('\n'):
        if line.startswith('RESULT:'):
            parts = line.split(':')
            return {
                'warmup_type': parts[1],
                'load_ms': int(parts[2]),
                'warmup_ms': int(parts[3]),
                'first_transcription_ms': int(parts[4]),
                'second_transcription_ms': int(parts[5])
            }
    return None

def main():
    print("=" * 70)
    print("A/B TEST: Warmup Strategy Comparison")
    print("=" * 70)
    print()
    print("Testing how warmup strategy affects time-to-first-transcription")
    print("Each test runs in a FRESH Python process (true cold start)")
    print()
    
    # Test A: Silence warmup (baseline)
    print("-" * 70)
    print("TEST A: Silence Warmup (1 second of silence)")
    print("-" * 70)
    result_silence = run_test("silence")
    
    print()
    
    # Test B: Real speech warmup
    print("-" * 70)
    print("TEST B: Real Speech Warmup (TTS audio)")
    print("-" * 70)
    result_speech = run_test("real_speech")
    
    # Summary comparison
    print()
    print("=" * 70)
    print("COMPARISON SUMMARY")
    print("=" * 70)
    print()
    print(f"{'Metric':<30} {'Silence':<15} {'Real Speech':<15} {'Difference':<15}")
    print("-" * 70)
    
    if result_silence and result_speech:
        metrics = [
            ('Model Load', 'load_ms'),
            ('Warmup Time', 'warmup_ms'),
            ('1st Transcription (USER)', 'first_transcription_ms'),
            ('2nd Transcription', 'second_transcription_ms'),
        ]
        
        for label, key in metrics:
            silence_val = result_silence[key]
            speech_val = result_speech[key]
            diff = speech_val - silence_val
            diff_str = f"{diff:+d}ms" if diff != 0 else "same"
            print(f"{label:<30} {silence_val:>10}ms {speech_val:>10}ms {diff_str:>15}")
        
        print()
        print("=" * 70)
        print("VERDICT")
        print("=" * 70)
        
        first_diff = result_speech['first_transcription_ms'] - result_silence['first_transcription_ms']
        
        if first_diff < -100:
            print(f"✓ REAL SPEECH WARMUP IS FASTER by {-first_diff}ms for first transcription!")
            print("  → User will see first text sooner")
        elif first_diff > 100:
            print(f"✗ Real speech warmup is SLOWER by {first_diff}ms")
            print("  → But may have other benefits (kernel compilation)")
        else:
            print(f"≈ No significant difference ({first_diff:+d}ms)")
            print("  → Both approaches perform similarly")
        
        # Calculate total time to first transcription from app start
        total_silence = result_silence['load_ms'] + result_silence['warmup_ms'] + result_silence['first_transcription_ms']
        total_speech = result_speech['load_ms'] + result_speech['warmup_ms'] + result_speech['first_transcription_ms']
        
        print()
        print(f"Total time (load + warmup + 1st transcription):")
        print(f"  Silence: {total_silence}ms")
        print(f"  Speech:  {total_speech}ms")

if __name__ == "__main__":
    main()
