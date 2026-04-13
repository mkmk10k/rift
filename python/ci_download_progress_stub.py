#!/usr/bin/env python3
"""
CI stub: emits the same JSON line protocol as download_models.py with tiny delays.

Simulates "user kept in the loop" — phase lines, init, per-model start →
multiple progress → complete, then all_complete. No Hugging Face.

Usage:
  python3 python/ci_download_progress_stub.py --fast
"""

from __future__ import annotations

import argparse
import json
import sys
import time


def send(msg: dict) -> None:
    print(json.dumps(msg), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit fake download progress for CI")
    parser.add_argument(
        "--fast",
        action="store_true",
        help="Shorter delays (~2s total) for GitHub Actions",
    )
    args = parser.parse_args()
    delay = 0.02 if args.fast else 0.08

    # Same shape as ensure_dependencies phases (subset)
    send({"type": "phase", "phase": "dependencies_start", "detail": "CI stub"})
    time.sleep(delay)
    send({"type": "phase", "phase": "pip_check", "package": "stub"})
    time.sleep(delay)
    send({"type": "phase", "phase": "dependencies_done"})
    time.sleep(delay)

    models = [
        {"id": "TTS", "name": "Stub Kokoro", "size_mb": 10},
        {"id": "STT", "name": "Stub Parakeet", "size_mb": 20},
    ]
    send({"type": "init", "total_models": len(models)})

    for m in models:
        mid = m["id"]
        size = m["size_mb"]
        send({"type": "start", "model": mid, "name": m["name"], "size_mb": size})
        # Multiple progress ticks (what keeps tray / setup UI from looking frozen)
        for pct in (0.2, 0.45, 0.7, 1.0):
            downloaded = int(size * pct)
            send(
                {
                    "type": "progress",
                    "model": mid,
                    "downloaded_mb": downloaded,
                    "total_mb": size,
                }
            )
            time.sleep(delay)
        send({"type": "complete", "model": mid, "name": m["name"]})
        time.sleep(delay)

    send({"type": "all_complete"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
