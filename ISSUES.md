# Issues

Lightweight issue tracker for outloud-electron. Update this file as bugs are found and fixed.

## Open

- [ ] **#006** [P1] Homophone detection inconsistent
  - `homo-their-theyre` and `homo-your-youre` failing in unit tests
  - 4B model not catching all their/they're, your/you're cases

- [ ] **#007** [P2] URL/phone formatting not working
  - "w w w dot" not converting to "www."
  - Spoken digits not converting to phone format
  - May require specialized post-processing

## Known STT Characteristics (Not Bugs)

- **Parakeet normalizes "todo" → "to-do"**: STT uses standard English hyphenation
  - Model: `mlx-community/parakeet-tdt-0.6b-v3` (NVIDIA's speech recognition for MLX)
  - This happens before our LLM sees the text
  - Cannot be changed without modifying Parakeet behavior
  - Could add post-processing if user requests verbatim "TODO" for code comments

## Memory Management

**Problem**: Full eval suite runs 3 servers simultaneously:
- TTS (Kokoro) ~4 GB
- STT (Parakeet) ~5 GB  
- LLM (Qwen 4B) ~10 GB
- **Total: ~19 GB peak**

On 16GB Mac: Forces heavy swap usage (10+ GB), causing slow latency.

**Solutions**:
1. Use `silence-polish-evals-lowmem.ts` for sequential mode (~10GB peak) - has sync bugs to fix
2. Kill zombie Python processes after tests: `pkill -f "llm_server|stt_server|tts_server"`
3. For production app: Only LLM runs continuously; TTS/STT are for testing only

## In Progress

- [ ] **#013** [P1] First inference after 4B model load produces garbage
  - **Symptom**: Silence Polish outputs truncated/corrupted text like "police. silence polish"
  - **Root cause**: MLX models can be unstable on first inference after load
  - **Fix applied**: Added warmup inference after loading 4B model
  - **Eval added**: `sp-long-input-list` and `sp-first-inference-stability` (80+ word inputs)
  - **Status**: Fix deployed, needs validation

## Recently Fixed (This Session)

- [x] **#008** [P0] Empty response bug (`polishedLen=0`)
  - **ROOT CAUSE**: Unsolicited `deep_model_loaded` notification matched to pending request
  - **FIX**: Filter notification types in `llmService.ts onData()` - don't match to pending requests
  - File: `src/main/services/llmService.ts`

- [x] **#009** [P1] Duplicate content from STT
  - **ROOT CAUSE**: STT re-transcription creates duplicates, LLM prompt said "never delete"
  - **FIX**: LLM-based deduplication via few-shot example (not brittle regex)
  - File: `python/llm_server.py` - POLISH_PROMPTS["clean"]

- [x] **#010** [P1] Compound filler words ("and uh", "like um")
  - **ROOT CAUSE**: Missing few-shot examples for compound patterns
  - **FIX**: LLM-based removal via few-shot examples (not brittle regex)
  - File: `python/llm_server.py` - POLISH_PROMPTS["clean"]

- [x] **#011** [P2] Gibberish from background noise
  - **ROOT CAUSE**: Low-volume background noise transcribed as speech fragments
  - **FIX**: Audio-level filtering in STT - skip transcription if RMS < 30% of average speech
  - File: `python/stt_server.py` - `is_low_volume_noise()`

- [x] **#012** [P2] Headless E2E tests fail (4B model won't load)
  - **ROOT CAUSE**: TTS/STT servers started in headless mode consumed memory
  - **FIX**: Skip TTS/STT startup in headless mode, only start LLM
  - File: `src/main/index.ts`

## Done

- [x] **#001** [P0] List formatting not working in Silence Polish
  - FIXED: Swapped to 4B model for polish
  - **PRODUCTION GRADE**: 18/18 Silence Polish stress tests pass (100%)
  - Tested: numbered lists, bullet lists, multi-pause, mixed content, edge cases
  - E2E test confirms: "Number one..." → "1. Take the dog out..." ✅

- [x] **#002** [P0] Content duplicates after Silence Polish
  - FIXED: silencePolishedTextRef tracks already-polished content
  - Frontend only applies delta after Silence Polish

- [x] **#003** [P1] `/no_think` appears in output
  - FIXED: Added `sanitize_output()` function in llm_server.py

- [x] **#004** [P1] Filler words not always removed
  - VERIFIED: E2E test shows filler removal working
  - Sentence preserved correctly in autonomous test

- [x] **#005** [P2] No empty lines around lists
  - FIXED: 4B model now adds proper spacing around lists

---

## Test Coverage Summary

| Test Suite | Pass Rate | Tests | Memory |
|------------|-----------|-------|--------|
| Headless E2E | **87.5%** | 7/8 | ~3GB |
| Paste Integration | **100%** | 4/4 | ~10GB |
| LLM Unit Tests | 68.2% | 45/66 | ~10GB |
| Silence Polish Stress | **100%** | 18/18 | ~19GB |

**Note:** Headless E2E silence-timing test (1 failure) is a test design issue, not a feature bug.

### Running Tests

```bash
# Run all evals (memory-safe, sequential)
bunx ts-node test-engine/run-all-evals.ts

# Individual suites
bunx ts-node test-engine/paste-integration-test.ts   # LLM polish behavior
bunx ts-node test-engine/llm-runner.ts               # LLM phase unit tests
bunx ts-node test-engine/silence-polish-evals.ts     # Full TTS→STT→LLM pipeline

# View history
cat test-engine/history.jsonl | tail -5
```

## Priority Levels
- **P0**: Critical - app unusable or produces wrong output
- **P1**: High - significant quality issue
- **P2**: Medium - polish/improvement
- **P3**: Low - nice to have
