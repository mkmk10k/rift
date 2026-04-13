#!/usr/bin/env npx ts-node
/**
 * Model Comparison Runner
 *
 * Runs the full LLM eval suite against multiple model configs sequentially,
 * collects per-model results, and outputs a comparison JSON for the website.
 *
 * USAGE:
 *   npx ts-node test-engine/model-comparison.ts                      # All models
 *   npx ts-node test-engine/model-comparison.ts --models qwen3,gemma4-e4b
 *   npx ts-node test-engine/model-comparison.ts --skip-download      # Skip HF download step
 *
 * OUTPUT:
 *   test-engine/model-comparison-results.json
 *   website/evals-data.json (model comparison section appended)
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ALL_MODELS = ['qwen3', 'gemma4-e4b', 'gemma4-e4b-6bit', 'gemma4-moe'];

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'qwen3': 'Qwen3 4B (baseline)',
  'gemma4-e4b': 'Gemma 4 E4B 4-bit',
  'gemma4-e4b-6bit': 'Gemma 4 E4B 6-bit',
  'gemma4-moe': 'Gemma 4 26B MoE 4-bit',
};

const MODEL_REPOS: Record<string, string> = {
  'qwen3': 'mlx-community/Qwen3-4B-4bit',
  'gemma4-e4b': 'mlx-community/gemma-4-e4b-it-4bit',
  'gemma4-e4b-6bit': 'mlx-community/gemma-4-e4b-it-6bit',
  'gemma4-moe': 'mlx-community/gemma-4-26b-a4b-it-4bit',
};

const PYTHON_PATH = process.env.RIFT_PYTHON_PATH || '/tmp/rift-mlx-env/bin/python3';
const RESULTS_FILE = path.join(__dirname, 'model-comparison-results.json');
const WEBSITE_EVALS = path.join(__dirname, '..', 'website', 'evals-data.json');
const LATEST_RESULTS = path.join(__dirname, 'latest-results.json');

interface ModelResult {
  model: string;
  displayName: string;
  repo: string;
  timestamp: string;
  passRate: number;
  passed: number;
  total: number;
  avgLatencyMs: number;
  phase2PassRate: number;
  phase3PassRate: number;
  phase4PassRate: number;
  ttsTransformPassRate: number | null;
  ttsTransformAvgLatencyMs: number | null;
  serverStartupMs: number;
  errors: string[];
}

interface ComparisonReport {
  generated: string;
  models: ModelResult[];
  winner: string | null;
  winnerReason: string;
  recommendations: string[];
}

function downloadModel(repo: string): boolean {
  console.log(`\n  Downloading ${repo}...`);
  try {
    execSync(
      `${PYTHON_PATH} -c "from huggingface_hub import snapshot_download; snapshot_download('${repo}')"`,
      { stdio: 'inherit', timeout: 600000 }
    );
    return true;
  } catch (e: any) {
    console.error(`  Failed to download ${repo}: ${e.message}`);
    return false;
  }
}

function runEvalsForModel(modelConfig: string): Promise<ModelResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const displayName = MODEL_DISPLAY_NAMES[modelConfig] || modelConfig;
    const repo = MODEL_REPOS[modelConfig] || '';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  Running evals for: ${displayName}`);
    console.log(`  Config: ${modelConfig} | Repo: ${repo}`);
    console.log(`${'═'.repeat(60)}\n`);

    const child = spawn(
      'npx',
      ['ts-node', 'test-engine/llm-runner.ts', '--model', modelConfig, '--label', `comparison-${modelConfig}`],
      {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, RIFT_MODEL_CONFIG: modelConfig, SKIP_TTS_TRANSFORM: '1' },
      }
    );

    let stdout = '';
    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.on('close', (code) => {
      const elapsed = Date.now() - startTime;
      const result: ModelResult = {
        model: modelConfig,
        displayName,
        repo,
        timestamp: new Date().toISOString(),
        passRate: 0,
        passed: 0,
        total: 0,
        avgLatencyMs: 0,
        phase2PassRate: 0,
        phase3PassRate: 0,
        phase4PassRate: 0,
        ttsTransformPassRate: null,
        ttsTransformAvgLatencyMs: null,
        serverStartupMs: 0,
        errors: [],
      };

      if (code !== 0 && code !== 1) {
        result.errors.push(`Process exited with code ${code}`);
      }

      // Parse the agent summary from stdout
      const passRateMatch = stdout.match(/PASS_RATE:\s*([\d.]+)%/);
      const totalMatch = stdout.match(/TOTAL:\s*(\d+)\/(\d+)/);
      const phase2Match = stdout.match(/PHASE_2:\s*(\d+)\/(\d+)/);
      const phase3Match = stdout.match(/PHASE_3:\s*(\d+)\/(\d+)/);
      const phase4Match = stdout.match(/PHASE_4:\s*(\d+)\/(\d+)/);
      const latencyMatch = stdout.match(/AVG_LATENCY_MS:\s*([\d.]+)/);

      if (passRateMatch) result.passRate = parseFloat(passRateMatch[1]);
      if (totalMatch) {
        result.passed = parseInt(totalMatch[1]);
        result.total = parseInt(totalMatch[2]);
      }
      if (phase2Match) result.phase2PassRate = parseInt(phase2Match[1]) / parseInt(phase2Match[2]) * 100;
      if (phase3Match) result.phase3PassRate = parseInt(phase3Match[1]) / parseInt(phase3Match[2]) * 100;
      if (phase4Match) result.phase4PassRate = parseInt(phase4Match[1]) / parseInt(phase4Match[2]) * 100;
      if (latencyMatch) result.avgLatencyMs = parseFloat(latencyMatch[1]);

      // Also read from latest-results.json for more detail
      try {
        if (fs.existsSync(LATEST_RESULTS)) {
          const latest = JSON.parse(fs.readFileSync(LATEST_RESULTS, 'utf-8'));
          if (latest.modelConfig === modelConfig) {
            const llmLatencies = (latest.llmResults || [])
              .map((r: any) => r.latencyMs)
              .filter((l: number) => l > 0);
            if (llmLatencies.length > 0) {
              result.avgLatencyMs = llmLatencies.reduce((a: number, b: number) => a + b, 0) / llmLatencies.length;
            }
          }
        }
      } catch {}

      console.log(`\n  ${displayName}: ${result.passRate}% pass rate, ${Math.round(result.avgLatencyMs)}ms avg latency (${Math.round(elapsed / 1000)}s total)`);
      resolve(result);
    });

    child.on('error', (err) => {
      resolve({
        model: modelConfig,
        displayName,
        repo,
        timestamp: new Date().toISOString(),
        passRate: 0,
        passed: 0,
        total: 0,
        avgLatencyMs: 0,
        phase2PassRate: 0,
        phase3PassRate: 0,
        phase4PassRate: 0,
        ttsTransformPassRate: null,
        ttsTransformAvgLatencyMs: null,
        serverStartupMs: 0,
        errors: [err.message],
      });
    });
  });
}

function determineWinner(results: ModelResult[]): { winner: string | null; reason: string } {
  const valid = results.filter(r => r.errors.length === 0 && r.total > 0);
  if (valid.length === 0) return { winner: null, reason: 'No valid results' };

  // Sort by: pass rate (desc), then latency (asc)
  valid.sort((a, b) => {
    if (Math.abs(a.passRate - b.passRate) > 2) return b.passRate - a.passRate;
    return a.avgLatencyMs - b.avgLatencyMs;
  });

  const best = valid[0];
  const baseline = results.find(r => r.model === 'qwen3');

  if (baseline && best.model !== 'qwen3') {
    const passRateDiff = best.passRate - baseline.passRate;
    const latencyRatio = best.avgLatencyMs / Math.max(baseline.avgLatencyMs, 1);

    if (passRateDiff > 2) {
      return {
        winner: best.model,
        reason: `${best.displayName} wins with ${best.passRate.toFixed(1)}% pass rate (+${passRateDiff.toFixed(1)}% vs baseline)`,
      };
    } else if (passRateDiff >= -2 && latencyRatio < 0.9) {
      return {
        winner: best.model,
        reason: `${best.displayName} matches quality (${best.passRate.toFixed(1)}%) with ${((1 - latencyRatio) * 100).toFixed(0)}% lower latency`,
      };
    } else {
      return {
        winner: 'qwen3',
        reason: `Qwen3 baseline holds: ${baseline.passRate.toFixed(1)}% pass rate. Best challenger ${best.displayName} at ${best.passRate.toFixed(1)}%`,
      };
    }
  }

  return { winner: best.model, reason: `${best.displayName}: ${best.passRate.toFixed(1)}% pass rate` };
}

function generateRecommendations(results: ModelResult[]): string[] {
  const recs: string[] = [];
  const baseline = results.find(r => r.model === 'qwen3');

  for (const r of results) {
    if (r.model === 'qwen3' || r.errors.length > 0) continue;
    if (!baseline) continue;

    const passDiff = r.passRate - baseline.passRate;
    const latencyRatio = r.avgLatencyMs / Math.max(baseline.avgLatencyMs, 1);

    if (passDiff > 5) {
      recs.push(`${r.displayName} shows significant quality improvement (+${passDiff.toFixed(1)}%). Consider as new default.`);
    } else if (passDiff < -5) {
      recs.push(`${r.displayName} underperforms baseline by ${Math.abs(passDiff).toFixed(1)}%. Not recommended.`);
    }

    if (latencyRatio > 2) {
      recs.push(`${r.displayName} is ${latencyRatio.toFixed(1)}x slower than baseline. May impact UX.`);
    }

    if (r.errors.length > 0) {
      recs.push(`${r.displayName} had errors: ${r.errors.join('; ')}`);
    }
  }

  if (recs.length === 0) {
    recs.push('All models performed within expected ranges.');
  }

  return recs;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`
Model Comparison Runner
═══════════════════════

Usage:
  npx ts-node test-engine/model-comparison.ts [options]

Options:
  --models <list>     Comma-separated model configs (default: all)
  --skip-download     Skip model download step
  --help              Show this help
`);
    process.exit(0);
  }

  let models = [...ALL_MODELS];
  const modelsIdx = args.indexOf('--models');
  if (modelsIdx >= 0 && args[modelsIdx + 1]) {
    models = args[modelsIdx + 1].split(',').map(m => m.trim());
    for (const m of models) {
      if (!ALL_MODELS.includes(m)) {
        console.error(`Unknown model: ${m}. Available: ${ALL_MODELS.join(', ')}`);
        process.exit(1);
      }
    }
  }

  const skipDownload = args.includes('--skip-download');

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              MODEL COMPARISON BENCHMARK                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\nModels to benchmark: ${models.join(', ')}`);
  console.log(`Download: ${skipDownload ? 'skipped' : 'enabled'}\n`);

  // Download models first
  if (!skipDownload) {
    console.log('─── Downloading models ───');
    for (const model of models) {
      const repo = MODEL_REPOS[model];
      if (repo) {
        downloadModel(repo);
      }
    }
  }

  // Run evals for each model sequentially
  const results: ModelResult[] = [];
  for (const model of models) {
    const result = await runEvalsForModel(model);
    results.push(result);
  }

  // Determine winner
  const { winner, reason } = determineWinner(results);
  const recommendations = generateRecommendations(results);

  // Build comparison report
  const report: ComparisonReport = {
    generated: new Date().toISOString(),
    models: results,
    winner,
    winnerReason: reason,
    recommendations,
  };

  // Save results
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(report, null, 2));
  console.log(`\nResults saved to: ${RESULTS_FILE}`);

  // Also inject into website evals-data.json if it exists
  try {
    if (fs.existsSync(WEBSITE_EVALS)) {
      const evalsData = JSON.parse(fs.readFileSync(WEBSITE_EVALS, 'utf-8'));
      evalsData.modelComparison = {
        generated: report.generated,
        models: results.map(r => ({
          name: r.displayName,
          config: r.model,
          repo: r.repo,
          passRate: r.passRate,
          passed: r.passed,
          total: r.total,
          avgLatencyMs: Math.round(r.avgLatencyMs),
          phase2: r.phase2PassRate,
          phase3: r.phase3PassRate,
          phase4: r.phase4PassRate,
          errors: r.errors,
        })),
        winner: winner ? MODEL_DISPLAY_NAMES[winner] || winner : null,
        winnerReason: reason,
      };
      fs.writeFileSync(WEBSITE_EVALS, JSON.stringify(evalsData, null, 2));
      console.log(`Updated: ${WEBSITE_EVALS}`);
    }
  } catch (e: any) {
    console.error(`Could not update website evals: ${e.message}`);
  }

  // Print summary
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    COMPARISON RESULTS                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Model                          Pass%   Latency   P2     P3     P4');
  console.log('─'.repeat(75));
  for (const r of results) {
    const name = r.displayName.padEnd(30);
    const pass = `${r.passRate.toFixed(1)}%`.padStart(6);
    const lat = `${Math.round(r.avgLatencyMs)}ms`.padStart(8);
    const p2 = `${r.phase2PassRate.toFixed(0)}%`.padStart(5);
    const p3 = `${r.phase3PassRate.toFixed(0)}%`.padStart(5);
    const p4 = `${r.phase4PassRate.toFixed(0)}%`.padStart(5);
    const marker = r.model === winner ? ' ★' : '';
    console.log(`${name} ${pass} ${lat}  ${p2}  ${p3}  ${p4}${marker}`);
  }

  console.log(`\nWinner: ${reason}`);
  console.log('\nRecommendations:');
  for (const rec of recommendations) {
    console.log(`  • ${rec}`);
  }

  // Exit with success even if some models failed
  const anySuccess = results.some(r => r.total > 0);
  process.exit(anySuccess ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
