# Skill: fresh-install-test

## Trigger Phrases
- "test installer"
- "fresh install"
- "test setup wizard"
- Before major releases

## Purpose
Test the complete first-launch experience from a clean state.

## Why This Matters
- Users only get one first impression
- Installer bugs are embarrassing and hard to debug remotely
- Many bugs only appear on fresh install (cached state masks issues)

## Pre-Conditions

Run `cleanup-processes` skill first.

## Steps

### 1. Clean All Caches

```bash
# HuggingFace model cache
rm -rf ~/.cache/huggingface/hub/models--mlx-community*
rm -rf ~/.cache/huggingface/hub/models--ResembleAI*
rm -rf ~/.cache/huggingface/hub/models--nvidia*

# Electron store (BOTH locations!)
rm -rf ~/Library/Application\ Support/rift/
rm -rf ~/Library/Preferences/electron-store-nodejs/

# Python bundle
rm -rf /Users/mikkokiiskila/Code/playground/rift-app/python-bundle/

echo "All caches cleaned"
```

### 2. Rebuild Python Bundle

```bash
cd /Users/mikkokiiskila/Code/playground/rift-app
bun run bundle:python
```

Wait for completion (~2-5 min).

### 3. Run Installer Tests

```bash
bunx ts-node test-engine/installer-tests.ts --all
```

Expected: 100% pass rate

### 4. Build Package (Optional - Full Test)

```bash
bun run package
```

### 5. Install Fresh App

```bash
# Mount DMG
hdiutil attach dist-package/Rift-*-arm64.dmg

# Copy to Applications (use ditto for reliable copy)
rm -rf /Applications/Rift.app
ditto /Volumes/Rift*/Rift.app /Applications/Rift.app

# Unmount
hdiutil detach /Volumes/Rift*
```

### 6. Manual Verification Checklist

Launch the app and verify:

- [ ] Setup wizard appears (not blank)
- [ ] Model downloads start with progress
- [ ] Voice preview plays audio
- [ ] Microphone permission flow works
- [ ] Accessibility permission flow works
- [ ] Main widget appears after setup
- [ ] Tray icon visible
- [ ] Keyboard shortcuts work (Cmd+Shift+R)

## Success Criteria

| Check | Expected |
|-------|----------|
| installer-tests.ts | 100% pass |
| Setup wizard visible | Yes |
| Voice preview works | Audio plays |
| Setup completes | Widget appears |

## Common Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| Blank setup window | Wrong path to setup.html | Check `process.resourcesPath` usage |
| "Components missing" | python-bundle not in extraResources | Fix package.json extraResources |
| Voice preview silent | TTS server not ready | Check model_loaded signal timing |
| Permissions stuck | macOS cache | Add restart button |

## Key Files

| File | What to Check |
|------|---------------|
| `src/main/index.ts` | First-launch detection |
| `src/main/windows/setup.ts` | Setup window path |
| `setup/setup.html` | Setup wizard UI |
| `package.json` | extraResources config |

## After Testing

If all passes:
1. Log success to evals.json
2. Proceed with release

If failures:
1. Document in ISSUES.md
2. Fix issues
3. Re-run fresh-install-test
