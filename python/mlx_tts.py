#!/opt/homebrew/bin/python3.11
"""
MLX Audio Text-to-Speech Bridge
Provides local TTS using mlx-audio Kokoro models
"""

import sys
import json
import argparse
from pathlib import Path

try:
    from mlx_audio.tts.models.kokoro import KokoroPipeline
    from mlx_audio.tts.utils import load_model
    import soundfile as sf
except ImportError as e:
    print(json.dumps({"error": f"Missing dependency: {e}"}), file=sys.stderr)
    sys.exit(1)


def synthesize_speech(
    text: str,
    output_file: str,
    voice: str = "af_heart",
    speed: float = 1.0,
    model_id: str = "prince-canuma/Kokoro-82M",
    lang_code: str = "a"  # American English
) -> dict:
    """
    Synthesize speech from text using mlx-audio TTS
    
    Args:
        text: Text to synthesize
        output_file: Path to save audio file
        voice: Voice ID (af_heart, af_nova, af_bella, bf_emma, etc.)
        speed: Speech speed (0.5 - 2.0)
        model_id: MLX TTS model to use
        lang_code: Language code (a=American English, b=British, j=Japanese, z=Chinese)
        
    Returns:
        Dictionary with synthesis result
    """
    try:
        # Load model (cached after first load)
        model = load_model(model_id)
        
        # Create pipeline
        pipeline = KokoroPipeline(lang_code=lang_code, model=model, repo_id=model_id)
        
        # Generate audio
        audio_data = None
        sample_rate = 24000
        
        for _, _, audio in pipeline(text, voice=voice, speed=speed, split_pattern=r'\n+'):
            audio_data = audio
            break  # Take first chunk for now
        
        if audio_data is None:
            return {"error": "No audio generated"}
        
        # Save audio file
        output_path = Path(output_file)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_path), audio_data[0], sample_rate)
        
        return {
            "output_file": str(output_path),
            "sample_rate": sample_rate,
            "duration": len(audio_data[0]) / sample_rate
        }
        
    except Exception as e:
        return {"error": f"Synthesis failed: {str(e)}"}


def main():
    parser = argparse.ArgumentParser(description="MLX Audio TTS Bridge")
    parser.add_argument("--text", required=True, help="Text to synthesize")
    parser.add_argument("--output", required=True, help="Output audio file path")
    parser.add_argument("--voice", default="af_heart", help="Voice ID")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed")
    parser.add_argument("--model", default="prince-canuma/Kokoro-82M", help="Model ID")
    parser.add_argument("--lang", default="a", help="Language code")
    args = parser.parse_args()
    
    result = synthesize_speech(
        args.text,
        args.output,
        voice=args.voice,
        speed=args.speed,
        model_id=args.model,
        lang_code=args.lang
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()

