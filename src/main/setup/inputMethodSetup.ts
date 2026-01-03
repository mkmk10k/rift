/**
 * Input Method Setup Module
 * 
 * Handles installation and configuration of the OutloudInput input method
 * which enables live text injection into any macOS app.
 */

import { app, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn } from 'child_process';

const INPUT_METHOD_NAME = 'OutloudInput.app';
const INPUT_METHOD_BUNDLE_ID = 'sh.outloud.inputmethod';
const INPUT_METHOD_SOURCE_ID = 'sh.outloud.inputmethod.outloud';

/**
 * Get the path where input methods should be installed
 */
function getInputMethodsDir(): string {
  return path.join(app.getPath('home'), 'Library', 'Input Methods');
}

/**
 * Get the path to the installed input method
 */
function getInstalledInputMethodPath(): string {
  return path.join(getInputMethodsDir(), INPUT_METHOD_NAME);
}

/**
 * Get the path to the bundled input method in app resources
 */
function getBundledInputMethodPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'input-method', INPUT_METHOD_NAME);
  }
  return path.join(app.getAppPath(), 'input-method', 'build', INPUT_METHOD_NAME);
}

/**
 * Check if the input method is installed
 */
export function isInputMethodInstalled(): boolean {
  const installedPath = getInstalledInputMethodPath();
  return fs.existsSync(installedPath);
}

/**
 * Check if the input method is enabled in System Preferences
 */
export function isInputMethodEnabled(): boolean {
  try {
    // Use TISCreateInputSourceList to check enabled input sources
    const result = execSync(
      `defaults read ~/Library/Preferences/com.apple.HIToolbox.plist AppleEnabledInputSources 2>/dev/null || echo "[]"`,
      { encoding: 'utf-8' }
    );
    
    // Check if our input method is in the enabled list
    return result.includes(INPUT_METHOD_BUNDLE_ID) || result.includes(INPUT_METHOD_SOURCE_ID);
  } catch (e) {
    console.log('[InputMethod] Could not check if enabled:', e);
    return false;
  }
}

/**
 * Install the input method by copying to ~/Library/Input Methods/
 */
export async function installInputMethod(): Promise<{ success: boolean; error?: string }> {
  const sourcePath = getBundledInputMethodPath();
  const destPath = getInstalledInputMethodPath();
  const inputMethodsDir = getInputMethodsDir();
  
  console.log('[InputMethod] Installing from:', sourcePath);
  console.log('[InputMethod] Installing to:', destPath);
  
  // Check if source exists
  if (!fs.existsSync(sourcePath)) {
    return { 
      success: false, 
      error: `Input method bundle not found at ${sourcePath}` 
    };
  }
  
  try {
    // Create Input Methods directory if it doesn't exist
    if (!fs.existsSync(inputMethodsDir)) {
      fs.mkdirSync(inputMethodsDir, { recursive: true });
    }
    
    // Remove existing installation if present
    if (fs.existsSync(destPath)) {
      fs.rmSync(destPath, { recursive: true, force: true });
    }
    
    // Copy the app bundle
    // Use cp -R to preserve app bundle structure
    execSync(`cp -R "${sourcePath}" "${destPath}"`);
    
    console.log('[InputMethod] Installed successfully');
    
    // Notify the system about new input method
    // This helps macOS discover it without requiring logout
    try {
      execSync('killall -HUP SystemUIServer 2>/dev/null || true');
    } catch (e) {
      // Not critical if this fails
    }
    
    return { success: true };
  } catch (error: any) {
    console.error('[InputMethod] Installation failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Open System Preferences to the Input Sources pane
 */
export function openInputSourceSettings(): void {
  // macOS 13+ uses System Settings, older versions use System Preferences
  shell.openExternal('x-apple.systempreferences:com.apple.Keyboard-Settings.extension?InputSources');
}

/**
 * Get the status of the input method
 */
export function getInputMethodStatus(): {
  installed: boolean;
  enabled: boolean;
  bundleExists: boolean;
} {
  return {
    installed: isInputMethodInstalled(),
    enabled: isInputMethodEnabled(),
    bundleExists: fs.existsSync(getBundledInputMethodPath())
  };
}

/**
 * Inject text using the input method via distributed notification
 * Falls back to the inject-text CLI tool
 */
export async function injectTextViaInputMethod(
  text: string, 
  mode: 'replace' | 'append' = 'replace'
): Promise<{ success: boolean; error?: string }> {
  const toolPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'inject-text')
    : path.join(app.getAppPath(), 'tools', 'inject-text');
  
  if (!fs.existsSync(toolPath)) {
    return { success: false, error: 'inject-text tool not found' };
  }
  
  return new Promise((resolve) => {
    const args = mode === 'append' ? ['--append', text] : ['--replace', text];
    const proc = spawn(toolPath, args);
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr || `Exit code ${code}` });
      }
    });
    
    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
    
    // Timeout after 5 seconds
    setTimeout(() => {
      proc.kill();
      resolve({ success: false, error: 'Timeout' });
    }, 5000);
  });
}

/**
 * Clear the accumulated text state in the input method
 */
export async function clearInputMethodText(): Promise<void> {
  const toolPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'inject-text')
    : path.join(app.getAppPath(), 'tools', 'inject-text');
  
  if (fs.existsSync(toolPath)) {
    try {
      execSync(`"${toolPath}" --clear`, { timeout: 2000 });
    } catch (e) {
      console.warn('[InputMethod] Clear failed:', e);
    }
  }
}

/**
 * Send Enter key via the input method
 */
export async function sendEnterViaInputMethod(): Promise<{ success: boolean; error?: string }> {
  const toolPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'inject-text')
    : path.join(app.getAppPath(), 'tools', 'inject-text');
  
  if (!fs.existsSync(toolPath)) {
    return { success: false, error: 'inject-text tool not found' };
  }
  
  try {
    execSync(`"${toolPath}" --enter`, { timeout: 2000 });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}


