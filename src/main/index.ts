import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, dialog, clipboard } from 'electron';
import * as path from 'path';
import { createWidgetWindow } from './windows/widget';
import { createSetupWindow } from './windows/setup';
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
 * Rift - Pure Orb Interface with Black Hole visualization
 * Uses Three.js TSL which compiles to WebGPU or WebGL automatically
 */

// Enable WebGPU support in Chromium
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan');

let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

/** Main-process services (Python servers, IPC) — once, after models exist for first-run */
let mainBackendServicesRegistered = false;
/** Dictation/settings handlers that live in index.ts (not handlers.ts) */
let widgetIndexIpcRegistered = false;

function registerWidgetIndexSideIpc(): void {
  if (widgetIndexIpcRegistered) return;
  widgetIndexIpcRegistered = true;

  ipcMain.handle('dictation:set-mode', (_event, mode: 'toggle' | 'hold') => {
    console.log('[Rift] Dictation mode set to:', mode);
    setSetting('dictationMode', mode);
    setHoldToTalkEnabled(mode === 'hold');
    updateTrayMenu();
    return { success: true, mode };
  });

  ipcMain.handle('settings:get-all', () => {
    return getAllSettings();
  });

  ipcMain.handle('settings:set', (_event, key: string, value: unknown) => {
    setSetting(key as keyof AppSettings, value as AppSettings[keyof AppSettings]);

    if (key === 'launchAtLogin') {
      app.setLoginItemSettings({
        openAtLogin: value as boolean,
        openAsHidden: true,
      });
    }

    mainWindow?.webContents.send('settings:updated', key, value);
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
}

function scheduleTtsModelSwitchFromSettings(): void {
  const savedTtsModel = getSetting('ttsModel');
  const chatterboxDownloaded = getSetting('chatterboxDownloaded');
  console.log(`[Rift] Saved TTS model: ${savedTtsModel}, chatterboxDownloaded: ${chatterboxDownloaded}`);

  if (savedTtsModel && savedTtsModel !== 'kokoro') {
    console.log(`[Rift] Will switch TTS server to saved model: ${savedTtsModel}`);

    setTimeout(async () => {
      console.log(`[Rift] Attempting to switch TTS model to ${savedTtsModel}...`);

      const { getTtsServer } = require('./ipc/handlers');
      const ttsServer = getTtsServer();
      if (ttsServer && typeof ttsServer.switchModel === 'function') {
        try {
          const result = await ttsServer.switchModel(savedTtsModel);
          console.log('[Rift] TTS switch result:', result);

          if (result.success) {
            console.log(`[Rift] TTS server switched to ${savedTtsModel}`);
          } else {
            console.error(`[Rift] Failed to switch to ${savedTtsModel}:`, result.error);
            console.log('[Rift] Falling back to Kokoro for this session');
            setSetting('ttsModel', 'kokoro');
            mainWindow?.webContents.send('settings:updated', 'ttsModel', 'kokoro');
            updateTrayMenu();

            const { Notification } = require('electron');
            if (Notification.isSupported()) {
              new Notification({
                title: 'TTS Model Unavailable',
                body: `${savedTtsModel} model failed to load. Using Kokoro instead.`,
              }).show();
            }
          }
        } catch (err: unknown) {
          console.error(`[Rift] Error switching to ${savedTtsModel}:`, err);
        }
      } else {
        console.error('[Rift] ttsServer or switchModel not available');
      }
    }, 5000);
  }
}

function registerMainBackendServices(): void {
  if (mainBackendServicesRegistered) return;
  mainBackendServicesRegistered = true;
  registerIpcHandlers();
  setupTestCaptureHandlers();
  registerWidgetIndexSideIpc();
  scheduleTtsModelSwitchFromSettings();
}

function startBackgroundLlmDeepIfNeeded(): void {
  if (getSetting('llmDeepDownloaded')) return;
  if (modelDownloadService.isDownloadInProgress()) return;
  void modelDownloadService.downloadModels({ onlyModelId: 'LLM_DEEP' }).catch((err: unknown) => {
    console.warn('[Rift] Background Gemma download failed (will retry on a later launch):', err);
  });
}

const trayDownloadModelStart = (progress: DownloadProgress) => {
  console.log(`[Rift] Downloading ${progress.name}...`);
  updateTrayMenuDownloading(progress.name, 0, progress.totalMb);
};
const trayDownloadProgress = (progress: DownloadProgress) => {
  updateTrayMenuDownloading(progress.name, progress.downloadedMb, progress.totalMb);
};
const trayDownloadModelComplete = (info: { model: string; name: string; cached: boolean }) => {
  console.log(`[Rift] ${info.name} ${info.cached ? 'already cached' : 'downloaded'}`);
};

function wireTrayModelDownloadProgress(): void {
  modelDownloadService.on('modelStart', trayDownloadModelStart);
  modelDownloadService.on('progress', trayDownloadProgress);
  modelDownloadService.on('modelComplete', trayDownloadModelComplete);
}

function unwireTrayModelDownloadProgress(): void {
  modelDownloadService.removeListener('modelStart', trayDownloadModelStart);
  modelDownloadService.removeListener('progress', trayDownloadProgress);
  modelDownloadService.removeListener('modelComplete', trayDownloadModelComplete);
}

app.whenReady().then(async () => {
  // Check for headless E2E test mode first
  if (isHeadlessTestMode()) {
    console.log('[Rift] Starting in HEADLESS E2E TEST MODE');
    console.log('[Rift] Skipping TTS/STT startup to preserve memory for 4B model');
    
    // DON'T call registerIpcHandlers() - it starts TTS and STT which consume ~2GB
    // Only start the LLM server directly for headless testing
    const { llmServer } = require('./services/llmService');
    try {
      await llmServer.start();
    } catch (e) {
      console.error('[Rift] LLM server failed to start in headless mode:', e);
      app.exit(1);
      return;
    }
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

  createTray();

  const isFirstLaunch = !getSetting('setupComplete');
  const forceSetup = process.argv.includes('--setup');
  const setupFlow = isFirstLaunch || forceSetup;
  const needsDownload = !modelDownloadService.areModelsDownloaded();

  const onSetupCompleteLaunchWidget = () => {
    console.log('[Rift] Setup complete - launching main widget');
    mainWindow = createWidgetWindow();
    initHoldToTalk(mainWindow);
    const savedMode = getSetting('dictationMode');
    setHoldToTalkEnabled(savedMode === 'hold');
    registerGlobalShortcuts();
    startBackgroundLlmDeepIfNeeded();
  };

  // First-run setup: show window immediately; downloads run via setup IPC (core models only).
  // Defer Python servers until download process exits — avoids racing HF cache with TTS/STT.
  if (setupFlow && needsDownload) {
    console.log('[Rift] First-run setup — opening window before model download');

    let notified = false;
    modelDownloadService.once('start', () => {
      if (notified) return;
      notified = true;
      const { Notification } = require('electron');
      if (Notification.isSupported()) {
        new Notification({
          title: 'Rift',
          body: 'Downloading required models. Keep this window open; you can also check progress in the menu bar.',
        }).show();
      }
    });

    wireTrayModelDownloadProgress();
    let deferredRegisterDone = false;
    const finishDeferredModelBootstrap = () => {
      if (deferredRegisterDone) return;
      deferredRegisterDone = true;
      unwireTrayModelDownloadProgress();
      updateTrayMenu();
      registerMainBackendServices();
    };
    modelDownloadService.once('complete', finishDeferredModelBootstrap);
    modelDownloadService.once('error', finishDeferredModelBootstrap);

    console.log(`[Rift] Opening setup window (${isFirstLaunch ? 'first launch' : '--setup flag'})`);
    openSetupWindow();
    (app as any).once('setup-complete', onSetupCompleteLaunchWidget);
    return;
  }

  // Returning user with missing models (rare): block here with tray progress only
  if (!setupFlow && needsDownload) {
    console.log('[Rift] Models missing — downloading core bundle before main window');
    wireTrayModelDownloadProgress();
    await modelDownloadService.downloadModels({ coreOnly: true });
    unwireTrayModelDownloadProgress();
    updateTrayMenu();
  }

  registerMainBackendServices();

  if (setupFlow) {
    console.log(`[Rift] Opening setup window (${isFirstLaunch ? 'first launch' : '--setup flag'})`);
    openSetupWindow();
    (app as any).once('setup-complete', onSetupCompleteLaunchWidget);
    return;
  }
  
  // Create the widget window (normal launch, not setup mode)
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

  registerGlobalShortcuts();
  startBackgroundLlmDeepIfNeeded();
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
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'trayIconTemplate.png')
    : path.join(app.getAppPath(), 'assets', 'trayIconTemplate.png');
    
  const trayIcon = nativeImage.createFromPath(iconPath);
  trayIcon.setTemplateImage(true);

  tray = new Tray(trayIcon);
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

// Voice definitions for TTS models
const KOKORO_VOICES: Record<string, string> = {
  'af_heart': 'Heart',
  'af_bella': 'Bella',
  'af_sarah': 'Sarah',
  'am_adam': 'Adam',
};

const CHATTERBOX_VOICES: Record<string, string> = {
  'aaron': 'Aaron',
  'abigail': 'Abigail',
  'anaya': 'Anaya',
  'andy': 'Andy',
  'archer': 'Archer',
  'brian': 'Brian',
  'chloe': 'Chloe',
  'dylan': 'Dylan',
  'evelyn': 'Evelyn',
  'fiona': 'Fiona',
};

/**
 * Handle TTS model switch from tray menu
 */
async function handleTTSModelSwitch(newModel: 'kokoro' | 'chatterbox' | 'chatterbox-turbo' | 'chatterbox-full-mlx') {
  const currentModel = getSetting('ttsModel');
  const chatterboxDownloaded = getSetting('chatterboxDownloaded');
  const chatterboxTurboDownloaded = getSetting('chatterboxTurboDownloaded');
  
  if (newModel === currentModel) {
    return;
  }

  // Chatterbox Turbo - switch directly (no dialog, model downloads on demand via HuggingFace cache)
  // Note: Turbo runs on CPU on Mac (MPS has bugs), so it may be slower than MLX models

  // Check if Chatterbox needs to be downloaded
  if (newModel === 'chatterbox' && !chatterboxDownloaded) {
    // Check available RAM - warn on 8GB Macs
    const os = require('os');
    const totalRamGB = os.totalmem() / (1024 ** 3);
    
    if (totalRamGB <= 8) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Memory Warning',
        message: 'Chatterbox may run slowly on 8GB Macs',
        detail: 'Chatterbox uses more memory than Kokoro. For the best experience, we recommend staying with Kokoro on 8GB Macs.\n\nWould you like to continue anyway?',
        buttons: ['Use Chatterbox Anyway', 'Stay with Kokoro'],
        defaultId: 1,
      });
      
      if (response === 1) {
        updateTrayMenu(); // Reset radio button
        return;
      }
    }

    // Open setup window in download mode for Chatterbox
    console.log('[Rift] Chatterbox not downloaded, opening download window...');
    
    const { createSetupWindow } = require('./windows/setup');
    const downloadWindow = createSetupWindow({
      mode: 'download',
      downloadModel: 'chatterbox',
      onComplete: () => {
        console.log('[Rift] Chatterbox setup complete callback');
      }
    });
    
    // Listen for the setup completion event (fired from setup window)
    const onChatterboxComplete = async () => {
      console.log('[Rift] Chatterbox setup complete - switching model');
      
      // Notify renderer
      mainWindow?.webContents.send('settings:updated', 'ttsModel', 'chatterbox');
      mainWindow?.webContents.send('settings:updated', 'ttsVoiceChatterbox', getSetting('ttsVoiceChatterbox'));
      
      // Tell TTS server to switch models
      const { getTtsServer: getTtsServerForSwitch } = require('./ipc/handlers');
      const ttsServerForSwitch = getTtsServerForSwitch();
      if (ttsServerForSwitch && typeof ttsServerForSwitch.switchModel === 'function') {
        const result = await ttsServerForSwitch.switchModel('chatterbox');
        if (!result.success) {
          console.error('[Rift] TTS model switch failed:', result.error);
        }
      }
      
      updateTrayMenu();
      (app as any).removeListener('chatterbox-setup-complete', onChatterboxComplete);
    };
    
    (app as any).on('chatterbox-setup-complete', onChatterboxComplete);
    
    downloadWindow.on('closed', () => {
      // If download was cancelled, stay on current model
      if (!getSetting('chatterboxDownloaded')) {
        updateTrayMenu(); // Reset radio button
      }
      (app as any).removeListener('chatterbox-setup-complete', onChatterboxComplete);
    });
    return;
  }

  // Switch the model (direct switch - chatterbox already downloaded)
  console.log(`[Rift] Switching TTS model to: ${newModel}`);
  
  setSetting('ttsModel', newModel);
  
  // Notify renderer
  mainWindow?.webContents.send('settings:updated', 'ttsModel', newModel);
  
  // Tell TTS server to switch models
  const { getTtsServer: getServer } = require('./ipc/handlers');
  const server = getServer();
  
  if (server && typeof server.switchModel === 'function') {
    
    const result = await server.switchModel(newModel);
    
    if (!result.success) {
      console.error('[Rift] TTS model switch failed:', result.error);
      // Revert setting on failure
      setSetting('ttsModel', currentModel);
    }
  } else {
  }
  
  updateTrayMenu();
}

/**
 * Build voice submenu based on current TTS model
 */
function buildVoiceSubmenu(): Electron.MenuItemConstructorOptions[] {
  const currentModel = getSetting('ttsModel');
  // chatterbox-full-mlx uses a single default voice, others have voice options
  const voices = (currentModel === 'chatterbox' || currentModel === 'chatterbox-turbo') 
    ? CHATTERBOX_VOICES 
    : currentModel === 'chatterbox-full-mlx'
      ? { 'default': 'Default Voice' }
      : KOKORO_VOICES;
  
  // Voice setting key depends on model
  let voiceSetting: 'ttsVoiceKokoro' | 'ttsVoiceChatterbox' | 'ttsVoiceChatterboxTurbo';
  if (currentModel === 'chatterbox' || currentModel === 'chatterbox-full-mlx') {
    voiceSetting = 'ttsVoiceChatterbox';
  } else if (currentModel === 'chatterbox-turbo') {
    voiceSetting = 'ttsVoiceChatterboxTurbo';
  } else {
    voiceSetting = 'ttsVoiceKokoro';
  }
  
  const currentVoice = getSetting(voiceSetting);

  return Object.entries(voices).map(([id, name]) => ({
    label: name,
    type: 'radio' as const,
    checked: currentVoice === id,
    click: () => {
      setSetting(voiceSetting, id);
      mainWindow?.webContents.send('settings:updated', voiceSetting, id);
      updateTrayMenu();
    },
  }));
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
      label: 'TTS Model',
      submenu: [
        {
          label: 'Kokoro (Stable)',
          type: 'radio' as const,
          checked: getSetting('ttsModel') === 'kokoro',
          click: () => handleTTSModelSwitch('kokoro'),
        },
        {
          label: 'Chatterbox MLX (Fast)',
          type: 'radio' as const,
          checked: getSetting('ttsModel') === 'chatterbox-full-mlx',
          click: () => handleTTSModelSwitch('chatterbox-full-mlx'),
        },
        {
          label: 'Chatterbox (PyTorch)',
          type: 'radio' as const,
          checked: getSetting('ttsModel') === 'chatterbox',
          click: () => handleTTSModelSwitch('chatterbox'),
        },
        {
          label: 'Chatterbox Turbo (Beta)',
          type: 'radio' as const,
          checked: getSetting('ttsModel') === 'chatterbox-turbo',
          click: () => handleTTSModelSwitch('chatterbox-turbo'),
        },
      ],
    },
    {
      label: 'Voice',
      submenu: buildVoiceSubmenu(),
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
      label: 'Run Setup...',
      click: openSetupWindow,
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
      label: 'Large models can take 20+ minutes on slower connections',
      enabled: false,
    },
    {
      label: 'Gemma may continue in the background after setup',
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
 * Open the Setup window
 */
function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }
  
  setupWindow = createSetupWindow();
  setupWindow.on('closed', () => {
    setupWindow = null;
  });
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
