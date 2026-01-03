# Known Limitations

> Rift is in **Alpha Preview**. This document tracks current limitations and planned improvements.

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Mac | Apple Silicon (M1/M2/M3/M4) | M1 Pro or newer |
| macOS | Sonoma 14.0+ | Latest |
| RAM | 8 GB | 16 GB |
| Disk | ~2 GB (for models) | SSD recommended |

**Note:** Intel Macs are not supported. MLX requires Apple Silicon.

---

## First Launch

- **Model download:** First launch downloads ~1.5 GB of ML models. This requires an internet connection and may take several minutes.
- **Warmup time:** The first transcription after launch takes 3-5 seconds while models initialize. Subsequent transcriptions are faster.

---

## Speech-to-Text

| Limitation | Details |
|------------|---------|
| English only | No multilingual support yet |
| Background noise | Loud environments may affect accuracy |
| Fast speech | Very rapid speech may miss words |
| Homophones | "their/they're" and "your/you're" detection is inconsistent |
| Special formats | Spoken URLs ("w w w dot") and phone numbers don't auto-format |

### Known Behavior (Not Bugs)

- **"todo" → "to-do"**: The speech model uses standard English hyphenation. This happens at the STT level before text processing.

---

## Text-to-Speech

| Limitation | Details |
|------------|---------|
| Single voice | Only one voice available |
| No controls | Speed and pitch adjustment not yet available |
| English only | Same language limitation as STT |

---

## Memory Usage

Rift uses local ML models that require significant memory:

| Model | Memory | When Loaded |
|-------|--------|-------------|
| Fast (0.6B) | ~400 MB | Always |
| Intelligence (4B) | ~2.5 GB | During polish/silence |
| **Total (active)** | ~3 GB | During transcription |

### On 8 GB Macs

- The 4B model may not load if other apps are using significant memory
- Falls back to smaller model with reduced polish quality
- List formatting ("number one..." → "1.") may not work reliably

### Recommendation

Close memory-heavy applications (browsers with many tabs, Docker) for best performance.

---

## General

| Limitation | Details |
|------------|---------|
| No auto-update | Must manually download new versions |
| Unsigned app | May require right-click → Open on first launch |
| Single window | Can't run multiple instances |

---

## Planned Improvements

See [ROADMAP.md](ROADMAP.md) for upcoming features, including:

- Auto-context polish mode detection
- Voice commands during dictation
- Custom vocabulary learning
- Speed/pitch controls for TTS

---

## Reporting Issues

Found a bug not listed here? Open an issue on GitHub with:

1. macOS version and Mac model
2. What you expected vs. what happened
3. Steps to reproduce (if possible)
