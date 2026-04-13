#!/usr/bin/env bash
# Capture golden screenshots for the Rift marketing site (agent-browser).
# Covers 8 viewports × 5 sections × (default font + 4 scaled font sizes on 2 key viewports).
# Run from repo root: bun run test:website:update
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${WEBSITE_VISUAL_PORT:-8899}"
URL="http://127.0.0.1:${PORT}/"
OUT="${WEBSITE_VISUAL_BASELINE_DIR:-$ROOT/test-engine/website-baselines}"
AB="${AB:-$ROOT/node_modules/.bin/agent-browser}"

if [[ ! -x "$AB" ]] && command -v agent-browser >/dev/null 2>&1; then
  AB="$(command -v agent-browser)"
fi

if [[ ! -x "$AB" ]]; then
  echo "agent-browser not found. Install with: bun install" >&2
  exit 1
fi

VIEWPORTS=(
  "320x568"    # iPhone SE
  "375x812"    # iPhone X/12/13/14
  "768x1024"   # iPad portrait
  "1024x768"   # iPad landscape / small laptop
  "1024x1366"  # iPad Pro 12.9" portrait
  "1440x900"   # Laptop
  "1920x1080"  # Full HD desktop
  "2560x1440"  # QHD / large monitor
)

SECTIONS=(
  "hero:#hero"
  "comparison-table:.comparison-table"
  "tech-quartet:.tech-quartet"
  "download:#download"
)

# Font scales matching FONT_STEPS in main.js: 0.875, 1, 1.125, 1.25, 1.5
# Index 1 (scale 1) is the default — tested in the main viewport loop.
# We test scaled variants on two representative viewports (mobile + desktop).
FONT_SCALE_VIEWPORTS=("375x812" "1440x900")
FONT_SCALES=("0:0.875" "2:1.125" "3:1.25" "4:1.5")

mkdir -p "$OUT"

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

capture_shots() {
  local suffix="$1"
  "$AB" screenshot --full "$OUT/full-${suffix}.png"
  for spec in "${SECTIONS[@]}"; do
    local name="${spec%%:*}"
    local sel="${spec#*:}"
    "$AB" screenshot "$sel" "$OUT/${name}-${suffix}.png"
  done
}

# ---------- Main viewport loop (default font scale) ----------
for vp in "${VIEWPORTS[@]}"; do
  W="${vp%x*}"
  H="${vp#*x}"
  SAFE="${vp//x/_}"

  echo "Baseline ${W}x${H} (default font)..."

  "$AB" open "$URL"
  "$AB" set viewport "$W" "$H"
  "$AB" wait --load networkidle
  "$AB" wait 800

  capture_shots "$SAFE"
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

    echo "Baseline ${W}x${H} font-scale ${SCALE}..."

    "$AB" open "$URL"
    "$AB" set viewport "$W" "$H"
    "$AB" wait --load networkidle
    "$AB" eval "document.documentElement.style.setProperty('--font-scale','${SCALE}'); localStorage.setItem('rift-font-index','${IDX}')"
    # Trigger layoutPage recalc
    "$AB" eval "window.dispatchEvent(new Event('resize'))"
    "$AB" wait 800

    capture_shots "${SAFE}-${TAG}"
    "$AB" close
  done
done

echo "Baselines written to $OUT"
