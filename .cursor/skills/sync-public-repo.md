# Skill: sync-public-repo

## Trigger Phrases
- "sync to public"
- "update public repo"
- "push to rift repo"

## Purpose
Sync code from internal `playground` repo to public `mkmk10k/rift` repo with privacy checks.

## Repository Structure

| Repo | Purpose | Visibility |
|------|---------|------------|
| `mkmk10k/playground` | Development | Private |
| `mkmk10k/rift` | Public source | Public |

## Pre-Conditions

1. All evals pass
2. No uncommitted changes in playground
3. Changes are ready for public view

## Steps

### 1. Privacy Check

Review changes for sensitive content:

**NEVER sync:**
- `python/prompts.json` (optimized prompts = IP)
- `.env` files
- API keys or credentials
- `test-engine/history.jsonl`
- `reports/` directory
- `.cursor/` rules and skills (internal)

**Flag for review:**
- Debug print statements
- Hardcoded local paths
- Internal comments about users/companies
- TODO comments with sensitive context

### 2. Quality Check

Before syncing, verify code quality:
- No excessive AI-generated comments
- No commented-out dead code
- No placeholder TODOs
- Consistent formatting

### 3. Clone/Update Public Repo

```bash
cd /tmp
rm -rf rift-sync
git clone https://github.com/mkmk10k/rift.git rift-sync
cd rift-sync
```

### 4. Sync Files

```bash
# Sync Python (excluding prompts.json)
rsync -av --exclude='__pycache__' --exclude='prompts.json' \
  /Users/mikkokiiskila/Code/playground/rift-app/python/*.py ./python/

# Sync example prompts
rsync -av /Users/mikkokiiskila/Code/playground/rift-app/python/prompts.example.json ./python/

# Sync Electron src
rsync -av --exclude='node_modules' --exclude='dist' --exclude='.cache' \
  /Users/mikkokiiskila/Code/playground/rift-app/src/ ./src/

# Sync other public files
cp /Users/mikkokiiskila/Code/playground/rift-app/package.json ./
cp /Users/mikkokiiskila/Code/playground/rift-app/tsconfig*.json ./
cp /Users/mikkokiiskila/Code/playground/rift-app/electron-builder.yml ./ 2>/dev/null || true
```

### 5. Review Changes

```bash
git status
git diff
```

Check:
- No prompts.json in changes
- No .env or secrets
- No internal paths exposed

### 6. Commit and Push

```bash
git add .
git commit -m "sync: [description of changes]"
git push
```

## What Gets Synced

| Source | Destination | Notes |
|--------|-------------|-------|
| `src/` | `src/` | Full Electron source |
| `python/*.py` | `python/` | Server code |
| `python/prompts.example.json` | `python/` | Basic working prompts |
| `package.json` | `package.json` | Dependencies |

## What NEVER Gets Synced

| File | Reason |
|------|--------|
| `prompts.json` | IP protection |
| `.cursor/` | Internal agent config |
| `test-engine/history.jsonl` | Internal data |
| `reports/` | Internal analysis |
| `.env` | Security |
| `python-bundle/` | Build artifact |
| `dist*/` | Build artifacts |

## Success Criteria

- [ ] No sensitive files in commit
- [ ] `prompts.example.json` works standalone
- [ ] Public repo builds successfully
- [ ] README accurate

## After Sync

Verify public repo:
```bash
cd /tmp/rift-sync
bun install
bun run build
# Should succeed
```
