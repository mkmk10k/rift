# Rift (Electron)

A beautiful macOS voice assistant app with Speech-to-Text (STT) and Text-to-Speech (TTS) capabilities, featuring native glassmorphic UI.

## Features

- 🎙️ **Speech-to-Text**: Voice dictation with local MLX models
- 🔊 **Text-to-Speech**: Natural voice synthesis using MLX Kokoro
- 🪟 **Native macOS Design**: True vibrancy effects with glassmorphism
- ⌨️ **Global Shortcuts**: System-wide hotkeys for quick access
- 🎯 **Always On Top**: Floating widget that stays accessible
- 🔒 **Privacy First**: Local processing with Apple Silicon optimization

## Tech Stack

- **Electron 28**: Native macOS application framework
- **React 18 + TypeScript**: Modern UI development
- **Vite**: Lightning-fast development server
- **Tailwind CSS**: Utility-first styling
- **MLX Audio**: Apple Silicon-optimized ML models

## Setup

### Prerequisites

1. **Python 3.11** with MLX audio:
```bash
brew install python@3.11
/opt/homebrew/bin/python3.11 -m pip install -r python/requirements.txt
```

2. **Node.js/Bun** for development:
```bash
# Install dependencies
bun install
```

## Development

```bash
# Start dev server
bun run dev

# Build for production
bun run build

# Package for distribution
bun run package
```

## Keyboard Shortcuts

- `Cmd+Shift+V`: Activate voice dictation
- `Cmd+Shift+W`: Show/hide widget

## Architecture

```
rift-electron/
├── src/
│   ├── main/       # Electron main process (Node.js/TypeScript)
│   ├── renderer/   # React UI (runs in Chromium)
│   ├── preload/    # Secure IPC bridge
│   └── shared/     # Shared types
└── python/         # MLX audio scripts
```

## Native Vibrancy

The app uses Electron's built-in `vibrancy` option for true macOS glass effects:

```typescript
const window = new BrowserWindow({
  vibrancy: 'fullscreen-ui',  // Native macOS vibrancy
  transparent: false,         // Important: false when using vibrancy
  frame: false,
  roundedCorners: false      // Prevents gray corner artifacts
});
```

### UI Design Solution

After extensive testing, we achieved a perfect glassmorphic UI by:
- Using `vibrancy: 'fullscreen-ui'` for native macOS blur
- Setting minimal border radius (4px) to match window shape
- Black text for optimal legibility on glass backgrounds
- No CSS backdrop filters - let macOS handle the effects

This provides the authentic macOS look without any gray padding or corner artifacts!

## License

MIT

