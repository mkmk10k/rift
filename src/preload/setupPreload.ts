/**
 * Preload script for Setup Window
 * Exposes IPC channels for real model download progress and permissions
 */

import { contextBridge, ipcRenderer } from 'electron';

// Expose setup-specific API to renderer
contextBridge.exposeInMainWorld('setupAPI', {
  // ============================================
  // MODEL DOWNLOADS
  // ============================================
  
  // Get initial state
  getDownloadStatus: () => ipcRenderer.invoke('setup:get-status'),
  
  // Start downloads
  startDownloads: () => ipcRenderer.invoke('setup:start-downloads'),
  
  // Listen for download events
  onDownloadInit: (callback: (data: { totalModels: number }) => void) => {
    ipcRenderer.on('setup:download-init', (_event, data) => callback(data));
  },

  onPhase: (callback: (data: { phase: string; package?: string; detail?: string }) => void) => {
    ipcRenderer.on('setup:phase', (_event, data) => callback(data));
  },
  
  onModelStart: (callback: (data: { model: string; name: string; totalMb: number }) => void) => {
    ipcRenderer.on('setup:model-start', (_event, data) => callback(data));
  },
  
  onProgress: (callback: (data: { model: string; name: string; downloadedMb: number; totalMb: number }) => void) => {
    ipcRenderer.on('setup:progress', (_event, data) => callback(data));
  },
  
  onModelComplete: (callback: (data: { model: string; name: string; cached: boolean }) => void) => {
    ipcRenderer.on('setup:model-complete', (_event, data) => callback(data));
  },
  
  onAllComplete: (callback: () => void) => {
    ipcRenderer.on('setup:all-complete', () => callback());
  },
  
  onError: (callback: (data: { error: string }) => void) => {
    ipcRenderer.on('setup:error', (_event, data) => callback(data));
  },
  
  // ============================================
  // PERMISSIONS
  // ============================================
  
  // Check microphone permission status
  getMicrophoneStatus: () => ipcRenderer.invoke('setup:get-mic-status'),
  
  // Request microphone access - returns granted/denied/restricted
  requestMicrophone: () => ipcRenderer.invoke('setup:request-mic'),
  
  // Check accessibility permission status  
  getAccessibilityStatus: () => ipcRenderer.invoke('setup:get-accessibility-status'),
  
  // Request accessibility access (opens System Settings)
  requestAccessibility: () => ipcRenderer.invoke('setup:request-accessibility'),
  
  // Open System Settings to specific pane
  openSystemSettings: (pane: string) => ipcRenderer.invoke('setup:open-settings', pane),
  
  // ============================================
  // CHATTERBOX ON-DEMAND DOWNLOAD
  // ============================================
  
  // Check if Chatterbox is already downloaded
  isChatterboxDownloaded: () => ipcRenderer.invoke('setup:is-chatterbox-downloaded'),
  
  // Start Chatterbox download
  downloadChatterbox: () => ipcRenderer.invoke('setup:download-chatterbox'),
  
  // Chatterbox download events
  onChatterboxStart: (callback: (data: { name: string; totalMb: number }) => void) => {
    ipcRenderer.on('setup:chatterbox-start', (_event, data) => callback(data));
  },
  
  onChatterboxProgress: (callback: (data: { downloadedMb: number; totalMb: number }) => void) => {
    ipcRenderer.on('setup:chatterbox-progress', (_event, data) => callback(data));
  },
  
  onChatterboxComplete: (callback: () => void) => {
    ipcRenderer.on('setup:chatterbox-complete', () => callback());
  },
  
  onChatterboxError: (callback: (data: { error: string }) => void) => {
    ipcRenderer.on('setup:chatterbox-error', (_event, data) => callback(data));
  },
  
  // Save selected Chatterbox voice
  setChatterboxVoice: (voiceId: string) => ipcRenderer.invoke('setup:set-chatterbox-voice', voiceId),
  
  // Complete Chatterbox setup (triggers model switch)
  completeChatterboxSetup: () => ipcRenderer.invoke('setup:complete-chatterbox-setup'),
  
  // ============================================
  // VOICE PREVIEW (Real TTS)
  // ============================================
  
  // Preview a voice with text - returns audio data
  previewVoice: (voice: string, text: string) => ipcRenderer.invoke('setup:preview-voice', voice, text),
  
  // Stop any playing preview
  stopPreview: () => ipcRenderer.invoke('setup:stop-preview'),
  
  // Save selected voice
  setVoice: (voice: string) => ipcRenderer.invoke('setup:set-voice', voice),
  
  // Get available voices
  getVoices: () => ipcRenderer.invoke('setup:get-voices'),
  
  // ============================================
  // SETUP LIFECYCLE
  // ============================================
  
  // Mark setup as complete
  completeSetup: () => ipcRenderer.invoke('setup:complete'),
  
  // Close setup window and launch main app
  finishAndLaunch: () => ipcRenderer.invoke('setup:finish-and-launch'),
  
  // Restart the app (for permission refresh)
  restartApp: () => ipcRenderer.invoke('setup:restart-app'),
  
  // Remove listeners when done
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('setup:download-init');
    ipcRenderer.removeAllListeners('setup:phase');
    ipcRenderer.removeAllListeners('setup:model-start');
    ipcRenderer.removeAllListeners('setup:progress');
    ipcRenderer.removeAllListeners('setup:model-complete');
    ipcRenderer.removeAllListeners('setup:all-complete');
    ipcRenderer.removeAllListeners('setup:error');
    ipcRenderer.removeAllListeners('setup:chatterbox-start');
    ipcRenderer.removeAllListeners('setup:chatterbox-progress');
    ipcRenderer.removeAllListeners('setup:chatterbox-complete');
    ipcRenderer.removeAllListeners('setup:chatterbox-error');
  }
});

// Type declaration for window
declare global {
  interface Window {
    setupAPI: {
      // Downloads
      getDownloadStatus: () => Promise<{ modelsDownloaded: boolean; isDownloading: boolean }>;
      startDownloads: () => Promise<boolean>;
      onDownloadInit: (callback: (data: { totalModels: number }) => void) => void;
      onPhase: (callback: (data: { phase: string; package?: string; detail?: string }) => void) => void;
      onModelStart: (callback: (data: { model: string; name: string; totalMb: number }) => void) => void;
      onProgress: (callback: (data: { model: string; name: string; downloadedMb: number; totalMb: number }) => void) => void;
      onModelComplete: (callback: (data: { model: string; name: string; cached: boolean }) => void) => void;
      onAllComplete: (callback: () => void) => void;
      onError: (callback: (data: { error: string }) => void) => void;
      // Permissions
      getMicrophoneStatus: () => Promise<'granted' | 'denied' | 'restricted' | 'not-determined'>;
      requestMicrophone: () => Promise<boolean>;
      getAccessibilityStatus: () => Promise<boolean>;
      requestAccessibility: () => Promise<boolean>;
      openSystemSettings: (pane: string) => Promise<void>;
      // Chatterbox Download
      isChatterboxDownloaded: () => Promise<boolean>;
      downloadChatterbox: () => Promise<{ success: boolean; error?: string }>;
      onChatterboxStart: (callback: (data: { name: string; totalMb: number }) => void) => void;
      onChatterboxProgress: (callback: (data: { downloadedMb: number; totalMb: number }) => void) => void;
      onChatterboxComplete: (callback: () => void) => void;
      onChatterboxError: (callback: (data: { error: string }) => void) => void;
      setChatterboxVoice: (voiceId: string) => Promise<void>;
      completeChatterboxSetup: () => Promise<{ success: boolean }>;
      // Voice Preview
      previewVoice: (voice: string, text: string) => Promise<{ success: boolean; audioBase64?: string; error?: string }>;
      stopPreview: () => Promise<void>;
      setVoice: (voice: string) => Promise<void>;
      getVoices: () => Promise<Array<{ id: string; name: string; description: string }>>;
      // Lifecycle
      completeSetup: () => Promise<void>;
      finishAndLaunch: () => Promise<void>;
      restartApp: () => Promise<void>;
      removeAllListeners: () => void;
    };
  }
}
