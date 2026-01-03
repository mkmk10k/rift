/**
 * Hold-to-Talk Keyboard Handler
 * Uses uiohook-napi for native key up/down detection
 * Detects ⌘⇧S (Cmd+Shift+S) hold and release
 * 
 * LAZY LOADING: uiohook-napi is only loaded when hold mode is enabled
 * This prevents crashes from native module issues when not needed
 */

import { BrowserWindow } from 'electron';

// Lazy-loaded uiohook module
let uIOhook: any = null;
let UiohookKey: any = null;

let isHoldToTalkEnabled = false;
let isHolding = false;
let mainWindow: BrowserWindow | null = null;
let isHookRunning = false;
let isInitialized = false;

// Track pressed keys
const pressedKeys = new Set<number>();

/**
 * Lazily load the uiohook module
 * Returns true if successful, false if failed
 */
function loadUiohook(): boolean {
  if (uIOhook !== null) {
    return true; // Already loaded
  }
  
  try {
    const uiohookModule = require('uiohook-napi');
    uIOhook = uiohookModule.uIOhook;
    UiohookKey = uiohookModule.UiohookKey;
    console.log('[HoldToTalk] uiohook-napi loaded successfully');
    return true;
  } catch (error) {
    console.error('[HoldToTalk] Failed to load uiohook-napi:', error);
    return false;
  }
}

/**
 * Check if the hold-to-talk combo is pressed (Cmd+Shift+S)
 */
function isHoldToTalkCombo(): boolean {
  if (!UiohookKey) return false;
  return pressedKeys.has(UiohookKey.Meta) && 
         pressedKeys.has(UiohookKey.Shift) && 
         pressedKeys.has(UiohookKey.S);
}

/**
 * Set up event handlers for the hook
 */
function setupEventHandlers(): void {
  if (!uIOhook || isInitialized) return;
  
  uIOhook.on('keydown', (e: any) => {
    if (!isHoldToTalkEnabled) return;
    
    pressedKeys.add(e.keycode);
    
    // Check if hold-to-talk combo just activated
    if (isHoldToTalkCombo() && !isHolding) {
      isHolding = true;
      console.log('[HoldToTalk] Started - ⌘⇧S held');
      
      if (mainWindow) {
        mainWindow.showInactive();
        mainWindow.webContents.send('hold-to-talk:start');
      }
    }
  });
  
  uIOhook.on('keyup', (e: any) => {
    if (!isHoldToTalkEnabled) return;
    
    const wasHolding = isHolding;
    pressedKeys.delete(e.keycode);
    
    // Check if any key of the combo was released while holding
    if (wasHolding && !isHoldToTalkCombo()) {
      isHolding = false;
      console.log('[HoldToTalk] Released - ⌘⇧S released, stopping recording');
      
      if (mainWindow) {
        mainWindow.webContents.send('hold-to-talk:stop');
      }
    }
  });
  
  isInitialized = true;
  console.log('[HoldToTalk] Event handlers registered');
}

/**
 * Initialize the hold-to-talk keyboard hook
 * NOTE: Does NOT load uiohook until setHoldToTalkEnabled(true) is called
 */
export function initHoldToTalk(window: BrowserWindow): void {
  mainWindow = window;
  console.log('[HoldToTalk] Initialized (lazy mode - hook will load when enabled)');
}

/**
 * Start the keyboard hook
 */
export function startHook(): void {
  if (isHookRunning) return;
  
  if (!uIOhook) {
    if (!loadUiohook()) {
      console.error('[HoldToTalk] Cannot start hook - uiohook failed to load');
      return;
    }
    setupEventHandlers();
  }
  
  try {
    uIOhook.start();
    isHookRunning = true;
    console.log('[HoldToTalk] Hook started');
  } catch (error) {
    console.error('[HoldToTalk] Failed to start hook:', error);
  }
}

/**
 * Stop the keyboard hook
 */
export function stopHook(): void {
  if (!isHookRunning || !uIOhook) return;
  
  try {
    uIOhook.stop();
    isHookRunning = false;
    pressedKeys.clear();
    isHolding = false;
    console.log('[HoldToTalk] Hook stopped');
  } catch (error) {
    console.error('[HoldToTalk] Failed to stop hook:', error);
  }
}

/**
 * Enable or disable hold-to-talk mode
 */
export function setHoldToTalkEnabled(enabled: boolean): void {
  isHoldToTalkEnabled = enabled;
  console.log('[HoldToTalk] Mode:', enabled ? 'enabled' : 'disabled');
  
  if (enabled) {
    startHook();
  } else {
    // Stop the hook when disabled to save CPU resources
    stopHook();
  }
}

/**
 * Check if hold-to-talk is currently enabled
 */
export function isHoldToTalkMode(): boolean {
  return isHoldToTalkEnabled;
}
