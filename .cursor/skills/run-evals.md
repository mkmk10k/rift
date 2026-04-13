# Skill: run-evals

## Trigger Phrases
- "run evals"
- "run tests"
- "check quality"
- "release gate"
- "benchmark"
- Before any release
- After significant changes to TTS/STT/LLM

## Purpose
Run all test suites with proper tracking. Evals ARE the success metrics for the product.

## Quick Commands

```bash
cd rift-app

# Full eval suite
bun run evals

# Quick LLM check only
bun run evals:quick

# Release gate check (blocks on threshold failures)
bun run evals:release
```

## Success Thresholds (Release Gates)

Defined in `test-engine/evals.json`:

| Suite | Metric | Threshold | Blocks Release |
|-------|--------|-----------|----------------|
| llm-runner | Pass rate | > 70% | Yes |
| e2e-paste-test | Pass rate | 100% | Yes |
| installer-tests | Pass rate | 100% | Yes |
| tts-kokoro-ttfa | TTFA | < 500ms | Yes |

## Steps

### 1. Clean Up First (Required)
Run `cleanup-processes` skill first to kill orphaned servers.

### 2. Run Eval Suite
```bash
# Recommended: Use npm scripts
bun run evals              # Full suite
bun run evals:release      # With release gate checking

# Or direct commands:
bunx ts-node test-engine/run-all-evals.ts
bunx ts-node test-engine/run-all-evals.ts --release-gate
```

### Individual suites:
```bash
# LLM unit tests
bun run test:llm

# Installer tests
bun run test:installer

# Full silence polish (high memory)
bunx ts-node test-engine/silence-polish-evals.ts
```

### 3. Check Results
Results are written to:
- `test-engine/history.jsonl` (append-only log)
- `test-engine/evals.json` (structured database)

### 4. Compare Against Baseline
```bash
# Last line of history.jsonl shows latest run
tail -1 test-engine/history.jsonl | jq .
```

Check:
- `passRate` vs baseline (should not regress >5%)
- `avgLatencyMs` vs baseline
- Per-phase pass rates

## Success Criteria
- All suites run without crashes
- Pass rates meet thresholds
- No regression >5% from baseline
- Results logged to evals.json

## Failure Action
- If regression detected: Do NOT proceed with release
- Identify failing tests and fix
- Re-run evals after fix
- Update ISSUES.md if new bug discovered

## Output Format
The skill should output a summary table:
```
Suite               | Pass Rate | Threshold | Status
--------------------|-----------|-----------|-------
llm-runner          | 71.2%     | 70%       | PASS
e2e-paste-test      | 100%      | 100%      | PASS
installer-tests     | 100%      | 100%      | PASS
--------------------|-----------|-----------|-------
Overall: PASS - Safe to release
```
