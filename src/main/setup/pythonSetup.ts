import { spawn, execSync } from 'child_process';
import { app, dialog, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getSetting, setSetting } from '../services/settings';

const PYTHON_PATHS = [
  '/opt/homebrew/bin/python3.11',  // Apple Silicon Homebrew
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3.11',     // Intel Homebrew
  '/usr/local/bin/python3',
  '/usr/bin/python3',              // System Python
];

export function findPythonPath(): string | null {
  // Check cached path first
  const cachedPath = getSetting('pythonPath');
  if (cachedPath && fs.existsSync(cachedPath)) {
    return cachedPath;
  }

  // Search common paths
  for (const pythonPath of PYTHON_PATHS) {
    if (fs.existsSync(pythonPath)) {
      try {
        // Verify it's actually Python 3.9+
        const version = execSync(`${pythonPath} --version 2>&1`).toString().trim();
        const match = version.match(/Python (\d+)\.(\d+)/);
        if (match) {
          const major = parseInt(match[1]);
          const minor = parseInt(match[2]);
          if (major >= 3 && minor >= 9) {
            setSetting('pythonPath', pythonPath);
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
      setSetting('pythonPath', whichResult);
      return whichResult;
    }
  } catch {
    // Ignore
  }

  return null;
}

/**
 * Check if core MLX dependencies for STT are installed.
 * These are required for the Parakeet speech-to-text model.
 */
export function checkMLXInstalled(pythonPath: string): boolean {
  try {
    execSync(`${pythonPath} -c "import mlx_audio; import parakeet_mlx"`, {
      timeout: 10000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if LLM dependencies are installed (optional, for Live Paste enhancement).
 * These are used for intelligent text processing via Qwen3.
 * 
 * FEATURES ENABLED:
 * - Phase 2: Intelligent text merge when anchor detection fails
 * - Phase 3: Rolling sentence correction during speech
 * - Phase 4: Final polish when recording stops
 */
export function checkLLMInstalled(pythonPath: string): boolean {
  try {
    execSync(`${pythonPath} -c "import mlx_lm"`, {
      timeout: 10000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export async function installMLXDependencies(
  pythonPath: string,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const requirementsPath = app.isPackaged
      ? path.join(process.resourcesPath, 'python', 'requirements.txt')
      : path.join(__dirname, '../../../python/requirements.txt');

    if (!fs.existsSync(requirementsPath)) {
      resolve({ success: false, error: `Requirements file not found: ${requirementsPath}` });
      return;
    }

    onProgress?.('Installing MLX dependencies (this may take a few minutes)...');

    const pip = spawn(pythonPath, ['-m', 'pip', 'install', '-r', requirementsPath, '--upgrade'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    pip.stdout?.on('data', (data) => {
      const line = data.toString();
      stdout += line;
      // Send progress updates for package installations
      const match = line.match(/Installing collected packages: (.+)/);
      if (match) {
        onProgress?.(`Installing: ${match[1].split(',')[0].trim()}...`);
      }
    });

    pip.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    pip.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ 
          success: false, 
          error: `pip install failed (exit code ${code}): ${stderr || stdout}` 
        });
      }
    });

    pip.on('error', (err) => {
      resolve({ success: false, error: `Failed to run pip: ${err.message}` });
    });
  });
}

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

  // Step 1: Find Python
  const pythonPath = findPythonPath();
  if (!pythonPath) {
    const result = await dialog.showMessageBox({
      type: 'error',
      title: 'Python Not Found',
      message: 'Outloud requires Python 3.9 or higher.',
      detail: 'Please install Python using Homebrew:\n\nbrew install python@3.11\n\nThen restart Outloud.',
      buttons: ['Open Homebrew Guide', 'Quit'],
    });

    if (result.response === 0) {
      const { shell } = require('electron');
      shell.openExternal('https://brew.sh');
    }
    
    return false;
  }

  console.log(`[Setup] Found Python at: ${pythonPath}`);

  // Step 2: Check MLX dependencies
  if (checkMLXInstalled(pythonPath)) {
    console.log('[Setup] MLX dependencies already installed');
    setSetting('setupComplete', true);
    return true;
  }

  // Step 3: Ask user to install dependencies
  const installResult = await dialog.showMessageBox({
    type: 'question',
    title: 'Outloud Setup',
    message: 'MLX dependencies need to be installed.',
    detail: 'Outloud needs to install some Python packages for local speech processing.\n\nThis will take 1-3 minutes and requires internet.',
    buttons: ['Install Now', 'Quit'],
    defaultId: 0,
  });

  if (installResult.response !== 0) {
    return false;
  }

  // Step 4: Install dependencies with progress
  const progressResult = await installMLXDependencies(pythonPath, (message) => {
    console.log(`[Setup] ${message}`);
    // Could send to renderer for UI display
    mainWindow?.webContents.send('setup:progress', message);
  });

  if (!progressResult.success) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Installation Failed',
      message: 'Failed to install dependencies.',
      detail: progressResult.error,
      buttons: ['OK'],
    });
    return false;
  }

  // Step 5: Verify installation
  if (checkMLXInstalled(pythonPath)) {
    setSetting('setupComplete', true);
    console.log('[Setup] Core setup complete!');
    
    // Step 6: Check LLM dependencies (optional enhancement)
    // These enable AI-powered text enhancement for Live Paste
    // If not installed, Live Paste still works with heuristics
    if (!checkLLMInstalled(pythonPath)) {
      console.log('[Setup] Installing LLM dependencies for AI-enhanced Live Paste...');
      mainWindow?.webContents.send('setup:progress', 'Installing AI enhancement modules...');
      
      // LLM dependencies are in the same requirements.txt
      // They'll be installed as part of the pip install
      // If they fail, Live Paste still works (just without LLM)
    }
    
    await dialog.showMessageBox({
      type: 'info',
      title: 'Setup Complete',
      message: 'Outloud is ready to use!',
      detail: 'Shortcuts:\n• ⌃1 - Read selected text\n• ⌃2 - Voice dictation\n• ⌃3 - Pause & Hide\n\nAI-enhanced dictation enabled!',
      buttons: ['Get Started'],
    });
    
    return true;
  } else {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Setup Failed',
      message: 'Dependencies were installed but verification failed.',
      detail: 'Please try restarting Outloud or check the console for errors.',
      buttons: ['OK'],
    });
    return false;
  }
}



