#!/usr/bin/env python3
"""
Model Download Script with Progress
Downloads all required models on first launch with progress output.
Also ensures all Python dependencies are installed.

Outputs JSON to stdout for Electron to parse:
  {"type": "start", "model": "TTS", "name": "Kokoro", "size_mb": 80}
  {"type": "progress", "model": "TTS", "downloaded_mb": 45, "total_mb": 80}
  {"type": "complete", "model": "TTS"}
  {"type": "phase", "phase": "pip_install", "package": "spacy"}
  {"type": "all_complete"}
"""

import sys
import json
import os
import subprocess
import threading
import time

# Suppress warnings before imports
os.environ['MLX_DISABLE_METAL_WARNINGS'] = '1'
os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '0'

def send(msg):
    """Send JSON message to stdout for Electron to parse."""
    print(json.dumps(msg), flush=True)

def log(msg):
    """Log to stderr (visible in console but not parsed)."""
    sys.stderr.write(f"[Download] {msg}\n")
    sys.stderr.flush()


def ensure_dependencies():
    """Ensure all required Python packages are installed."""
    required_packages = [
        ('loguru', None),
        ('soundfile', None),
        ('numpy', None),
        ('munch', None),
        ('espeakng-loader', 'espeakng_loader'),
        ('phonemizer', None),
        ('num2words', None),
        ('inflect', None),
        ('pydantic', None),
        ('spacy', None),
        ('misaki[en]', 'misaki'),
    ]

    send({"type": "phase", "phase": "dependencies_start", "detail": "Checking Python packages"})
    log("Checking Python dependencies...")

    for pkg_info in required_packages:
        if isinstance(pkg_info, tuple):
            pkg_name, import_name = pkg_info
        else:
            pkg_name, import_name = pkg_info, None

        check_name = import_name or pkg_name
        send({"type": "phase", "phase": "pip_check", "package": pkg_name})
        try:
            __import__(check_name)
            log(f"  {pkg_name}: OK")
        except ImportError:
            log(f"  {pkg_name}: Installing...")
            send({"type": "phase", "phase": "pip_install", "package": pkg_name})
            try:
                result = subprocess.run(
                    [sys.executable, '-m', 'pip', 'install', pkg_name],
                    capture_output=True,
                    text=True,
                    timeout=300
                )
                if result.returncode == 0:
                    log(f"  {pkg_name}: Installed successfully")
                    send({"type": "phase", "phase": "pip_done", "package": pkg_name})
                else:
                    log(f"  {pkg_name}: Failed - {result.stderr[:200]}")
            except subprocess.TimeoutExpired:
                log(f"  {pkg_name}: Timeout during installation")
            except Exception as e:
                log(f"  {pkg_name}: Failed to install - {e}")

    send({"type": "phase", "phase": "dependencies_done"})


# Core models to download on first launch (full list)
MODELS = [
    {
        "id": "TTS",
        "name": "Kokoro Voice",
        "repo": "prince-canuma/Kokoro-82M",
        "size_mb": 80,
    },
    {
        "id": "STT",
        "name": "Parakeet Transcription",
        "repo": "mlx-community/parakeet-tdt-0.6b-v3",
        "size_mb": 600,
    },
    {
        "id": "LLM_FAST",
        "name": "Qwen3 Fast",
        "repo": "mlx-community/Qwen3-0.6B-4bit",
        "size_mb": 400,
    },
    {
        "id": "LLM_DEEP",
        "name": "Gemma Intelligence",
        "repo": "mlx-community/gemma-4-e4b-it-4bit",
        "size_mb": 5000,
    },
]

CORE_MODELS = MODELS[:3]

# Optional models downloaded on-demand
OPTIONAL_MODELS = {
    "chatterbox": {
        "id": "CHATTERBOX",
        "name": "Chatterbox",
        "repo": "ResembleAI/chatterbox",
        "size_mb": 2500,
    },
    "chatterbox-turbo": {
        "id": "CHATTERBOX_TURBO",
        "name": "Chatterbox Turbo (CPU)",
        "repo": "ResembleAI/chatterbox-turbo",
        "size_mb": 3800,
    },
}


def check_model_cached(repo_id: str) -> bool:
    """Check if a model is already in the HuggingFace cache."""
    try:
        from huggingface_hub import scan_cache_dir

        cache_info = scan_cache_dir()
        for repo in cache_info.repos:
            if repo.repo_id == repo_id:
                if repo.size_on_disk > 1000:
                    return True
        return False
    except Exception:
        return False


def get_repo_disk_bytes(repo_id: str) -> int:
    """Approximate on-disk bytes for a repo in the HF cache (grows during download)."""
    try:
        from huggingface_hub import scan_cache_dir

        cache_info = scan_cache_dir()
        for repo in cache_info.repos:
            if repo.repo_id == repo_id:
                return int(repo.size_on_disk)
    except Exception:
        pass
    return 0


def download_model_with_progress(model_info: dict) -> bool:
    """Download a model with progress reporting."""
    model_id = model_info["id"]
    repo_id = model_info["repo"]
    name = model_info["name"]
    size_mb = model_info["size_mb"]

    if check_model_cached(repo_id):
        log(f"{name} already cached, skipping download")
        send({"type": "cached", "model": model_id, "name": name})
        return True

    send({"type": "start", "model": model_id, "name": name, "size_mb": size_mb})
    log(f"Downloading {name} ({repo_id})...")

    stop_poll = threading.Event()

    def poll_loop():
        last_sent = -1
        while not stop_poll.wait(0.45):
            bytes_on_disk = get_repo_disk_bytes(repo_id)
            downloaded_mb = int(bytes_on_disk / (1024 * 1024))
            downloaded_mb = min(downloaded_mb, size_mb)
            if downloaded_mb > last_sent:
                last_sent = downloaded_mb
                send({
                    "type": "progress",
                    "model": model_id,
                    "downloaded_mb": downloaded_mb,
                    "total_mb": size_mb
                })

    poll_thread = threading.Thread(target=poll_loop, daemon=True)
    poll_thread.start()

    try:
        from huggingface_hub import snapshot_download

        snapshot_download(
            repo_id,
            local_dir=None,
            local_dir_use_symlinks=True,
        )

        stop_poll.set()
        poll_thread.join(timeout=2.0)

        send({
            "type": "progress",
            "model": model_id,
            "downloaded_mb": size_mb,
            "total_mb": size_mb
        })
        send({"type": "complete", "model": model_id, "name": name})
        log(f"{name} download complete")
        return True

    except Exception as e:
        stop_poll.set()
        poll_thread.join(timeout=2.0)
        error_msg = str(e)
        log(f"Error downloading {name}: {error_msg}")
        send({"type": "error", "model": model_id, "error": error_msg})
        return False


def download_optional_model(model_key: str) -> int:
    """Download a specific optional model."""
    if model_key not in OPTIONAL_MODELS:
        log(f"Unknown optional model: {model_key}")
        send({"type": "error", "model": model_key, "error": f"Unknown model: {model_key}"})
        return 1

    model = OPTIONAL_MODELS[model_key]
    log(f"Downloading optional model: {model['name']}...")
    send({"type": "init", "total_models": 1})

    if download_model_with_progress(model):
        send({"type": "all_complete"})
        log(f"{model['name']} downloaded successfully!")
        return 0
    else:
        send({"type": "partial_complete", "error": f"Failed to download {model['name']}"})
        log(f"Failed to download {model['name']}")
        return 1


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Download Rift models")
    parser.add_argument("--chatterbox", action="store_true", help="Download Chatterbox model (MPS-compatible)")
    parser.add_argument("--chatterbox-turbo", action="store_true", help="Download Chatterbox Turbo model (CPU-only)")
    parser.add_argument("--core-only", action="store_true", help="TTS + STT + fast LLM only (skip Gemma)")
    parser.add_argument("--only", type=str, metavar="MODEL_ID", help="Download a single model id (e.g. LLM_DEEP)")
    args = parser.parse_args()

    if args.chatterbox:
        log("Chatterbox download mode")
        return download_optional_model("chatterbox")

    if getattr(args, 'chatterbox_turbo', False):
        log("Chatterbox Turbo download mode")
        return download_optional_model("chatterbox-turbo")

    model_list = MODELS
    skip_deps = False

    if args.only:
        model_list = [m for m in MODELS if m["id"] == args.only]
        if not model_list:
            log(f"Unknown model id: {args.only}")
            send({"type": "error", "model": args.only, "error": f"Unknown model id: {args.only}"})
            return 1
        skip_deps = True
    elif args.core_only:
        model_list = CORE_MODELS

    log("Starting setup...")

    if not skip_deps:
        ensure_dependencies()

    log("Starting model downloads...")
    send({"type": "init", "total_models": len(model_list)})

    success = True
    for model in model_list:
        if not download_model_with_progress(model):
            success = False

    if success:
        send({"type": "all_complete"})
        log("All models downloaded successfully!")
    else:
        send({"type": "partial_complete", "error": "Some models failed to download"})
        log("Some models failed to download")

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
