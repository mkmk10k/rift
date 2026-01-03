# Decision Log

Track architectural decisions and their rationale. Reference this to understand why things are built a certain way.

---

## 2026-01-02: Two-Model Architecture (VALIDATED)

**Context:** The 1.7B "Quality" model consistently failed to format lists. When given "Number one... Number two...", it returned the text unchanged.

**Decision:** Simplify to 2 models:
- **Fast (0.6B)**: Real-time operations during speech (merge, extract, correct)
- **Intelligence (4B)**: All polish operations (Silence Polish, Final Polish)

**Evaluation Results:**

| Metric | 1.7B (Before) | 4B (After) | Change |
|--------|---------------|------------|--------|
| Total Pass Rate | 63.6% | 68.2% | **+4.6%** |
| Phase 4 (Polish) | 66.7% | 76.2% | **+9.5%** |
| List Detection | 2/4 (50%) | 4/4 (100%) | **+50%** |
| Avg Latency | 1305ms | 3125ms | +1820ms |

**Conclusion:** 4B model significantly improves quality at cost of ~2x latency. This is acceptable because polish happens during silence/stop, not during active speech.

**Status:** IMPLEMENTED AND VALIDATED

---

## 2026-01-02: BE-Driven Silence Detection

**Context:** There were 4 competing FE silence detection systems causing race conditions and unreliable behavior.

**Decision:** Move all silence detection to backend (llmService.ts). Frontend only:
1. Sends `notifySpeechDetected()` when new words come in
2. Receives polish results via callback
3. Applies results with undo-and-replace

**Rationale:**
1. Single source of truth for silence timing
2. No race conditions between FE systems
3. Cleaner separation of concerns

**Status:** Implemented

---

## 2026-01-02: Evals-Driven Development

**Context:** Changes to LLM prompts and models need to be validated. Manual testing is slow and inconsistent.

**Decision:** Build an evals engine that:
1. Runs automated tests before/after changes
2. Tracks results in `history.jsonl` over time
3. Detects regressions automatically
4. Uses TTS→STT loop for end-to-end testing (future)

**Components Built:**
- `test-engine/llm-runner.ts` - Test runner
- `test-engine/llm-scenarios.ts` - Test scenarios
- `test-engine/history.jsonl` - Historical tracking
- `.cursor/rules/agent-autonomy.mdc` - Agent guidelines

**Status:** COMPLETE

---

## 2026-01-02: Autonomous E2E Test Engine

**Context:** Manual testing requires human involvement. Agent should be fully autonomous.

**Decision:** Build E2E test engine using TTS→STT→LLM loop:
1. Kokoro TTS generates speech from test text
2. Parakeet STT transcribes the audio
3. Qwen3 LLM polishes the transcription
4. Engine verifies output matches expectations
5. **NO human interaction required**

**Implementation:**
- `test-engine/e2e-paste-test.ts` - Main runner
- Warmup request forces 4B model loading before tests
- Sequential execution (memory-safe)
- Results appended to `history.jsonl`

**Validation:**
```
TOTAL: 3/3 passed (100.0%)
- e2e-list-basic: "Number one..." → "1. Take the dog out..." ✅
- e2e-filler-removal: Sentence preserved ✅
- e2e-simple-sentence: TTS→STT→LLM roundtrip ✅
```

**Key Learnings:**
1. Must warm up LLM before tests (4B model takes ~3s to load)
2. Server responses can get out of sync without warmup
3. 2-minute timeouts needed for 4B model operations

**Status:** COMPLETE AND WORKING

---

## 2026-01-02: Sanitize Output Function

**Context:** LLM sometimes echoes prompt artifacts like `/no_think`, `<|im_end|>`, or markdown asterisks.

**Decision:** Add `sanitize_output()` function in `llm_server.py` that strips:
- Thinking mode artifacts (`/no_think`, `/think`)
- Special tokens (`<|im_end|>`, `<|endoftext|>`)
- Common LLM prefixes ("Answer:", "Output:")
- Markdown emphasis (`**text**` → `text`)

**Status:** Implemented

---

## 2026-01-03: Production-Grade Eval Engine

**Context:** Need comprehensive testing of paste behavior without human intervention. Memory constraints on 16GB Mac.

**Decision:** Build a multi-tier eval engine:

| Tier | Test Suite | Memory | Purpose |
|------|------------|--------|---------|
| 1 | Paste Integration | ~10GB | LLM polish behavior only |
| 2 | LLM Unit Tests | ~10GB | All LLM phases |
| 3 | Silence Polish Stress | ~19GB | Full TTS→STT→LLM pipeline |

**Key Design Decisions:**

1. **Sequential Execution** - Only one suite runs at a time to stay within memory limits
2. **Master Runner** - `run-all-evals.ts` orchestrates all suites with cleanup between them
3. **Memory Detection** - Automatically skips heavy tests on <20GB systems unless `--full` flag
4. **History Tracking** - All results append to `history.jsonl` for trend analysis

**Components:**
- `test-engine/paste-integration-test.ts` - Lightweight LLM-only tests (100% pass)
- `test-engine/silence-polish-evals.ts` - Full pipeline stress tests (100% pass)
- `test-engine/run-all-evals.ts` - Master runner with memory management

**Usage:**
```bash
bunx ts-node test-engine/run-all-evals.ts        # Standard (auto-skip heavy tests)
bunx ts-node test-engine/run-all-evals.ts --full # Force all tests (needs 20GB+)
```

**Status:** COMPLETE

---

## 2026-01-02: Headless App E2E Test Mode

**Context:** Even with TTS→STT→LLM testing, we weren't testing the REAL app integration: actual LLM service, silence detection timing, paste handlers.

**Decision:** Add `--run-e2e-tests` flag to Electron app that:
1. Runs app in headless mode (no UI)
2. Uses the real LLM service (not a separate subprocess)
3. Tests polish behavior, silence detection, duplicate prevention
4. Reports results and exits with appropriate code

**Implementation:**
- `src/main/services/headlessTestRunner.ts` - Test runner
- Modified `src/main/index.ts` - Headless mode entry point
- Must run with `ELECTRON_RUN_AS_NODE=` to ensure electron module loads correctly

**Usage:**
```bash
ELECTRON_RUN_AS_NODE= bunx electron . --run-e2e-tests
```

**Test Scenarios:**
| Scenario | Description | Validation |
|----------|-------------|------------|
| List Formatting | "Number one..." → "1." | Check for 1., 2., 3. |
| Filler Removal | "Um so basically..." | No um, uh, basically |
| Preserve Numbers | "5 copies" stays "5" | Not "five copies" |
| Silence Timing | 2s silence triggers polish | Callback fires |
| No Duplicates | Same content not repeated | Sentence dedup |

**Key Finding:** On memory-constrained systems (<2GB available), 4B model can't load and falls back to 1.7B, which doesn't reliably format lists. This is expected behavior documented in memory management guidelines.

**Status:** COMPLETE

---

## 2026-01-02: LLM Over Regex Principle

**Context:** Initial fixes for duplicate detection, filler removal, and gibberish tail used brittle regex post-processing that fails on edge cases.

**Decision:** Prefer LLM-based solutions over regex for text transformations:

1. **Deduplication** - LLM via few-shot example, not regex sentence splitting
2. **Compound fillers** - LLM via few-shot example, not pattern matching  
3. **Gibberish tail** - Audio-level filtering (RMS volume), not text analysis

**Rationale:**
- Regex is brittle and fails on edge cases
- LLM understands semantic meaning and context
- Audio-level filtering addresses root cause (noise) not symptom (gibberish text)

**Created:** `.cursor/rules/llm-over-regex.mdc`

**Status:** IMPLEMENTED

---

## 2026-01-02: Response Queue Desync Fix

**Context:** First Silence Polish trigger returned `polishedLen=0` while 4B model was loading.

**Root Cause:** Python sends unsolicited notifications to stdout:
```python
print(json.dumps({"type": "deep_model_loaded", ...}))
```

TypeScript blindly matches ANY response to the first pending request, so a polish request could receive `{type: "deep_model_loaded"}` instead of `{type: "polish_result"}`.

**Decision:** Filter notification types in `llmService.ts onData()`:
```typescript
const notificationTypes = ['ready', 'quality_model_loaded', 'deep_model_loaded'];
if (notificationTypes.includes(response.type)) {
  console.log(`[LLM Server] Notification: ${response.type}`);
  return;  // Don't match to pending request
}
```

**Alternative Considered:** Move Python notifications to stderr. Rejected because stdout filtering is simpler and more explicit.

**Status:** IMPLEMENTED
