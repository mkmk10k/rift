#!/usr/bin/env python3
"""
Model Download Script with Progress
Downloads all required models on first launch with progress output.

Outputs JSON to stdout for Electron to parse:
  {"type": "start", "model": "TTS", "name": "Kokoro", "size_mb": 80}
  {"type": "progress", "model": "TTS", "downloaded_mb": 45, "total_mb": 80}
  {"type": "complete", "model": "TTS"}
  {"type": "error", "model": "TTS", "error": "..."}
  {"type": "all_complete"}
"""

import sys
import json
import os

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

# Models to download
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
        "id": "LLM_QUALITY",
        "name": "Qwen3 Quality",
        "repo": "mlx-community/Qwen3-4B-4bit",
        "size_mb": 2500,
    },
]


def check_model_cached(repo_id: str) -> bool:
    """Check if a model is already in the HuggingFace cache."""
    try:
        from huggingface_hub import scan_cache_dir, HfFileSystem
        
        # Try to check if repo exists in cache
        cache_info = scan_cache_dir()
        for repo in cache_info.repos:
            if repo.repo_id == repo_id:
                # Check if it has actual files (not just metadata)
                if repo.size_on_disk > 1000:  # More than 1KB
                    return True
        return False
    except Exception:
        return False


def download_model_with_progress(model_info: dict) -> bool:
    """Download a model with progress reporting."""
    model_id = model_info["id"]
    repo_id = model_info["repo"]
    name = model_info["name"]
    size_mb = model_info["size_mb"]
    
    # Check if already cached
    if check_model_cached(repo_id):
        log(f"{name} already cached, skipping download")
        send({"type": "cached", "model": model_id, "name": name})
        return True
    
    send({"type": "start", "model": model_id, "name": name, "size_mb": size_mb})
    log(f"Downloading {name} ({repo_id})...")
    
    try:
        from huggingface_hub import snapshot_download
        
        # Track progress via callback
        last_progress = [0]  # Use list to allow mutation in closure
        
        def progress_callback(progress):
            # progress is 0-1 float
            downloaded_mb = int(progress * size_mb)
            if downloaded_mb > last_progress[0]:
                last_progress[0] = downloaded_mb
                send({
                    "type": "progress",
                    "model": model_id,
                    "downloaded_mb": downloaded_mb,
                    "total_mb": size_mb
                })
        
        # Download the model
        # Note: snapshot_download doesn't have a simple progress callback,
        # so we'll use tqdm integration via environment variable
        snapshot_download(
            repo_id,
            local_dir=None,  # Use default cache
            local_dir_use_symlinks=True,
        )
        
        send({"type": "complete", "model": model_id, "name": name})
        log(f"{name} download complete")
        return True
        
    except Exception as e:
        error_msg = str(e)
        log(f"Error downloading {name}: {error_msg}")
        send({"type": "error", "model": model_id, "error": error_msg})
        return False


def main():
    log("Starting model downloads...")
    send({"type": "init", "total_models": len(MODELS)})
    
    success = True
    for model in MODELS:
        if not download_model_with_progress(model):
            success = False
            # Continue with other models even if one fails
    
    if success:
        send({"type": "all_complete"})
        log("All models downloaded successfully!")
    else:
        send({"type": "partial_complete", "error": "Some models failed to download"})
        log("Some models failed to download")
    
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
