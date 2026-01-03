#!/usr/bin/swift
/**
 * switch-input.swift
 * 
 * CLI tool to switch macOS input sources programmatically.
 * Used by Outloud to automatically switch to Outloud Input
 * when dictation starts, and switch back when it ends.
 * 
 * Usage:
 *   ./switch-input --get                    - Print current input source ID
 *   ./switch-input --to <source-id>         - Switch to specified input source
 *   ./switch-input --list                   - List all enabled input sources
 *   ./switch-input --to-outloud             - Switch to Outloud Input
 * 
 * Exit codes:
 *   0 - Success
 *   1 - Invalid arguments
 *   2 - Input source not found
 *   3 - Switch failed
 */

import Carbon
import Foundation

// MARK: - Input Source Helpers

func getCurrentInputSourceID() -> String? {
    guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else {
        return nil
    }
    guard let idPtr = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
        return nil
    }
    return Unmanaged<CFString>.fromOpaque(idPtr).takeUnretainedValue() as String
}

func getEnabledInputSources() -> [(id: String, name: String)] {
    var result: [(id: String, name: String)] = []
    
    // Get only keyboard input sources that are enabled and can be selected
    let properties: [CFString: Any] = [
        kTISPropertyInputSourceCategory: kTISCategoryKeyboardInputSource,
        kTISPropertyInputSourceIsSelectCapable: true,
        kTISPropertyInputSourceIsEnabled: true
    ]
    
    guard let sourceList = TISCreateInputSourceList(properties as CFDictionary, false)?.takeRetainedValue() as? [TISInputSource] else {
        return result
    }
    
    for source in sourceList {
        guard let idPtr = TISGetInputSourceProperty(source, kTISPropertyInputSourceID),
              let namePtr = TISGetInputSourceProperty(source, kTISPropertyLocalizedName) else {
            continue
        }
        
        let id = Unmanaged<CFString>.fromOpaque(idPtr).takeUnretainedValue() as String
        let name = Unmanaged<CFString>.fromOpaque(namePtr).takeUnretainedValue() as String
        result.append((id: id, name: name))
    }
    
    return result
}

func switchToInputSource(id: String) -> Bool {
    // Get all selectable input sources
    let properties: [CFString: Any] = [
        kTISPropertyInputSourceCategory: kTISCategoryKeyboardInputSource,
        kTISPropertyInputSourceIsSelectCapable: true
    ]
    
    guard let sourceList = TISCreateInputSourceList(properties as CFDictionary, false)?.takeRetainedValue() as? [TISInputSource] else {
        fputs("Error: Could not get input source list\n", stderr)
        return false
    }
    
    for source in sourceList {
        guard let idPtr = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
            continue
        }
        let sourceID = Unmanaged<CFString>.fromOpaque(idPtr).takeUnretainedValue() as String
        
        if sourceID == id {
            let result = TISSelectInputSource(source)
            if result == noErr {
                return true
            } else {
                fputs("Error: TISSelectInputSource failed with code \(result)\n", stderr)
                return false
            }
        }
    }
    
    fputs("Error: Input source '\(id)' not found\n", stderr)
    return false
}

func enableInputSource(id: String) -> Bool {
    // Get all input sources (including disabled)
    let properties: [CFString: Any] = [
        kTISPropertyInputSourceCategory: kTISCategoryKeyboardInputSource
    ]
    
    guard let sourceList = TISCreateInputSourceList(properties as CFDictionary, true)?.takeRetainedValue() as? [TISInputSource] else {
        return false
    }
    
    for source in sourceList {
        guard let idPtr = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
            continue
        }
        let sourceID = Unmanaged<CFString>.fromOpaque(idPtr).takeUnretainedValue() as String
        
        if sourceID == id {
            let result = TISEnableInputSource(source)
            return result == noErr
        }
    }
    
    return false
}

// MARK: - Main

let args = Array(CommandLine.arguments.dropFirst())

if args.isEmpty {
    fputs("Usage: switch-input [--get|--list|--to <id>|--to-outloud]\n", stderr)
    exit(1)
}

switch args[0] {
case "--get":
    if let currentID = getCurrentInputSourceID() {
        print(currentID)
        exit(0)
    } else {
        fputs("Error: Could not get current input source\n", stderr)
        exit(3)
    }
    
case "--list":
    let sources = getEnabledInputSources()
    for source in sources {
        print("\(source.id)\t\(source.name)")
    }
    exit(0)
    
case "--to":
    guard args.count > 1 else {
        fputs("Error: Missing input source ID\n", stderr)
        exit(1)
    }
    let targetID = args[1]
    if switchToInputSource(id: targetID) {
        print("OK: Switched to \(targetID)")
        exit(0)
    } else {
        exit(2)
    }
    
case "--to-outloud":
    let outloudID = "sh.outloud.inputmethod.outloud"
    
    // First try to switch
    if switchToInputSource(id: outloudID) {
        print("OK: Switched to Outloud Input")
        exit(0)
    }
    
    // If not found, try to enable it first
    fputs("Attempting to enable Outloud Input...\n", stderr)
    if enableInputSource(id: outloudID) {
        // Small delay for system to register
        usleep(100000) // 100ms
        if switchToInputSource(id: outloudID) {
            print("OK: Enabled and switched to Outloud Input")
            exit(0)
        }
    }
    
    fputs("Error: Outloud Input not found. Please enable it in System Preferences > Keyboard > Input Sources\n", stderr)
    exit(2)
    
default:
    fputs("Unknown option: \(args[0])\n", stderr)
    fputs("Usage: switch-input [--get|--list|--to <id>|--to-outloud]\n", stderr)
    exit(1)
}


