import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, dialog, clipboard } from 'electron';
import * as path from 'path';
import { createWidgetWindow } from './windows/widget';
import { registerIpcHandlers, shutdownServers } from './ipc/handlers';
import { initHoldToTalk, setHoldToTalkEnabled, stopHook } from './keyboard/holdToTalk';
import { runSetupCheck, findPythonPath, collectDiagnostics } from './setup/pythonSetup';
import { getSetting, setSetting, getAllSettings, AppSettings } from './services/settings';
import { checkForUpdates } from './services/updateService';
import { setupTestCaptureHandlers } from './services/testCaptureService';
import { startTestServer, stopTestServer, isTestMode, getTestPort } from './services/testServer';
import { HeadlessTestRunner, isHeadlessTestMode } from './services/headlessTestRunner';
import { modelDownloadService, DownloadProgress } from './services/modelDownloadService';

/**
 * Main Electron process entry point
 * 
 * Outloud - Pure Orb Interface with Black Hole visualization
 * Uses Three.js TSL which compiles to WebGPU or WebGL automatically
 */

// Enable WebGPU support in Chromium
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

app.whenReady().then(async () => {
  // Check for headless E2E test mode first
  if (isHeadlessTestMode()) {
    console.log('[Rift] Starting in HEADLESS E2E TEST MODE');
    console.log('[Rift] Skipping TTS/STT startup to preserve memory for 4B model');
    
    // DON'T call registerIpcHandlers() - it starts TTS and STT which consume ~2GB
    // Only start the LLM server directly for headless testing
    const { llmServer } = require('./services/llmService');
    await llmServer.start();
    console.log('[Rift] LLM server started (TTS/STT skipped for memory)');
    
    // Run headless tests
    const runner = new HeadlessTestRunner();
    const exitCode = await runner.run();
    
    console.log(`\n[Rift] Headless tests complete. Exit code: ${exitCode}`);
    app.exit(exitCode);
    return;
  }
  
  // Run first-launch setup check (Python verification)
  const setupOk = await runSetupCheck(null);
  if (!setupOk) {
    console.log('[Rift] Setup incomplete, quitting...');
    app.quit();
    return;
  }

  // Create system tray EARLY (so we can show download progress)
  createTray();

  // Check if models need to be downloaded
  if (!modelDownloadService.areModelsDownloaded()) {
    console.log('[Rift] First launch - downloading models...');
    
    // Set up progress listeners
    modelDownloadService.on('modelStart', (progress: DownloadProgress) => {
      console.log(`[Rift] Downloading ${progress.name}...`);
      updateTrayMenuDownloading(progress.name, 0, progress.totalMb);
    });
    
    modelDownloadService.on('progress', (progress: DownloadProgress) => {
      updateTrayMenuDownloading(progress.name, progress.downloadedMb, progress.totalMb);
    });
    
    modelDownloadService.on('modelComplete', (info: { model: string; name: string; cached: boolean }) => {
      console.log(`[Rift] ${info.name} ${info.cached ? 'already cached' : 'downloaded'}`);
    });
    
    // Start download
    const downloadOk = await modelDownloadService.downloadModels();
    
    // Remove listeners
    modelDownloadService.removeAllListeners();
    
    if (!downloadOk) {
      console.error('[Rift] Model download failed');
      // Continue anyway - some models might work
    }
    
    // Switch to normal menu
    updateTrayMenu();
  }

  // Register IPC handlers
  registerIpcHandlers();
  setupTestCaptureHandlers();

  // Create the widget window
  mainWindow = createWidgetWindow();

  // Start test server if in test mode
  if (isTestMode()) {
    console.log('[Rift] Running in TEST MODE');
    startTestServer(mainWindow, getTestPort());
  }

  // Initialize hold-to-talk keyboard hook
  initHoldToTalk(mainWindow);

  // Load saved dictation mode
  const savedMode = getSetting('dictationMode');
  setHoldToTalkEnabled(savedMode === 'hold');

  // Set up launch at login based on saved setting
  const launchAtLogin = getSetting('launchAtLogin');
  app.setLoginItemSettings({
    openAtLogin: launchAtLogin,
    openAsHidden: true,
  });

  // Register global shortcuts
  registerGlobalShortcuts();

  // IPC handler for dictation mode switch
  ipcMain.handle('dictation:set-mode', (_event, mode: 'toggle' | 'hold') => {
    console.log('[Rift] Dictation mode set to:', mode);
    setSetting('dictationMode', mode);
    setHoldToTalkEnabled(mode === 'hold');
    updateTrayMenu(); // Refresh tray to show current mode
    return { success: true, mode };
  });

  // IPC handler for getting all settings
  ipcMain.handle('settings:get-all', () => {
    return getAllSettings();
  });

  // IPC handler for setting a specific setting
  ipcMain.handle('settings:set', (_event, key: string, value: any) => {
    setSetting(key as keyof AppSettings, value);
    
    // Handle special cases
    if (key === 'launchAtLogin') {
      app.setLoginItemSettings({
        openAtLogin: value,
        openAsHidden: true,
      });
    }
    
    // Notify renderer of setting change
    mainWindow?.webContents.send('settings:updated', key, value);
    
    // Refresh tray menu to reflect changes
    updateTrayMenu();
    
    return { success: true };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWidgetWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('before-quit', () => {
  stopHook();
  shutdownServers();
  stopTestServer();
});

/**
 * Create system tray icon with comprehensive menu
 */
function createTray() {
  // Use our beautiful programmatic black hole icon
  tray = new Tray(createBlackHoleIcon());
  tray.setToolTip('Rift');
  updateTrayMenu();
  
  // Click on tray icon shows/hides window
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

/**
 * Create a sharp black hole icon for the menu bar.
 * Interstellar-style: thin ring with horizontal accretion disk through center.
 * Clean geometric design matching macOS menu bar icon style.
 */
function createBlackHoleIcon(): Electron.NativeImage {
  const size = 22;
  const canvas = Buffer.alloc(size * size * 4);
  
  const cx = size / 2;
  const cy = size / 2;
  
  // Parameters for clean geometric look
  const outerRadius = 9;        // Outer edge of ring
  const ringThickness = 1.5;    // Thin ring stroke
  const innerRadius = outerRadius - ringThickness;
  const eventHorizon = 2.5;     // Dark center
  const diskHeight = 2;         // Horizontal accretion disk thickness
  const diskExtend = 10;        // How far disk extends beyond ring
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      
      let alpha = 0;
      
      // 1. Horizontal accretion disk (full width band through middle)
      if (Math.abs(dy) <= diskHeight && Math.abs(dx) <= diskExtend) {
        // Skip the event horizon center
        if (dist > eventHorizon) {
          alpha = 255;
        }
      }
      
      // 2. Outer ring (thin stroke)
      if (dist >= innerRadius && dist <= outerRadius) {
        alpha = 255;
      }
      
      // 3. Event horizon stays dark (already 0)
      if (dist <= eventHorizon) {
        alpha = 0;
      }
      
      // Template image: white with alpha
      canvas[idx] = 255;
      canvas[idx + 1] = 255;
      canvas[idx + 2] = 255;
      canvas[idx + 3] = alpha;
    }
  }
  
  const image = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  image.setTemplateImage(true);
  return image;
}

/**
 * Build comprehensive tray menu with all settings
 */
function updateTrayMenu() {
  if (!tray) return;

  const currentSpeed = getSetting('playbackSpeed');
  const currentMode = getSetting('dictationMode');
  const livePreview = getSetting('showLivePreview');
  const livePaste = getSetting('livePasteMode');
  const autoSend = getSetting('autoSendAfterDictation');
  const launchAtLogin = getSetting('launchAtLogin');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Rift',
      accelerator: 'Ctrl+3',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Read Selection',
      accelerator: 'CmdOrCtrl+Alt+V',
      click: () => {
        if (mainWindow) {
          mainWindow.showInactive();
          mainWindow.webContents.send('shortcut:read-selection');
        }
      },
    },
    {
      label: 'Voice Dictation',
      accelerator: 'CmdOrCtrl+Shift+S',
      click: () => {
        if (mainWindow) {
          // Only show if not already visible - renderer handles visibility based on mode
          if (!mainWindow.isVisible()) {
            mainWindow.showInactive();
          }
          mainWindow.webContents.send('shortcut:voice-dictation');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Playback Speed',
      submenu: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map(speed => ({
        label: `${speed}x`,
        type: 'radio' as const,
        checked: currentSpeed === speed,
        click: () => {
          setSetting('playbackSpeed', speed);
          mainWindow?.webContents.send('settings:updated', 'playbackSpeed', speed);
          updateTrayMenu();
        },
      })),
    },
    {
      label: 'Dictation Mode',
      submenu: [
        {
          label: 'Toggle (tap to start/stop)',
          type: 'radio' as const,
          checked: currentMode === 'toggle',
          click: () => {
            setSetting('dictationMode', 'toggle');
            setHoldToTalkEnabled(false);
            mainWindow?.webContents.send('settings:updated', 'dictationMode', 'toggle');
            updateTrayMenu();
          },
        },
        {
          label: 'Hold (hold to speak)',
          type: 'radio' as const,
          checked: currentMode === 'hold',
          click: () => {
            setSetting('dictationMode', 'hold');
            setHoldToTalkEnabled(true);
            mainWindow?.webContents.send('settings:updated', 'dictationMode', 'hold');
            updateTrayMenu();
          },
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Live Preview',
      type: 'checkbox',
      checked: livePreview,
      click: (menuItem) => {
        setSetting('showLivePreview', menuItem.checked);
        mainWindow?.webContents.send('settings:updated', 'showLivePreview', menuItem.checked);
      },
    },
    {
      label: 'Live Paste',
      type: 'checkbox',
      checked: livePaste,
      click: (menuItem) => {
        setSetting('livePasteMode', menuItem.checked);
        // If enabling live paste, also enable live preview
        if (menuItem.checked && !getSetting('showLivePreview')) {
          setSetting('showLivePreview', true);
          mainWindow?.webContents.send('settings:updated', 'showLivePreview', true);
        }
        mainWindow?.webContents.send('settings:updated', 'livePasteMode', menuItem.checked);
        updateTrayMenu();
      },
    },
    {
      label: 'Auto-Send After Paste',
      type: 'checkbox',
      checked: autoSend,
      click: (menuItem) => {
        setSetting('autoSendAfterDictation', menuItem.checked);
        mainWindow?.webContents.send('settings:updated', 'autoSendAfterDictation', menuItem.checked);
      },
    },
    { type: 'separator' },
    {
      label: 'Play Test TTS',
      click: () => {
        if (mainWindow) {
          mainWindow.showInactive();
          mainWindow.webContents.send('action:test-tts');
        }
      },
    },
    {
      label: 'Toggle Console',
      click: () => {
        if (mainWindow) {
          if (mainWindow.webContents.isDevToolsOpened()) {
            mainWindow.webContents.closeDevTools();
          } else {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
          }
        }
      },
    },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: launchAtLogin,
      click: (menuItem) => {
        setSetting('launchAtLogin', menuItem.checked);
        app.setLoginItemSettings({
          openAtLogin: menuItem.checked,
          openAsHidden: true,
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Check for Updates...',
      click: async () => {
        await checkForUpdates(true);
      },
    },
    {
      label: 'About Rift',
      click: showAboutDialog,
    },
    {
      label: 'Copy Diagnostics',
      click: () => {
        const diagnostics = collectDiagnostics();
        clipboard.writeText(diagnostics);
        dialog.showMessageBox({
          type: 'info',
          title: 'Diagnostics Copied',
          message: 'System diagnostics copied to clipboard.',
          detail: 'You can paste this into a GitHub issue or support request.',
          buttons: ['OK'],
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Rift',
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * Build minimal tray menu showing download progress
 */
function updateTrayMenuDownloading(modelName: string, downloadedMb: number, totalMb: number) {
  if (!tray) return;

  const progressText = totalMb > 0 
    ? `Downloading ${modelName}... (${downloadedMb}/${totalMb} MB)`
    : `Downloading ${modelName}...`;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: progressText,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'This may take a few minutes',
      enabled: false,
    },
    {
      label: 'Models are downloaded once on first launch',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit Rift',
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        modelDownloadService.cancelDownload();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * Show About dialog
 */
function showAboutDialog() {
  const version = app.getVersion();
  const pythonPath = findPythonPath() || 'Not found';
  
  dialog.showMessageBox({
    type: 'info',
    title: 'About Rift',
    message: 'Rift',
    detail: `Version ${version}

Your voice. Your Mac. Nothing else.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KEYBOARD SHORTCUTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• ⌃1 - Read selected text aloud
• ⌃2 - Voice dictation
• ⌃3 - Pause & Hide widget
• Esc - Dismiss widget

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIVACY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
All speech processing runs entirely 
on-device via Apple's MLX framework.
No data leaves your Mac.

Python: ${pythonPath}`,
    buttons: ['OK'],
  });
}

/**
 * Register global keyboard shortcuts
 * 
 * New ergonomic shortcuts (2-key combos, left hand, no Safari conflicts):
 * - Ctrl+1 = Read selected text aloud
 * - Ctrl+2 = Voice dictation
 * - Ctrl+3 = Pause & Hide (dismiss widget)
 */
function registerGlobalShortcuts() {
  // Read selected text aloud (Ctrl+1)
  const reg1 = globalShortcut.register('Control+1', () => {
    console.log('[Rift] ⌃1 pressed - Read selection');
    if (mainWindow) {
      mainWindow.showInactive();
      mainWindow.webContents.send('shortcut:read-selection');
    }
  });
  console.log('[Rift] ⌃1 registered:', reg1);

  // Voice dictation (Ctrl+2)
  const reg2 = globalShortcut.register('Control+2', () => {
    console.log('[Rift] ⌃2 pressed - Voice dictation');
    if (mainWindow) {
      // Only show if not already visible - the renderer will hide if in live paste mode
      if (!mainWindow.isVisible()) {
        mainWindow.showInactive();
      }
      mainWindow.webContents.send('shortcut:voice-dictation');
    }
  });
  console.log('[Rift] ⌃2 registered:', reg2);

  // Pause & Hide widget (Ctrl+3)
  const reg3 = globalShortcut.register('Control+3', () => {
    console.log('[Rift] ⌃3 pressed - Pause & Hide');
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        // Notify renderer to pause audio before hiding
        mainWindow.webContents.send('shortcut:pause-audio');
        mainWindow.hide();
      } else {
        mainWindow.show();
      }
    }
  });
  console.log('[Rift] ⌃3 registered:', reg3);

  // Note: Escape is handled in the renderer with a keyboard event listener
  // (global Escape would interfere with all other apps)
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});
