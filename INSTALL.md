# Outloud Installation Guide

## Requirements

- **macOS 12+** on Apple Silicon (M1/M2/M3/M4)
- **Python 3.9+** (Python 3.11 recommended)
- **Homebrew** (for installing Python if needed)

## Quick Install

1. **Download** `Outloud-1.0.0-arm64.dmg`
2. **Open** the DMG and drag Outloud to Applications
3. **Launch** Outloud from Applications

### First Launch Setup

On first launch, Outloud will:
1. Check for Python installation
2. Install required MLX packages (mlx-audio, mlx-whisper)
3. Download speech models (~100MB total)

This takes 1-3 minutes on first run. Subsequent launches are instant.

## Bypassing Gatekeeper (Unsigned App)

Since Outloud is not signed with an Apple Developer certificate, macOS will show a warning.

**To open anyway:**

1. Right-click (or Control-click) on Outloud in Applications
2. Select "Open" from the context menu
3. Click "Open" in the dialog that appears

**Alternative method:**

```bash
xattr -cr /Applications/Outloud.app
```

Then open normally.

## Installing Python (if needed)

If Outloud shows "Python not found", install via Homebrew:

```bash
# Install Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Python 3.11
brew install python@3.11
```

## Granting Permissions

Outloud requires two macOS permissions:

### 1. Accessibility (Required for text injection)

1. Go to **System Settings → Privacy & Security → Accessibility**
2. Click the lock to make changes
3. Add Outloud to the list and enable it

### 2. Microphone (Prompted automatically)

You'll be prompted when you first use voice dictation. Click "Allow".

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘⌥V | Read selected text aloud |
| ⌘⇧S | Start/stop voice dictation |
| ⌘⇧W | Show/hide Outloud widget |

## Updating Outloud

To update:
1. Download the new DMG
2. Drag Outloud to Applications (replace existing)
3. Launch - your settings are preserved

## Uninstalling

1. Quit Outloud (right-click tray icon → Quit)
2. Delete `/Applications/Outloud.app`
3. (Optional) Delete settings: `rm -rf ~/Library/Application\ Support/outloud-settings`

## Troubleshooting

### "Python not found"
- Install Python 3.11 via Homebrew (see above)
- Restart Outloud

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



