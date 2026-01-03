# Roadmap

> Planned features and improvements for Rift.

## High Priority

### Auto-Context Polish Mode Detection

**Status:** Planned

Automatically detect the appropriate polish mode based on context rather than requiring manual selection.

**How it will work:**
- Detect active application (Slack vs Word vs email client)
- Analyze surrounding text for formal vs casual tone
- Auto-switch between verbatim/clean/professional modes

---

## Ideas (Exploring)

- **Voice commands** — "new paragraph", "delete that" during dictation
- **Speaker diarization** — Identify different speakers in meetings
- **Custom vocabulary** — Learn proper nouns and technical terms
- **Clipboard history** — Integration with macOS clipboard
- **Markdown detection** — Smart formatting for markdown editors
- **Speed/pitch controls** — Adjust TTS voice characteristics

---

## Recently Completed

### LLM Integration (Qwen3)
- ✓ Three-tier model architecture (0.6B fast, 4B intelligence)
- ✓ Real-time text merging during speech
- ✓ Rolling sentence correction
- ✓ Polish modes (clean, professional, verbatim)
- ✓ Silence-triggered automatic polish
- ✓ Adaptive model loading based on available memory

### Core Features
- ✓ Local speech-to-text (Parakeet)
- ✓ Local text-to-speech (Kokoro)
- ✓ Filler word removal ("um", "uh", "like")
- ✓ List detection and formatting
- ✓ Background noise filtering

---

## Contributing Ideas

Have a feature suggestion? Open an issue on GitHub describing:

1. What problem it solves
2. How you imagine it working
3. Any technical considerations
