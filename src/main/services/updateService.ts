import { app, dialog, shell } from 'electron';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Update Service for Rift
 * 
 * Checks GitHub Releases for new versions and downloads updates.
 * Since the app is unsigned, we download the DMG and reveal it in Finder
 * for the user to install manually.
 */

// Configure your GitHub repository here
const GITHUB_OWNER = 'mkmk10k';
const GITHUB_REPO = 'rift';

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  downloadUrl?: string;
  releaseUrl?: string;
}

/**
 * Compare two version strings (supports YYYY.MM.DD+hash format)
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 * 
 * For same-day releases: if dates match but hashes differ, v1 is considered newer
 * (assumes v1 is the latest release from GitHub)
 */
function compareVersions(v1: string, v2: string): number {
  // Parse version and hash
  const [date1, hash1] = v1.replace(/^v/, '').split('+');
  const [date2, hash2] = v2.replace(/^v/, '').split('+');
  
  const parts1 = date1.split('.').map(Number);
  const parts2 = date2.split('.').map(Number);
  
  // Compare date parts
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  
  // Dates are equal - check if hashes differ (same-day release)
  if (hash1 && hash2 && hash1 !== hash2) {
    // Different commits on same day = newer release available
    return 1;
  }
  
  return 0;
}

/**
 * Fetch the latest release from GitHub
 */
async function fetchLatestRelease(): Promise<GitHubRelease> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      headers: {
        'User-Agent': `Rift/${app.getVersion()}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    };

    const req = https.get(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Failed to parse release data'));
          }
        } else if (res.statusCode === 404) {
          reject(new Error('No releases found. Please create a GitHub release first.'));
        } else {
          reject(new Error(`GitHub API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error(`Network error: ${e.message}`));
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Find the DMG asset for the current architecture
 */
function findDmgAsset(release: GitHubRelease): { name: string; url: string } | null {
  const arch = process.arch; // 'arm64' or 'x64'
  
  // Look for DMG matching current architecture
  const dmgAsset = release.assets.find(asset => {
    const name = asset.name.toLowerCase();
    return name.endsWith('.dmg') && 
           (name.includes(arch) || name.includes('arm64') || !name.includes('x64'));
  });
  
  if (dmgAsset) {
    return { name: dmgAsset.name, url: dmgAsset.browser_download_url };
  }
  
  // Fallback: any DMG
  const anyDmg = release.assets.find(asset => 
    asset.name.toLowerCase().endsWith('.dmg')
  );
  
  if (anyDmg) {
    return { name: anyDmg.name, url: anyDmg.browser_download_url };
  }
  
  return null;
}

/**
 * Download a file from URL to the Downloads folder
 */
async function downloadFile(url: string, filename: string): Promise<string> {
  const downloadsPath = path.join(os.homedir(), 'Downloads');
  const destPath = path.join(downloadsPath, filename);
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    
    const request = (downloadUrl: string) => {
      https.get(downloadUrl, (res) => {
        // Handle redirects (GitHub uses them for asset downloads)
        if (res.statusCode === 302 || res.statusCode === 301) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            request(redirectUrl);
            return;
          }
        }
        
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`Download failed: ${res.statusCode}`));
          return;
        }
        
        res.pipe(file);
        
        file.on('finish', () => {
          file.close();
          resolve(destPath);
        });
      }).on('error', (e) => {
        file.close();
        fs.unlinkSync(destPath);
        reject(new Error(`Download error: ${e.message}`));
      });
    };
    
    request(url);
  });
}

/**
 * Check for updates - main entry point
 * @param showNoUpdateDialog - If true, shows a dialog even when no update is available
 */
export async function checkForUpdates(showNoUpdateDialog: boolean = false): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  
  try {
    console.log('[Rift Update] Checking for updates...');
    const release = await fetchLatestRelease();
    const latestVersion = release.tag_name.replace(/^v/, '');
    
    const result: UpdateCheckResult = {
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      currentVersion,
      latestVersion,
      releaseNotes: release.body,
      releaseUrl: release.html_url,
    };
    
    const dmgAsset = findDmgAsset(release);
    if (dmgAsset) {
      result.downloadUrl = dmgAsset.url;
    }
    
    console.log(`[Rift Update] Current: ${currentVersion}, Latest: ${latestVersion}, Update available: ${result.updateAvailable}`);
    
    if (result.updateAvailable) {
      await showUpdateAvailableDialog(result, dmgAsset?.name);
    } else if (showNoUpdateDialog) {
      dialog.showMessageBox({
        type: 'info',
        title: 'No Updates Available',
        message: 'You\'re up to date!',
        detail: `Rift ${currentVersion} is the latest version.`,
        buttons: ['OK'],
      });
    }
    
    return result;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Rift Update] Error checking for updates:', errorMessage);
    
    if (showNoUpdateDialog) {
      dialog.showMessageBox({
        type: 'error',
        title: 'Update Check Failed',
        message: 'Could not check for updates',
        detail: errorMessage,
        buttons: ['OK'],
      });
    }
    
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
    };
  }
}

/**
 * Show dialog when update is available
 */
async function showUpdateAvailableDialog(
  result: UpdateCheckResult,
  dmgFilename?: string
): Promise<void> {
  const releaseNotes = result.releaseNotes 
    ? `\n\nRelease Notes:\n${result.releaseNotes.slice(0, 500)}${result.releaseNotes.length > 500 ? '...' : ''}`
    : '';
  
  const buttons = result.downloadUrl 
    ? ['Download Update', 'View Release', 'Later']
    : ['View Release', 'Later'];
  
  const response = await dialog.showMessageBox({
    type: 'info',
    title: 'Update Available',
    message: `Rift ${result.latestVersion} is available!`,
    detail: `You're currently running version ${result.currentVersion}.${releaseNotes}`,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  
  if (result.downloadUrl && response.response === 0) {
    // Download Update
    await downloadAndReveal(result.downloadUrl, dmgFilename || 'Rift-update.dmg');
  } else if ((result.downloadUrl && response.response === 1) || (!result.downloadUrl && response.response === 0)) {
    // View Release
    if (result.releaseUrl) {
      shell.openExternal(result.releaseUrl);
    }
  }
  // "Later" does nothing
}

/**
 * Download the update and reveal in Finder
 */
async function downloadAndReveal(url: string, filename: string): Promise<void> {
  const progressDialog = dialog.showMessageBox({
    type: 'info',
    title: 'Downloading Update',
    message: 'Downloading Rift update...',
    detail: 'Please wait while the update is downloaded.',
    buttons: [],
  });
  
  try {
    console.log('[Rift Update] Downloading:', url);
    const filePath = await downloadFile(url, filename);
    console.log('[Rift Update] Downloaded to:', filePath);
    
    // Show success and reveal in Finder
    const response = await dialog.showMessageBox({
      type: 'info',
      title: 'Download Complete',
      message: 'Update downloaded successfully!',
      detail: `The update has been saved to your Downloads folder.\n\nTo install:\n1. Open the DMG file\n2. Drag Rift to Applications\n3. Replace the existing app when prompted`,
      buttons: ['Show in Finder', 'OK'],
      defaultId: 0,
    });
    
    if (response.response === 0) {
      shell.showItemInFolder(filePath);
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Rift Update] Download failed:', errorMessage);
    
    dialog.showMessageBox({
      type: 'error',
      title: 'Download Failed',
      message: 'Could not download the update',
      detail: errorMessage,
      buttons: ['OK'],
    });
  }
}
