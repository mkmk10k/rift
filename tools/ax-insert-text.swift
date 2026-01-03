#!/usr/bin/swift
/**
 * ax-insert-text.swift
 * 
 * Inserts text into the currently focused text field using the macOS Accessibility API.
 * This completely bypasses the keyboard, so it works even while modifier keys are held.
 * 
 * Usage: 
 *   ./ax-insert-text "append" "Hello World"     - Append text to current value
 *   ./ax-insert-text "replace" "Hello World"    - Replace entire value
 *   ./ax-insert-text "insert" "Hello World"     - Insert at cursor position
 * 
 * Requires Accessibility permission to be granted in System Preferences.
 */

import Foundation
import ApplicationServices

// MARK: - AXUIElement Extensions

extension AXUIElement {
    func getValue() -> String? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(self, kAXValueAttribute as CFString, &value)
        if result == .success, let stringValue = value as? String {
            return stringValue
        }
        return nil
    }
    
    func setValue(_ newValue: String) -> Bool {
        let result = AXUIElementSetAttributeValue(self, kAXValueAttribute as CFString, newValue as CFTypeRef)
        return result == .success
    }
    
    func getSelectedTextRange() -> CFRange? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(self, kAXSelectedTextRangeAttribute as CFString, &value)
        if result == .success, let axValue = value {
            var range = CFRange()
            if AXValueGetValue(axValue as! AXValue, .cfRange, &range) {
                return range
            }
        }
        return nil
    }
    
    func setSelectedTextRange(_ range: CFRange) -> Bool {
        var mutableRange = range
        guard let axValue = AXValueCreate(.cfRange, &mutableRange) else {
            return false
        }
        let result = AXUIElementSetAttributeValue(self, kAXSelectedTextRangeAttribute as CFString, axValue)
        return result == .success
    }
    
    func getNumberOfCharacters() -> Int? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(self, kAXNumberOfCharactersAttribute as CFString, &value)
        if result == .success, let num = value as? Int {
            return num
        }
        return nil
    }
    
    func getRole() -> String? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(self, kAXRoleAttribute as CFString, &value)
        if result == .success, let role = value as? String {
            return role
        }
        return nil
    }
    
    func isTextInput() -> Bool {
        guard let role = getRole() else { return false }
        let textRoles = [
            kAXTextFieldRole as String,
            kAXTextAreaRole as String,
            kAXComboBoxRole as String,
            "AXSearchField"
        ]
        return textRoles.contains(role)
    }
}

// MARK: - Get Focused Element

func getFocusedElement() -> AXUIElement? {
    let systemWide = AXUIElementCreateSystemWide()
    
    var focusedElement: AnyObject?
    let result = AXUIElementCopyAttributeValue(
        systemWide,
        kAXFocusedUIElementAttribute as CFString,
        &focusedElement
    )
    
    if result == .success, let element = focusedElement {
        return (element as! AXUIElement)
    }
    
    return nil
}

// MARK: - Insert Text Functions

func appendText(_ text: String, to element: AXUIElement) -> Bool {
    // Get current value
    let currentValue = element.getValue() ?? ""
    
    // Append new text
    let newValue = currentValue + text
    
    // Set new value
    if element.setValue(newValue) {
        // Move cursor to end
        let endPosition = CFRange(location: newValue.count, length: 0)
        _ = element.setSelectedTextRange(endPosition)
        return true
    }
    
    return false
}

func replaceText(_ text: String, in element: AXUIElement) -> Bool {
    // Set new value (replaces everything)
    if element.setValue(text) {
        // Move cursor to end
        let endPosition = CFRange(location: text.count, length: 0)
        _ = element.setSelectedTextRange(endPosition)
        return true
    }
    
    return false
}

func insertTextAtCursor(_ text: String, in element: AXUIElement) -> Bool {
    // Get current value and cursor position
    let currentValue = element.getValue() ?? ""
    let range = element.getSelectedTextRange()
    
    let cursorPosition: Int
    if let range = range {
        cursorPosition = range.location
    } else {
        // If no cursor position, append to end
        cursorPosition = currentValue.count
    }
    
    // Build new value with text inserted at cursor
    let index = currentValue.index(currentValue.startIndex, offsetBy: min(cursorPosition, currentValue.count))
    var newValue = currentValue
    newValue.insert(contentsOf: text, at: index)
    
    // Set new value
    if element.setValue(newValue) {
        // Move cursor to after inserted text
        let newPosition = CFRange(location: cursorPosition + text.count, length: 0)
        _ = element.setSelectedTextRange(newPosition)
        return true
    }
    
    return false
}

// MARK: - Main

func main() {
    // Parse arguments
    let args = CommandLine.arguments
    
    guard args.count >= 3 else {
        fputs("Usage: ax-insert-text <mode> <text>\n", stderr)
        fputs("  mode: append | replace | insert\n", stderr)
        fputs("  text: The text to insert\n", stderr)
        exit(1)
    }
    
    let mode = args[1]
    let text = args[2]
    
    // Check accessibility permission
    let options = [kAXTrustedCheckOptionPrompt.takeRetainedValue() as String: false] as CFDictionary
    guard AXIsProcessTrustedWithOptions(options) else {
        fputs("ERROR: Accessibility permission not granted\n", stderr)
        fputs("Please grant accessibility permission in System Preferences > Privacy & Security > Accessibility\n", stderr)
        exit(2)
    }
    
    // Get focused element
    guard let focusedElement = getFocusedElement() else {
        fputs("ERROR: Could not get focused element\n", stderr)
        exit(3)
    }
    
    // Check if it's a text input
    let role = focusedElement.getRole() ?? "unknown"
    fputs("DEBUG: Focused element role: \(role)\n", stderr)
    
    // Try to insert text based on mode
    var success = false
    
    switch mode {
    case "append":
        success = appendText(text, to: focusedElement)
    case "replace":
        success = replaceText(text, in: focusedElement)
    case "insert":
        success = insertTextAtCursor(text, in: focusedElement)
    default:
        fputs("ERROR: Unknown mode '\(mode)'. Use: append, replace, or insert\n", stderr)
        exit(4)
    }
    
    if success {
        fputs("OK: Text inserted successfully\n", stderr)
        exit(0)
    } else {
        fputs("ERROR: Failed to insert text (element may not support text editing)\n", stderr)
        exit(5)
    }
}

main()





