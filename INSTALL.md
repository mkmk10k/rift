# Rift Installation Guide

## Requirements

- **macOS 12+** on Apple Silicon (M1/M2/M3/M4)
- **Python 3.9+** (Python 3.11 recommended)
- **Homebrew** (for installing Python if needed)

## Quick Install

1. **Download** `Rift-1.0.0-arm64.dmg`
2. **Open** the DMG and drag Rift to Applications
3. **Launch** Rift from Applications

### First Launch Setup

On first launch, Rift will:
1. Check for Python installation
2. Install required MLX packages (mlx-audio, mlx-whisper)
3. Download speech models (~100MB total)

This takes 1-3 minutes on first run. Subsequent launches are instant.

## Bypassing Gatekeeper (Unsigned App)

Since Rift is not signed with an Apple Developer certificate, macOS will show a warning.

**To open anyway:**

1. Right-click (or Control-click) on Rift in Applications
2. Select "Open" from the context menu
3. Click "Open" in the dialog that appears

**Alternative method:**

```bash
xattr -cr /Applications/Rift.app
```

Then open normally.

## Installing Python (if needed)

If Rift shows "Python not found", install via Homebrew:

```bash
# Install Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Python 3.11
brew install python@3.11
```

## Granting Permissions

Rift requires two macOS permissions:

### 1. Accessibility (Required for text injection)

1. Go to **System Settings → Privacy & Security → Accessibility**
2. Click the lock to make changes
3. Add Rift to the list and enable it

### 2. Microphone (Prompted automatically)

You'll be prompted when you first use voice dictation. Click "Allow".

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘⌥V | Read selected text aloud |
| ⌘⇧S | Start/stop voice dictation |
| ⌘⇧W | Show/hide Rift widget |

## Updating Rift

To update:
1. Download the new DMG
2. Drag Rift to Applications (replace existing)
3. Launch - your settings are preserved

## Uninstalling

1. Quit Rift (right-click tray icon → Quit)
2. Delete `/Applications/Rift.app`
3. (Optional) Delete settings: `rm -rf ~/Library/Application\ Support/rift-settings`

## Troubleshooting

### "Python not found"
- Install Python 3.11 via Homebrew (see above)
- Restart Rift

### "Accessibility permission required"
- Grant permission in System Settings → Privacy & Security → Accessibility

### Models not loading
- Ensure you have internet for first-time model download
- Check console for errors (Settings → 🛠 Console)

### Text not being pasted
- Ensure Accessibility permission is granted
- Make sure cursor is in an editable text field

## Support

For issues, check the console output (Settings → 🛠 Console) for error messages.



