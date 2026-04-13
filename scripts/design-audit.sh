#!/usr/bin/env bash
# Gate 0: programmatic design audit (contrast, type, touch targets) + screenshots.
# Run from repo root: bun run design:audit
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${WEBSITE_VISUAL_PORT:-8899}"
URL="http://127.0.0.1:${PORT}/"
AB="${AB:-$ROOT/node_modules/.bin/agent-browser}"
EVAL_JS="$ROOT/scripts/design-audit-eval.js"
OUT_JSON="${DESIGN_AUDIT_JSON:-$ROOT/test-engine/design-audit-last.json}"
SHOT_DIR="${DESIGN_AUDIT_SHOTS:-$ROOT/test-engine/.cache/design-audit}"

if [[ ! -x "$AB" ]] && command -v agent-browser >/dev/null 2>&1; then
  AB="$(command -v agent-browser)"
fi

if [[ ! -x "$AB" ]]; then
  echo "agent-browser not found. Install with: bun install" >&2
  exit 1
fi

if [[ ! -f "$EVAL_JS" ]]; then
  echo "Missing $EVAL_JS" >&2
  exit 1
fi

mkdir -p "$SHOT_DIR"

if command -v lsof >/dev/null 2>&1; then
  for p in $(lsof -ti:"$PORT" 2>/dev/null || true); do
    kill "$p" 2>/dev/null || true
  done
  sleep 0.3
fi

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  "$AB" close --all 2>/dev/null || true
  rm -f "${TMP_RESULTS:-}"
}
trap cleanup EXIT

(
  cd "$ROOT/website"
  exec python3 -m http.server "$PORT"
) &
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -sf "$URL" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
if ! curl -sf "$URL" >/dev/null 2>&1; then
  echo "Server did not start on $URL" >&2
  exit 1
fi

THEMES=(light dark high-contrast)
VIEWPORTS=("375 812" "1024 768" "1440 900")

TMP_RESULTS="$(mktemp)"

for theme in "${THEMES[@]}"; do
  for vp in "${VIEWPORTS[@]}"; do
    # shellcheck disable=SC2086
    set -- $vp
    W=$1
    H=$2
    SAFE="${W}x${H}-${theme}"

    echo "Design audit: ${SAFE}..."

    "$AB" open "$URL"
    "$AB" set viewport "$W" "$H"
    "$AB" wait --load networkidle
    "$AB" wait 600
    "$AB" eval "localStorage.setItem('rift-theme','${theme}'); document.documentElement.dataset.theme='${theme}';"
    "$AB" eval "window.dispatchEvent(new Event('resize'));"
    "$AB" wait 500

    cat "$EVAL_JS" | "$AB" eval --stdin --json 2>/dev/null \
      | node "$ROOT/scripts/design-audit-extract-json.js" > "${TMP_RESULTS}.one"
    node "$ROOT/scripts/design-audit-append-run.js" "${TMP_RESULTS}.one" "$TMP_RESULTS" "$SAFE"

    "$AB" screenshot "$SHOT_DIR/${SAFE}.png" || true
    "$AB" close
  done
done

rm -f "${TMP_RESULTS}.one"

node "$ROOT/scripts/design-audit-finalize.js" "$TMP_RESULTS" "$OUT_JSON" "$ROOT/test-engine/history.jsonl"
EXIT_CODE=$?

echo "Wrote $OUT_JSON"
echo "Appended design-audit line to test-engine/history.jsonl"
echo "Sum of per-run issue counts: (see $OUT_JSON)"

if [[ "$EXIT_CODE" -ne 0 ]]; then
  echo "Design audit reported issues — review $OUT_JSON and fix CSS/HTML, then re-run." >&2
  exit "$EXIT_CODE"
fi

echo "Design audit passed (programmatic checks)."
