import { BrowserWindow, screen, app } from 'electron';
import * as path from 'path';

/**
 * Create the main widget window - Pure Orb Interface
 * 
 * A small, circular-feeling window containing the particle orb.
 * 140x140px - just enough for the orb and subtle status text.
 */
export function createWidgetWindow(): BrowserWindow {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const appPath = app.getAppPath();
  const preloadPath = path.join(appPath, 'dist', 'preload', 'preload', 'index.js');
  
  console.log('[Outloud] App path:', appPath);
  console.log('[Outloud] Is packaged:', app.isPackaged);
  console.log('[Outloud] Preload path:', preloadPath);

  // Black hole orb window - 360px orb + 20px padding for glow
  const windowSize = 380;

  const widget = new BrowserWindow({
    width: windowSize,
    height: windowSize,
    x: Math.floor((screenWidth - windowSize) / 2),
    y: Math.floor(screenHeight / 3),
    frame: false,
    transparent: true,           // TRUE transparency - no window chrome
    hasShadow: false,            // The orb provides its own glow
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000', // Fully transparent
    // No vibrancy - we want pure transparency, not blur
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
      devTools: true
    }
  });

  // Make widget visible on all workspaces
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  
  // Hide window buttons
  widget.setWindowButtonVisibility(false);

  // Load the renderer
  if (process.env.VITE_DEV_SERVER_URL) {
    widget.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const rendererPath = path.join(appPath, 'dist', 'renderer', 'index.html');
    console.log('[Outloud] Loading renderer from:', rendererPath);
    widget.loadFile(rendererPath);
  }

  return widget;
}

/**
 * Resize widget window (for speed overlay)
 */
export function resizeWidget(widget: BrowserWindow, width: number, height: number) {
  const currentBounds = widget.getBounds();
  widget.setBounds({
    ...currentBounds,
    width,
    height
  });
}
