#!/opt/homebrew/bin/python3.11
"""
MLX Audio Speech-to-Text Bridge
Provides local Whisper inference using mlx-audio
"""

import sys
import json
import argparse
from pathlib import Path

try:
    import mlx_whisper
    import soundfile as sf
    import numpy as np
except ImportError as e:
    print(json.dumps({"error": f"Missing dependency: {e}"}))
    sys.exit(0)


def transcribe_audio(audio_file: str, model_name: str = "mlx-community/whisper-tiny") -> dict:
    """
    Transcribe audio file using mlx-audio Whisper model
    
    Args:
        audio_file: Path to audio file
        model_name: MLX Whisper model to use
        
    Returns:
        Dictionary with transcription result
    """
    try:
        # Load audio
        audio_path = Path(audio_file)
        if not audio_path.exists():
            return {"error": f"Audio file not found: {audio_file}"}
        
        # soundfile can handle WebM/Opus via libsndfile
        # If it fails, we'll catch and report the error
        try:
            audio, sample_rate = sf.read(audio_file)
        except Exception as e:
            # WebM might not be supported, return helpful error
            import sys
            print(json.dumps({"error": f"Audio format not supported. WebM/Opus may not be readable by soundfile. Error: {str(e)}"}))
            sys.exit(0)
            return {"error": f"Audio format not supported: {str(e)}. Try installing ffmpeg."}
        
        # Convert stereo to mono if needed
        if len(audio.shape) > 1:
            audio = audio.mean(axis=1)
        
        # Resample to 16kHz if needed (Whisper expects 16kHz)
        if sample_rate != 16000:
            # Simple resampling
            duration = len(audio) / sample_rate
            target_length = int(duration * 16000)
            audio = np.interp(
                np.linspace(0, len(audio), target_length),
                np.arange(len(audio)),
                audio
            )
            sample_rate = 16000
        
        # Transcribe using mlx-whisper
        result = mlx_whisper.transcribe(
            audio, 
            path_or_hf_repo=model_name,
            fp16=False  # Use fp32 for M-series chips
        )
        
        return {
            "text": result.get("text", "").strip(),
            "segments": result.get("segments", []),
            "language": result.get("language", "en")
        }
        
    except Exception as e:
        return {"error": f"Transcription failed: {str(e)}"}


def main():
    parser = argparse.ArgumentParser(description="MLX Audio STT Bridge")
    parser.add_argument("--audio", required=True, help="Path to audio file")
    parser.add_argument("--model", default="mlx-community/whisper-tiny", help="Model name")
    args = parser.parse_args()
    
    result = transcribe_audio(args.audio, args.model)
    print(json.dumps(result))


if __name__ == "__main__":
    main()

