# Skill: analyze-trends

## Trigger Phrases
- "analyze trends"
- "how are we doing"
- "check progress"
- "any regressions"

## Purpose
Analyze eval history to identify improvements, regressions, and patterns.

## Steps

### 1. Load Recent Runs
```bash
cd /Users/mikkokiiskila/Code/playground/rift-app

# Last 10 runs
tail -10 test-engine/history.jsonl | jq -s '.'
```

### 2. Compare Against Baseline
```bash
# Get baselines
cat test-engine/evals.json | jq '.baselines'

# Get latest run
tail -1 test-engine/history.jsonl | jq '.'
```

Calculate:
- `delta = latest.passRate - baseline.passRate`
- If delta < -0.05: **REGRESSION** (>5% drop)
- If delta > 0.05: **IMPROVEMENT**
- Otherwise: **STABLE**

### 3. Identify Flaky Tests
Look for tests that pass/fail inconsistently across recent runs:
```bash
# Compare pass rates across runs
tail -5 test-engine/history.jsonl | jq -s '[.[].passRate]'
```

High variance = flaky tests that need investigation.

### 4. Check Per-Phase Trends
```bash
tail -5 test-engine/history.jsonl | jq -s '[.[] | {label, phase2: .phase2PassRate, phase3: .phase3PassRate, phase4: .phase4PassRate}]'
```

Identify which phase is:
- Consistently passing (stable)
- Consistently failing (needs work)
- Inconsistent (flaky)

### 5. Check Latency Trends
```bash
tail -5 test-engine/history.jsonl | jq -s '[.[] | {label, avgLatencyMs}]'
```

If latency increasing: Performance regression.

## Output Format

```
## Eval Trend Analysis

### Overall: [IMPROVING / STABLE / REGRESSING]

| Metric | Baseline | Current | Delta | Status |
|--------|----------|---------|-------|--------|
| Pass Rate | 71.2% | 69.7% | -1.5% | STABLE |
| Latency | 942ms | 1050ms | +11% | WARNING |
| Phase 2 | 52% | 52% | 0% | STABLE |
| Phase 3 | 93% | 93% | 0% | STABLE |
| Phase 4 | 86% | 81% | -5% | WATCH |

### Recommendations
- Phase 4 showing slight decline - investigate polish output quality
- Latency increased - check if 4B model loading is slow
```

## Actions Based on Findings

| Finding | Action |
|---------|--------|
| Regression > 5% | Block release, create ISSUES.md entry |
| Flaky tests | Add to ISSUES.md, investigate root cause |
| Latency spike | Check memory, model loading |
| Consistent improvement | Update baseline in evals.json |

## When to Update Baselines

Update baselines in `evals.json` when:
1. A feature is complete and tests pass consistently
2. Pass rate improves and holds for 3+ runs
3. After intentional test suite changes

```bash
# Update baseline
cat test-engine/evals.json | jq '.baselines["llm-runner"].passRate = 0.75' > tmp.json && mv tmp.json test-engine/evals.json
```
