#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════════════
LLM Server - Qwen3 Text Processing for Live Paste Enhancement
═══════════════════════════════════════════════════════════════════════════════

This server provides intelligent text processing to enhance Live Paste accuracy.
It runs as a persistent subprocess managed by the Electron main process.

MODELS:
- Fast (Qwen3-0.6B-4bit-MLX): Real-time operations (Phase 2, 3)
- Quality (Qwen3-1.7B-4bit-MLX): Final polish (Phase 4)

PHASES:
- Phase 2: Intelligent merge when anchor detection fails during streaming
- Phase 3: Rolling sentence correction - clean up previous sentences
- Phase 4: Final polish when recording stops

PROTOCOL:
- JSON stdin/stdout (same as stt_server.py)
- One command per line, one response per line

LATENCY TARGETS:
- Phase 2 (merge): 50ms target, 100ms max
- Phase 3 (correct): 100ms target, 200ms max
- Phase 4 (polish): 300ms target, 1000ms max

AUTO-INSTALLATION:
- Dependencies installed automatically via pythonSetup.ts
- Models downloaded automatically on first use by mlx-lm

═══════════════════════════════════════════════════════════════════════════════
"""

import sys
import json
import time
import traceback
from typing import Optional, Tuple, Any

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

import os
import re

# Multi-model configuration: select via RIFT_MODEL_CONFIG env var
MODEL_CONFIGS = {
    "qwen3": {
        "fast": "mlx-community/Qwen3-0.6B-4bit",
        "quality": "mlx-community/Qwen3-1.7B-4bit",
        "deep": "mlx-community/Qwen3-4B-4bit",
        "family": "qwen3",
    },
    "gemma4-e4b": {
        "fast": "mlx-community/Qwen3-0.6B-4bit",
        "quality": "mlx-community/Qwen3-1.7B-4bit",
        "deep": "mlx-community/gemma-4-e4b-it-4bit",
        "family": "gemma4",
    },
    "gemma4-e4b-6bit": {
        "fast": "mlx-community/Qwen3-0.6B-4bit",
        "quality": "mlx-community/Qwen3-1.7B-4bit",
        "deep": "mlx-community/gemma-4-e4b-it-6bit",
        "family": "gemma4",
    },
    "gemma4-moe": {
        "fast": "mlx-community/Qwen3-0.6B-4bit",
        "quality": "mlx-community/Qwen3-1.7B-4bit",
        "deep": "mlx-community/gemma-4-26b-a4b-it-4bit",
        "family": "gemma4",
    },
}

_active_config_name = os.environ.get("RIFT_MODEL_CONFIG", "gemma4-e4b")
if _active_config_name not in MODEL_CONFIGS:
    _active_config_name = "gemma4-e4b"
_active_config = MODEL_CONFIGS[_active_config_name]

FAST_MODEL = _active_config["fast"]
QUALITY_MODEL = _active_config["quality"]
DEEP_MODEL = _active_config["deep"]
_model_family = _active_config["family"]

# Latency thresholds (ms)
LATENCY_THRESHOLD_MERGE = 100
LATENCY_THRESHOLD_CORRECT = 200
LATENCY_THRESHOLD_POLISH = 1000
LATENCY_THRESHOLD_DEEP = 5000  # Deep cleanup can take longer (background)

# GPU contention tracking
_fast_model_busy = False
_last_fast_model_use = 0


# ═══════════════════════════════════════════════════════════════════════════════
# PROMPT FORMAT CONVERSION (model-agnostic prompts)
# ═══════════════════════════════════════════════════════════════════════════════

def parse_qwen3_prompt(prompt: str) -> list:
    """Parse a Qwen3-formatted prompt string into a list of message dicts.

    Turns must end at the same special tokens as prompts.json. The end token includes
    the substring "redacted_im_end"; matching only "im_end" leaves stray markers inside
    message bodies and breaks apply_chat_template for non-Qwen models.
    """
    _end = r'(?:<\|im_end\|>|<\|redacted_im_end\|>)'
    messages = []
    parts = re.split(r'<\|im_start\|>', prompt)
    for part in parts:
        part = part.strip()
        if not part:
            continue
        match = re.match(
            rf'(system|user|assistant)\n(.*?)(?:{_end}|$)',
            part,
            re.DOTALL,
        )
        if match:
            role = match.group(1)
            content = match.group(2).strip()
            content = re.sub(r'\s*/no_think\s*$', '', content).strip()
            if content or role == "assistant":
                messages.append({"role": role, "content": content})
    return messages


_gemma_chat_template_logged = False
_gemma_polish_prompt_logged = False


def format_prompt_for_model(prompt: str, tokenizer) -> str:
    """
    Convert a Qwen3-formatted prompt to the loaded model's native format.

    For qwen3: returns prompt unchanged.

    For gemma4 configs: fast + quality weights are still Qwen3 MLX; only the deep model
    is Gemma. Passing Qwen prompts through Qwen's apply_chat_template can change few-shot
    layout vs the baseline and destroy scores — keep the raw string for Qwen tokenizers.
    Only the Gemma deep tokenizer gets messages + apply_chat_template().
    """
    global _gemma_chat_template_logged

    if _model_family == "qwen3":
        return prompt

    # Gemma configs: convert only for the actual Gemma (deep) tokenizer.
    if tokenizer is not _deep_tokenizer:
        return prompt

    messages = parse_qwen3_prompt(prompt)
    if not messages:
        return prompt

    # Remove trailing empty-assistant message (the generation prompt)
    if messages and messages[-1]["role"] == "assistant" and not messages[-1]["content"]:
        messages = messages[:-1]

    try:
        formatted = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        if _model_family == "gemma4" and not _gemma_chat_template_logged:
            _gemma_chat_template_logged = True
            preview = formatted[:600].replace("\n", "\\n")
            log(
                f"[Gemma chat_template] {len(messages)} msgs | "
                f"formatted preview: {preview}"
            )
        return formatted
    except Exception as e:
        log(f"apply_chat_template failed for {_model_family}: {e}")
        return prompt

# ═══════════════════════════════════════════════════════════════════════════════
# PROMPT TEMPLATES (loaded from external config)
# ═══════════════════════════════════════════════════════════════════════════════

def load_prompts():
    """
    Load prompts from external JSON config.
    
    Looks for prompts.json in the same directory as this script.
    Falls back to prompts.example.json if not found.
    
    This allows keeping optimized prompts private while sharing
    basic working prompts in the public repository.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    prompts_path = os.path.join(script_dir, "prompts.json")
    example_path = os.path.join(script_dir, "prompts.example.json")
    
    if os.path.exists(prompts_path):
        log(f"Loading prompts from {prompts_path}")
        with open(prompts_path, 'r') as f:
            return json.load(f)
    elif os.path.exists(example_path):
        log(f"prompts.json not found, using example prompts from {example_path}")
        with open(example_path, 'r') as f:
            return json.load(f)
    else:
        raise FileNotFoundError(
            "No prompts config found. Copy prompts.example.json to prompts.json"
        )

# Load prompts at module level (will be loaded when server starts)
_prompts = None

def get_prompts():
    """Get loaded prompts, loading if necessary."""
    global _prompts
    if _prompts is None:
        _prompts = load_prompts()
    return _prompts

# Accessor functions for each prompt type
def get_merge_prompt():
    return get_prompts()["MERGE_PROMPT"]

def get_correct_sentence_prompt():
    return get_prompts()["CORRECT_SENTENCE_PROMPT"]

def get_extract_new_words_prompt():
    return get_prompts()["EXTRACT_NEW_WORDS_PROMPT"]

# Extra few-shot turns for Gemma deep model (phone + URL formatting)
# Uses the same end-token as prompts.json so parse_qwen3_prompt() handles them correctly.
_IM_END = "<|" + "im_end" + "|>"
_GEMMA_POLISH_EXTRA_TURNS = (
    "<|im_start|>user\nCall five five five eight six seven five three oh nine" + _IM_END + "\n"
    "<|im_start|>assistant\nCall 555-867-5309." + _IM_END + "\n"
    "<|im_start|>user\nCheck out w w w dot example dot com slash docs for more info" + _IM_END + "\n"
    "<|im_start|>assistant\nCheck out www.example.com/docs for more info." + _IM_END + "\n"
    "<|im_start|>user\nMy number is eight hundred five five five one two three four" + _IM_END + "\n"
    "<|im_start|>assistant\nMy number is 800-555-1234." + _IM_END + "\n"
    "<|im_start|>user\nVisit h t t p s colon slash slash github dot com slash docs" + _IM_END + "\n"
    "<|im_start|>assistant\nVisit https://github.com/docs." + _IM_END + "\n"
)


# Extra system-level instruction for Gemma on format conversion
_GEMMA_FORMAT_ADDENDUM = (
    "\n\nCRITICAL FORMAT CONVERSIONS (always apply):\n"
    "- Spoken phone numbers → digits with dashes: "
    "\"five five five one two three four\" → \"555-1234\"\n"
    "- Spoken URLs → proper URLs: "
    "\"w w w dot example dot com slash docs\" → \"www.example.com/docs\"\n"
    "- Spoken \"h t t p s colon slash slash\" → \"https://\"\n"
    "- Spoken \"dot\" between domain parts → \".\"\n"
    "- Spoken \"slash\" in paths → \"/\"\n"
    "- Spoken \"at\" in emails → \"@\"\n"
)


def get_polish_prompt(mode: str):
    prompts = get_prompts()
    base = prompts["POLISH_PROMPTS"]
    template = base.get(mode, base["clean"])
    if _model_family == "gemma4":
        gemma_over = prompts.get("POLISH_PROMPTS_GEMMA4")
        if isinstance(gemma_over, dict) and gemma_over.get(mode):
            return gemma_over[mode]
        # Augment system message with format-conversion rules
        _sys_end = _IM_END
        if _sys_end in template:
            first_end = template.index(_sys_end)
            template = template[:first_end] + _GEMMA_FORMAT_ADDENDUM + template[first_end:]
        # Inject extra few-shots before the final user turn
        if "{final_text}" in template:
            marker = "<|im_start|>user\n{final_text}"
            if marker in template:
                template = template.replace(marker, _GEMMA_POLISH_EXTRA_TURNS + marker, 1)
    return template

def get_deep_cleanup_prompt():
    return get_prompts()["DEEP_CLEANUP_PROMPT"]

def get_tts_transform_prompt(mode: str):
    """Get TTS transform prompt for Code Talk feature."""
    prompts = get_prompts().get("TTS_TRANSFORM_PROMPTS", {})
    return prompts.get(mode, prompts.get("developer", ""))


# ═══════════════════════════════════════════════════════════════════════════════
# MODEL MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════════

_fast_model: Any = None
_fast_tokenizer: Any = None
_quality_model: Any = None
_quality_tokenizer: Any = None
_mlx_lm = None


def log(message: str) -> None:
    """Log to stderr (visible in Electron console)"""
    print(f"[LLM] {message}", file=sys.stderr, flush=True)


def import_mlx_lm():
    """Import mlx-lm module (lazy load)"""
    global _mlx_lm
    if _mlx_lm is None:
        try:
            import mlx_lm
            _mlx_lm = mlx_lm
            log("mlx-lm module loaded")
        except ImportError as e:
            log(f"ERROR: mlx-lm not installed: {e}")
            raise
    return _mlx_lm


def load_fast_model() -> Tuple[Any, Any]:
    """Load the fast model for real-time operations"""
    global _fast_model, _fast_tokenizer
    
    if _fast_model is not None:
        return _fast_model, _fast_tokenizer
    
    mlx_lm = import_mlx_lm()
    
    log(f"Loading fast model: {FAST_MODEL}")
    start = time.time()
    
    _fast_model, _fast_tokenizer = mlx_lm.load(FAST_MODEL)
    
    elapsed = int((time.time() - start) * 1000)
    log(f"Fast model loaded in {elapsed}ms")
    
    return _fast_model, _fast_tokenizer


def load_quality_model() -> Tuple[Any, Any]:
    """Load the quality model for final polish (lazy load)"""
    global _quality_model, _quality_tokenizer, _deep_model, _deep_tokenizer
    
    if _quality_model is not None:
        return _quality_model, _quality_tokenizer
    
    # If deep model is loaded, unload it first to free memory
    if _deep_model is not None:
        log("[Memory] Unloading deep model before loading quality model")
        unload_deep_model()
    
    mlx_lm = import_mlx_lm()
    
    log(f"Loading quality model: {QUALITY_MODEL}")
    start = time.time()
    
    try:
        _quality_model, _quality_tokenizer = mlx_lm.load(QUALITY_MODEL)
    except Exception as e:
        log(f"ERROR loading quality model: {e}")
        # Clear any partial state
        _quality_model = None
        _quality_tokenizer = None
        raise
    
    elapsed = int((time.time() - start) * 1000)
    log(f"Quality model loaded in {elapsed}ms")
    
    # Signal quality model loaded (for metrics)
    print(json.dumps({
        "type": "quality_model_loaded",
        "load_time_ms": elapsed
    }), flush=True)
    
    return _quality_model, _quality_tokenizer


# Deep model (4B) - loaded lazily for background cleanup
_deep_model = None
_deep_tokenizer = None
_deep_model_disabled = False  # Set to True if loading fails due to memory


def get_available_memory_gb() -> float:
    """Get available system memory in GB."""
    import subprocess
    try:
        # Get memory pressure info on macOS
        result = subprocess.run(['vm_stat'], capture_output=True, text=True)
        lines = result.stdout.strip().split('\n')
        
        page_size = 4096  # Default page size on macOS
        free_pages = 0
        inactive_pages = 0
        
        for line in lines:
            if 'page size of' in line:
                parts = line.split()
                for i, p in enumerate(parts):
                    if p.isdigit():
                        page_size = int(p)
                        break
            elif 'Pages free:' in line:
                free_pages = int(line.split(':')[1].strip().replace('.', ''))
            elif 'Pages inactive:' in line:
                inactive_pages = int(line.split(':')[1].strip().replace('.', ''))
        
        available_bytes = (free_pages + inactive_pages) * page_size
        return available_bytes / (1024**3)
    except Exception as e:
        log(f"[Memory] Could not get available memory: {e}")
        return 4.0  # Conservative default


def check_gpu_memory_available(required_gb: float = 3.0) -> bool:
    """
    Check if there's enough GPU memory available.
    Returns True if we believe there's enough memory for the deep model.
    
    Note: MLX doesn't expose direct memory queries, so we use heuristics:
    - If quality model is loaded, we have ~2GB in use
    - 4B model needs ~3-4GB additional
    - Most Macs have 8-64GB unified memory
    """
    import subprocess
    try:
        # Get total system memory
        result = subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True)
        total_bytes = int(result.stdout.strip())
        total_gb = total_bytes / (1024**3)
        
        # Check available memory (more accurate than total)
        available_gb = get_available_memory_gb()
        
        # With model swapping, we need ~3GB for fast + deep
        min_ram = float(os.environ.get("RIFT_MIN_RAM_GB", "8"))
        if total_gb < min_ram:
            log(f"[Memory] Total RAM: {total_gb:.1f}GB < {min_ram:.0f}GB minimum - too low for deep model")
            return False
        
        if available_gb < required_gb:
            log(f"[Memory] Available RAM: {available_gb:.1f}GB, need {required_gb:.1f}GB - insufficient")
            return False
        
        log(f"[Memory] Available RAM: {available_gb:.1f}GB - sufficient for {required_gb:.1f}GB model")
        return True
    except Exception as e:
        log(f"[Memory] Check failed: {e} - proceeding with caution")
        return True  # Proceed if we can't check


def unload_quality_model() -> None:
    """Unload quality model to free GPU memory for deep model."""
    global _quality_model, _quality_tokenizer
    import gc
    
    if _quality_model is not None:
        log("[Memory] Unloading quality model to make room for deep model")
        _quality_model = None
        _quality_tokenizer = None
        gc.collect()
        # Force MLX to release memory
        try:
            import mlx.core as mx
            mx.metal.clear_cache()
            log("[Memory] Cleared MLX metal cache")
        except Exception as e:
            log(f"[Memory] Could not clear MLX cache: {e}")


def unload_deep_model() -> None:
    """Unload deep model to free GPU memory for real-time processing."""
    global _deep_model, _deep_tokenizer
    import gc
    
    if _deep_model is not None:
        log("[Memory] Unloading deep model to prioritize real-time")
        _deep_model = None
        _deep_tokenizer = None
        gc.collect()
        try:
            import mlx.core as mx
            mx.metal.clear_cache()
            log("[Memory] Cleared MLX metal cache")
        except Exception as e:
            log(f"[Memory] Could not clear MLX cache: {e}")


def load_deep_model(swap_out_quality: bool = True) -> Tuple[Optional[Any], Optional[Any]]:
    """
    Load the deep model (4B) for high-quality background cleanup.
    
    This model is larger and slower but more accurate.
    Only used for background cleanup of already-pasted text.
    Lazy loaded on first use to avoid memory pressure at startup.
    
    Memory safety:
    - Checks available memory before loading
    - Swaps out quality model to make room (if swap_out_quality=True)
    - Returns (None, None) if loading would cause memory issues
    
    Memory Strategy:
    - Fast (0.6B): ~400MB - ALWAYS loaded for real-time
    - Quality (1.7B): ~1GB - Swapped out when deep model needed
    - Deep (4B): ~2.5GB - Loaded during silence for cleanup
    - Total with swap: Fast + Deep = ~2.9GB (safe for 8GB+ Macs)
    """
    global _deep_model, _deep_tokenizer, _deep_model_disabled
    
    # If previously disabled due to memory, don't retry
    if _deep_model_disabled:
        return None, None
    
    if _deep_model is not None:
        return _deep_model, _deep_tokenizer
    
    # Swap out quality model FIRST to free memory, THEN check
    if swap_out_quality:
        unload_quality_model()
    
    # Force garbage collection and clear MLX cache to maximize available memory
    import gc
    gc.collect()
    try:
        import mlx.core as mx
        mx.metal.clear_cache()
    except Exception:
        pass
    
    # Check if we have enough memory (after unloading and clearing cache)
    # Threshold lowered to 2.0GB - model may use swap but should work on 8GB+ Macs
    if not check_gpu_memory_available(required_gb=2.0):
        log("[Memory] Insufficient memory for deep model - disabling")
        _deep_model_disabled = True
        return None, None
    
    mlx_lm = import_mlx_lm()
    
    try:
        log(f"Loading deep model: {DEEP_MODEL}")
        start = time.time()
        
        _deep_model, _deep_tokenizer = mlx_lm.load(DEEP_MODEL)
        
        elapsed = int((time.time() - start) * 1000)
        log(f"Deep model loaded in {elapsed}ms")
        
        log("Warming up deep model...")
        warmup_start = time.time()
        try:
            warmup_prompt = format_prompt_for_model(
                "<|im_start|>user\nHello<|im_end|>\n<|im_start|>assistant\n",
                _deep_tokenizer,
            )
            warmup_result = mlx_lm.generate(
                _deep_model, 
                _deep_tokenizer, 
                prompt=warmup_prompt,
                max_tokens=10
            )
            warmup_ms = int((time.time() - warmup_start) * 1000)
            log(f"Deep model warmup complete in {warmup_ms}ms")
        except Exception as e:
            log(f"Deep model warmup failed (non-critical): {e}")
        
        # Signal deep model loaded (for metrics)
        print(json.dumps({
            "type": "deep_model_loaded",
            "load_time_ms": elapsed
        }), flush=True)
        
        return _deep_model, _deep_tokenizer
        
    except Exception as e:
        log(f"[Memory] Failed to load deep model: {e} - disabling")
        _deep_model_disabled = True
        return None, None


def swap_to_realtime_mode() -> None:
    """
    Swap from deep cleanup mode back to real-time mode.
    
    Called when speech resumes after a silence period.
    Unloads deep model to free memory for smooth real-time processing.
    Quality model will be reloaded on demand if needed.
    """
    global _deep_model, _deep_tokenizer
    
    if _deep_model is not None:
        unload_deep_model()
        log("[Memory] Swapped to real-time mode")


def is_fast_model_busy() -> bool:
    """Check if fast model was recently used (GPU may be busy)."""
    global _last_fast_model_use
    # Consider busy if used within last 100ms
    return (time.time() - _last_fast_model_use) < 0.1


def generate_text(model: Any, tokenizer: Any, prompt: str, max_tokens: int = 150, fallback: str = "") -> str:
    """Generate text using the model.
    
    Prompts are stored in Qwen3 chat format and automatically converted
    to the active model's native format via format_prompt_for_model().
    """
    mlx_lm = import_mlx_lm()
    
    # Convert prompt to the loaded model's native chat format
    formatted_prompt = format_prompt_for_model(prompt, tokenizer)
    
    try:
        sampler = mlx_lm.sample_utils.make_sampler(temp=0.0)
        
        response = mlx_lm.generate(
            model,
            tokenizer,
            prompt=formatted_prompt,
            max_tokens=max_tokens,
            verbose=False,
            sampler=sampler,
        )
    except Exception as e:
        log(f"Generation error: {e}")
        return fallback
    
    response = response.strip()
    
    # Qwen3 may include <think>...</think> reasoning blocks
    if "<think>" in response:
        think_end = response.find("</think>")
        if think_end != -1:
            _think_close = "</redacted_thinking>"
            response = response[think_end + len(_think_close) :].strip()
        else:
            log("WARNING: Model hit max_tokens during thinking, using fallback")
            return fallback
    
    # Strip model-specific special tokens from output
    response = response.replace("<|im_end|>", "").strip()
    response = response.replace("<end_of_turn>", "").strip()
    response = response.replace("<eos>", "").strip()
    
    if not response:
        return fallback
    
    return response


# ═══════════════════════════════════════════════════════════════════════════════
# PHASE HANDLERS
# ═══════════════════════════════════════════════════════════════════════════════

def _normalize_for_comparison(text: str) -> str:
    """Normalize text for semantic comparison (punctuation/whitespace insensitive)."""
    import re
    result = text.lower()
    result = re.sub(r'[.,!?;:\'"]+', '', result)  # Remove punctuation
    result = re.sub(r'\s+', ' ', result).strip()
    return result


def _quick_diff_check(pasted: str, new_text: str) -> tuple:
    """
    Quick heuristic check before LLM - handles obvious cases.
    Returns (handled, result) where handled=True means we have an answer.
    """
    # Normalize both for comparison
    norm_pasted = _normalize_for_comparison(pasted)
    norm_new = _normalize_for_comparison(new_text)
    
    # Case 1: Identical after normalization (punctuation-only difference)
    if norm_pasted == norm_new:
        return (True, "")
    
    # Case 2: After normalization, new_text extends pasted (e.g. commas mid-sentence).
    # Raw indices != len(pasted); recover trailing new words by matching normalized tail.
    if norm_new.startswith(norm_pasted):
        extra_norm = norm_new[len(norm_pasted) :].strip()
        if not extra_norm:
            return (True, "")
        words_extra = extra_norm.split()
        if words_extra and len(words_extra) <= 12:
            words_new = new_text.split()
            if len(words_new) >= len(words_extra):
                tail = " ".join(words_new[-len(words_extra) :])
                if _normalize_for_comparison(tail) == extra_norm:
                    return (True, tail)
        # Normalized drift without a clean trailing word match — use LLM
        return (False, "")
    
    # Case 3: Raw pasted prefix + suffix (indices align)
    if new_text.startswith(pasted):
        suffix_start = len(pasted)
        while suffix_start < len(new_text) and new_text[suffix_start] in ' .,!?;:\'"':
            suffix_start += 1
        suffix = new_text[suffix_start:].strip()
        if suffix:
            return (True, suffix)
    
    # Not a simple case, need LLM
    return (False, "")


def _looks_suspicious(result: str, pasted: str, new_text: str) -> bool:
    """
    Detect when LLM output is probably wrong and we should retry with quality model.
    
    Red flags:
    - Output is longer than the actual difference (model echoed input)
    - Contains explanatory text or markdown
    - Contains prompt artifacts
    """
    if not result:
        return False  # Empty is valid
    
    result_clean = result.strip()
    
    # 1. Output is suspiciously long (longer than the difference + margin)
    max_expected_len = abs(len(new_text) - len(pasted)) + 30
    if len(result_clean) > max_expected_len:
        return True
    
    # 2. Contains explanatory text
    lower = result_clean.lower()
    explanatory_markers = ['answer:', 'output:', 'the new words', 'result:', 'here is', 'here are']
    if any(marker in lower for marker in explanatory_markers):
        return True
    
    # 3. Contains markdown formatting
    if '**' in result_clean or '```' in result_clean or '##' in result_clean:
        return True
    
    # 4. Contains prompt artifacts (echoed labels)
    if 'PASTED:' in result_clean.upper() or 'NEW:' in result_clean.upper():
        return True
    
    # 5. Result contains most of the pasted text (model echoed input)
    if len(pasted) > 10 and pasted[:len(pasted)//2] in result_clean:
        return True
    
    return False


def _clean_merge_result(result: str) -> str:
    """Clean up merge result, extracting just the new words."""
    if not result:
        return ""
    
    import re
    cleaned = result.strip()
    
    # Remove markdown
    cleaned = re.sub(r'\*+', '', cleaned)
    
    # Remove explanatory prefixes
    for prefix in ['answer:', 'output:', 'new words:', 'result:']:
        if prefix in cleaned.lower():
            cleaned = cleaned.split(prefix)[-1].strip()
            cleaned = cleaned.split(':')[-1].strip() if ':' in cleaned else cleaned
    
    # Check for empty indicators
    upper = cleaned.upper()
    if upper in ("EMPTY", "NONE", "") or upper.startswith("EMPTY") or upper.startswith("NONE"):
        return ""
    
    return cleaned


def handle_merge_text(pasted: str, new_text: str) -> dict:
    """
    Phase 2: Intelligent text merge with adaptive model switching.
    
    Called when heuristic anchor detection fails during Live Paste.
    Determines what new words to append based on semantic understanding.
    
    Strategy:
    1. Quick heuristic check for obvious cases (punctuation-only, simple suffix)
    2. Try fast model (0.6B) if heuristic doesn't handle it
    3. If result looks suspicious, retry with quality model (1.7B)
    
    Edge cases handled:
    - Punctuation changes: "Hello world" vs "Hello, world"
    - Contractions: "I am" vs "I'm"
    - Rolling window truncation
    - STT revisions of earlier words
    """
    start = time.time()
    
    try:
        log(f"[Phase 2] Merge request: pasted_len={len(pasted)}, new_len={len(new_text)}")
        
        # Quick heuristic check for obvious cases
        handled, quick_result = _quick_diff_check(pasted, new_text)
        if handled:
            elapsed = int((time.time() - start) * 1000)
            log(f"[Phase 2] Quick check handled: new_words='{quick_result}', time={elapsed}ms")
            return {
                "type": "merge_result",
                "new_words": quick_result,
                "inference_time_ms": elapsed,
                "exceeded_latency": False,
                "used_quality_model": False,
                "used_heuristic": True,
            }
        
        # Limit context for speed
        pasted_context = pasted[-200:] if len(pasted) > 200 else pasted
        new_context = new_text[-200:] if len(new_text) > 200 else new_text
        prompt = get_merge_prompt().format(pasted=pasted_context, new_text=new_context)
        
        # Try fast model first
        model, tokenizer = load_fast_model()
        inference_start = time.time()
        result = generate_text(model, tokenizer, prompt, max_tokens=100)
        fast_time = int((time.time() - inference_start) * 1000)
        
        new_words = _clean_merge_result(result)
        used_quality = False
        
        # Check if result looks suspicious
        if _looks_suspicious(result, pasted, new_text):
            log(f"[Phase 2] Fast model result suspicious ('{result[:50]}...'), retrying with quality model")
            
            # Retry with quality model
            model, tokenizer = load_quality_model()
            inference_start = time.time()
            result = generate_text(model, tokenizer, prompt, max_tokens=100)
            quality_time = int((time.time() - inference_start) * 1000)
            
            new_words = _clean_merge_result(result)
            used_quality = True
            log(f"[Phase 2] Quality model result: '{new_words[:50]}...' ({quality_time}ms)")
        
        elapsed = int((time.time() - start) * 1000)
        exceeded = elapsed > LATENCY_THRESHOLD_MERGE
        
        log(f"[Phase 2] Merge complete: new_words_len={len(new_words)}, total={elapsed}ms, exceeded={exceeded}, used_quality={used_quality}")
        
        return {
            "type": "merge_result",
            "new_words": new_words,
            "inference_time_ms": elapsed,
            "exceeded_latency": exceeded,
            "used_quality_model": used_quality,
        }
        
    except Exception as e:
        log(f"ERROR in merge_text: {e}")
        traceback.print_exc(file=sys.stderr)
        return {
            "type": "error",
            "error": str(e),
        }


def handle_correct_sentence(original: str, latest: str) -> dict:
    """
    Phase 3: Sentence correction
    
    Called during rolling correction while user speaks.
    Cleans up previously pasted sentences using STT improvements.
    
    Corrections made:
    - Grammar fixes
    - Stuttering removal ("I I I" → "I")
    - Punctuation standardization
    - Transcription artifacts
    """
    start = time.time()
    
    try:
        log(f"[Phase 3] Correct request: original_len={len(original)}, latest_len={len(latest)}")
        model, tokenizer = load_fast_model()
        
        prompt = get_correct_sentence_prompt().format(original=original, latest=latest)
        
        inference_start = time.time()
        result = generate_text(model, tokenizer, prompt, max_tokens=150)
        inference_time = int((time.time() - inference_start) * 1000)
        
        # Check if anything changed
        corrected = result.strip() if result else original
        changed = corrected != original
        
        elapsed = int((time.time() - start) * 1000)
        exceeded = elapsed > LATENCY_THRESHOLD_CORRECT
        
        log(f"[Phase 3] Correct complete: changed={changed}, inference={inference_time}ms, total={elapsed}ms, exceeded={exceeded}")
        
        return {
            "type": "correct_result",
            "corrected": corrected,
            "changed": changed,
            "inference_time_ms": elapsed,
            "exceeded_latency": exceeded,
        }
        
    except Exception as e:
        log(f"ERROR in correct_sentence: {e}")
        traceback.print_exc(file=sys.stderr)
        return {
            "type": "error",
            "error": str(e),
        }


def normalize_output(text: str) -> str:
    """
    Minimal post-processing - just normalize whitespace and fix obvious formatting issues.
    
    PHILOSOPHY: The LLM handles content transformation via few-shot prompts.
    This function ONLY does universal cleanup that can't break content:
    - Whitespace normalization
    - Fixing obvious double punctuation
    - Ensuring proper line endings
    """
    import re
    
    result = text
    
    # Normalize horizontal whitespace (tabs, multiple spaces -> single space)
    result = re.sub(r'[^\S\n]+', ' ', result)
    
    # Remove space before punctuation
    result = re.sub(r'\s+([.,!?;:])', r'\1', result)
    
    # Remove leading/trailing space on lines  
    result = re.sub(r'^\s+', '', result, flags=re.MULTILINE)
    result = re.sub(r'\s+$', '', result, flags=re.MULTILINE)
    
    # Normalize multiple newlines to max 2 (paragraph break)
    result = re.sub(r'\n{3,}', '\n\n', result)
    
    # Fix double punctuation (LLM sometimes outputs "..")
    result = re.sub(r'\.{2,}', '.', result)
    result = re.sub(r',{2,}', ',', result)
    
    return result.strip()


def sanitize_output(text: str) -> str:
    """
    Remove prompt artifacts that LLM might echo.
    
    Common artifacts:
    - /no_think from Qwen thinking mode
    - <|im_end|> or similar special tokens
    - "Answer:" or "Output:" prefixes
    - Asterisks from markdown formatting
    """
    import re
    
    result = text
    
    # Remove thinking mode artifacts
    result = re.sub(r'/no_think\s*', '', result, flags=re.IGNORECASE)
    result = re.sub(r'/think\s*', '', result, flags=re.IGNORECASE)
    
    # Remove special tokens that might leak through (Qwen3 + Gemma 4)
    result = re.sub(r'<\|im_(?:start|end)\|>\s*', '', result)
    result = re.sub(r'<\|endoftext\|>\s*', '', result)
    result = re.sub(r'<start_of_turn>\s*\w*\s*', '', result)
    result = re.sub(r'<end_of_turn>\s*', '', result)
    result = re.sub(r'<eos>\s*', '', result)
    
    # Remove common LLM prefixes
    result = re.sub(r'^(?:Answer|Output|Response|Result|Here[\'s ]* (?:the|your)):\s*', '', result, flags=re.IGNORECASE)
    
    # Remove asterisks from markdown emphasis (but preserve content)
    # **text** -> text, *text* -> text
    result = re.sub(r'\*{1,2}([^*]+)\*{1,2}', r'\1', result)
    
    return result.strip()


def is_list_formatting(original: str, polished: str) -> bool:
    """
    Detect if word reduction is due to list formatting, not summarization.
    
    List formatting has a specific signature:
    - Word count DECREASES (removing "number one", "first", etc.)
    - Line count INCREASES or stays same (each item gets its own line)
    - List markers APPEAR (1., 2., -, •, etc.)
    
    Returns True if the transformation appears to be list formatting.
    """
    import re
    
    # Comprehensive list marker patterns
    list_patterns = [
        # Numbered lists
        r'^\s*\d+[\.\)]\s',           # 1. or 1) 
        r'^\s*[ivxIVX]+[\.\)]\s',     # i. ii. iii. (roman numerals)
        
        # Lettered lists  
        r'^\s*\([a-zA-Z]\)\s',        # (a) (b) (A) (B)
        r'^\s*[a-zA-Z][\.\)]\s',      # a. b. or a) b)
        
        # Bullet points (comprehensive)
        r'^\s*[-–—•●○◦◆◇▪▫★☆→►▸]\s',  # Common bullet chars
        r'^\s*\*\s',                   # * markdown bullets
    ]
    
    polished_lines = [l.strip() for l in polished.strip().split('\n') if l.strip()]
    
    # Count lines that match list patterns
    list_line_count = 0
    for line in polished_lines:
        for pattern in list_patterns:
            if re.match(pattern, line):
                list_line_count += 1
                break
    
    # If polished has 2+ list items, it's formatting not summarization
    if list_line_count >= 2:
        return True
    
    # Also check: line count increased (structuring content into lines)
    original_lines = len([l for l in original.split('\n') if l.strip()])
    polished_line_count = len(polished_lines)
    
    # If we went from 1-2 lines to 3+, that's structuring
    if original_lines <= 2 and polished_line_count >= 3:
        return True
    
    return False


def chunk_text_by_paragraphs(text: str, max_words: int = 500) -> list:
    """
    Split text into chunks for long dictation handling.
    Splits on paragraph boundaries first, then by sentences if needed.
    
    Args:
        text: The text to chunk
        max_words: Maximum words per chunk
    
    Returns:
        List of text chunks
    """
    import re
    
    words = text.split()
    if len(words) <= max_words:
        return [text]
    
    # Try to split on paragraph boundaries first
    paragraphs = re.split(r'\n\n+', text)
    if len(paragraphs) > 1:
        chunks = []
        current_chunk = []
        current_words = 0
        
        for para in paragraphs:
            para_words = len(para.split())
            if current_words + para_words > max_words and current_chunk:
                chunks.append('\n\n'.join(current_chunk))
                current_chunk = [para]
                current_words = para_words
            else:
                current_chunk.append(para)
                current_words += para_words
        
        if current_chunk:
            chunks.append('\n\n'.join(current_chunk))
        
        return chunks
    
    # No paragraph breaks - split by sentences
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks = []
    current_chunk = []
    current_words = 0
    
    for sentence in sentences:
        sentence_words = len(sentence.split())
        if current_words + sentence_words > max_words and current_chunk:
            chunks.append(' '.join(current_chunk))
            current_chunk = [sentence]
            current_words = sentence_words
        else:
            current_chunk.append(sentence)
            current_words += sentence_words
    
    if current_chunk:
        chunks.append(' '.join(current_chunk))
    
    return chunks


def handle_polish_text(pasted_text: str, final_text: str, mode: str = "clean") -> dict:
    """
    Phase 4: Final text polish
    
    Called when recording stops for comprehensive cleanup.
    Uses the quality model for better results.
    
    Handles long dictation by chunking text if over 1000 words.
    
    Modes:
    - verbatim: Minimal cleanup, keep filler words (legal/medical)
    - clean: Remove filler words, fix punctuation (default)
    - professional: Full grammar and style polish (business writing)
    """
    start = time.time()
    
    try:
        # Use deep model (4B) for final polish - more intelligent for lists/formatting
        # Falls back to quality model if deep model fails to load
        model, tokenizer = load_deep_model(swap_out_quality=True)
        if model is None:
            log("[Phase 4] Deep model unavailable, falling back to quality model")
            model, tokenizer = load_quality_model()
        
        # Get appropriate prompt template
        prompt_template = get_polish_prompt(mode)
        
        # Check if text is too long and needs chunking
        word_count = len(final_text.split())
        
        if word_count > 1000:
            # Long dictation - process in chunks
            log(f"Long text detected ({word_count} words), processing in chunks")
            chunks = chunk_text_by_paragraphs(final_text, max_words=500)
            log(f"Split into {len(chunks)} chunks")
            
            polished_chunks = []
            for i, chunk in enumerate(chunks):
                prompt = prompt_template.format(pasted_text="", final_text=chunk)
                chunk_len = len(chunk.split())
                max_tokens = min(chunk_len * 4 + 100, 1500)
                
                result = generate_text(
                    model,
                    tokenizer,
                    prompt,
                    max_tokens=max_tokens,
                    fallback=chunk
                )
                
                polished_chunk = result.strip() if result else chunk
                polished_chunks.append(polished_chunk)
                log(f"Processed chunk {i+1}/{len(chunks)}")
            
            # Join chunks with paragraph breaks
            polished = '\n\n'.join(polished_chunks)
        else:
            # Normal length - process as single text
            prompt = prompt_template.format(pasted_text=pasted_text, final_text=final_text)
            
            # Allow more tokens for final polish (input length + buffer).
            # Qwen3 may emit <think>...</think> blocks despite /no_think, consuming
            # ~100-300 tokens for reasoning.  Add headroom so the actual answer survives.
            think_budget = 300 if _model_family == "qwen3" else 0
            max_tokens = min(word_count * 4 + 100 + think_budget, 2000)
            
            result = generate_text(
                model, 
                tokenizer, 
                prompt, 
                max_tokens=max_tokens,
                fallback=final_text  # Return original if generation fails
            )
            
            polished = result.strip() if result else final_text
        
        # Minimal post-processing: just normalize whitespace
        # The LLM handles content transformation via few-shot prompts
        polished = normalize_output(polished)
        
        # Remove prompt artifacts (e.g., /no_think, special tokens)
        polished = sanitize_output(polished)
        
        # Validate: LLM should not drastically shorten the text (over-summarization)
        # But list formatting legitimately reduces word count while adding structure
        original_words = len(final_text.split())
        polished_words = len(polished.split())
        word_ratio = polished_words / max(original_words, 1)
        
        if word_ratio < 0.5 and original_words > 10:
            # Significant word reduction - check if it's list formatting or summarization
            if is_list_formatting(final_text, polished):
                log(f"[Phase 4] Low word ratio {word_ratio:.2f} but list formatting detected - allowing")
                # Keep polished version - it's structured, not summarized
            else:
                # True summarization - reject and return original
                log(f"[Phase 4] Rejected: word ratio {word_ratio:.2f} too low (summarization detected), returning original")
                polished = final_text
        
        elapsed = int((time.time() - start) * 1000)
        exceeded = elapsed > LATENCY_THRESHOLD_POLISH
        
        log(f"[Phase 4] Polish complete: mode={mode}, word_count={word_count}, polished_words={polished_words}, ratio={word_ratio:.2f}, chunks={len(chunks) if word_count > 1000 else 1}, total={elapsed}ms, exceeded={exceeded}")
        
        return {
            "type": "polish_result",
            "polished": polished,
            "mode": mode,
            "inference_time_ms": elapsed,
            "exceeded_latency": exceeded,
        }
        
    except Exception as e:
        log(f"ERROR in polish_text: {e}")
        traceback.print_exc(file=sys.stderr)
        return {
            "type": "error",
            "error": str(e),
        }


def _clean_extract_result(result: str) -> str:
    """Clean up extract result, extracting just the new words."""
    if not result:
        return ""
    
    import re
    cleaned = result.strip()
    
    # Remove markdown
    cleaned = re.sub(r'\*+', '', cleaned)
    
    # Remove explanatory prefixes
    for prefix in ['are:', 'answer:', 'output:', 'new words:']:
        if prefix in cleaned.lower():
            parts = cleaned.lower().split(prefix)
            if len(parts) > 1:
                cleaned = parts[-1].strip()
    
    # Check for empty indicators
    upper = cleaned.upper()
    if upper in ("EMPTY", "NONE", "") or upper.startswith("EMPTY") or upper.startswith("NONE"):
        return ""
    
    return cleaned


def _extract_looks_suspicious(result: str, pasted_end: str, tail_words: str) -> bool:
    """Detect when extract result is probably wrong."""
    if not result:
        return False  # Empty can be valid
    
    result_clean = result.strip()
    
    # 1. Result is longer than tail (impossible - can only be subset)
    if len(result_clean) > len(tail_words) + 10:
        return True
    
    # 2. Contains explanatory text
    lower = result_clean.lower()
    if any(marker in lower for marker in ['answer:', 'the new words', 'result:', 'here is']):
        return True
    
    # 3. Contains markdown
    if '**' in result_clean or '```' in result_clean:
        return True
    
    # 4. Contains the pasted end (should only contain tail words)
    if len(pasted_end) > 5 and pasted_end[-10:] in result_clean:
        return True
    
    return False


def handle_extract_new_words(pasted_end: str, tail_words: str) -> dict:
    """
    Extract new words from tail with adaptive model switching.
    
    Called during rolling window recovery when we need to determine what words
    from the tail are truly new and should be appended.
    
    Strategy:
    1. Try fast model (0.6B) first
    2. If result looks suspicious, retry with quality model (1.7B)
    
    Handles edge cases:
    - Partial overlaps: "nineteen" in both pasted and tail
    - Complete overlaps: all tail words already exist
    - Punctuation differences
    - Word order variations
    """
    start = time.time()
    
    try:
        log(f"[Extract] Request: pasted_end_len={len(pasted_end)}, tail_words_len={len(tail_words)}")
        
        # Limit context for speed
        pasted_context = pasted_end[-100:] if len(pasted_end) > 100 else pasted_end
        tail_context = tail_words[:200] if len(tail_words) > 200 else tail_words
        prompt = get_extract_new_words_prompt().format(pasted_end=pasted_context, tail_words=tail_context)
        
        # Try fast model first
        model, tokenizer = load_fast_model()
        inference_start = time.time()
        result = generate_text(model, tokenizer, prompt, max_tokens=100)
        fast_time = int((time.time() - inference_start) * 1000)
        
        new_words = _clean_extract_result(result)
        used_quality = False
        
        # Check if result looks suspicious
        if _extract_looks_suspicious(result, pasted_end, tail_words):
            log(f"[Extract] Fast model result suspicious ('{result[:50]}...'), retrying with quality model")
            
            # Retry with quality model
            model, tokenizer = load_quality_model()
            inference_start = time.time()
            result = generate_text(model, tokenizer, prompt, max_tokens=100)
            quality_time = int((time.time() - inference_start) * 1000)
            
            new_words = _clean_extract_result(result)
            used_quality = True
            log(f"[Extract] Quality model result: '{new_words[:50]}' ({quality_time}ms)")
        
        elapsed = int((time.time() - start) * 1000)
        exceeded = elapsed > LATENCY_THRESHOLD_MERGE
        
        log(f"[Extract] Complete: new_words_len={len(new_words)}, total={elapsed}ms, exceeded={exceeded}, used_quality={used_quality}")
        
        return {
            "type": "extract_result",
            "new_words": new_words,
            "inference_time_ms": elapsed,
            "exceeded_latency": exceeded,
            "used_quality_model": used_quality,
        }
        
    except Exception as e:
        log(f"ERROR in extract_new_words: {e}")
        traceback.print_exc(file=sys.stderr)
        return {
            "type": "error",
            "error": str(e),
        }


def handle_deep_cleanup(sentence: str, checksum: str, gpu_busy: bool = False) -> dict:
    """
    Deep cleanup using 4B model for background correction.
    
    This is the "Cleanup Crew" - a secondary layer that runs asynchronously
    on already-pasted text to catch issues the faster models missed.
    
    Args:
        sentence: The sentence to clean up
        checksum: Checksum for validation (ensure sentence hasn't changed)
        gpu_busy: If True, return immediately without processing (GPU contention)
    
    Returns:
        - cleaned: The cleaned sentence
        - checksum: Same checksum passed in (for validation)
        - skipped: True if processing was skipped (GPU busy)
    """
    start = time.time()
    
    # Check GPU contention
    if gpu_busy or is_fast_model_busy():
        log(f"[DeepCleanup] Skipped: GPU busy")
        return {
            "type": "deep_cleanup_result",
            "cleaned": sentence,
            "checksum": checksum,
            "skipped": True,
            "reason": "gpu_busy",
            "inference_time_ms": 0,
        }
    
    try:
        log(f"[DeepCleanup] Processing: len={len(sentence)}, checksum={checksum[:8]}...")
        
        # Load deep model (lazy - first call may be slow)
        model, tokenizer = load_deep_model()
        
        # Check if model loading failed (memory constraints)
        if model is None or tokenizer is None:
            log(f"[DeepCleanup] Skipped: deep model unavailable (memory)")
            return {
                "type": "deep_cleanup_result",
                "cleaned": sentence,
                "checksum": checksum,
                "skipped": True,
                "reason": "model_unavailable",
                "inference_time_ms": 0,
            }
        
        # Format prompt
        prompt = get_deep_cleanup_prompt().format(sentence=sentence)
        
        # Generate with deep model
        inference_start = time.time()
        result = generate_text(
            model, 
            tokenizer, 
            prompt, 
            max_tokens=len(sentence.split()) * 3 + 50,  # Allow expansion
            fallback=sentence
        )
        inference_time = int((time.time() - inference_start) * 1000)
        
        # Clean up result
        cleaned = result.strip() if result else sentence
        cleaned = normalize_output(cleaned)
        
        # Validate: result shouldn't be drastically different
        original_words = len(sentence.split())
        cleaned_words = len(cleaned.split())
        word_ratio = cleaned_words / max(original_words, 1)
        
        if word_ratio < 0.3 or word_ratio > 3.0:
            # Too much change - something went wrong
            log(f"[DeepCleanup] Rejected: word ratio {word_ratio:.2f} out of range")
            return {
                "type": "deep_cleanup_result",
                "cleaned": sentence,  # Return original
                "checksum": checksum,
                "skipped": True,
                "reason": "ratio_rejected",
                "inference_time_ms": inference_time,
            }
        
        elapsed = int((time.time() - start) * 1000)
        exceeded = elapsed > LATENCY_THRESHOLD_DEEP
        
        # Check if there were any changes
        has_changes = cleaned != sentence
        
        log(f"[DeepCleanup] Complete: has_changes={has_changes}, total={elapsed}ms, exceeded={exceeded}")
        
        return {
            "type": "deep_cleanup_result",
            "cleaned": cleaned,
            "original": sentence,
            "checksum": checksum,
            "skipped": False,
            "has_changes": has_changes,
            "inference_time_ms": elapsed,
            "exceeded_latency": exceeded,
        }
        
    except Exception as e:
        log(f"ERROR in deep_cleanup: {e}")
        traceback.print_exc(file=sys.stderr)
        return {
            "type": "deep_cleanup_result",
            "cleaned": sentence,
            "checksum": checksum,
            "skipped": True,
            "reason": "error",
            "error": str(e),
            "inference_time_ms": 0,
        }


def handle_transform_for_tts(text: str, mode: str = "developer") -> dict:
    """
    Transform text into natural spoken form for TTS (Code Talk feature).
    
    This pre-processes technical content before TTS synthesis to make it
    sound like how expert developers naturally explain code.
    
    Args:
        text: The technical text to transform
        mode: Speech mode - 'developer', 'conversational', or 'presentation'
    
    Returns:
        - transformed: The text rewritten for natural TTS
        - inference_time_ms: How long the LLM took
    
    Uses the 4B intelligence model for high-quality code-to-speech transformation.
    This is a complex task requiring good instruction following.
    Memory is managed by swapping out quality model if needed.
    """
    start = time.time()
    
    try:
        # Get prompt template for the mode
        prompt_template = get_tts_transform_prompt(mode)
        
        if not prompt_template:
            log(f"[TTS Transform] No prompt for mode '{mode}', returning original")
            return {
                "type": "tts_transform_result",
                "transformed": text,
                "inference_time_ms": 0,
                "skipped": True,
                "reason": "no_prompt",
            }
        
        log(f"[TTS Transform] Processing ({mode}): len={len(text)}")
        
        # Use 4B deep model for best code-to-speech transformation
        # The smaller models can't handle complex instruction following
        # Unload quality model first to make room (handled by load_deep_model)
        model, tokenizer = load_deep_model(swap_out_quality=True)
        
        if model is None:
            log("[TTS Transform] Failed to load deep model, returning original")
            return {
                "type": "tts_transform_result",
                "transformed": text,
                "inference_time_ms": int((time.time() - start) * 1000),
                "skipped": True,
                "reason": "model_load_failed",
            }
        
        # Format prompt with input text
        prompt = prompt_template.format(text=text)
        
        # Generate with appropriate token limit
        # Allow more expansion for natural speech (code becomes words)
        max_tokens = min(len(text.split()) * 4 + 100, 800)
        
        inference_start = time.time()
        result = generate_text(
            model, 
            tokenizer, 
            prompt, 
            max_tokens=max_tokens,
            fallback=text  # Return original if generation fails
        )
        inference_time = int((time.time() - inference_start) * 1000)
        
        # Clean up result
        transformed = result.strip() if result else text
        transformed = sanitize_output(transformed)
        
        # Validate: output shouldn't be empty or drastically different length
        if not transformed:
            log("[TTS Transform] Empty result, using original")
            return {
                "type": "tts_transform_result",
                "transformed": text,
                "inference_time_ms": inference_time,
                "skipped": True,
                "reason": "empty_result",
            }
        
        # Check expansion ratio (shouldn't be more than 3x or less than 0.3x)
        input_words = len(text.split())
        output_words = len(transformed.split())
        ratio = output_words / max(input_words, 1)
        
        if ratio > 5.0 or ratio < 0.2:
            log(f"[TTS Transform] Rejected: ratio {ratio:.2f} out of bounds")
            return {
                "type": "tts_transform_result",
                "transformed": text,
                "inference_time_ms": inference_time,
                "skipped": True,
                "reason": "ratio_rejected",
            }
        
        elapsed = int((time.time() - start) * 1000)
        
        log(f"[TTS Transform] Complete: {input_words} → {output_words} words, ratio={ratio:.2f}, time={elapsed}ms")
        
        return {
            "type": "tts_transform_result",
            "transformed": transformed,
            "original": text,
            "mode": mode,
            "inference_time_ms": elapsed,
            "word_ratio": ratio,
        }
        
    except Exception as e:
        log(f"ERROR in transform_for_tts: {e}")
        traceback.print_exc(file=sys.stderr)
        return {
            "type": "tts_transform_result",
            "transformed": text,
            "inference_time_ms": 0,
            "skipped": True,
            "reason": "error",
            "error": str(e),
        }


def handle_get_status() -> dict:
    """Return server status"""
    return {
        "type": "status",
        "fast_model_loaded": _fast_model is not None,
        "quality_model_loaded": _quality_model is not None,
        "deep_model_loaded": _deep_model is not None,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN LOOP
# ═══════════════════════════════════════════════════════════════════════════════

def cleanup_all_models() -> None:
    """Force cleanup of all loaded models - call before exit or on memory pressure."""
    global _fast_model, _fast_tokenizer, _quality_model, _quality_tokenizer
    global _deep_model, _deep_tokenizer
    import gc
    
    log("[Memory] Cleaning up all models...")
    
    _fast_model = None
    _fast_tokenizer = None
    _quality_model = None
    _quality_tokenizer = None
    _deep_model = None
    _deep_tokenizer = None
    
    gc.collect()
    
    try:
        import mlx.core as mx
        mx.metal.clear_cache()
        log("[Memory] All models unloaded, MLX cache cleared")
    except Exception as e:
        log(f"[Memory] Could not clear MLX cache: {e}")


def initialize() -> None:
    """Initialize the LLM server - load fast model"""
    log(f"Initializing LLM server (config={_active_config_name}, family={_model_family})...")
    log(f"  Fast:    {FAST_MODEL}")
    log(f"  Quality: {QUALITY_MODEL}")
    log(f"  Deep:    {DEEP_MODEL}")
    
    import atexit
    atexit.register(cleanup_all_models)
    
    try:
        load_start = time.time()
        load_fast_model()
        load_time = int((time.time() - load_start) * 1000)
        
        print(json.dumps({
            "type": "ready",
            "fast_model_load_time_ms": load_time,
            "model_config": _active_config_name,
            "model_family": _model_family,
            "fast_model": FAST_MODEL,
            "quality_model": QUALITY_MODEL,
            "deep_model": DEEP_MODEL,
        }), flush=True)
        log("Server ready")
        
    except Exception as e:
        log(f"ERROR during initialization: {e}")
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"type": "error", "error": str(e)}), flush=True)


def main() -> None:
    """Main command loop"""
    initialize()
    
    for line in sys.stdin:
        try:
            line = line.strip()
            if not line:
                continue
            
            command = json.loads(line)
            action = command.get("action", "")
            
            if action == "merge_text":
                result = handle_merge_text(
                    command.get("pasted", ""),
                    command.get("new_text", "")
                )
            
            elif action == "correct_sentence":
                result = handle_correct_sentence(
                    command.get("original", ""),
                    command.get("latest", "")
                )
            
            elif action == "polish_text":
                result = handle_polish_text(
                    command.get("pasted_text", ""),
                    command.get("final_text", ""),
                    command.get("mode", "clean")
                )
            
            elif action == "extract_new_words":
                result = handle_extract_new_words(
                    command.get("pasted_end", ""),
                    command.get("tail_words", "")
                )
            
            elif action == "deep_cleanup":
                result = handle_deep_cleanup(
                    command.get("sentence", ""),
                    command.get("checksum", ""),
                    command.get("gpu_busy", False)
                )
            
            elif action == "transform_for_tts":
                result = handle_transform_for_tts(
                    command.get("text", ""),
                    command.get("mode", "developer")
                )
            
            elif action == "swap_to_realtime":
                # Called when speech resumes - free memory for real-time
                swap_to_realtime_mode()
                result = {
                    "type": "swap_result",
                    "mode": "realtime",
                    "deep_model_loaded": _deep_model is not None,
                }
            
            elif action == "get_status":
                result = handle_get_status()
            
            elif action == "quit":
                log("Shutting down...")
                break
            
            else:
                result = {"type": "error", "error": f"Unknown action: {action}"}
            
            print(json.dumps(result), flush=True)
            
        except json.JSONDecodeError as e:
            log(f"Invalid JSON: {e}")
            print(json.dumps({"type": "error", "error": f"Invalid JSON: {e}"}), flush=True)
            
        except Exception as e:
            log(f"Error processing command: {e}")
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"type": "error", "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
