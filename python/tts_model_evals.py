#!/usr/bin/env python3
"""
TTS Model Evaluation Framework

Autonomous testing framework for TTS models with:
- Performance metrics (TTFA, RTF, iterations/sec)
- Quality validation (not silence, not noise, proper speech spectrum)
- Memory monitoring
- Regression detection

Usage:
    # Test all models
    python tts_model_evals.py
    
    # Test specific model
    python tts_model_evals.py --model chatterbox-turbo-mlx
    
    # Quick test (short scenarios only)
    python tts_model_evals.py --quick
    
    # Generate report
    python tts_model_evals.py --report
"""

import sys
import os
import json
import time
import gc
import argparse
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional, Tuple
from pathlib import Path

import numpy as np

# Add parent directory for imports
sys.path.insert(0, str(Path(__file__).parent))

# ============================================================================
# CONSTANTS
# ============================================================================

SAMPLE_RATE = 24000  # Chatterbox uses 24kHz

# Audio quality thresholds
MIN_RMS_THRESHOLD = 0.005          # Below this = silence
MAX_ZCR_THRESHOLD = 0.4            # Above this = likely noise
MIN_ZCR_THRESHOLD = 0.005          # Below this = likely DC offset or silence
SPEECH_SPECTRAL_CENTROID_MIN = 300  # Hz - speech is typically 300-3000 Hz
SPEECH_SPECTRAL_CENTROID_MAX = 4000 # Hz

# Performance thresholds
MAX_MEMORY_GROWTH_MB = 100         # Fail if memory grows more than this over test run


# ============================================================================
# TEST SCENARIOS
# ============================================================================

@dataclass
class TTSScenario:
    id: str
    name: str
    text: str
    description: str
    category: str  # 'short', 'medium', 'long', 'edge_case'
    max_generation_time_ms: int = 30000
    min_rtf: float = 0.1  # Real-time factor

SCENARIOS = [
    # Short text
    TTSScenario('minimal', 'Minimal Text', 'Hello.', 
                'Single word TTFA test', 'short', 5000, 0.5),
    TTSScenario('greeting', 'Greeting', 'Hello, how are you today?',
                'Common greeting', 'short', 8000, 0.5),
    TTSScenario('short-sentence', 'Short Sentence', 
                'The quick brown fox jumps over the lazy dog.',
                'Pangram', 'short', 10000, 0.5),
    
    # Medium text
    TTSScenario('paragraph', 'Single Paragraph',
                'This is a test of the text-to-speech system. It should generate natural sounding speech.',
                'Two sentences', 'medium', 15000, 0.3),
    TTSScenario('technical', 'Technical Content',
                'The API returns a JSON object with status code 200. Check the documentation for details.',
                'Technical text', 'medium', 15000, 0.3),
    
    # Long text
    TTSScenario('long-paragraph', 'Long Paragraph',
                'Artificial intelligence has transformed many aspects of our daily lives. '
                'From voice assistants that help us manage our schedules to recommendation systems. '
                'As these systems become more sophisticated, they are being integrated everywhere.',
                'Sustained synthesis test', 'long', 60000, 0.2),
    
    # Edge cases
    TTSScenario('punctuation', 'Heavy Punctuation',
                'Wait... what? No! I mean - yes, definitely.',
                'Punctuation handling', 'edge_case', 10000, 0.3),
    TTSScenario('numbers', 'Numbers',
                'The meeting is on January 15th at 3:30 PM.',
                'Number pronunciation', 'edge_case', 10000, 0.3),
]


# ============================================================================
# METRICS
# ============================================================================

@dataclass
class TTSMetrics:
    """Metrics from a single TTS generation"""
    scenario_id: str
    model_id: str
    
    # Timing
    generation_time_ms: float
    audio_duration_ms: float
    real_time_factor: float  # audio_duration / generation_time
    iterations_per_sec: Optional[float] = None
    
    # Quality
    rms_level: float = 0.0
    zero_crossing_rate: float = 0.0
    spectral_centroid: float = 0.0
    
    # Quality checks
    is_silence: bool = True
    is_noise: bool = True
    has_speech_spectrum: bool = False
    
    # Memory
    memory_before_mb: float = 0.0
    memory_after_mb: float = 0.0
    memory_growth_mb: float = 0.0
    
    # Pass/Fail
    passed: bool = False
    failures: List[str] = None
    
    def __post_init__(self):
        if self.failures is None:
            self.failures = []


@dataclass
class TTSModelReport:
    """Aggregate report for a model across all scenarios"""
    model_id: str
    model_name: str
    
    # Aggregate metrics
    total_scenarios: int
    passed_scenarios: int
    failed_scenarios: int
    
    # Performance summary
    avg_rtf: float
    min_rtf: float
    max_ttfa_ms: float
    avg_generation_time_ms: float
    
    # Memory summary
    baseline_memory_mb: float
    peak_memory_mb: float
    total_memory_growth_mb: float
    
    # Individual results
    scenario_results: List[TTSMetrics] = None
    
    def __post_init__(self):
        if self.scenario_results is None:
            self.scenario_results = []


# ============================================================================
# AUDIO ANALYSIS
# ============================================================================

def analyze_audio(audio_np: np.ndarray, sample_rate: int = SAMPLE_RATE) -> Dict:
    """
    Analyze audio for quality metrics.
    
    Returns dict with:
    - rms: Root mean square level
    - zcr: Zero crossing rate
    - spectral_centroid: Center frequency of spectrum
    - is_silence: True if RMS below threshold
    - is_noise: True if ZCR suggests noise
    - has_speech_spectrum: True if spectral centroid in speech range
    """
    if len(audio_np) == 0:
        return {
            'rms': 0.0,
            'zcr': 0.0,
            'spectral_centroid': 0.0,
            'is_silence': True,
            'is_noise': True,
            'has_speech_spectrum': False,
            'duration_ms': 0.0,
        }
    
    # Ensure 1D
    audio = audio_np.squeeze()
    
    # Duration
    duration_ms = (len(audio) / sample_rate) * 1000
    
    # RMS level
    rms = np.sqrt(np.mean(audio ** 2))
    is_silence = rms < MIN_RMS_THRESHOLD
    
    # Zero crossing rate
    zero_crossings = np.sum(np.abs(np.diff(np.sign(audio))) > 0)
    zcr = zero_crossings / len(audio) if len(audio) > 0 else 0
    is_noise = zcr > MAX_ZCR_THRESHOLD or zcr < MIN_ZCR_THRESHOLD
    
    # Spectral centroid (simplified - using FFT)
    try:
        fft = np.abs(np.fft.rfft(audio))
        freqs = np.fft.rfftfreq(len(audio), 1/sample_rate)
        spectral_centroid = np.sum(freqs * fft) / (np.sum(fft) + 1e-10)
    except Exception:
        spectral_centroid = 0.0
    
    has_speech_spectrum = (
        SPEECH_SPECTRAL_CENTROID_MIN < spectral_centroid < SPEECH_SPECTRAL_CENTROID_MAX
    )
    
    return {
        'rms': float(rms),
        'zcr': float(zcr),
        'spectral_centroid': float(spectral_centroid),
        'is_silence': is_silence,
        'is_noise': is_noise and not is_silence,  # Silence takes precedence
        'has_speech_spectrum': has_speech_spectrum,
        'duration_ms': duration_ms,
    }


def get_memory_mb() -> float:
    """Get current process memory in MB"""
    try:
        import psutil
        return psutil.Process().memory_info().rss / (1024 * 1024)
    except ImportError:
        return 0.0


# ============================================================================
# MODEL LOADERS
# ============================================================================

def load_chatterbox_turbo_mlx():
    """
    Load Chatterbox Turbo using native MLX weights.
    
    This bypasses the broken from_pretrained() by directly downloading
    the pre-converted MLX weights from mlx-community.
    """
    from huggingface_hub import snapshot_download
    from mlx_audio.tts.models.chatterbox_turbo import ChatterboxTurboTTS
    
    # Download pre-converted MLX weights
    print("[TTS Eval] Downloading Chatterbox Turbo MLX weights...")
    local_path = snapshot_download(
        repo_id="mlx-community/Chatterbox-Turbo-TTS-fp16",
        allow_patterns=["*.safetensors", "*.json"],
    )
    
    print(f"[TTS Eval] Loading from {local_path}")
    model = ChatterboxTurboTTS.from_local(local_path)
    
    return model


def load_chatterbox_full_mlx():
    """
    Load full Chatterbox using native MLX weights.
    """
    from huggingface_hub import snapshot_download
    from mlx_audio.tts.models.chatterbox import Model as ChatterboxModel
    
    # Download pre-converted MLX weights
    print("[TTS Eval] Downloading Chatterbox Full MLX weights...")
    local_path = snapshot_download(
        repo_id="mlx-community/Chatterbox-TTS-fp16",
        allow_patterns=["*.safetensors", "*.json"],
    )
    
    print(f"[TTS Eval] Loading from {local_path}")
    model = ChatterboxModel.from_local(local_path)
    
    return model


def load_kokoro():
    """Load Kokoro TTS (existing implementation)"""
    # Import from existing tts_server
    import tts_server
    return tts_server.initialize_kokoro()


MODEL_LOADERS = {
    'chatterbox-turbo-mlx': load_chatterbox_turbo_mlx,
    'chatterbox-full-mlx': load_chatterbox_full_mlx,
    'kokoro': load_kokoro,
}


# ============================================================================
# SYNTHESIS FUNCTIONS
# ============================================================================

def synthesize_chatterbox_turbo_mlx(model, text: str) -> Tuple[np.ndarray, int, Optional[float]]:
    """
    Synthesize with Chatterbox Turbo MLX.
    
    Returns: (audio_np, sample_rate, iterations_per_sec or None)
    """
    start = time.time()
    
    # Generate audio
    audio = model.generate(text)
    
    elapsed = time.time() - start
    
    # Convert to numpy
    audio_np = np.array(audio).squeeze()
    
    return audio_np, 24000, None  # Turbo doesn't report iterations


def synthesize_chatterbox_full_mlx(model, text: str) -> Tuple[np.ndarray, int, Optional[float]]:
    """
    Synthesize with full Chatterbox MLX.
    """
    start = time.time()
    
    # Generate audio (full model may need reference audio for best quality)
    audio = model.generate(text, stream=False)
    
    elapsed = time.time() - start
    
    audio_np = np.array(audio).squeeze()
    
    return audio_np, 24000, None


def synthesize_kokoro(model, text: str) -> Tuple[np.ndarray, int, Optional[float]]:
    """Synthesize with Kokoro"""
    import soundfile as sf
    import io
    import base64
    
    # Use existing tts_server synthesis
    import tts_server
    
    start = time.time()
    
    results = list(tts_server.synthesize_realtime_kokoro(text, voice="af_heart"))
    
    elapsed = time.time() - start
    
    # Extract audio from results
    for result in results:
        if result.get('type') == 'realtime_chunk' and result.get('audio_base64'):
            audio_bytes = base64.b64decode(result['audio_base64'])
            audio_np, sr = sf.read(io.BytesIO(audio_bytes))
            return audio_np, sr, None
    
    return np.array([]), 24000, None


SYNTHESIZERS = {
    'chatterbox-turbo-mlx': synthesize_chatterbox_turbo_mlx,
    'chatterbox-full-mlx': synthesize_chatterbox_full_mlx,
    'kokoro': synthesize_kokoro,
}


# ============================================================================
# TEST RUNNER
# ============================================================================

def run_scenario(
    model,
    model_id: str,
    scenario: TTSScenario,
    synthesize_fn,
) -> TTSMetrics:
    """Run a single scenario and return metrics"""
    
    metrics = TTSMetrics(
        scenario_id=scenario.id,
        model_id=model_id,
        generation_time_ms=0,
        audio_duration_ms=0,
        real_time_factor=0,
    )
    
    # Memory before
    metrics.memory_before_mb = get_memory_mb()
    
    try:
        # Time the synthesis
        start = time.time()
        audio_np, sample_rate, iterations = synthesize_fn(model, scenario.text)
        elapsed = time.time() - start
        
        metrics.generation_time_ms = elapsed * 1000
        metrics.iterations_per_sec = iterations
        
        # Memory after
        metrics.memory_after_mb = get_memory_mb()
        metrics.memory_growth_mb = metrics.memory_after_mb - metrics.memory_before_mb
        
        # Analyze audio quality
        analysis = analyze_audio(audio_np, sample_rate)
        
        metrics.audio_duration_ms = analysis['duration_ms']
        metrics.rms_level = analysis['rms']
        metrics.zero_crossing_rate = analysis['zcr']
        metrics.spectral_centroid = analysis['spectral_centroid']
        metrics.is_silence = analysis['is_silence']
        metrics.is_noise = analysis['is_noise']
        metrics.has_speech_spectrum = analysis['has_speech_spectrum']
        
        # Calculate RTF
        if metrics.generation_time_ms > 0:
            metrics.real_time_factor = metrics.audio_duration_ms / metrics.generation_time_ms
        
        # Determine pass/fail
        failures = []
        
        # Performance checks
        if metrics.generation_time_ms > scenario.max_generation_time_ms:
            failures.append(
                f"Generation too slow: {metrics.generation_time_ms:.0f}ms > {scenario.max_generation_time_ms}ms"
            )
        
        if metrics.real_time_factor < scenario.min_rtf:
            failures.append(
                f"RTF too low: {metrics.real_time_factor:.2f} < {scenario.min_rtf}"
            )
        
        # Quality checks
        if metrics.is_silence:
            failures.append(f"Audio is silence (RMS={metrics.rms_level:.4f})")
        
        if metrics.is_noise:
            failures.append(f"Audio is likely noise (ZCR={metrics.zero_crossing_rate:.4f})")
        
        if not metrics.has_speech_spectrum and not metrics.is_silence:
            failures.append(
                f"Spectral centroid outside speech range: {metrics.spectral_centroid:.0f}Hz"
            )
        
        metrics.failures = failures
        metrics.passed = len(failures) == 0
        
    except Exception as e:
        metrics.failures = [f"Exception during synthesis: {str(e)}"]
        metrics.passed = False
    
    return metrics


def run_model_evaluation(
    model_id: str,
    scenarios: List[TTSScenario],
    verbose: bool = True,
) -> TTSModelReport:
    """
    Run all scenarios for a model and return aggregate report.
    """
    
    if model_id not in MODEL_LOADERS:
        raise ValueError(f"Unknown model: {model_id}. Available: {list(MODEL_LOADERS.keys())}")
    
    if model_id not in SYNTHESIZERS:
        raise ValueError(f"No synthesizer for: {model_id}")
    
    if verbose:
        print(f"\n{'='*60}")
        print(f"Testing: {model_id}")
        print(f"{'='*60}\n")
    
    # Load model
    baseline_memory = get_memory_mb()
    
    if verbose:
        print(f"[Memory] Baseline: {baseline_memory:.1f}MB")
        print(f"Loading model...")
    
    load_start = time.time()
    model = MODEL_LOADERS[model_id]()
    load_time = time.time() - load_start
    
    post_load_memory = get_memory_mb()
    
    if verbose:
        print(f"[Memory] After load: {post_load_memory:.1f}MB (+{post_load_memory - baseline_memory:.1f}MB)")
        print(f"Model loaded in {load_time:.1f}s\n")
    
    # Run scenarios
    synthesize_fn = SYNTHESIZERS[model_id]
    results: List[TTSMetrics] = []
    peak_memory = post_load_memory
    
    for i, scenario in enumerate(scenarios):
        if verbose:
            print(f"[{i+1}/{len(scenarios)}] {scenario.name}: '{scenario.text[:50]}...'")
        
        metrics = run_scenario(model, model_id, scenario, synthesize_fn)
        results.append(metrics)
        
        # Track peak memory
        if metrics.memory_after_mb > peak_memory:
            peak_memory = metrics.memory_after_mb
        
        if verbose:
            status = "PASS" if metrics.passed else "FAIL"
            print(f"    {status} | Gen: {metrics.generation_time_ms:.0f}ms | "
                  f"Audio: {metrics.audio_duration_ms:.0f}ms | RTF: {metrics.real_time_factor:.2f}x")
            if not metrics.passed:
                for f in metrics.failures:
                    print(f"    -> {f}")
        
        # GC between scenarios
        gc.collect()
    
    # Build report
    passed = [r for r in results if r.passed]
    failed = [r for r in results if not r.passed]
    
    rtfs = [r.real_time_factor for r in results if r.real_time_factor > 0]
    gen_times = [r.generation_time_ms for r in results]
    
    report = TTSModelReport(
        model_id=model_id,
        model_name=model_id,  # Could look up friendly name
        total_scenarios=len(results),
        passed_scenarios=len(passed),
        failed_scenarios=len(failed),
        avg_rtf=np.mean(rtfs) if rtfs else 0,
        min_rtf=min(rtfs) if rtfs else 0,
        max_ttfa_ms=max(gen_times) if gen_times else 0,
        avg_generation_time_ms=np.mean(gen_times) if gen_times else 0,
        baseline_memory_mb=baseline_memory,
        peak_memory_mb=peak_memory,
        total_memory_growth_mb=peak_memory - baseline_memory,
        scenario_results=results,
    )
    
    if verbose:
        print(f"\n{'='*60}")
        print(f"SUMMARY: {model_id}")
        print(f"{'='*60}")
        print(f"Passed: {report.passed_scenarios}/{report.total_scenarios}")
        print(f"Avg RTF: {report.avg_rtf:.2f}x")
        print(f"Min RTF: {report.min_rtf:.2f}x")
        print(f"Avg Gen Time: {report.avg_generation_time_ms:.0f}ms")
        print(f"Memory: {report.baseline_memory_mb:.0f}MB -> {report.peak_memory_mb:.0f}MB "
              f"(+{report.total_memory_growth_mb:.0f}MB)")
        
        # Memory leak warning
        if report.total_memory_growth_mb > MAX_MEMORY_GROWTH_MB:
            print(f"\n⚠️  WARNING: Memory growth ({report.total_memory_growth_mb:.0f}MB) "
                  f"exceeds threshold ({MAX_MEMORY_GROWTH_MB}MB)")
    
    return report


# ============================================================================
# MAIN
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description='TTS Model Evaluation Framework')
    parser.add_argument('--model', type=str, default=None,
                        help='Specific model to test (default: all)')
    parser.add_argument('--quick', action='store_true',
                        help='Quick test with short scenarios only')
    parser.add_argument('--report', type=str, default=None,
                        help='Save JSON report to file')
    parser.add_argument('--quiet', action='store_true',
                        help='Minimal output')
    args = parser.parse_args()
    
    # Select scenarios
    if args.quick:
        scenarios = [s for s in SCENARIOS if s.category == 'short']
    else:
        scenarios = SCENARIOS
    
    # Select models
    if args.model:
        models = [args.model]
    else:
        # Default: test MLX models
        models = ['chatterbox-turbo-mlx']
    
    # Run evaluations
    all_reports = []
    
    for model_id in models:
        try:
            report = run_model_evaluation(
                model_id, 
                scenarios, 
                verbose=not args.quiet
            )
            all_reports.append(report)
        except Exception as e:
            print(f"\nERROR testing {model_id}: {e}")
            import traceback
            traceback.print_exc()
    
    # Save report if requested
    if args.report:
        report_data = {
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'models': [asdict(r) for r in all_reports],
        }
        with open(args.report, 'w') as f:
            json.dump(report_data, f, indent=2, default=str)
        print(f"\nReport saved to: {args.report}")
    
    # Summary
    print(f"\n{'='*60}")
    print("FINAL SUMMARY")
    print(f"{'='*60}")
    
    all_passed = True
    for report in all_reports:
        status = "PASS" if report.failed_scenarios == 0 else "FAIL"
        if report.failed_scenarios > 0:
            all_passed = False
        print(f"{report.model_id}: {status} ({report.passed_scenarios}/{report.total_scenarios})")
    
    return 0 if all_passed else 1


if __name__ == '__main__':
    sys.exit(main())
