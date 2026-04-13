/**
 * Pure parsing for download_models.py stdout JSON (no Electron).
 * Shared by ModelDownloadService and CI contract tests.
 */

export type DownloadEventType =
  | 'init'
  | 'start'
  | 'progress'
  | 'complete'
  | 'cached'
  | 'error'
  | 'all_complete'
  | 'partial_complete'
  | 'phase';

export interface DownloadEvent {
  type: DownloadEventType;
  model?: string;
  name?: string;
  downloadedMb?: number;
  totalMb?: number;
  sizeMb?: number;
  totalModels?: number;
  error?: string;
  phase?: string;
  package?: string;
  detail?: string;
}

export function readNumericField(raw: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = raw[k];
    if (v !== undefined && v !== null) {
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
}

/** Normalize Python stdout JSON (snake_case) to internal camelCase-style fields. */
export function normalizePythonDownloadEvent(raw: Record<string, unknown>): DownloadEvent {
  const type = raw.type as DownloadEvent['type'];
  return {
    type,
    model: (raw.model as string) || undefined,
    name: (raw.name as string) || undefined,
    downloadedMb: readNumericField(raw, ['downloaded_mb', 'downloadedMb']),
    totalMb: readNumericField(raw, ['total_mb', 'totalMb']),
    sizeMb: readNumericField(raw, ['size_mb', 'sizeMb']),
    totalModels: readNumericField(raw, ['total_models', 'totalModels']),
    error: (raw.error as string) || undefined,
    phase: (raw.phase as string) || undefined,
    package: (raw.package as string) || undefined,
    detail: (raw.detail as string) || undefined,
  };
}
