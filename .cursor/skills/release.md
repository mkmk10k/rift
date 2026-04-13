# Skill: release

## Trigger Phrases
- "release"
- "publish"
- "push an update"
- "deploy"

## Purpose
Build DMG, create GitHub release, update website. **Gated by evals passing.**

## Pre-Conditions (MUST PASS)

### 1. Run Evals First
```bash
cd /Users/mikkokiiskila/Code/playground/rift-app
bunx ts-node test-engine/run-all-evals.ts
```

Check results meet thresholds:
- llm-runner > 70%
- e2e-paste-test = 100%
- installer-tests = 100%

**If evals fail: STOP. Do not release. Fix issues first.**

### 2. Clean Working Directory
```bash
git status
# Should show no uncommitted changes to src/
```

## Steps

### Step 1: Build DMG
```bash
cd /Users/mikkokiiskila/Code/playground/rift-app
bun run package
```

### Step 2: Verify DMG Size
```bash
ls -lh dist-package/Rift-*.dmg
# MUST be < 2GB (GitHub limit)
# If > 2GB: Check extraResources in package.json for bundled models
```

### Step 3: Create GitHub Release
```bash
VERSION=$(cat package.json | jq -r .version)
gh release create "v$VERSION" \
  --repo mkmk10k/rift \
  --title "Rift $VERSION" \
  --notes "## Rift $VERSION

### Changes
- [List changes from git log]

### Test Results
- LLM pass rate: X%
- E2E pass rate: 100%
- Installer: 100%
" \
  --latest \
  dist-package/Rift-*-arm64.dmg
```

### Step 4: Update Website
```bash
# Update rift-landing files
cd /Users/mikkokiiskila/Code/playground/rift-landing

# Update version.json
VERSION="YYYY.M.D"
COMMIT=$(cd ../rift-app && git rev-parse --short HEAD)
cat > version.json << EOF
{
  "version": "$VERSION",
  "commit": "$COMMIT",
  "updated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# Update download links in HTML files
sed -i '' "s|Rift-[0-9.]+-arm64.dmg|Rift-$VERSION-arm64.dmg|g" index.html install.html index-ive.html
```

### Step 5: Commit and Push
```bash
cd /Users/mikkokiiskila/Code/playground
git add rift-landing/ rift-app/
git commit -m "Release $VERSION"
git push origin main
```

### Step 6: Log to Evals
Add entry to `test-engine/evals.json` runs array with release tag.

## Success Criteria
- [ ] DMG exists and < 2GB
- [ ] GitHub release created (verify URL works)
- [ ] Website download link returns 200
- [ ] version.json updated
- [ ] Git committed and pushed

## Failure Actions

| Failure | Action |
|---------|--------|
| Evals don't pass | Do not release. Fix failing tests. |
| DMG > 2GB | Remove bundled models from extraResources |
| gh release fails | Check gh auth, retry |
| Website update fails | Manual update, log to ISSUES.md |

## Post-Release
- Share release URL with user
- Verify "Check for Updates" in app finds new version
