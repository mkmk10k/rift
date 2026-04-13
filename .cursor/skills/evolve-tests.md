# Skill: evolve-tests

## Trigger Phrases
- "improve tests"
- "add test for X"
- "test coverage"
- After test failures indicate coverage gaps

## Purpose
When tests fail, analyze the failure and add new scenarios to improve coverage.

## When to Use

1. **After unexpected failure** - Test passed before, now fails
2. **After bug fix** - Add regression test for the bug
3. **After new feature** - Add scenarios covering the feature
4. **After production issue** - Add test that would have caught it

## Steps

### 1. Identify the Gap

Look at failing tests:
```bash
tail -1 test-engine/history.jsonl | jq '.suites[] | select(.passed == false)'
```

Questions:
- What input caused the failure?
- What output was expected vs actual?
- Is this a new edge case or regression?

### 2. Categorize the Failure

| Category | File to Update | Example |
|----------|----------------|---------|
| LLM quality | `llm-scenarios.ts` | Polish output wrong |
| TTS transform | `tts-transform-scenarios.ts` | Code talk failed |
| E2E flow | `e2e-paste-test.ts` | Paste pipeline broken |
| Installer | `installer-tests.ts` | Setup wizard issue |

### 3. Add New Scenario

Example for LLM scenario:
```typescript
// In llm-scenarios.ts
{
  id: 'new-edge-case-001',
  name: 'Handle [specific edge case]',
  phase: 4,  // or appropriate phase
  input: '[The problematic input]',
  expected: {
    contains: ['expected', 'output', 'keywords'],
    notContains: ['unwanted', 'artifacts'],
  },
  rationale: 'Added after [date] failure - [brief description]',
}
```

### 4. Verify New Test Catches the Issue

```bash
# Run just the new scenario
bunx ts-node test-engine/llm-runner.ts --scenario new-edge-case-001
```

The test should:
- FAIL before the fix (proves it catches the bug)
- PASS after the fix

### 5. Log Evolution in evals.json

Add entry to `test_evolution` array:
```json
{
  "date": "2026-01-20",
  "file": "llm-scenarios.ts",
  "scenarios_added": 1,
  "reason": "Edge case from production bug #123"
}
```

## Test Scenario Guidelines

### Good Scenarios
- Specific, reproducible input
- Clear expected output criteria
- Documents WHY it was added (rationale)
- Covers one thing (not multiple behaviors)

### Bad Scenarios
- Vague expected output
- Tests multiple things at once
- No rationale for why it exists
- Flaky (passes sometimes, fails sometimes)

## Coverage Categories

Current test coverage by area:

| Area | File | Scenarios | Coverage |
|------|------|-----------|----------|
| LLM phases 2-4 | llm-scenarios.ts | 66 | Core polish |
| TTS transforms | tts-transform-scenarios.ts | 45 | Code talk |
| E2E flow | e2e-paste-test.ts | 8 | Full pipeline |
| Installer | installer-tests.ts | ~10 | Setup flow |

## When NOT to Add Tests

- Flaky behavior that can't be reliably reproduced
- One-off user error (not a real bug)
- Already covered by existing test
- Low-value edge case unlikely to recur
