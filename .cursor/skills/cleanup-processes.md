# Skill: cleanup-processes

## Trigger Phrases
- "clean up processes"
- "kill processes"
- "before starting dev"
- Before any `bun run dev` command

## Purpose
Kill all Rift-related processes to prevent duplicate app instances that cause memory exhaustion and GPU contention.

## Why This Matters
- Each `bun run dev` spawns: Electron + Vite + 3 Python servers (~3-5GB RAM)
- Multiple instances cause system freeze
- User sees multiple tray icons
- GPU contention degrades TTS/STT performance

## Steps

### 1. Check for Running Processes
```bash
ps aux | grep -E "(Rift|Electron|electron|vite|tts_server|stt_server|llm_server)" | grep -v grep
```

### 2. Kill All Rift Processes
```bash
pkill -f "Electron" 2>/dev/null || true
pkill -f "electron" 2>/dev/null || true
pkill -f "Rift" 2>/dev/null || true
pkill -f "bun run dev" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
pkill -f "tts_server" 2>/dev/null || true
pkill -f "stt_server" 2>/dev/null || true
pkill -f "llm_server" 2>/dev/null || true
sleep 2
```

### 3. Verify Cleanup
```bash
ps aux | grep -E "(Rift|Electron|tts_server)" | grep -v grep | wc -l
# Should output: 0
```

## Success Criteria
- Process count returns 0
- No Rift-related processes in `ps aux`

## Failure Action
- If processes won't die, use `pkill -9` (force kill)
- If still failing, log to ISSUES.md

## When to Use
- ALWAYS before `bun run dev`
- After any test run that spawns servers
- When user reports "slow computer" or "multiple apps"
- After errors that may have left orphaned processes
