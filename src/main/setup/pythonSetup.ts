import { execSync } from 'child_process';
import { app, dialog, BrowserWindow, clipboard, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getSetting, setSetting } from '../services/settings';
import { sendDiagnostics } from '../services/diagnosticsReporter';

/**
 * Collect comprehensive system diagnostics for troubleshooting.
 * This gives users something they can copy/paste when reporting issues.
 */
export function collectDiagnostics(): string {
  const lines: string[] = [];
  
  lines.push('=== RIFT DIAGNOSTICS ===');
  lines.push(`Timestamp: ${new Date().toISOString()}`);
  lines.push(`App Version: ${app.getVersion()}`);
  lines.push(`Packaged: ${app.isPackaged}`);
  lines.push('');
  
  // System info
  lines.push('--- SYSTEM ---');
  lines.push(`macOS: ${os.release()} (${os.arch()})`);
  lines.push(`CPU: ${os.cpus()[0]?.model || 'Unknown'}`);
  lines.push(`RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`);
  lines.push(`Free RAM: ${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`);
  lines.push('');
  
  // Python bundle info
  lines.push('--- PYTHON BUNDLE ---');
  const bundledPath = app.isPackaged
    ? path.join(process.resourcesPath, 'python', 'bin', 'python3.11')
    : path.join(app.getAppPath(), 'python-bundle', 'bin', 'python3.11');
  
  lines.push(`Expected path: ${bundledPath}`);
  lines.push(`Exists: ${fs.existsSync(bundledPath)}`);
  
  if (fs.existsSync(bundledPath)) {
    try {
      const version = execSync(`"${bundledPath}" --version 2>&1`, { timeout: 5000 }).toString().trim();
      lines.push(`Version: ${version}`);
    } catch (e) {
      lines.push(`Version: ERROR - ${e instanceof Error ? e.message : String(e)}`);
    }
    
    // Check each package (use pip show to avoid import which triggers Metal GPU init)
    const packages = ['mlx', 'mlx-lm', 'parakeet-mlx', 'mlx-audio', 'huggingface_hub'];
    lines.push('');
    lines.push('--- PACKAGE STATUS ---');
    for (const pkg of packages) {
      try {
        const output = execSync(`"${bundledPath}" -m pip show ${pkg} 2>/dev/null | grep -E "^Version:"`, {
          timeout: 5000,
          encoding: 'utf-8',
        });
        const version = output.trim().replace('Version: ', '');
        lines.push(`${pkg}: OK (${version})`);
      } catch {
        lines.push(`${pkg}: MISSING/FAILED`);
      }
    }
  }
  lines.push('');
  
  // App paths
  lines.push('--- PATHS ---');
  lines.push(`Resources: ${process.resourcesPath}`);
  lines.push(`User Data: ${app.getPath('userData')}`);
  lines.push(`App Path: ${app.getAppPath()}`);
  lines.push('');
  
  // Settings
  lines.push('--- SETTINGS ---');
  lines.push(`Python Path (cached): ${getSetting('pythonPath') || 'Not set'}`);
  lines.push(`Setup Complete: ${getSetting('setupComplete') || false}`);
  lines.push('');
  
  // Check for common issues
  lines.push('--- ISSUE CHECKS ---');
  
  // Check if running under Rosetta
  try {
    const archCheck = execSync('sysctl -n sysctl.proc_translated 2>/dev/null || echo 0').toString().trim();
    if (archCheck === '1') {
      lines.push('WARNING: Running under Rosetta (x86 translation)');
      lines.push('  MLX requires native ARM - app may not work correctly');
    } else {
      lines.push('Native ARM: OK');
    }
  } catch {
    lines.push('Native ARM: Unable to check');
  }
  
  // Check Gatekeeper quarantine
  if (app.isPackaged) {
    try {
      const appPath = app.getPath('exe').replace('/Contents/MacOS/Rift', '');
      const xattr = execSync(`xattr "${appPath}" 2>&1 || true`).toString();
      if (xattr.includes('com.apple.quarantine')) {
        lines.push('WARNING: App is quarantined by Gatekeeper');
        lines.push('  Run: xattr -cr /Applications/Rift.app');
      } else {
        lines.push('Gatekeeper: OK (not quarantined)');
      }
    } catch {
      lines.push('Gatekeeper: Unable to check');
    }
  }
  
  lines.push('');
  lines.push('=== END DIAGNOSTICS ===');
  
  return lines.join('\n');
}

/**
 * Show error dialog with diagnostics that user can send directly or copy.
 */
async function showErrorWithDiagnostics(
  title: string,
  message: string,
  detail: string
): Promise<void> {
  const diagnostics = collectDiagnostics();
  
  const result = await dialog.showMessageBox({
    type: 'error',
    title,
    message,
    detail: `${detail}\n\nYou can send a diagnostic report directly to the developer, or copy it to clipboard.`,
    buttons: ['Send Report to Mikko', 'Copy Diagnostics', 'OK'],
  });
  
  if (result.response === 0) {
    // Send diagnostics to remote endpoint
    const sendResult = await sendDiagnostics(diagnostics, message);
    
    if (sendResult.success) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Report Sent',
        message: 'Diagnostic report sent successfully!',
        detail: `${sendResult.message || 'Mikko will investigate the issue.'}\n\nReport ID: ${sendResult.id || 'N/A'}`,
        buttons: ['OK'],
      });
    } else {
      // Network failed — fall back to clipboard copy
      clipboard.writeText(diagnostics);
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Could Not Send Report',
        message: 'Unable to send the report automatically.',
        detail: `${sendResult.error || 'Network error'}\n\nDiagnostics have been copied to your clipboard instead. You can paste them into a GitHub issue.`,
        buttons: ['Open GitHub Issues', 'OK'],
      });
    }
  } else if (result.response === 1) {
    clipboard.writeText(diagnostics);
    
    const followUp = await dialog.showMessageBox({
      type: 'info',
      title: 'Diagnostics Copied',
      message: 'Diagnostics copied to clipboard!',
      detail: 'You can paste this into a GitHub issue or send to support.',
      buttons: ['Open GitHub Issues', 'OK'],
    });
    
    if (followUp.response === 0) {
      shell.openExternal('https://github.com/mkmk10k/rift/issues/new');
    }
  }
}

/**
 * Get the path to the bundled Python executable.
 * 
 * In production: The Python bundle is in Resources/python/
 * In development: Falls back to system Python for now
 */
function getBundledPythonPath(): string | null {
  if (app.isPackaged) {
    // Production: use bundled Python
    const bundledPath = path.join(process.resourcesPath, 'python', 'bin', 'python3.11');
    if (fs.existsSync(bundledPath)) {
      return bundledPath;
    }
    console.error('[Python] Bundled Python not found at:', bundledPath);
    return null;
  } else {
    // Development: project root via getAppPath() (stable vs dist/main/main/__dirname depth)
    const devBundlePath = path.join(app.getAppPath(), 'python-bundle', 'bin', 'python3.11');
    if (fs.existsSync(devBundlePath)) {
      return devBundlePath;
    }
    
    // Fall back to system Python for development
    return findSystemPython();
  }
}

/**
 * Fall back to system Python (for development only).
 */
function findSystemPython(): string | null {
  const PYTHON_PATHS = [
    '/opt/homebrew/bin/python3.11',  // Apple Silicon Homebrew
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3.11',     // Intel Homebrew
    '/usr/local/bin/python3',
    '/usr/bin/python3',              // System Python
  ];

  for (const pythonPath of PYTHON_PATHS) {
    if (fs.existsSync(pythonPath)) {
      try {
        const version = execSync(`${pythonPath} --version 2>&1`).toString().trim();
        const match = version.match(/Python (\d+)\.(\d+)/);
        if (match) {
          const major = parseInt(match[1]);
          const minor = parseInt(match[2]);
          if (major >= 3 && minor >= 9) {
            return pythonPath;
          }
        }
      } catch {
        continue;
      }
    }
  }

  // Try which command
  try {
    const whichResult = execSync('which python3').toString().trim();
    if (whichResult && fs.existsSync(whichResult)) {
      return whichResult;
    }
  } catch {
    // Ignore
  }

  return null;
}

/**
 * In dev, electron-store may still point at a installed Rift.app bundle from a prior
 * packaged run — that interpreter can lag repo code (e.g. mlx-lm without Gemma4).
 */
function isDevPythonPathFromPackagedRiftInstall(p: string): boolean {
  return /\/Applications\/Rift\.app\//i.test(p);
}

/**
 * Get the Python path to use for the app.
 * In production: ALWAYS use bundled Python (ignore cache)
 * In development: Use cache or find system Python
 */
export function findPythonPath(): string | null {
  // In production, ALWAYS use bundled Python - ignore any cached settings
  if (app.isPackaged) {
    const bundledPath = getBundledPythonPath();
    if (bundledPath) {
      // Update cache to bundled path (clears any old system Python path)
      setSetting('pythonPath', bundledPath);
      return bundledPath;
    }
    // Bundled Python missing in production - critical error
    console.error('[Python] Bundled Python not found in packaged app');
    return null;
  }

  // Development: prefer repo python-bundle when present (reliable mlx for evals / dev)
  const bundleOrSystem = getBundledPythonPath();
  if (
    bundleOrSystem &&
    bundleOrSystem.includes(`${path.sep}python-bundle${path.sep}`)
  ) {
    setSetting('pythonPath', bundleOrSystem);
    return bundleOrSystem;
  }

  // Development: optional cached path (never use another app's bundle)
  const cachedPath = getSetting('pythonPath');
  if (cachedPath && isDevPythonPathFromPackagedRiftInstall(cachedPath)) {
    console.log('[Python] Ignoring cached pythonPath from packaged install in dev:', cachedPath);
    setSetting('pythonPath', null);
  } else if (cachedPath && fs.existsSync(cachedPath)) {
    return cachedPath;
  }

  if (bundleOrSystem) {
    setSetting('pythonPath', bundleOrSystem);
  }

  return bundleOrSystem;
}

/**
 * Check if core MLX dependencies for STT are installed.
 * With bundled Python, this should always return true.
 */
export function checkMLXInstalled(pythonPath: string): boolean {
  try {
    execSync(`"${pythonPath}" -c "import mlx; import parakeet_mlx"`, {
      timeout: 10000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if LLM dependencies are installed.
 * With bundled Python, this should always return true.
 */
export function checkLLMInstalled(pythonPath: string): boolean {
  try {
    execSync(`"${pythonPath}" -c "import mlx_lm"`, {
      timeout: 10000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if TTS dependencies are installed.
 * With bundled Python, this should always return true.
 */
export function checkTTSInstalled(pythonPath: string): boolean {
  try {
    execSync(`"${pythonPath}" -c "import mlx_audio"`, {
      timeout: 10000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run setup check on app startup.
 * 
 * With bundled Python, this is simplified:
 * - In production: Just verify bundled Python exists and works
 * - In development: Check for system Python and optionally prompt to install deps
 */
export async function runSetupCheck(mainWindow: BrowserWindow | null): Promise<boolean> {
  // Skip if setup already complete
  if (getSetting('setupComplete')) {
    const pythonPath = findPythonPath();
    if (pythonPath && checkMLXInstalled(pythonPath)) {
      return true;
    }
    // Reset if something changed
    setSetting('setupComplete', false);
  }

  console.log('[Setup] Running first-launch setup check...');

  // Find Python (bundled in production, system in development)
  const pythonPath = findPythonPath();
  
  if (!pythonPath) {
    // This should only happen in development if no system Python found
    if (!app.isPackaged) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Python Not Found',
        message: 'Development mode requires Python 3.9+',
        detail: 'Please install Python using Homebrew:\n\nbrew install python@3.11\n\nThen restart the app.',
        buttons: ['OK'],
      });
      return false;
    }
    
    // In production, this means the bundled Python is missing - critical error
    console.error('[Setup] CRITICAL: Bundled Python not found!');
    await showErrorWithDiagnostics(
      'Installation Issue',
      'Required components are missing.',
      'The bundled Python runtime was not found. This usually means the app installation is incomplete or corrupted.\n\nPlease re-download Rift from myrift.dev.'
    );
    return false;
  }

  console.log(`[Setup] Using Python at: ${pythonPath}`);

  // Verify MLX dependencies
  if (checkMLXInstalled(pythonPath)) {
    console.log('[Setup] All dependencies verified - Python is ready');
    // NOTE: Don't set setupComplete here - let the setup wizard do that
    // This function just verifies Python is usable
    return true;
  }

  // Dependencies not found - this shouldn't happen with bundled Python
  if (app.isPackaged) {
    console.error('[Setup] CRITICAL: Bundled Python is missing MLX dependencies!');
    await showErrorWithDiagnostics(
      'Installation Issue', 
      'Machine learning components failed to load.',
      'The bundled MLX packages could not be imported. This may indicate:\n\n• Corrupted installation\n• Running on Intel Mac (MLX requires Apple Silicon)\n• System security blocking access'
    );
    return false;
  }

  // Development only: offer to install dependencies
  console.log('[Setup] Development mode - dependencies not installed');
  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'Development Setup',
    message: 'MLX dependencies need to be installed.',
    detail: 'Run one of these commands:\n\n• bun run bundle:python  (recommended)\n• pip3 install -r python/requirements.txt',
    buttons: ['OK', 'Quit'],
  });

  if (result.response === 1) {
    return false;
  }

  // Let them continue anyway (they might have just installed)
  return checkMLXInstalled(pythonPath);
}
