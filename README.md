<p align="center">
  <img src="https://myrift.dev/assets/rift-logo.png" alt="Rift" width="120" />
</p>

<h1 align="center">Rift</h1>

<p align="center">
  <strong>Speak, it types. Select, it reads.</strong><br>
  Voice-to-text and text-to-speech for macOS — private, fast, and entirely on-device.
</p>

<p align="center">
  <a href="https://myrift.dev">Website</a> •
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#license">License</a>
</p>

---

## Features

### Voice to Text
- **On-device transcription** — No cloud, no latency, complete privacy
- **Live paste** — Words appear in any app as you speak
- **Smart formatting** — Dates, numbers, and punctuation handled automatically
- **AI polish** — Removes filler words, cleans up speech patterns
- **No auto-cutoff** — Dictate as long as you need

### Text to Speech
- **Neural TTS** — Natural-sounding voice synthesis
- **150ms latency** — Starts reading almost instantly
- **Works anywhere** — Select text in any app, press the shortcut

### Privacy First
- 100% on-device processing
- Zero network requests
- No recordings saved
- Open source

---

## Installation

> **Alpha Preview** — Rift is in active development.

### Requirements
- macOS 14.0 (Sonoma) or later
- Apple Silicon (M1/M2/M3/M4)
- ~2GB disk space for models

### Download
Visit [myrift.dev](https://myrift.dev) to download the latest release.

---

## How It Works

Rift uses state-of-the-art models optimized for Apple Silicon:

| Component | Model | Purpose |
|-----------|-------|---------|
| Speech-to-Text | Parakeet TDT 0.6B | Fast, accurate transcription |
| Text-to-Speech | Kokoro | Natural voice synthesis |
| Language Intelligence | Qwen3 | Smart formatting & polish |
| Framework | MLX | Apple Silicon optimization |

All models run locally using Apple's MLX framework, taking full advantage of the unified memory architecture.

---

## Development

```bash
# Clone the repo
git clone https://github.com/mkmk10k/rift.git
cd rift

# Install dependencies
bun install

# Start development
bun run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Built with ♥ on Apple Silicon</sub>
</p>
