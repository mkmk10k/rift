# Rift

**Speak, it types. Select, it reads.**

Voice-to-text and text-to-speech for macOS — private, fast, and entirely on-device.

Website: https://myrift.dev

---

## Features

### Voice to Text
- **On-device transcription** — No cloud, no latency, complete privacy
- **Live paste** — Words appear in any app as you speak
- **Chunk-and-commit architecture** — No freezes during long dictation
- **Smart formatting** — Dates, numbers, emails, phone numbers
- **AI polish** — Removes filler words, cleans up speech patterns
- **No auto-cutoff** — Dictate as long as you need

### Text to Speech  
- **Neural TTS** — Natural-sounding voice synthesis
- **150ms first-word latency** — Starts reading almost instantly
- **Works anywhere** — Select text in any app, press the shortcut

### Privacy
- 100% on-device processing
- Zero network requests
- No recordings saved
- Open source

---

## Requirements

- macOS 14.0 (Sonoma) or later
- Apple Silicon (M1/M2/M3/M4)
- ~2GB disk space for models
- 8GB RAM minimum (16GB recommended)

---

## Installation

### Download
Visit [myrift.dev](https://myrift.dev) to download the latest release.

### Build from Source

```bash
# Clone the repository
git clone https://github.com/mkmk10k/rift.git
cd rift

# Install Node dependencies
bun install

# Install Python dependencies
brew install python@3.11
/opt/homebrew/bin/python3.11 -m pip install -r python/requirements.txt

# Start development
bun run dev

# Build for production
bun run build

# Package as DMG
bun run package
```

---

## Architecture

```
rift/
├── src/
│   ├── main/           # Electron main process
│   │   ├── services/   # LLM, STT, TTS service management
│   │   ├── ipc/        # Inter-process communication
│   │   └── keyboard/   # Global hotkey handling
│   ├── renderer/       # React UI
│   │   ├── components/ # Black hole visualization, controls
│   │   └── services/   # Audio recording, playback
│   ├── preload/        # Secure IPC bridge
│   └── shared/         # Shared types
├── python/
│   ├── stt_server.py   # Speech-to-text (Parakeet)
│   ├── tts_server.py   # Text-to-speech (Kokoro)
│   └── llm_server.py   # Text polish (Qwen3)
├── tools/              # macOS accessibility tools
└── test-engine/        # E2E test framework
```

### Key Technologies

| Component | Technology | Purpose |
|-----------|------------|---------|
| Framework | Electron 28 | Native macOS app |
| UI | React 18 + TypeScript | Reactive interface |
| STT | Parakeet TDT 0.6B | Speech recognition |
| TTS | Kokoro | Voice synthesis |
| LLM | Qwen3 (0.6B/4B) | Smart formatting |
| ML Runtime | MLX | Apple Silicon optimization |

### Novel Techniques

**Chunk-and-Commit**: Unlike traditional STT that re-transcribes the entire audio buffer, Rift commits small chunks of text as "immutable" and only processes new audio. This prevents the "freeze" problem during long dictation.

**Stable Word Pasting**: Words that appear consistently across multiple transcription updates are pasted immediately, providing word-by-word feedback even before chunks are committed.

**Three-Tier LLM**: Fast model (0.6B) for real-time operations, larger model (4B) for polish during silence periods. Models are swapped dynamically based on latency requirements.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+2 | Start/stop voice dictation |
| Ctrl+1 | Read selected text aloud |

---

## Development

```bash
# LLM unit tests
bunx ts-node test-engine/llm-runner.ts

# E2E tests
bunx ts-node test-engine/e2e-paste-test.ts
```

See [DECISIONS.md](DECISIONS.md) for architectural decisions.

---

## Customizing Prompts

Rift loads LLM prompts from python/prompts.json. Copy the example to customize:

```bash
cp python/prompts.example.json python/prompts.json
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.
