#!/usr/bin/swift
/**
 * type-text.swift
 * 
 * Types text using CGEvent with explicit modifier flags set to 0.
 * This allows typing even while modifier keys (Cmd, Shift, etc.) are physically held.
 * 
 * Usage: ./type-text "Hello World"
 */

import Foundation
import CoreGraphics

// Get text from command line argument
guard CommandLine.arguments.count > 1 else {
    fputs("Usage: type-text <text>\n", stderr)
    exit(1)
}

let text = CommandLine.arguments[1]

// Small delay to let things settle
usleep(20000) // 20ms

// Create an event source with a custom state ID to avoid inheriting modifier state
let eventSource = CGEventSource(stateID: .privateState)

// Type each character using CGEvent
for char in text {
    let charString = String(char)
    var utf16Chars = Array(charString.utf16)
    
    // Create key down event with our private event source
    guard let keyDown = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true) else {
        fputs("Failed to create keyDown event\n", stderr)
        continue
    }
    
    // Create key up event
    guard let keyUp = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false) else {
        fputs("Failed to create keyUp event\n", stderr)
        continue
    }
    
    // CRITICAL: Explicitly set flags to empty (no modifiers)
    // This clears any modifier state that might have been inherited
    keyDown.flags = []
    keyUp.flags = []
    
    // Set the Unicode character to type
    keyDown.keyboardSetUnicodeString(stringLength: utf16Chars.count, unicodeString: &utf16Chars)
    keyUp.keyboardSetUnicodeString(stringLength: utf16Chars.count, unicodeString: &utf16Chars)
    
    // Post to HID event tap (lower level, more reliable)
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
    
    // Small delay between characters
    usleep(2000) // 2ms
}

// Final delay
usleep(10000) // 10ms

print("OK: Typed \(text.count) characters")
