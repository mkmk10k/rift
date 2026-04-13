# Rift Roadmap

## Feature Backlog

### High Priority

#### Auto-Context Polish Mode Detection
**Status:** Planned  
**Effort:** Medium  
**Impact:** High

Automatically detect the appropriate polish mode based on context rather than requiring user preference.

**Implementation ideas:**
- Detect active application (Slack vs Word vs email client)
- Analyze surrounding text for formal vs casual tone
- Use frontmost window title/bundle ID to infer context
- Auto-switch between verbatim/clean/professional modes

**Technical approach:**
1. Add `NSWorkspace` observer to detect active app bundle ID
2. Create app-to-mode mapping (e.g., Slack → clean, Word → professional)
3. Optional: Use LLM to analyze paste target context
4. Fall back to user preference if context unclear

**When complete:**
- [ ] Update landing page to reflect automatic detection
- [ ] Change "Your style, automatically" section to emphasize zero-config intelligence
- [ ] Update comparison table to highlight this as differentiator

---

## Completed Features

### LLM Integration (Qwen3)
- [x] Three-tier model architecture (0.6B, 1.7B, 4B)
- [x] Real-time merge (Phase 2)
- [x] Rolling sentence correction (Phase 3)
- [x] Final polish with modes (Phase 4)
- [x] Silence polish (backend-triggered)
- [x] Adaptive model loading based on memory

### Landing Page v2
- [x] Apple-style design language
- [x] LLM feature sections
- [x] Updated architecture diagrams
- [x] Technology credits (Qwen3)
- [x] Comparison table updates

---

## Ideas (Unvalidated)

- Voice commands during dictation ("new paragraph", "delete that")
- Speaker diarization for meeting transcription
- Custom vocabulary / proper noun learning
- Clipboard history integration
- Markdown formatting detection
