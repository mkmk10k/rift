import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron';
import * as path from 'path';
import { createWidgetWindow } from './windows/widget';
import { registerIpcHandlers, shutdownServers } from './ipc/handlers';
import { initHoldToTalk, setHoldToTalkEnabled, stopHook } from './keyboard/holdToTalk';
import { runSetupCheck, findPythonPath } from './setup/pythonSetup';
import { getSetting, setSetting, getAllSettings, AppSettings } from './services/settings';
import { setupTestCaptureHandlers } from './services/testCaptureService';
import { startTestServer, stopTestServer, isTestMode, getTestPort } from './services/testServer';
import { HeadlessTestRunner, isHeadlessTestMode } from './services/headlessTestRunner';

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
  
  // Run first-launch setup check
  const setupOk = await runSetupCheck(null);
  if (!setupOk) {
    console.log('[Rift] Setup incomplete, quitting...');
    app.quit();
    return;
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

  // Create system tray
  createTray();

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
  const iconSize = 22;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray-icon.png')
    : path.join(__dirname, '../../assets/tray-icon.png');
  
  try {
    const customIcon = nativeImage.createFromPath(iconPath);
    if (!customIcon.isEmpty()) {
      tray = new Tray(customIcon.resize({ width: iconSize, height: iconSize }));
    } else {
      tray = new Tray(createFallbackIcon());
    }
  } catch {
    tray = new Tray(createFallbackIcon());
  }

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

function createFallbackIcon(): Electron.NativeImage {
  const size = 22;
  const canvas = Buffer.alloc(size * size * 4);
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2;
      const dy = y - size / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      
      if (dist < size / 3) {
        canvas[idx] = 255;
        canvas[idx + 1] = 255;
        canvas[idx + 2] = 255;
        canvas[idx + 3] = 255;
      } else {
        canvas[idx] = 0;
        canvas[idx + 1] = 0;
        canvas[idx + 2] = 0;
        canvas[idx + 3] = 0;
      }
    }
  }
  
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
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
      label: 'About Rift',
      click: showAboutDialog,
    },
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
