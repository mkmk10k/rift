import { BrowserWindow, screen, app, ipcMain, systemPreferences, shell } from 'electron';
import * as path from 'path';
import { modelDownloadService } from '../services/modelDownloadService';
import { setSetting, getSetting } from '../services/settings';

export interface SetupWindowOptions {
  /** Mode: 'full' for first-run setup, 'download' for on-demand model download */
  mode?: 'full' | 'download';
  /** Model to download when in download mode */
  downloadModel?: 'chatterbox';
  /** Callback when download completes */
  onComplete?: () => void;
}

/**
 * Create the Setup window - First-run installer experience
 * 
 * A 520x720px window with Liquid Glass aesthetics showing:
 * - Model downloads (real progress from modelDownloadService)
 * - Permission requests
 * - Voice selection
 * - Tutorials
 * 
 * Can also be used in 'download' mode for on-demand model downloads
 */
export function createSetupWindow(options: SetupWindowOptions = {}): BrowserWindow {
  const { mode = 'full', downloadModel, onComplete } = options;
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const windowWidth = 520;
  const windowHeight = 720;
  
  // Get preload path
  const appPath = app.getAppPath();
  const preloadPath = path.join(appPath, 'dist', 'preload', 'preload', 'setupPreload.js');
  console.log('[Rift Setup] Preload path:', preloadPath);

  const setupWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: Math.floor((screenWidth - windowWidth) / 2),
    y: Math.floor((screenHeight - windowHeight) / 2),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'hud',              // Dark glass for floating panels
    visualEffectState: 'active',
    hasShadow: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
      devTools: true
    }
  });
  
  // Register IPC handlers for setup communication
  registerSetupIpcHandlers(setupWindow);

  // Load the setup HTML from Resources (extraResources), NOT from asar
  // In production: process.resourcesPath = /Applications/Rift.app/Contents/Resources
  // In dev: fall back to app path
  const setupPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'setup', 'setup.html')
    : path.join(app.getAppPath(), 'setup', 'setup.html');
  console.log('[Rift Setup] Loading setup from:', setupPath, 'mode:', mode);
  
  // Pass mode and model as query parameters
  const queryParams: Record<string, string> = { mode };
  if (downloadModel) {
    queryParams.model = downloadModel;
  }
  
  setupWindow.loadFile(setupPath, { query: queryParams });

  // Track load errors
  setupWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[Rift Setup] Failed to load:', errorCode, errorDescription);
  });

  // Make window draggable from the glass panel
  setupWindow.webContents.once('did-finish-load', () => {
    console.log('[Rift Setup] Setup window loaded');
    
    // Only open DevTools if explicitly requested via --dev-tools flag
    // In production (packaged app), DevTools never opens
    if (!app.isPackaged && process.argv.includes('--dev-tools')) {
      setupWindow.webContents.openDevTools({ mode: 'detach' });
    }
    
    setupWindow.webContents.insertCSS(`
      .window { -webkit-app-region: drag; }
      button, .demo-controls, .mode-toggle, .btn, .demo-btn, .mode-btn,
      input, textarea, .model-card, .stage-dots, .orb-container, .voice-card, .preview-input {
        -webkit-app-region: no-drag;
      }
    `);
  });

  return setupWindow;
}

/**
 * Register IPC handlers for setup window communication
 */
function registerSetupIpcHandlers(setupWindow: BrowserWindow): void {
  // Get current download status
  ipcMain.handle('setup:get-status', () => {
    return {
      modelsDownloaded: modelDownloadService.areModelsDownloaded(),
      isDownloading: modelDownloadService.isDownloadInProgress()
    };
  });
  
  // Start downloads and forward events to setup window
  ipcMain.handle('setup:start-downloads', async () => {
    if (modelDownloadService.areModelsDownloaded()) {
      console.log('[Setup] Models already downloaded');
      setupWindow.webContents.send('setup:all-complete');
      return true;
    }
    
    if (modelDownloadService.isDownloadInProgress()) {
      console.log('[Setup] Download already in progress');
      return false;
    }
    
    console.log('[Setup] Starting real model downloads...');
    
    // Set up event forwarding to setup window
    const onInit = (data: any) => {
      setupWindow.webContents.send('setup:download-init', data);
    };
    
    const onModelStart = (data: any) => {
      setupWindow.webContents.send('setup:model-start', {
        model: data.model,
        name: data.name,
        totalMb: data.totalMb
      });
    };
    
    const onProgress = (data: any) => {
      setupWindow.webContents.send('setup:progress', {
        model: data.model,
        name: data.name,
        downloadedMb: data.downloadedMb,
        totalMb: data.totalMb
      });
    };
    
    const onModelComplete = (data: any) => {
      setupWindow.webContents.send('setup:model-complete', data);
    };
    
    const onAllComplete = () => {
      setupWindow.webContents.send('setup:all-complete');
      cleanup();
    };
    
    const onError = (data: any) => {
      setupWindow.webContents.send('setup:error', data);
    };

    const onPhase = (data: { phase: string; package?: string; detail?: string }) => {
      setupWindow.webContents.send('setup:phase', data);
    };
    
    const cleanup = () => {
      modelDownloadService.removeListener('init', onInit);
      modelDownloadService.removeListener('modelStart', onModelStart);
      modelDownloadService.removeListener('progress', onProgress);
      modelDownloadService.removeListener('modelComplete', onModelComplete);
      modelDownloadService.removeListener('allComplete', onAllComplete);
      modelDownloadService.removeListener('error', onError);
      modelDownloadService.removeListener('phase', onPhase);
    };
    
    // Register listeners
    modelDownloadService.on('init', onInit);
    modelDownloadService.on('modelStart', onModelStart);
    modelDownloadService.on('progress', onProgress);
    modelDownloadService.on('modelComplete', onModelComplete);
    modelDownloadService.on('allComplete', onAllComplete);
    modelDownloadService.on('error', onError);
    modelDownloadService.on('phase', onPhase);
    
    // Core bundle first (~1.1 GB); Gemma downloads in background after setup
    const success = await modelDownloadService.downloadModels({ coreOnly: true });
    
    if (!success) {
      cleanup();
    }
    
    return success;
  });
  
  // ============================================
  // PERMISSION HANDLERS
  // ============================================
  
  // Get microphone permission status
  ipcMain.handle('setup:get-mic-status', async () => {
    if (process.platform !== 'darwin') return 'granted';
    const status = systemPreferences.getMediaAccessStatus('microphone');
    console.log('[Setup] Microphone status:', status);
    return status; // 'granted' | 'denied' | 'restricted' | 'not-determined'
  });
  
  // Request microphone access
  ipcMain.handle('setup:request-mic', async () => {
    if (process.platform !== 'darwin') return true;
    
    const currentStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log('[Setup] Requesting microphone, current status:', currentStatus);
    
    if (currentStatus === 'granted') {
      return true;
    }
    
    if (currentStatus === 'denied' || currentStatus === 'restricted') {
      // Can't request again - need to open System Settings
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
      return false;
    }
    
    // Request access (only works if 'not-determined')
    const granted = await systemPreferences.askForMediaAccess('microphone');
    console.log('[Setup] Microphone request result:', granted);
    return granted;
  });
  
  // Get accessibility permission status
  ipcMain.handle('setup:get-accessibility-status', () => {
    if (process.platform !== 'darwin') return true;
    // Pass false to just check without prompting
    const isEnabled = systemPreferences.isTrustedAccessibilityClient(false);
    console.log('[Setup] Accessibility status:', isEnabled);
    return isEnabled;
  });
  
  // Request accessibility access (prompts user)
  ipcMain.handle('setup:request-accessibility', () => {
    if (process.platform !== 'darwin') return true;
    // Pass true to prompt the user if not already granted
    const isEnabled = systemPreferences.isTrustedAccessibilityClient(true);
    console.log('[Setup] Accessibility request, enabled:', isEnabled);
    
    if (!isEnabled) {
      // Open System Settings to Accessibility pane
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
    return isEnabled;
  });
  
  // Restart the app (for permission refresh after macOS caches)
  ipcMain.handle('setup:restart-app', () => {
    console.log('[Setup] Restarting app for permission refresh...');
    app.relaunch();
    app.exit(0);
  });
  
  // Open System Settings to specific pane
  ipcMain.handle('setup:open-settings', async (_event, pane: string) => {
    const paneMap: Record<string, string> = {
      'microphone': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      'accessibility': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      'input-monitoring': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
    };
    const url = paneMap[pane] || paneMap['accessibility'];
    console.log('[Setup] Opening System Settings:', url);
    await shell.openExternal(url);
  });
  
  // ============================================
  // CHATTERBOX ON-DEMAND DOWNLOAD
  // ============================================
  
  // Check if Chatterbox is downloaded
  ipcMain.handle('setup:is-chatterbox-downloaded', () => {
    return getSetting('chatterboxDownloaded');
  });
  
  // Start Chatterbox download
  ipcMain.handle('setup:download-chatterbox', async () => {
    console.log('[Setup] Starting Chatterbox Turbo download...');
    
    // Check if already downloaded
    if (getSetting('chatterboxDownloaded')) {
      console.log('[Setup] Chatterbox already downloaded');
      setupWindow.webContents.send('setup:chatterbox-complete');
      return { success: true, cached: true };
    }
    
    try {
      // Use the Python download script for Chatterbox
      const { spawn } = require('child_process');
      const pythonPath = app.isPackaged
        ? path.join(process.resourcesPath, 'python', 'bin', 'python3.11')
        : path.join(app.getAppPath(), 'python-bundle', 'bin', 'python3.11');
      
      const downloadScript = app.isPackaged
        ? path.join(process.resourcesPath, 'python', 'download_models.py')
        : path.join(app.getAppPath(), 'python', 'download_models.py');
      
      console.log('[Setup] Python:', pythonPath);
      console.log('[Setup] Script:', downloadScript);
      // Run download with --chatterbox flag
      const proc = spawn(pythonPath, [downloadScript, '--chatterbox'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });
      
      let lastProgress = 0;
      
      proc.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            
            if (msg.type === 'start') {
              setupWindow.webContents.send('setup:chatterbox-start', {
                name: msg.name || 'Chatterbox Turbo',
                totalMb: msg.size_mb || 350
              });
            } else if (msg.type === 'progress') {
              // Throttle progress updates
              const now = Date.now();
              if (now - lastProgress > 100) {
                lastProgress = now;
                setupWindow.webContents.send('setup:chatterbox-progress', {
                  downloadedMb: msg.downloaded_mb,
                  totalMb: msg.total_mb
                });
              }
            } else if (msg.type === 'complete' || msg.type === 'cached') {
              console.log('[Setup] Chatterbox download complete');
              setSetting('chatterboxDownloaded', true);
              setupWindow.webContents.send('setup:chatterbox-complete');
            } else if (msg.type === 'error') {
              console.error('[Setup] Chatterbox download error:', msg.error);
              setupWindow.webContents.send('setup:chatterbox-error', { error: msg.error });
            }
          } catch (e) {
            // Not JSON, just log it
            console.log('[Setup Download]', line);
          }
        }
      });
      
      proc.stderr?.on('data', (data: Buffer) => {
        console.log('[Setup Download]', data.toString().trim());
      });
      
      return new Promise((resolve) => {
        proc.on('close', (code: number) => {
          console.log('[Setup] Download process exited with code:', code);
          if (code === 0) {
            setSetting('chatterboxDownloaded', true);
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `Download failed with code ${code}` });
          }
        });
        
        proc.on('error', (err: Error) => {
          console.error('[Setup] Download process error:', err);
          resolve({ success: false, error: err.message });
        });
      });
      
    } catch (error: any) {
      console.error('[Setup] Chatterbox download error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Save Chatterbox voice to settings
  ipcMain.handle('setup:set-chatterbox-voice', async (_event, voiceId: string) => {
    console.log('[Setup] Setting Chatterbox voice to:', voiceId);
    setSetting('ttsVoiceChatterbox', voiceId);
  });
  
  // Complete Chatterbox setup - switch model and trigger callback
  ipcMain.handle('setup:complete-chatterbox-setup', async () => {
    console.log('[Setup] Completing Chatterbox setup');
    setSetting('chatterboxDownloaded', true);
    setSetting('ttsModel', 'chatterbox');
    
    // Emit event for the main process to handle model switching
    (app as any).emit('chatterbox-setup-complete');
    
    return { success: true };
  });
  
  // ============================================
  // CHATTERBOX TURBO ON-DEMAND DOWNLOAD
  // ============================================
  
  // Check if Chatterbox Turbo is downloaded
  ipcMain.handle('setup:is-chatterbox-turbo-downloaded', () => {
    return getSetting('chatterboxTurboDownloaded');
  });
  
  // Start Chatterbox Turbo download
  ipcMain.handle('setup:download-chatterbox-turbo', async () => {
    console.log('[Setup] Starting Chatterbox Turbo download...');
    
    // Check if already downloaded
    if (getSetting('chatterboxTurboDownloaded')) {
      console.log('[Setup] Chatterbox Turbo already downloaded');
      setupWindow.webContents.send('setup:chatterbox-turbo-complete');
      return { success: true, cached: true };
    }
    
    try {
      // Use the Python download script for Chatterbox Turbo
      const { spawn } = require('child_process');
      const pythonPath = app.isPackaged
        ? path.join(process.resourcesPath, 'python', 'bin', 'python3.11')
        : path.join(app.getAppPath(), 'python-bundle', 'bin', 'python3.11');
      
      const downloadScript = app.isPackaged
        ? path.join(process.resourcesPath, 'python', 'download_models.py')
        : path.join(app.getAppPath(), 'python', 'download_models.py');
      
      console.log('[Setup Turbo] Python:', pythonPath);
      console.log('[Setup Turbo] Script:', downloadScript);
      
      // Run download with --chatterbox-turbo flag
      const proc = spawn(pythonPath, [downloadScript, '--chatterbox-turbo'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });
      
      let lastProgress = 0;
      
      proc.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            
            if (msg.type === 'start') {
              setupWindow.webContents.send('setup:chatterbox-turbo-start', {
                name: msg.name || 'Chatterbox Turbo (CPU)',
                totalMb: msg.size_mb || 3800
              });
            } else if (msg.type === 'progress') {
              const now = Date.now();
              if (now - lastProgress > 100) {
                lastProgress = now;
                setupWindow.webContents.send('setup:chatterbox-turbo-progress', {
                  downloadedMb: msg.downloaded_mb,
                  totalMb: msg.total_mb
                });
              }
            } else if (msg.type === 'complete' || msg.type === 'cached') {
              console.log('[Setup] Chatterbox Turbo download complete');
              setSetting('chatterboxTurboDownloaded', true);
              setupWindow.webContents.send('setup:chatterbox-turbo-complete');
            } else if (msg.type === 'error') {
              console.error('[Setup] Chatterbox Turbo download error:', msg.error);
              setupWindow.webContents.send('setup:chatterbox-turbo-error', { error: msg.error });
            }
          } catch (e) {
            console.log('[Setup Turbo Download]', line);
          }
        }
      });
      
      proc.stderr?.on('data', (data: Buffer) => {
        console.log('[Setup Turbo Download]', data.toString().trim());
      });
      
      return new Promise((resolve) => {
        proc.on('close', (code: number) => {
          console.log('[Setup] Turbo download process exited with code:', code);
          if (code === 0) {
            setSetting('chatterboxTurboDownloaded', true);
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `Download failed with code ${code}` });
          }
        });
        
        proc.on('error', (err: Error) => {
          console.error('[Setup] Turbo download process error:', err);
          resolve({ success: false, error: err.message });
        });
      });
      
    } catch (error: any) {
      console.error('[Setup] Chatterbox Turbo download error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Save Chatterbox Turbo voice to settings
  ipcMain.handle('setup:set-chatterbox-turbo-voice', async (_event, voiceId: string) => {
    console.log('[Setup] Setting Chatterbox Turbo voice to:', voiceId);
    setSetting('ttsVoiceChatterboxTurbo', voiceId);
  });
  
  // Complete Chatterbox Turbo setup - switch model and trigger callback
  ipcMain.handle('setup:complete-chatterbox-turbo-setup', async () => {
    console.log('[Setup] Completing Chatterbox Turbo setup');
    setSetting('chatterboxTurboDownloaded', true);
    setSetting('ttsModel', 'chatterbox-turbo');
    
    // Emit event for the main process to handle model switching
    (app as any).emit('chatterbox-turbo-setup-complete');
    
    return { success: true };
  });
  
  // ============================================
  // VOICE PREVIEW (Real TTS)
  // ============================================
  
  // Kokoro voice IDs from the TTS server
  const KOKORO_VOICES: Record<string, { id: string; name: string; description: string }> = {
    'af_heart': { id: 'af_heart', name: 'Heart', description: 'Warm and expressive' },
    'af_bella': { id: 'af_bella', name: 'Bella', description: 'Clear and professional' },
    'af_sarah': { id: 'af_sarah', name: 'Sarah', description: 'Friendly and natural' },
    'am_adam': { id: 'am_adam', name: 'Adam', description: 'Deep and confident' },
  };
  
  // Get available voices
  ipcMain.handle('setup:get-voices', () => {
    return Object.values(KOKORO_VOICES);
  });
  
  // Preview a voice - actually synthesize and return audio
  ipcMain.handle('setup:preview-voice', async (_event, voiceId: string, text: string) => {
    console.log('[Setup] Preview voice request:', voiceId, 'text:', text.substring(0, 30) + '...');
    
    try {
      // Import the TTS server from handlers
      const { getTtsServer } = require('../ipc/handlers');
      const ttsServer = getTtsServer?.();
      
      if (!ttsServer) {
        console.log('[Setup] TTS server not available yet');
        return { success: false, error: 'TTS server not available - please wait for model to load' };
      }
      
      // Check if TTS server is ready
      const isReady = ttsServer.isServerReady();
      
      if (!isReady) {
        console.log('[Setup] TTS server not ready yet');
        return { success: false, error: 'TTS model still loading - please wait' };
      }
      
      // Synthesize to a temp file
      const path = require('path');
      const fs = require('fs');
      const outputPath = path.join(app.getPath('temp'), `voice_preview_${Date.now()}.wav`);
      
      console.log('[Setup] Starting TTS synthesis to:', outputPath);
      const result = await ttsServer.synthesize(text, voiceId, 1.0, outputPath);
      
      console.log('[Setup] TTS synthesis result:', result.success, result.error || '');
      
      if (result.success && result.audioPath) {
        // Read the audio file and return as base64
        const audioBuffer = fs.readFileSync(result.audioPath);
        const audioBase64 = audioBuffer.toString('base64');
        console.log('[Setup] Audio file size:', audioBuffer.length, 'bytes, base64 length:', audioBase64.length);
        
        // Clean up temp file
        fs.unlinkSync(result.audioPath);
        
        return { success: true, audioBase64 };
      }
      
      return { success: false, error: result.error || 'Synthesis failed' };
    } catch (error: any) {
      console.error('[Setup] Voice preview error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Stop preview
  ipcMain.handle('setup:stop-preview', async () => {
    console.log('[Setup] Stop preview');
    // Would stop audio playback
  });
  
  // Save selected voice to settings
  ipcMain.handle('setup:set-voice', async (_event, voiceId: string) => {
    console.log('[Setup] Setting voice to:', voiceId);
    setSetting('defaultVoice' as any, voiceId);
  });
  
  // ============================================
  // SETUP LIFECYCLE
  // ============================================
  
  // Mark setup as complete
  ipcMain.handle('setup:complete', () => {
    console.log('[Setup] Setup completed by user');
    setSetting('setupComplete', true);
  });
  
  // Finish setup and launch main app
  ipcMain.handle('setup:finish-and-launch', () => {
    console.log('[Setup] Finishing setup and launching main app...');
    setSetting('setupComplete', true);
    
    // Close setup window
    setupWindow.close();
    
    // The main process will detect this and create the widget window
    // We emit an event that the main process can listen for
    app.emit('setup-complete');
  });
  
  // Cleanup handlers when window closes
  setupWindow.on('closed', () => {
    console.log('[Setup] Cleaning up IPC handlers...');
    ipcMain.removeHandler('setup:get-status');
    ipcMain.removeHandler('setup:start-downloads');
    ipcMain.removeHandler('setup:get-mic-status');
    ipcMain.removeHandler('setup:request-mic');
    ipcMain.removeHandler('setup:get-accessibility-status');
    ipcMain.removeHandler('setup:request-accessibility');
    ipcMain.removeHandler('setup:restart-app');
    ipcMain.removeHandler('setup:open-settings');
    ipcMain.removeHandler('setup:get-voices');
    ipcMain.removeHandler('setup:preview-voice');
    ipcMain.removeHandler('setup:stop-preview');
    ipcMain.removeHandler('setup:set-voice');
    ipcMain.removeHandler('setup:is-chatterbox-downloaded');
    ipcMain.removeHandler('setup:download-chatterbox');
    ipcMain.removeHandler('setup:set-chatterbox-voice');
    ipcMain.removeHandler('setup:complete-chatterbox-setup');
    ipcMain.removeHandler('setup:complete');
    ipcMain.removeHandler('setup:finish-and-launch');
  });
}
