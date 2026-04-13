#!/usr/bin/env npx ts-node
/**
 * Contract test: stub download script stdout → same parsing as ModelDownloadService.
 *
 * Validates that a "slow" download produces multiple progress events (user in the loop),
 * phase lines, and snake_case → normalized MB fields — without Hugging Face.
 *
 * Run: npx ts-node test-engine/model-download-contract-test.ts
 *      bun test-engine/model-download-contract-test.ts
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { normalizePythonDownloadEvent, type DownloadEvent } from '../src/main/services/modelDownloadParsing';

const ROOT = path.join(__dirname, '..');
const STUB = path.join(ROOT, 'python', 'ci_download_progress_stub.py');

function fail(msg: string): never {
  console.error('CONTRACT FAIL:', msg);
  process.exit(1);
}

function runStub(): Promise<DownloadEvent[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [STUB, '--fast'], {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let buf = '';
    const events: DownloadEvent[] = [];

    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as Record<string, unknown>;
          events.push(normalizePythonDownloadEvent(raw));
        } catch {
          fail(`non-JSON line: ${line.slice(0, 120)}`);
        }
      }
    });

    proc.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`stub exited ${code}`));
        return;
      }
      resolve(events);
    });
  });
}

async function main(): Promise<void> {
  const events = await runStub();

  const phases = events.filter((e) => e.type === 'phase');
  if (phases.length < 2) {
    fail(`expected multiple phase events, got ${phases.length}`);
  }

  const init = events.find((e) => e.type === 'init');
  if (!init || init.totalModels !== 2) {
    fail(`expected init with total_models=2, got ${JSON.stringify(init)}`);
  }

  const byModel: Record<string, DownloadEvent[]> = {};
  for (const e of events) {
    if (e.model) {
      if (!byModel[e.model]) byModel[e.model] = [];
      byModel[e.model].push(e);
    }
  }

  for (const modelId of ['TTS', 'STT']) {
    const list = byModel[modelId];
    if (!list) fail(`missing events for ${modelId}`);

    const starts = list.filter((e) => e.type === 'start');
    const progresses = list.filter((e) => e.type === 'progress');
    const completes = list.filter((e) => e.type === 'complete');

    if (starts.length !== 1) fail(`${modelId}: expected 1 start`);
    if (completes.length !== 1) fail(`${modelId}: expected 1 complete`);
    if (progresses.length < 3) {
      fail(`${modelId}: expected >=3 progress ticks (UI would look frozen), got ${progresses.length}`);
    }

    const start = starts[0];
    if (start.sizeMb <= 0) fail(`${modelId}: start.sizeMb should be >0 (tray total MB)`);

    let last = -1;
    for (const p of progresses) {
      if (p.downloadedMb < last) {
        fail(`${modelId}: progress not monotonic ${last} -> ${p.downloadedMb}`);
      }
      last = p.downloadedMb;
      if (p.totalMb !== start.sizeMb && p.totalMb > 0) {
        /* allow */
      }
    }
    const lastP = progresses[progresses.length - 1];
    if (lastP.downloadedMb < start.sizeMb) {
      fail(`${modelId}: final progress should reach size_mb`);
    }
  }

  if (!events.some((e) => e.type === 'all_complete')) {
    fail('missing all_complete');
  }

  console.log(
    `OK: ${events.length} events — phases=${phases.length}, progress density per model OK, snake_case normalized`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
