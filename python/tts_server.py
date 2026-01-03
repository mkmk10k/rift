#!/opt/homebrew/bin/python3.11
"""
Persistent TTS Server - Keeps model loaded in memory for fast synthesis
Supports streaming mode for long texts
Communicates via stdin/stdout JSON messages
"""

import sys
import json
import os
import re
import platform
from pathlib import Path

# Check for Apple Silicon - MLX only works on arm64
if platform.machine() != 'arm64':
    print(json.dumps({
        "type": "error", 
        "error": "VoiceFlow requires Apple Silicon (M1/M2/M3/M4). Intel Macs are not supported for local TTS."
    }), flush=True)
    sys.exit(1)

# Suppress mlx warnings
os.environ['MLX_DISABLE_METAL_WARNINGS'] = '1'

try:
    from mlx_audio.tts.models.kokoro import KokoroPipeline
    from mlx_audio.tts.utils import load_model
    import soundfile as sf
    import numpy as np
except ImportError as e:
    print(json.dumps({"type": "error", "error": f"Missing dependency: {e}"}), flush=True)
    sys.exit(1)

# Global model cache
_model = None
_pipeline = None
_model_id = "prince-canuma/Kokoro-82M"


def initialize_model():
    """Load model into memory - only done once"""
    global _model, _pipeline
    
    if _model is None:
        sys.stderr.write("[TTS Server] Loading model...\n")
        sys.stderr.flush()
        _model = load_model(_model_id)
        _pipeline = KokoroPipeline(lang_code="a", model=_model, repo_id=_model_id)
        sys.stderr.write("[TTS Server] Model loaded!\n")
        sys.stderr.flush()
        
        # Pre-load the default voice for faster first synthesis
        sys.stderr.write("[TTS Server] Pre-loading voice 'af_heart'...\n")
        sys.stderr.flush()
        _pipeline.load_voice("af_heart")
        
        # Warmup synthesis to initialize Neural Engine (first inference is slower)
        # Use a longer, realistic text to fully warm up tensor graphs
        # CRITICAL: Use the SAME split_pattern as realtime mode to ensure MLX
        # compiles optimal graphs for the actual production code path
        sys.stderr.write("[TTS Server] Warming up Neural Engine...\n")
        sys.stderr.flush()
        warmup_text = "Hello, this is a warmup sentence to initialize the neural engine properly. The quick brown fox jumps over the lazy dog. This ensures fast synthesis for the first real request."
        for _ in _pipeline(warmup_text, voice="af_heart", speed=1.0, 
                           split_pattern=r'(?<=[.!?,;:])\s+'):
            pass  # Just run through the generator to warm up
        sys.stderr.write("[TTS Server] Warmup complete - ready for instant TTS!\n")
        sys.stderr.flush()
    
    return _pipeline


def transform_to_natural_speech(text: str) -> str:
    """
    Transform structured text (markdown-like) into natural speech.
    Preserves meaning while making it sound like a human reading aloud.
    """
    lines = text.split('\n')
    result_parts = []
    
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        
        if not line:
            # Empty line = paragraph break, add pause
            if result_parts and not result_parts[-1].endswith('...'):
                result_parts.append('...')
            i += 1
            continue
        
        # Detect markdown headings (# Heading or ## Heading)
        heading_match = re.match(r'^#{1,3}\s+(.+)$', line)
        if heading_match:
            heading_text = heading_match.group(1).strip()
            # Add pause before heading if not first
            if result_parts:
                result_parts.append('...')
            result_parts.append(heading_text + '.')
            result_parts.append('...')
            i += 1
            continue
        
        # Detect if line looks like a heading (short, followed by content)
        is_likely_heading = (
            len(line) < 50 and 
            not line.endswith('.') and 
            not line.startswith(('-', '*', '•', '1', '2', '3')) and
            i + 1 < len(lines) and 
            lines[i + 1].strip()
        )
        
        if is_likely_heading:
            if result_parts:
                result_parts.append('...')
            result_parts.append(line + '.')
            result_parts.append('...')
            i += 1
            continue
        
        # Detect bullet points or numbered lists
        bullet_match = re.match(r'^[\-\*•]\s+(.+)$', line)
        number_match = re.match(r'^(\d+)[\.\)]\s+(.+)$', line)
        
        if bullet_match:
            content = bullet_match.group(1).strip()
            # Check if this is the first bullet in a series
            prev_was_bullet = i > 0 and re.match(r'^[\-\*•]\s+', lines[i-1].strip())
            if not prev_was_bullet and result_parts:
                result_parts.append('...')
            # Add the bullet content with natural pacing
            if not content.endswith(('.', '!', '?')):
                content += '.'
            result_parts.append(content)
            i += 1
            continue
        
        if number_match:
            num = number_match.group(1)
            content = number_match.group(2).strip()
            # Check if first numbered item
            prev_was_numbered = i > 0 and re.match(r'^\d+[\.\)]', lines[i-1].strip())
            if not prev_was_numbered and result_parts:
                result_parts.append('...')
            # Natural reading: "First, ..." or "Number one, ..."
            ordinals = {
                '1': 'First', '2': 'Second', '3': 'Third', '4': 'Fourth', 
                '5': 'Fifth', '6': 'Sixth', '7': 'Seventh', '8': 'Eighth'
            }
            prefix = ordinals.get(num, f'Number {num}')
            if not content.endswith(('.', '!', '?')):
                content += '.'
            result_parts.append(f'{prefix}, {content}')
            i += 1
            continue
        
        # Regular text - just add it
        result_parts.append(line)
        i += 1
    
    # Join and clean up
    result = ' '.join(result_parts)
    
    # Clean up multiple pauses
    result = re.sub(r'\.{3,}', '...', result)
    result = re.sub(r'\.\s*\.\.\.', '...', result)
    result = re.sub(r'\.\.\.(\s*\.\.\.)+', '...', result)
    
    # Clean up spacing
    result = re.sub(r'\s+', ' ', result)
    result = result.strip()
    
    return result


def sanitize_for_tts(text: str) -> str:
    """Final cleanup for TTS - handle special characters"""
    # Replace unicode with speakable equivalents
    replacements = {
        '→': 'leads to',
        '←': 'comes from', 
        '↔': 'goes both ways',
        '•': '',  # Handled in structure parsing
        '–': '-',
        '—': ', ',
        '"': '"',
        '"': '"',
        ''': "'",
        ''': "'",
        '`': '',
        '**': '',
        '*': '',
        '_': '',
        '#': '',
        '```': '',
        '\\n': ' ',
        '\\t': ' ',
        '<': 'less than',
        '>': 'greater than',
        '&': 'and',
        '@': 'at',
        '%': 'percent',
        '$': 'dollars',
        '€': 'euros',
        '£': 'pounds',
    }
    
    for old, new in replacements.items():
        text = text.replace(old, new)
    
    # Remove any remaining non-printable characters except basic punctuation
    text = ''.join(char for char in text if char.isprintable() or char == ' ')
    
    # Clean up spacing
    text = re.sub(r'\s+', ' ', text)
    
    return text.strip()


def split_into_chunks(text: str, max_chars: int = 400) -> list:
    """
    Split text into natural speech chunks.
    Preserves semantic structure while ensuring chunks are speakable.
    """
    # First transform to natural speech (handles structure)
    text = transform_to_natural_speech(text)
    
    # Then sanitize for TTS
    text = sanitize_for_tts(text)
    
    if not text:
        return []
    
    sys.stderr.write(f"[TTS Server] Transformed text ({len(text)} chars): {text[:100]}...\n")
    sys.stderr.flush()
    
    # If text is short enough, return as single chunk
    if len(text) <= max_chars:
        return [text]
    
    # Try to split at natural pause points (...)
    # This preserves the semantic chunks we created
    pause_chunks = text.split('...')
    
    chunks = []
    current_chunk = ""
    
    for part in pause_chunks:
        part = part.strip()
        if not part:
            continue
            
        # If this part fits in current chunk, add it
        if len(current_chunk) + len(part) + 4 <= max_chars:  # +4 for "... "
            if current_chunk:
                current_chunk += "... " + part
            else:
                current_chunk = part
        else:
            # Save current chunk and start new one
            if current_chunk:
                chunks.append(current_chunk)
            
            # If this single part is too long, split by sentences
            if len(part) > max_chars:
                sentences = re.split(r'(?<=[.!?])\s+', part)
                sub_chunk = ""
                for sentence in sentences:
                    if len(sub_chunk) + len(sentence) + 1 <= max_chars:
                        sub_chunk += sentence + " "
                    else:
                        if sub_chunk.strip():
                            chunks.append(sub_chunk.strip())
                        sub_chunk = sentence + " "
                if sub_chunk.strip():
                    current_chunk = sub_chunk.strip()
                else:
                    current_chunk = ""
            else:
                current_chunk = part
    
    # Don't forget the last chunk
    if current_chunk.strip():
        chunks.append(current_chunk.strip())
    
    # Filter and clean
    chunks = [c.strip() for c in chunks if c and c.strip()]
    
    sys.stderr.write(f"[TTS Server] Split into {len(chunks)} natural chunks\n")
    for i, c in enumerate(chunks):
        sys.stderr.write(f"[TTS Server]   Chunk {i+1}: {c[:60]}...\n")
    sys.stderr.flush()
    
    return chunks if chunks else [text]


def synthesize(text: str, voice: str = "af_heart", speed: float = 1.0, output_file: str = None) -> dict:
    """Synthesize speech - single chunk mode with full text transformation"""
    try:
        pipeline = initialize_model()
        sample_rate = 24000
        
        # Apply the same text transformations as streaming mode
        # This ensures paragraph breaks and special formatting work correctly
        processed_text = transform_to_natural_speech(text)
        processed_text = sanitize_for_tts(processed_text)
        
        sys.stderr.write(f"[TTS Server] Synthesizing: {processed_text[:100]}...\n")
        sys.stderr.flush()
        
        # Collect all audio chunks
        all_audio = []
        
        for _, _, audio in pipeline(processed_text, voice=voice, speed=speed, split_pattern=r'\.\.\.'):
            if audio is not None and len(audio) > 0:
                all_audio.append(audio[0])
        
        if not all_audio:
            return {"type": "error", "error": "No audio generated"}
        
        # Concatenate all audio chunks
        combined_audio = np.concatenate(all_audio)
        
        # Save to file
        if output_file:
            output_path = Path(output_file)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(str(output_path), combined_audio, sample_rate)
        
        return {
            "type": "success",
            "output_file": output_file,
            "sample_rate": sample_rate,
            "duration": len(combined_audio) / sample_rate
        }
        
    except Exception as e:
        sys.stderr.write(f"[TTS Server] Synthesis error: {str(e)}\n")
        sys.stderr.flush()
        return {"type": "error", "error": f"Synthesis failed: {str(e)}"}


def get_first_segment(text: str, max_chars: int = 25) -> tuple:
    """
    Extract a short first segment for fast initial audio delivery.
    
    Returns (first_segment, remaining_text) where first_segment is guaranteed
    to be short enough for fast synthesis (~150ms instead of 500ms+).
    
    Strategy:
    1. If punctuation (.!?,;:) appears within max_chars, split there
    2. Otherwise, split at the last word boundary before max_chars
    3. If text is already short, return (None, text) - no split needed
    """
    if len(text) <= max_chars:
        return None, text
    
    # Look for natural break point within max_chars
    for i, char in enumerate(text[:max_chars]):
        if char in '.!?,;:':
            # Include the punctuation in first segment
            first = text[:i+1].strip()
            rest = text[i+1:].strip()
            if first:  # Ensure we got something
                return first, rest
    
    # No punctuation found - split at last word boundary before max_chars
    space_idx = text.rfind(' ', 0, max_chars)
    if space_idx > 10:  # Found reasonable word boundary (at least 10 chars)
        first = text[:space_idx].strip()
        rest = text[space_idx:].strip()
        return first, rest
    
    # Text has no spaces in first max_chars - just take the whole first "word"
    # This is rare but handles edge cases
    return None, text


def sanitize_minimal(text: str) -> str:
    """
    Minimal sanitization for realtime TTS - only remove truly problematic characters.
    Preserves most formatting for natural speech flow.
    """
    # Only replace characters that could break TTS or sound unnatural
    replacements = {
        '```': ' code block ',  # Code blocks
        '`': '',                # Inline code markers
        '**': '',               # Bold markers
        '__': '',               # Underline/bold
        '\\n': ' ',             # Escaped newlines
        '\\t': ' ',             # Escaped tabs
        '\t': ' ',              # Tabs
    }
    
    for old, new in replacements.items():
        text = text.replace(old, new)
    
    # Convert newlines to spaces (Kokoro will handle sentence boundaries via split_pattern)
    text = re.sub(r'\n+', ' ', text)
    
    # Collapse multiple spaces
    text = re.sub(r'\s+', ' ', text)
    
    # Remove any non-printable characters
    text = ''.join(char for char in text if char.isprintable() or char == ' ')
    
    return text.strip()


def synthesize_realtime(text: str, voice: str = "af_heart", speed: float = 1.0, 
                        request_id: str = "0"):
    """
    True realtime streaming TTS - yields audio segments as Kokoro generates them.
    
    Uses Kokoro's native generator with sentence-level splitting for minimal latency.
    Audio is base64 encoded and sent directly (no file I/O).
    
    This leverages the M-series chip's speed - audio generates faster than realtime,
    so playback can start almost immediately.
    """
    import base64
    import io
    
    try:
        pipeline = initialize_model()
        sample_rate = 24000
        
        # Minimal sanitization - preserve natural flow
        processed_text = sanitize_minimal(text)
        
        if not processed_text or not processed_text.strip():
            yield {"type": "error", "request_id": request_id, "error": "No text to synthesize"}
            return
        
        sys.stderr.write(f"[TTS Realtime] Starting: '{processed_text[:80]}...'\n")
        sys.stderr.flush()
        
        # Agent debug log
        import time as _time
        _start_time = _time.time()
        _log_path = '/Users/mikkokiiskila/Code/playground/.cursor/debug.log'
        with open(_log_path, 'a') as _f:
            _f.write(json.dumps({"location":"tts_server.py:before_pipeline","message":"Before pipeline call","data":{"text_length":len(processed_text),"text_preview":processed_text[:100]},"timestamp":int(_time.time()*1000),"sessionId":"debug-session","hypothesisId":"F,G"})+'\n')
        
        chunk_index = 0
        total_duration = 0.0
        _first_chunk_logged = False
        
        # FIRST-CHUNK FAST-PATH: Extract short first segment for instant audio
        # This guarantees ~150ms first-word latency regardless of text content
        first_segment, remaining_text = get_first_segment(processed_text, max_chars=25)
        
        if first_segment:
            sys.stderr.write(f"[TTS Realtime] Fast-path first segment: '{first_segment[:40]}'\n")
            sys.stderr.flush()
            
            # Synthesize first segment immediately (no split_pattern - it's already short)
            for graphemes, phonemes, audio in pipeline(first_segment, voice=voice, speed=speed):
                if audio is None or len(audio) == 0:
                    continue
                
                # Log first chunk timing
                if not _first_chunk_logged:
                    _first_chunk_time = _time.time() - _start_time
                    with open(_log_path, 'a') as _f:
                        _f.write(json.dumps({"location":"tts_server.py:first_chunk","message":"First chunk ready","data":{"time_to_first_chunk_ms":int(_first_chunk_time*1000),"text_length":len(processed_text),"fast_path":True},"timestamp":int(_time.time()*1000),"sessionId":"debug-session","hypothesisId":"F,G"})+'\n')
                    _first_chunk_logged = True
                
                audio_data = audio[0]
                duration = len(audio_data) / sample_rate
                total_duration += duration
                
                wav_buffer = io.BytesIO()
                sf.write(wav_buffer, audio_data, sample_rate, format='WAV')
                wav_bytes = wav_buffer.getvalue()
                audio_base64 = base64.b64encode(wav_bytes).decode('utf-8')
                
                sys.stderr.write(f"[TTS Realtime] Chunk {chunk_index} (fast-path): {len(audio_data)} samples ({duration:.2f}s)\n")
                sys.stderr.flush()
                
                yield {
                    "type": "realtime_chunk",
                    "request_id": request_id,
                    "chunk_index": chunk_index,
                    "audio_base64": audio_base64,
                    "sample_rate": sample_rate,
                    "duration": duration,
                    "text_hint": graphemes[:30] if graphemes else ""
                }
                chunk_index += 1
            
            # Continue with remaining text using clause-based splitting
            if remaining_text:
                for graphemes, phonemes, audio in pipeline(
                    remaining_text, 
                    voice=voice, 
                    speed=speed, 
                    split_pattern=r'(?<=[.!?,;:])\s+'
                ):
                    if audio is None or len(audio) == 0:
                        continue
                    
                    audio_data = audio[0]
                    duration = len(audio_data) / sample_rate
                    total_duration += duration
                    
                    wav_buffer = io.BytesIO()
                    sf.write(wav_buffer, audio_data, sample_rate, format='WAV')
                    wav_bytes = wav_buffer.getvalue()
                    audio_base64 = base64.b64encode(wav_bytes).decode('utf-8')
                    
                    sys.stderr.write(f"[TTS Realtime] Chunk {chunk_index}: {len(audio_data)} samples ({duration:.2f}s)\n")
                    sys.stderr.flush()
                    
                    yield {
                        "type": "realtime_chunk",
                        "request_id": request_id,
                        "chunk_index": chunk_index,
                        "audio_base64": audio_base64,
                        "sample_rate": sample_rate,
                        "duration": duration,
                        "text_hint": graphemes[:30] if graphemes else ""
                    }
                    chunk_index += 1
        else:
            # Text is short enough - use original single-pass approach
            for graphemes, phonemes, audio in pipeline(
                processed_text, 
                voice=voice, 
                speed=speed, 
                split_pattern=r'(?<=[.!?,;:])\s+'  # Split on clause boundaries
            ):
                if audio is None or len(audio) == 0:
                    continue
                
                # Agent debug log - first chunk timing
                if not _first_chunk_logged:
                    _first_chunk_time = _time.time() - _start_time
                    with open(_log_path, 'a') as _f:
                        _f.write(json.dumps({"location":"tts_server.py:first_chunk","message":"First chunk ready","data":{"time_to_first_chunk_ms":int(_first_chunk_time*1000),"text_length":len(processed_text)},"timestamp":int(_time.time()*1000),"sessionId":"debug-session","hypothesisId":"F,G"})+'\n')
                    _first_chunk_logged = True
                
                audio_data = audio[0]  # Get the numpy array
                duration = len(audio_data) / sample_rate
                total_duration += duration
                
                # Convert to WAV in memory and base64 encode
                wav_buffer = io.BytesIO()
                sf.write(wav_buffer, audio_data, sample_rate, format='WAV')
                wav_bytes = wav_buffer.getvalue()
                audio_base64 = base64.b64encode(wav_bytes).decode('utf-8')
                
                sys.stderr.write(f"[TTS Realtime] Chunk {chunk_index}: {len(audio_data)} samples ({duration:.2f}s)\n")
                sys.stderr.flush()
                
                # Yield immediately - no file I/O!
                yield {
                    "type": "realtime_chunk",
                    "request_id": request_id,
                    "chunk_index": chunk_index,
                    "audio_base64": audio_base64,
                    "sample_rate": sample_rate,
                    "duration": duration,
                    "text_hint": graphemes[:30] if graphemes else ""
                }
                
                chunk_index += 1
        
        # Signal completion
        yield {
            "type": "realtime_complete",
            "request_id": request_id,
            "total_chunks": chunk_index,
            "total_duration": total_duration
        }
        
        sys.stderr.write(f"[TTS Realtime] Complete: {chunk_index} chunks, {total_duration:.2f}s total\n")
        sys.stderr.flush()
        
    except Exception as e:
        sys.stderr.write(f"[TTS Realtime] Error: {e}\n")
        sys.stderr.flush()
        yield {"type": "error", "request_id": request_id, "error": f"Realtime synthesis failed: {str(e)}"}


def synthesize_streaming(text: str, voice: str = "af_heart", speed: float = 1.0, 
                         output_dir: str = "/tmp", request_id: str = "0"):
    """Synthesize speech in streaming mode - yields chunks as they're generated (legacy)"""
    try:
        pipeline = initialize_model()
        sample_rate = 24000
        
        # Split text into manageable chunks (includes sanitization)
        chunks = split_into_chunks(text)
        total_chunks = len(chunks)
        
        if total_chunks == 0:
            yield {"type": "error", "request_id": request_id, "error": "No text to synthesize after sanitization"}
            return
        
        sys.stderr.write(f"[TTS Server] Streaming {total_chunks} chunks\n")
        sys.stderr.flush()
        
        successful_chunks = 0
        
        for i, chunk_text in enumerate(chunks):
            try:
                # Skip empty chunks
                if not chunk_text or not chunk_text.strip():
                    sys.stderr.write(f"[TTS Server] Skipping empty chunk {i}\n")
                    continue
                
                sys.stderr.write(f"[TTS Server] Generating chunk {i+1}/{total_chunks}: '{chunk_text[:30]}...'\n")
                sys.stderr.flush()
                
                # Generate audio for this chunk
                audio_data = None
                
                for _, _, audio in pipeline(chunk_text, voice=voice, speed=speed, split_pattern=r'\n+'):
                    audio_data = audio
                    break
                
                if audio_data is None:
                    sys.stderr.write(f"[TTS Server] Warning: No audio generated for chunk {i}\n")
                    continue
                
                # Save chunk to file
                output_file = f"{output_dir}/tts_stream_{request_id}_{i}.wav"
                output_path = Path(output_file)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                sf.write(str(output_path), audio_data[0], sample_rate)
                
                successful_chunks += 1
                
                # Yield chunk info
                yield {
                    "type": "chunk",
                    "request_id": request_id,
                    "chunk_index": successful_chunks - 1,  # Use successful count for index
                    "total_chunks": total_chunks,
                    "output_file": output_file,
                    "sample_rate": sample_rate,
                    "duration": len(audio_data[0]) / sample_rate,
                    "text": chunk_text[:50] + "..." if len(chunk_text) > 50 else chunk_text
                }
                
            except Exception as chunk_error:
                sys.stderr.write(f"[TTS Server] Error on chunk {i}: {chunk_error}\n")
                sys.stderr.flush()
                # Continue with next chunk instead of failing completely
                continue
        
        # Signal completion
        yield {
            "type": "stream_complete",
            "request_id": request_id,
            "total_chunks": successful_chunks
        }
        
    except Exception as e:
        sys.stderr.write(f"[TTS Server] Streaming failed: {e}\n")
        sys.stderr.flush()
        yield {"type": "error", "request_id": request_id, "error": f"Streaming synthesis failed: {str(e)}"}


def main():
    """Main server loop - reads JSON commands from stdin"""
    # Send ready signal
    print(json.dumps({"type": "ready"}), flush=True)
    
    # Pre-load model immediately for faster first request
    try:
        initialize_model()
        print(json.dumps({"type": "model_loaded"}), flush=True)
    except Exception as e:
        print(json.dumps({"type": "error", "error": f"Failed to load model: {e}"}), flush=True)
    
    # Process commands
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
            
        try:
            cmd = json.loads(line)
            
            if cmd.get("action") == "synthesize":
                result = synthesize(
                    text=cmd.get("text", ""),
                    voice=cmd.get("voice", "af_heart"),
                    speed=cmd.get("speed", 1.0),
                    output_file=cmd.get("output")
                )
                print(json.dumps(result), flush=True)
            
            elif cmd.get("action") == "synthesize_stream":
                # Legacy streaming mode - send chunks as they're generated
                for chunk_result in synthesize_streaming(
                    text=cmd.get("text", ""),
                    voice=cmd.get("voice", "af_heart"),
                    speed=cmd.get("speed", 1.0),
                    output_dir=cmd.get("output_dir", "/tmp"),
                    request_id=cmd.get("request_id", "0")
                ):
                    print(json.dumps(chunk_result), flush=True)
            
            elif cmd.get("action") == "synthesize_realtime":
                # True realtime streaming - no file I/O, immediate audio delivery
                for chunk_result in synthesize_realtime(
                    text=cmd.get("text", ""),
                    voice=cmd.get("voice", "af_heart"),
                    speed=cmd.get("speed", 1.0),
                    request_id=cmd.get("request_id", "0")
                ):
                    print(json.dumps(chunk_result), flush=True)
                
            elif cmd.get("action") == "ping":
                print(json.dumps({"type": "pong"}), flush=True)
                
            elif cmd.get("action") == "quit":
                print(json.dumps({"type": "goodbye"}), flush=True)
                break
                
            else:
                print(json.dumps({"type": "error", "error": f"Unknown action: {cmd.get('action')}"}), flush=True)
                
        except json.JSONDecodeError as e:
            print(json.dumps({"type": "error", "error": f"Invalid JSON: {e}"}), flush=True)
        except Exception as e:
            print(json.dumps({"type": "error", "error": f"Error: {e}"}), flush=True)


if __name__ == "__main__":
    main()

