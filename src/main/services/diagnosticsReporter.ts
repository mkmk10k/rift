/**
 * Remote diagnostics reporter.
 *
 * Sends crash/error diagnostics to the Rift diagnostics Worker so Mikko can
 * triage issues without asking users to copy-paste into GitHub issues.
 */

import { app } from 'electron';
import * as os from 'os';

const DIAGNOSTICS_URL = 'https://rift-diagnostics.mikko-sj-kiiskila.workers.dev/report';
const TIMEOUT_MS = 10_000;

export interface ReportResult {
  success: boolean;
  id?: string;
  message?: string;
  error?: string;
}

/**
 * Send diagnostics to the remote endpoint.
 * Returns quickly — never blocks the error dialog UX.
 */
export async function sendDiagnostics(
  diagnostics: string,
  errorContext?: string,
): Promise<ReportResult> {
  const payload = {
    diagnostics,
    appVersion: app.getVersion(),
    osVersion: os.release(),
    arch: os.arch(),
    error: errorContext || '',
    timestamp: new Date().toISOString(),
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(DIAGNOSTICS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { success: false, error: `Server returned ${res.status}: ${body}` };
    }

    const json = await res.json() as { ok: boolean; id?: string; message?: string };
    return { success: true, id: json.id, message: json.message };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}
