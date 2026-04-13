#!/usr/bin/env bash
# CI checks for first-launch / model download path (no Hugging Face downloads).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Python syntax: download_models.py + CI stub"
python3 -m py_compile python/download_models.py
python3 -m py_compile python/ci_download_progress_stub.py

echo "==> CLI: --core-only and --only (LLM_DEEP split)"
HELP="$(python3 python/download_models.py --help 2>&1)"
echo "$HELP" | grep -q -- '--core-only' || { echo "FAIL: --core-only missing from download_models.py --help"; exit 1; }
echo "$HELP" | grep -q -- '--only' || { echo "FAIL: --only missing from download_models.py --help"; exit 1; }

echo "==> TypeScript: model download service options"
grep -q 'coreOnly' src/main/services/modelDownloadService.ts || { echo "FAIL: coreOnly missing"; exit 1; }
grep -q 'onlyModelId' src/main/services/modelDownloadService.ts || { echo "FAIL: onlyModelId missing"; exit 1; }
grep -q 'normalizePythonDownloadEvent' src/main/services/modelDownloadService.ts || { echo "FAIL: normalizePythonDownloadEvent import missing"; exit 1; }
grep -q 'normalizePythonDownloadEvent' src/main/services/modelDownloadParsing.ts || { echo "FAIL: modelDownloadParsing missing"; exit 1; }

echo "==> TypeScript: setup uses core-only download"
grep -q 'downloadModels({ coreOnly: true })' src/main/windows/setup.ts || { echo "FAIL: setup must call downloadModels({ coreOnly: true })"; exit 1; }

echo "==> TypeScript: deferred IPC on first-run download path"
grep -qE 'finishDeferredModelBootstrap|registerMainBackendServices' src/main/index.ts || { echo "FAIL: index first-run bootstrap wiring missing"; exit 1; }

echo "==> Settings: llmDeepDownloaded"
grep -q 'llmDeepDownloaded' src/main/services/settings.ts || { echo "FAIL: llmDeepDownloaded setting missing"; exit 1; }

echo "==> Setup preload: onPhase"
grep -q "onPhase" src/preload/setupPreload.ts || { echo "FAIL: setupPreload onPhase missing"; exit 1; }

echo "==> Model download progress contract (stub stream, no HF)"
bun test-engine/model-download-contract-test.ts

echo "All first-launch CI checks passed."
