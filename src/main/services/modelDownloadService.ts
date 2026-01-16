/**
 * Model Download Service
 * 
 * Manages first-run model downloads with progress tracking.
 * Spawns Python script and parses JSON progress events.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { getSetting, setSetting } from './settings';

export interface DownloadProgress {
  model: string;
  name: string;
  downloadedMb: number;
  totalMb: number;
}

export interface DownloadEvent {
  type: 'init' | 'start' | 'progress' | 'complete' | 'cached' | 'error' | 'all_complete' | 'partial_complete';
  model?: string;
  name?: string;
  downloadedMb?: number;
  totalMb?: number;
  sizeMb?: number;
  totalModels?: number;
  error?: string;
}

class ModelDownloadService extends EventEmitter {
  private downloadProcess: ChildProcess | null = null;
  private isDownloading = false;
  private currentModel: string | null = null;
  private currentProgress: DownloadProgress | null = null;

  /**
   * Check if models have been downloaded
   */
  areModelsDownloaded(): boolean {
    return getSetting('modelsDownloaded') === true;
  }

  /**
   * Mark models as downloaded
   */
  markModelsDownloaded(): void {
    setSetting('modelsDownloaded', true);
  }

  /**
   * Get current download progress (for tray menu display)
   */
  getCurrentProgress(): DownloadProgress | null {
    return this.currentProgress;
  }

  /**
   * Check if download is in progress
   */
  isDownloadInProgress(): boolean {
    return this.isDownloading;
  }

  /**
   * Get the Python path (bundled or system)
   */
  private getPythonPath(): string | null {
    if (app.isPackaged) {
      const bundledPath = path.join(process.resourcesPath, 'python', 'bin', 'python3.11');
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
      console.error('[ModelDownload] Bundled Python not found');
      return null;
    } else {
      // Development: check for local bundle first
      const devBundlePath = path.join(__dirname, '../../../../python-bundle/bin/python3.11');
      if (fs.existsSync(devBundlePath)) {
        return devBundlePath;
      }
      // Fallback to system Python
      const systemPaths = ['/opt/homebrew/bin/python3.11', '/usr/local/bin/python3.11', '/usr/bin/python3'];
      for (const p of systemPaths) {
        if (fs.existsSync(p)) return p;
      }
      return null;
    }
  }

  /**
   * Get the download script path
   */
  private getDownloadScriptPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'python', 'download_models.py');
    } else {
      return path.join(__dirname, '../../../../python/download_models.py');
    }
  }

  /**
   * Start downloading models
   * Returns a promise that resolves when all downloads complete
   */
  async downloadModels(): Promise<boolean> {
    if (this.isDownloading) {
      console.log('[ModelDownload] Download already in progress');
      return false;
    }

    const pythonPath = this.getPythonPath();
    if (!pythonPath) {
      console.error('[ModelDownload] Python not found');
      this.emit('error', { error: 'Python not found' });
      return false;
    }

    const scriptPath = this.getDownloadScriptPath();
    if (!fs.existsSync(scriptPath)) {
      console.error('[ModelDownload] Download script not found:', scriptPath);
      this.emit('error', { error: 'Download script not found' });
      return false;
    }

    console.log('[ModelDownload] Starting model downloads...');
    console.log('[ModelDownload] Python:', pythonPath);
    console.log('[ModelDownload] Script:', scriptPath);

    this.isDownloading = true;
    this.emit('start');

    return new Promise((resolve) => {
      this.downloadProcess = spawn(pythonPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
        },
      });

      let stdoutBuffer = '';

      this.downloadProcess.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        
        // Parse complete JSON lines
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const event = JSON.parse(line) as DownloadEvent;
              this.handleDownloadEvent(event);
            } catch (e) {
              console.log('[ModelDownload] Non-JSON output:', line);
            }
          }
        }
      });

      this.downloadProcess.stderr?.on('data', (data: Buffer) => {
        // Log stderr but don't parse it (just debug info)
        console.log('[ModelDownload]', data.toString().trim());
      });

      this.downloadProcess.on('close', (code) => {
        console.log('[ModelDownload] Process exited with code:', code);
        this.isDownloading = false;
        this.downloadProcess = null;
        this.currentProgress = null;

        if (code === 0) {
          this.markModelsDownloaded();
          this.emit('complete');
          resolve(true);
        } else {
          this.emit('error', { error: `Download process exited with code ${code}` });
          resolve(false);
        }
      });

      this.downloadProcess.on('error', (err) => {
        console.error('[ModelDownload] Process error:', err);
        this.isDownloading = false;
        this.downloadProcess = null;
        this.emit('error', { error: err.message });
        resolve(false);
      });
    });
  }

  /**
   * Handle a download event from the Python script
   */
  private handleDownloadEvent(event: DownloadEvent): void {
    console.log('[ModelDownload] Event:', event.type, event.model || '');

    switch (event.type) {
      case 'init':
        this.emit('init', { totalModels: event.totalModels });
        break;

      case 'start':
        this.currentModel = event.model || null;
        this.currentProgress = {
          model: event.model || '',
          name: event.name || '',
          downloadedMb: 0,
          totalMb: event.sizeMb || 0,
        };
        this.emit('modelStart', this.currentProgress);
        break;

      case 'progress':
        if (this.currentProgress) {
          this.currentProgress.downloadedMb = event.downloadedMb || 0;
          this.emit('progress', this.currentProgress);
        }
        break;

      case 'complete':
      case 'cached':
        this.emit('modelComplete', { model: event.model, name: event.name, cached: event.type === 'cached' });
        this.currentProgress = null;
        break;

      case 'error':
        this.emit('modelError', { model: event.model, error: event.error });
        break;

      case 'all_complete':
        this.emit('allComplete');
        break;

      case 'partial_complete':
        this.emit('partialComplete', { error: event.error });
        break;
    }
  }

  /**
   * Cancel ongoing download
   */
  cancelDownload(): void {
    if (this.downloadProcess) {
      console.log('[ModelDownload] Cancelling download...');
      this.downloadProcess.kill('SIGTERM');
      this.downloadProcess = null;
      this.isDownloading = false;
      this.currentProgress = null;
      this.emit('cancelled');
    }
  }
}

// Singleton instance
export const modelDownloadService = new ModelDownloadService();
