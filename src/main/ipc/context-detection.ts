/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Context Detection for Code Talk TTS Transform
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Pure functions for detecting app context and choosing TTS speech mode.
 * These are separated from handlers.ts to allow headless testing without Electron.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export interface AppContext {
  appName: string;
  windowTitle: string;
  url: string;
}

export type TTSSpeechMode = 'developer' | 'conversational' | 'default';

/**
 * Detect which speech mode to use based on the active app context.
 * This is a PURE FUNCTION that can be unit tested without AppleScript.
 */
export function detectSpeechMode(context: AppContext): TTSSpeechMode {
  const { appName, windowTitle, url } = context;
  const appLower = appName.toLowerCase();
  const titleLower = windowTitle.toLowerCase();
  const urlLower = url.toLowerCase();
  
  // Developer IDEs and editors
  const developerApps = [
    'cursor', 'code', 'vscode', 'visual studio',
    'xcode', 'intellij', 'webstorm', 'pycharm', 'goland', 'rubymine',
    'android studio', 'sublime', 'atom', 'vim', 'nvim', 'neovim', 'emacs',
    'terminal', 'iterm', 'warp', 'hyper', 'kitty', 'alacritty',
  ];
  
  if (developerApps.some(app => appLower.includes(app))) {
    return 'developer';
  }
  
  // Developer websites (check URL)
  const developerDomains = [
    'github.com', 'gitlab.com', 'bitbucket.org',
    'stackoverflow.com', 'stackexchange.com',
    'developer.apple.com', 'developer.android.com', 'developer.mozilla.org',
    'docs.', 'npmjs.com', 'pypi.org', 'crates.io', 'rubygems.org',
    'kubernetes.io', 'docker.com', 'terraform.io', 'aws.amazon.com/documentation',
    'learn.microsoft.com', 'cloud.google.com/docs',
  ];
  
  if (developerDomains.some(domain => urlLower.includes(domain))) {
    return 'developer';
  }
  
  // Code-related window titles
  const codePatterns = [
    '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.swift', '.kt',
    '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.vue', '.svelte',
    'pull request', 'merge request', 'commit', 'diff', 'branch',
  ];
  
  if (codePatterns.some(pattern => titleLower.includes(pattern))) {
    return 'developer';
  }
  
  // Communication apps - use conversational mode
  const conversationalApps = [
    'slack', 'discord', 'teams', 'zoom', 'messages', 'mail', 'outlook',
    'telegram', 'whatsapp', 'signal',
  ];
  
  if (conversationalApps.some(app => appLower.includes(app))) {
    return 'conversational';
  }
  
  // Default mode for everything else
  return 'default';
}
