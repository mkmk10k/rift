#!/usr/bin/env bash
# Visual regression: compare current site to baselines (agent-browser).
# Mirrors the viewport + font-scale matrix from website-visual-test.sh.
# Run from repo root: bun run test:website
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${WEBSITE_VISUAL_PORT:-8899}"
URL="http://127.0.0.1:${PORT}/"
BASE="${WEBSITE_VISUAL_BASELINE_DIR:-$ROOT/test-engine/website-baselines}"
AB="${AB:-$ROOT/node_modules/.bin/agent-browser}"
THRESHOLD="${WEBSITE_VISUAL_THRESHOLD:-0.1}"

if [[ ! -x "$AB" ]] && command -v agent-browser >/dev/null 2>&1; then
  AB="$(command -v agent-browser)"
fi

if [[ ! -x "$AB" ]]; then
  echo "agent-browser not found. Install with: bun install" >&2
  exit 1
fi

VIEWPORTS=(
  "320x568"
  "375x812"
  "768x1024"
  "1024x768"
  "1024x1366"
  "1440x900"
  "1920x1080"
  "2560x1440"
)

SECTIONS=(
  "hero:#hero"
  "comparison-table:.comparison-table"
  "tech-quartet:.tech-quartet"
  "download:#download"
)

FONT_SCALE_VIEWPORTS=("375x812" "1440x900")
FONT_SCALES=("0:0.875" "2:1.125" "3:1.25" "4:1.5")

failures=0

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  "$AB" close --all 2>/dev/null || true
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

check_shots() {
  local suffix="$1"
  local label="$2"

  # Full page
  local bl="$BASE/full-${suffix}.png"
  if [[ ! -f "$bl" ]]; then
    echo "  MISSING baseline: $bl" >&2
    failures=$((failures + 1))
  elif ! "$AB" diff screenshot --baseline "$bl" --full -t "$THRESHOLD"; then
    echo "  FAIL: full-page ($label)" >&2
    failures=$((failures + 1))
  fi

  # Section shots
  for spec in "${SECTIONS[@]}"; do
    local name="${spec%%:*}"
    local sel="${spec#*:}"
    bl="$BASE/${name}-${suffix}.png"
    if [[ ! -f "$bl" ]]; then
      echo "  MISSING baseline: $bl" >&2
      failures=$((failures + 1))
      continue
    fi
    if ! "$AB" diff screenshot --baseline "$bl" -s "$sel" -t "$THRESHOLD"; then
      echo "  FAIL: ${name} ($label)" >&2
      failures=$((failures + 1))
    fi
  done
}

# ---------- Main viewport loop (default font scale) ----------
for vp in "${VIEWPORTS[@]}"; do
  W="${vp%x*}"
  H="${vp#*x}"
  SAFE="${vp//x/_}"

  echo "Checking ${W}x${H}..."

  "$AB" open "$URL"
  "$AB" set viewport "$W" "$H"
  "$AB" wait --load networkidle
  "$AB" wait 800

  check_shots "$SAFE" "${W}x${H}"
  "$AB" close
done

# ---------- Font-scale loop on representative viewports ----------
for vp in "${FONT_SCALE_VIEWPORTS[@]}"; do
  W="${vp%x*}"
  H="${vp#*x}"
  SAFE="${vp//x/_}"

  for fs in "${FONT_SCALES[@]}"; do
    IDX="${fs%%:*}"
    SCALE="${fs#*:}"
    TAG="fs${SCALE//./}"

    echo "Checking ${W}x${H} font-scale ${SCALE}..."

    "$AB" open "$URL"
    "$AB" set viewport "$W" "$H"
    "$AB" wait --load networkidle
    "$AB" eval "document.documentElement.style.setProperty('--font-scale','${SCALE}'); localStorage.setItem('rift-font-index','${IDX}')"
    "$AB" eval "window.dispatchEvent(new Event('resize'))"
    "$AB" wait 800

    check_shots "${SAFE}-${TAG}" "${W}x${H} @${SCALE}x"
    "$AB" close
  done
done

if [[ "$failures" -gt 0 ]]; then
  echo "Visual check failed: $failures mismatch(es). Update baselines with: bun run test:website:update" >&2
  exit 1
fi

echo "All visual diffs within threshold ($THRESHOLD)."
