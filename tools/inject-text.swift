#!/usr/bin/swift
/**
 * inject-text.swift
 * 
 * CLI tool to send text to the OutloudInput input method via distributed notifications.
 * This allows Outloud (Electron app) to inject text into any focused text field.
 * 
 * Usage:
 *   ./inject-text "Hello World"              - Replace mode (default)
 *   ./inject-text --replace "Hello World"    - Replace accumulated text
 *   ./inject-text --append "more text"       - Append to existing text
 *   ./inject-text --clear                    - Clear accumulated text state
 *   ./inject-text --enter                    - Send Enter key
 * 
 * Exit codes:
 *   0 - Success
 *   1 - Invalid arguments
 * 
 * NOTE: Distributed notifications do NOT pass userInfo across processes!
 * We encode the text as base64 in the `object` parameter instead.
 * Format: "mode:base64text"
 */

import Foundation

// Parse arguments
let args = Array(CommandLine.arguments.dropFirst())

if args.isEmpty {
    fputs("Usage: inject-text [--replace|--append|--clear|--enter] <text>\n", stderr)
    exit(1)
}

let notificationCenter = DistributedNotificationCenter.default()

// Handle special commands
if args[0] == "--clear" {
    notificationCenter.postNotificationName(
        NSNotification.Name("sh.outloud.clearText"),
        object: nil,
        userInfo: nil,
        deliverImmediately: true
    )
    print("OK: Cleared text state")
    exit(0)
}

if args[0] == "--enter" {
    notificationCenter.postNotificationName(
        NSNotification.Name("sh.outloud.sendEnter"),
        object: nil,
        userInfo: nil,
        deliverImmediately: true
    )
    print("OK: Sent Enter key")
    exit(0)
}

// Parse mode and text
var mode = "replace"
var text = ""

if args[0] == "--replace" {
    mode = "replace"
    text = args.dropFirst().joined(separator: " ")
} else if args[0] == "--append" {
    mode = "append"
    text = args.dropFirst().joined(separator: " ")
} else {
    // Default: replace mode with all args as text
    text = args.joined(separator: " ")
}

if text.isEmpty {
    fputs("Error: No text provided\n", stderr)
    exit(1)
}

// Encode text as base64 to safely pass via notification object
// Format: "mode:base64text"
guard let textData = text.data(using: .utf8) else {
    fputs("Error: Could not encode text\n", stderr)
    exit(1)
}
let base64Text = textData.base64EncodedString()
let payload = "\(mode):\(base64Text)"

// Send the notification with payload in the object parameter
// (userInfo is NOT delivered across process boundaries!)
notificationCenter.postNotificationName(
    NSNotification.Name("sh.outloud.injectText"),
    object: payload,
    userInfo: nil,
    deliverImmediately: true
)

print("OK: Sent '\(text.prefix(50))...' in \(mode) mode")
exit(0)


