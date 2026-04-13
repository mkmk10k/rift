# Testing Guide - Rift

## What Was Fixed

Based on your feedback:
- ✅ Settings modal now auto-resizes
- ✅ Settings content is fully visible
- ✅ Model errors show helpful messages
- ✅ Audio playback implemented
- ✅ Native liquid glass look preserved

## How to Test Each Feature

### 1. Test Native Vibrancy ✨

**Expected**: Widget has beautiful liquid glass effect that adapts to wallpaper

**To Test**:
1. Move the widget over different parts of your screen
2. The background should blur what's behind it
3. Should look like a native macOS overlay

**Pass Criteria**: Looks like Aqua Voice or macOS Control Center widgets

---

### 2. Test Settings Modal Resize 📐

**Expected**: Window automatically resizes when opening/closing settings

**To Test**:
1. Note current widget size (~420x96)
2. Click the gear icon (⚙)
3. Window should expand to 540x520
4. All settings content should be visible
5. Click the × button to close
6. Window should shrink back to 420x96

**Pass Criteria**: No content cutoff, smooth resize

---

### 3. Test Model Checking 🔍

**Expected**: Shows clear status or error message

**To Test**:
1. Open settings (⚙)
2. Look at "Model Status" section
3. Should show either:
   - ✓ "Ready" (green) if mlx-audio installed
   - ✗ "Not Available" (red) with error message
4. Click "Refresh Status" button
5. Should update status

**Common Errors You'll See**:
- "Python 3.11 not found at /opt/homebrew/bin/python3.11"
- "mlx-audio not installed"
- "Check timed out after 5 seconds"

**Pass Criteria**: Error messages are helpful and actionable

---

### 4. Test TTS Audio Playback 🔊

**Expected**: Synthesizes and plays test audio

**To Test**:
1. Open settings
2. Click "▶ Play Test Audio" button
3. Status should show "Synthesizing speech..."
4. If models are ready: audio file gets created and plays
5. If models aren't ready: shows clear error

**Pass Criteria**: 
- If mlx-audio works: Hear audio through speakers
- If not: See clear error message (not generic "failed")

---

### 5. Test Recording Button 🎙️

**Expected**: Shows placeholder message (not yet fully implemented)

**To Test**:
1. Click the blue record button (●)
2. Widget should show "Recording..." state
3. Currently will show "Recording failed" (expected - placeholder)

**Note**: This is expected behavior until we implement `node-record-lpcm16`

**Pass Criteria**: Clear message, doesn't crash

---

### 6. Test Window Dragging 🖱️

**Expected**: Can drag window anywhere on screen

**To Test**:
1. Click and drag anywhere on the widget (not on buttons)
2. Widget should move smoothly
3. Buttons should still be clickable

**Pass Criteria**: Draggable AND buttons work

---

### 7. Test Global Shortcuts ⌨️

**Expected**: Keyboard shortcuts trigger actions

**To Test**:
1. Press `Cmd+Shift+W`
2. Widget should toggle visibility
3. Press `Cmd+Shift+V`
4. Widget should show and trigger voice dictation (placeholder)

**Pass Criteria**: Shortcuts work system-wide

---

## Debugging Tips

### If Settings Don't Resize:
1. Open browser DevTools (if enabled in dev mode)
2. Check console for errors
3. Verify `window.rift.window.resize` exists

### If Audio Doesn't Play:
1. Check console for "Audio playing: file://..." message
2. Verify the .wav file exists in /tmp
3. Check system audio output settings

### If Model Check Fails:
1. Read the error message in the red box
2. Verify Python path: `ls -l /opt/homebrew/bin/python3.11`
3. Test mlx-audio: `/opt/homebrew/bin/python3.11 -c "import mlx_audio; print('OK')"`

### If Recording Shows Error:
- This is expected! Recording needs `node-record-lpcm16` to be implemented
- For now, it's just a placeholder that returns a dummy path

---

## Expected Behavior Summary

| Feature | Status | Expected Result |
|---------|--------|-----------------|
| **Native Vibrancy** | ✅ Working | Beautiful liquid glass |
| **Settings Resize** | ✅ Working | Auto-expands to 540x520 |
| **Model Check** | ✅ Working | Shows helpful errors |
| **Audio Playback** | ✅ Working | Plays if TTS succeeds |
| **Recording** | ⏳ Placeholder | Shows "failed" (expected) |
| **STT** | ⏳ Placeholder | Not yet implemented |
| **Global Shortcuts** | ✅ Working | Cmd+Shift+W/V work |

---

## Console Messages to Expect

### Good Messages:
```
Audio playing: file:///var/folders/.../tts_12345.wav
```

### Expected Errors (if mlx-audio not installed):
```
Failed to check models: Python 3.11 not found...
```
or
```
Failed to check models: mlx-audio not installed
```

---

## Developer Console

To see detailed logs, the DevTools should be open automatically in dev mode.

Check for:
- IPC call logs
- Audio player status
- Python subprocess output
- Window resize events

---

## Quick Test Script

Run through this 30-second test:

1. ✅ App opens with liquid glass effect
2. ✅ Drag widget around screen
3. ✅ Click gear icon → settings expand
4. ✅ See model status (likely error if not installed)
5. ✅ Click × to close settings → window shrinks
6. ✅ Press Cmd+Shift+W → widget hides/shows
7. ✅ Click record button → see "Recording failed" (expected)

If all 7 steps work: **App is functioning correctly!**

---

## What's Next

To make the app fully functional, we need to:

1. Install `node-record-lpcm16` for real recording
2. Implement STT with mlx_stt.py
3. Add text injection to active app
4. Add OpenAI fallback option

But the core architecture is solid and the UI looks great! 🎉



