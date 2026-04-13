# Skill: feature-complete

## Trigger Phrases
- "feature complete"
- "done with feature"
- "ready for release"
- After tests pass for a new feature

## Purpose
Finalize a feature by updating documentation and preparing for release.

## Pre-Conditions

1. Feature implementation complete
2. Evals pass (run `run-evals` skill)
3. No known bugs in the feature

## Steps

### 1. Run Evals

```bash
cd /Users/mikkokiiskila/Code/playground/rift-app
bunx ts-node test-engine/run-all-evals.ts
```

All suites must pass thresholds. If not, fix issues first.

### 2. Update DECISIONS.md

Add entry documenting the feature:

```markdown
## [Date] - [Feature Name]

### Context
[Why was this built? What problem does it solve?]

### Decision
[What approach was taken?]

### Key Files
- `file1.ts` - [Purpose]
- `file2.py` - [Purpose]

### Evaluation Results
| Metric | Result |
|--------|--------|
| Pass rate | X% |
| Latency | Xms |

### Key Learnings
- [What worked]
- [What didn't work initially]

### Status
IMPLEMENTED AND VALIDATED
```

### 3. Update ISSUES.md

- Close any issues fixed by this feature
- Add any new issues discovered during implementation

### 4. Add Learnings to agent-autonomy.mdc

If you discovered something reusable:
```markdown
## Learnings from [Date] Session ([Feature Name])

### What Worked
1. [Pattern that succeeded]

### What Failed Before Fixing
1. [Initial approach that didn't work]
2. [Why it failed]
3. [How it was fixed]

### Key Files
- [Files created/modified]
```

### 5. Update evals.json Learnings

Add entry:
```json
{
  "date": "2026-01-20",
  "finding": "[What was learned]",
  "source": "[How it was discovered]",
  "action": "[What was done about it]"
}
```

### 6. Generate Release Brief

Create summary for release:

```markdown
## Feature: [Name]

### Summary
[One paragraph description]

### User-Facing Changes
- [What users will notice]

### Technical Implementation
- [Key technical details]

### Test Results
| Metric | Result |
|--------|--------|
| Pass rate | X% |
| TTFA | Xms |

### Files Changed
- [List of key files]

### Breaking Changes
[None / Description]
```

## Success Criteria

- [ ] Evals pass
- [ ] DECISIONS.md updated
- [ ] ISSUES.md updated
- [ ] Learnings added (if any)
- [ ] Release brief generated

## After Feature Complete

Proceed to `release` skill if ready to ship.

## Template: Quick Feature Complete

For small features, minimal update:

```bash
# 1. Run evals
bunx ts-node test-engine/run-all-evals.ts

# 2. Quick DECISIONS.md entry
echo "
## $(date +%Y-%m-%d) - [Feature Name]
- Context: [Why]
- Decision: [What]
- Status: IMPLEMENTED
" >> DECISIONS.md

# 3. Commit
git add .
git commit -m "feat: [feature name]"
```
