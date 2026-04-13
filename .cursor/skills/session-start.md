# Skill: session-start

## Trigger
Automatically at the start of every session working on rift-app.

## Purpose
Load context to avoid re-discovering known bugs and understand current state.

## Steps

### 1. Read Learnings
Read the Learnings sections in `agent-autonomy.mdc`:
- What bugs were already fixed?
- What patterns work?
- What to avoid?

Key learnings to remember:
- Two repos: `mkmk10k/playground` (internal) vs `mkmk10k/rift` (public)
- TTS/STT must use bundled Python, not system Python
- electron-store has TWO locations (dev vs prod)
- Mock torch module needed for mlx_audio
- Kokoro is default TTS (274ms TTFA)

### 2. Check ISSUES.md
```bash
cat /Users/mikkokiiskila/Code/playground/rift-app/ISSUES.md
```
- What bugs are currently open?
- What's the priority?

### 3. Check Eval Trends
```bash
# Last 5 eval runs
tail -5 /Users/mikkokiiskila/Code/playground/rift-app/test-engine/history.jsonl | jq -s '.[].passRate'
```

Questions to answer:
- Are we improving or regressing?
- Any flaky tests (pass/fail inconsistently)?
- What was the last label? (indicates what was being worked on)

### 4. Check Baselines in evals.json
```bash
cat /Users/mikkokiiskila/Code/playground/rift-app/test-engine/evals.json | jq '.baselines'
```

### 5. Check for Running Processes
```bash
ps aux | grep -E "(Rift|Electron|tts_server)" | grep -v grep
```
If processes found: Run `cleanup-processes` skill before starting work.

### 6. Check Git Status
```bash
cd /Users/mikkokiiskila/Code/playground/rift-app
git status --short
```
- Any uncommitted changes from last session?
- Any stashed work?

## Output
After running session-start, you should know:
1. Current open bugs (from ISSUES.md)
2. Recent eval trend (improving/stable/regressing)
3. What was last worked on (from history.jsonl labels)
4. Any cleanup needed (processes, uncommitted changes)

## Key Files to Be Aware Of

| File | Purpose |
|------|---------|
| `ISSUES.md` | Current bugs |
| `DECISIONS.md` | Architecture decisions |
| `test-engine/evals.json` | Baselines and learnings |
| `test-engine/history.jsonl` | Eval run history |
| `python/prompts.json` | LLM prompts (the "secret sauce") |
| `.cursor/rules/agent-autonomy.mdc` | Agent learnings |

## If Stuck
1. Check ISSUES.md for related problems
2. Check DECISIONS.md for past solutions
3. Search agent-autonomy.mdc learnings sections
4. Run targeted evals to diagnose
