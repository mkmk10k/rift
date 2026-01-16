/**
 * OutloudInput - macOS Input Method for Live Text Injection
 * 
 * This input method allows Outloud to inject transcribed text
 * into ANY focused text field, including Electron apps and browsers.
 * 
 * It works by:
 * 1. Running as a background input method service
 * 2. Listening for distributed notifications from Outloud
 * 3. Using IMKInputController's client to insert text
 */

import Cocoa
import InputMethodKit

// MARK: - App Delegate

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    var server: IMKServer!
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Create the input method server
        server = IMKServer(
            name: "OutloudInput",
            bundleIdentifier: Bundle.main.bundleIdentifier!
        )
        
        // Listen for text injection requests from Outloud
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(handleInjectText(_:)),
            name: NSNotification.Name("sh.outloud.injectText"),
            object: nil,
            suspensionBehavior: .deliverImmediately
        )
        
        // Listen for clear text requests
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(handleClearText(_:)),
            name: NSNotification.Name("sh.outloud.clearText"),
            object: nil,
            suspensionBehavior: .deliverImmediately
        )
        
        // Listen for Enter key simulation requests
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(handleSendEnter(_:)),
            name: NSNotification.Name("sh.outloud.sendEnter"),
            object: nil,
            suspensionBehavior: .deliverImmediately
        )
        
        NSLog("[OutloudInput] Input method started and listening for notifications")
    }
    
    @objc func handleInjectText(_ notification: Notification) {
        // NOTE: userInfo is NOT delivered across process boundaries!
        // We receive the payload in the `object` parameter instead.
        // Format: "mode:base64text"
        guard let payload = notification.object as? String else {
            NSLog("[OutloudInput] Invalid notification - missing payload")
            return
        }
        
        // Parse the payload
        let parts = payload.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else {
            NSLog("[OutloudInput] Invalid payload format")
            return
        }
        
        let mode = String(parts[0])
        let base64Text = String(parts[1])
        
        // Decode the base64 text
        guard let textData = Data(base64Encoded: base64Text),
              let text = String(data: textData, encoding: .utf8) else {
            NSLog("[OutloudInput] Could not decode base64 text")
            return
        }
        
        NSLog("[OutloudInput] Received inject request: mode=\(mode), text=\(text.prefix(50))...")
        
        // Post to main thread to ensure UI operations work
        DispatchQueue.main.async {
            OutloudInputController.injectText(text, mode: mode)
        }
    }
    
    @objc func handleClearText(_ notification: Notification) {
        NSLog("[OutloudInput] Received clear request")
        DispatchQueue.main.async {
            OutloudInputController.clearText()
        }
    }
    
    @objc func handleSendEnter(_ notification: Notification) {
        NSLog("[OutloudInput] Received send Enter request")
        DispatchQueue.main.async {
            OutloudInputController.sendEnter()
        }
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        NSLog("[OutloudInput] Input method shutting down")
    }
}

// MARK: - Input Controller

class OutloudInputController: IMKInputController {
    
    // Static reference to the current active client
    private static var currentClient: IMKTextInput?
    private static var accumulatedText: String = ""
    
    override init!(server: IMKServer!, delegate: Any!, client inputClient: Any!) {
        super.init(server: server, delegate: delegate, client: inputClient)
        
        if let client = inputClient as? IMKTextInput {
            OutloudInputController.currentClient = client
            NSLog("[OutloudInput] Client connected: \(type(of: inputClient))")
        }
    }
    
    override func activateServer(_ sender: Any!) {
        super.activateServer(sender)
        if let client = sender as? IMKTextInput {
            OutloudInputController.currentClient = client
            NSLog("[OutloudInput] Server activated for client")
        }
    }
    
    override func deactivateServer(_ sender: Any!) {
        super.deactivateServer(sender)
        NSLog("[OutloudInput] Server deactivated")
    }
    
    // Pass through all keyboard events - we don't intercept typing
    override func handle(_ event: NSEvent!, client sender: Any!) -> Bool {
        // Return false to let the event pass through to the app
        // We only inject text via distributed notifications
        return false
    }
    
    // MARK: - Text Injection
    
    static func injectText(_ text: String, mode: String) {
        guard let client = currentClient else {
            NSLog("[OutloudInput] No active client to inject text into")
            // Try to get client from current input context
            if let context = NSTextInputContext.current,
               let activeClient = context.client as? IMKTextInput {
                NSLog("[OutloudInput] Found client via NSTextInputContext")
                insertIntoClient(activeClient, text: text, mode: mode)
            }
            return
        }
        
        insertIntoClient(client, text: text, mode: mode)
    }
    
    private static func insertIntoClient(_ client: IMKTextInput, text: String, mode: String) {
        if mode == "replace" {
            // Replace mode: Clear previous accumulated text and insert new
            // First, select all accumulated text and delete it
            if !accumulatedText.isEmpty {
                let deleteLength = accumulatedText.count
                let range = NSRange(location: NSNotFound, length: deleteLength)
                // Select the text we previously inserted
                client.setMarkedText("", selectionRange: NSRange(location: 0, length: 0), replacementRange: range)
            }
            
            // Insert the complete new text
            client.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
            accumulatedText = text
            NSLog("[OutloudInput] Replaced text, new length: \(text.count)")
        } else {
            // Append mode: Just insert the new text at cursor
            client.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
            accumulatedText += text
            NSLog("[OutloudInput] Appended text: \(text)")
        }
    }
    
    static func clearText() {
        accumulatedText = ""
        NSLog("[OutloudInput] Cleared accumulated text")
    }
    
    static func sendEnter() {
        // Simulate Enter key press using CGEvent
        // This works even after text insertion
        let source = CGEventSource(stateID: .hidSystemState)
        
        // Key code 36 is Return/Enter
        if let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0x24, keyDown: true) {
            keyDown.flags = []  // No modifiers
            keyDown.post(tap: .cghidEventTap)
        }
        
        if let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0x24, keyDown: false) {
            keyUp.flags = []
            keyUp.post(tap: .cghidEventTap)
        }
        
        NSLog("[OutloudInput] Sent Enter key")
    }
}


