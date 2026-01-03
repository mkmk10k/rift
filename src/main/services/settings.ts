// Dynamic import to avoid circular dependency with electron.app
// electron-store accesses app on require, causing issues at startup

export interface AppSettings {
  playbackSpeed: number;
  dictationMode: 'toggle' | 'hold';
  launchAtLogin: boolean;
  setupComplete: boolean;
  pythonPath: string | null;
  // Streaming STT settings
  showLivePreview: boolean;
  livePasteMode: boolean;
  autoSendAfterDictation: boolean;
  
  // ═══════════════════════════════════════════════════════════════════════════
  // LLM Settings - Qwen3 Text Enhancement for Live Paste
  // ═══════════════════════════════════════════════════════════════════════════
  // 
  // Controls AI-powered text enhancement features.
  // When disabled, Live Paste uses heuristic-only processing (still works well).
  // 
  // Phase 2: Intelligent merge - helps when anchor detection fails
  // Phase 3: Rolling correction - cleans up previous sentences during speech
  // Phase 4: Final polish - full cleanup when recording stops
  // ═══════════════════════════════════════════════════════════════════════════
  
  /** Enable AI-enhanced Live Paste (uses Qwen3 LLM locally) */
  llmEnabled: boolean;
  
  /** 
   * Polish mode for final cleanup:
   * - verbatim: Keep filler words, minimal changes (legal/medical)
   * - clean: Remove filler words, fix punctuation (default)
   * - professional: Full grammar and style polish (business writing)
   */
  llmPolishMode: 'verbatim' | 'clean' | 'professional';
  
  /** Remove filler words like "um", "uh", "like" */
  llmRemoveFillerWords: boolean;
  
  /** Enable rolling sentence correction during speech */
  llmRollingCorrection: boolean;
}

const defaults: AppSettings = {
  playbackSpeed: 1.0,
  dictationMode: 'toggle',
  launchAtLogin: false,
  setupComplete: false,
  pythonPath: null,
  // Streaming defaults - ON for magical experience
  showLivePreview: true,     // Show transcription as you speak
  livePasteMode: true,       // Words appear as you speak
  autoSendAfterDictation: false,  // Don't auto-send (too aggressive)
  
  // LLM defaults - enabled for enhanced experience
  llmEnabled: true,           // Use AI for improved accuracy
  llmPolishMode: 'clean',     // Remove filler words, fix punctuation
  llmRemoveFillerWords: true, // Remove "um", "uh", "like"
  llmRollingCorrection: true, // Correct previous sentences during speech
};

// Store instance - initialized lazily
let _store: any = null;
let _storeModule: any = null;

function getStore(): any {
  if (!_store) {
    // Dynamic require to delay loading until electron.app is ready
    if (!_storeModule) {
      _storeModule = require('electron-store');
    }
    const Store = _storeModule.default || _storeModule;
    _store = new Store({
      name: 'rift-settings',
      defaults,
    });
  }
  return _store;
}

// Migration: Ensure new "magical" defaults are applied for existing users
let _migrated = false;
function migrateSettings(): void {
  if (_migrated) return;
  _migrated = true;
  
  const store = getStore();
  
  // If livePasteMode was explicitly set to false from old behavior,
  // and we haven't migrated yet, keep it. But for fresh installs
  // or users who never set it, ensure it's true.
  // We use a migration flag to avoid overwriting user preference.
  // v3: Force live paste mode ON with Parakeet switch
  const migrationKey = '_livePasteMigrated_v3';
  if (!store.get(migrationKey)) {
    // Set the new defaults for the "magical" experience
    store.set('livePasteMode', true);
    store.set('showLivePreview', true);
    store.set('dictationMode', 'toggle'); // Toggle mode is more intuitive
    store.set(migrationKey, true);
  }
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  migrateSettings();
  return getStore().get(key);
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  getStore().set(key, value);
}

export function getAllSettings(): AppSettings {
  return getStore().store;
}

export function resetSettings(): void {
  getStore().clear();
}
