#!/bin/bash
# Build script for RiftInput input method
# Creates RiftInput.app bundle

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_NAME="RiftInput"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"

echo "Building RiftInput input method..."

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Create app bundle structure
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

# Copy Info.plist
cp "$SCRIPT_DIR/RiftInput/Info.plist" "$APP_BUNDLE/Contents/"

# Compile Swift code
echo "Compiling Swift code..."
swiftc \
    -o "$APP_BUNDLE/Contents/MacOS/$APP_NAME" \
    -framework Cocoa \
    -framework InputMethodKit \
    -framework Carbon \
    -target arm64-apple-macos12.0 \
    -parse-as-library \
    -O \
    "$SCRIPT_DIR/RiftInput/main.swift"

# Also compile for x86_64 if needed (universal binary)
# swiftc \
#     -o "$BUILD_DIR/${APP_NAME}_x86" \
#     -framework Cocoa \
#     -framework InputMethodKit \
#     -framework Carbon \
#     -target x86_64-apple-macos12.0 \
#     -O \
#     "$SCRIPT_DIR/RiftInput/main.swift"
# lipo -create "$APP_BUNDLE/Contents/MacOS/$APP_NAME" "$BUILD_DIR/${APP_NAME}_x86" -output "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

# Create PkgInfo
echo "APPL????" > "$APP_BUNDLE/Contents/PkgInfo"

# Sign the app (ad-hoc signing for development)
echo "Signing app bundle..."
codesign --force --deep --sign - "$APP_BUNDLE"

echo ""
echo "Build complete: $APP_BUNDLE"
echo ""
echo "To install:"
echo "  1. Copy to ~/Library/Input Methods/:"
echo "     cp -R \"$APP_BUNDLE\" ~/Library/Input\ Methods/"
echo ""
echo "  2. Log out and log back in, or run:"
echo "     killall SystemUIServer"
echo ""
echo "  3. Enable in System Preferences -> Keyboard -> Input Sources"
echo "     Click '+', find 'Rift Input' under English"
