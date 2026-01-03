#!/usr/bin/swift
/**
 * paste-text.swift
 * 
 * Pastes text using AppleScript which is more reliable for cross-app pasting.
 * Sets clipboard and uses System Events to paste.
 * 
 * Usage: ./paste-text "Hello World"
 */

import AppKit
import Foundation

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: paste-text <text>\n", stderr)
    exit(1)
}

let text = CommandLine.arguments[1]

// Copy text to clipboard
let pasteboard = NSPasteboard.general
pasteboard.clearContents()
pasteboard.setString(text, forType: .string)

// Small delay to ensure clipboard is ready
usleep(20000) // 20ms

// Use AppleScript to paste - this is more reliable than CGEvent
let script = """
tell application "System Events"
    keystroke "v" using command down
end tell
"""

var error: NSDictionary?
if let appleScript = NSAppleScript(source: script) {
    appleScript.executeAndReturnError(&error)
    if let error = error {
        fputs("AppleScript error: \(error)\n", stderr)
        exit(1)
    }
}

usleep(10000) // 10ms after paste

print("OK: Pasted \(text.count) characters")

