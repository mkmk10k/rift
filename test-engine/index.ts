#!/usr/bin/env npx ts-node
/**
 * Live Paste Test Engine - CLI Entry Point
 * 
 * Usage:
 *   npx ts-node test-engine/index.ts              # Run all tests
 *   npx ts-node test-engine/index.ts --phase 1    # Run Phase 1 tests only
 *   npx ts-node test-engine/index.ts --scenario quick-phrase  # Run specific scenario
 *   npx ts-node test-engine/index.ts --improve    # Self-improvement loop
 *   npx ts-node test-engine/index.ts --clear-cache # Clear audio cache
 */

import { execSync } from 'child_process';
import { scenarios, getScenarioById } from './scenarios';
import { runAllScenarios, runScenario, runPhaseScenarios, stopServer } from './runner';
import { analyzeResults, formatReport, saveReport, DiagnosticReport } from './analyzer';
import { clearCache } from './audio-generator';

/**
 * Kill any orphaned STT/TTS server processes from previous test runs
 * 
 * CRITICAL: This prevents memory accumulation from orphaned servers
 * that were left behind by interrupted test runs.
 * 
 * NOTE: We do NOT kill other test-engine processes here - that was causing
 * the test to kill itself. Instead, we only clean up orphaned Python servers.
 */
async function killOrphanedProcesses(): Promise<void> {
  try {
    // Only check for orphaned STT/TTS servers (not test-engines)
    const serverCheck = execSync(
      'ps aux | grep -E "python.*(stt_server|tts_server)" | grep -v grep | wc -l',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    
    const orphanedServers = parseInt(serverCheck, 10);
    
    if (orphanedServers > 0) {
      console.log(`[PreFlight] Found ${orphanedServers} existing server process(es), cleaning up...`);
      
      // Kill orphaned processes
      try { execSync('pkill -9 -f "python.*stt_server.py" 2>/dev/null || true', { stdio: 'pipe' }); } catch {}
      try { execSync('pkill -9 -f "python.*tts_server.py" 2>/dev/null || true', { stdio: 'pipe' }); } catch {}
      
      // Wait for processes to fully exit
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('[PreFlight] Cleanup complete');
    }
  } catch (e) {
    // Ignore errors - ps command might fail on some systems
  }
}

/**
 * Register cleanup handlers for SIGINT, SIGTERM, and SIGPIPE
 * 
 * CRITICAL: When piped to commands like `head -40` or `grep`, the pipe consumer
 * may exit early, sending SIGPIPE to this process. Without explicit signal handlers,
 * the `finally` block in main() won't run, leaving STT servers orphaned.
 * 
 * This prevents orphaned Python processes that consume memory indefinitely.
 */
function registerCleanupHandlers(): void {
  let isCleaningUp = false;
  
  const cleanup = (signal: string) => {
    if (isCleaningUp) return; // Prevent double cleanup
    isCleaningUp = true;
    
    console.log(`\n[Cleanup] ${signal} received, stopping servers...`);
    stopServer();
    process.exit(signal === 'SIGPIPE' ? 0 : 1);
  };
  
  process.on('SIGINT', () => cleanup('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => cleanup('SIGTERM')); // kill command
  process.on('SIGPIPE', () => cleanup('SIGPIPE')); // Pipe consumer exited (head, grep, etc.)
  
  // Also handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    console.error('[Cleanup] Uncaught exception:', err);
    stopServer();
    process.exit(1);
  });
  
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason) => {
    console.error('[Cleanup] Unhandled rejection:', reason);
    stopServer();
    process.exit(1);
  });
}

interface CLIOptions {
  phase?: 1 | 2 | 3 | 4;
  scenario?: string;
  improve?: boolean;
  maxIterations?: number;
  clearCache?: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--phase' && args[i + 1]) {
      options.phase = parseInt(args[i + 1], 10) as 1 | 2 | 3 | 4;
      i++;
    } else if (arg === '--scenario' && args[i + 1]) {
      options.scenario = args[i + 1];
      i++;
    } else if (arg === '--improve') {
      options.improve = true;
    } else if (arg === '--max-iterations' && args[i + 1]) {
      options.maxIterations = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--clear-cache') {
      options.clearCache = true;
    } else if (arg === '--no-server') {
      // Deprecated flag, ignored (server is now managed internally)
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  
  return options;
}

function printHelp(): void {
  console.log(`
Live Paste Test Engine
======================

Usage:
  npx ts-node test-engine/index.ts [options]

Options:
  --phase <1|2|3|4>     Run tests for a specific phase only
  --scenario <id>       Run a specific scenario by ID
  --improve             Run self-improvement loop
  --max-iterations <n>  Maximum iterations for improvement loop (default: 10)
  --clear-cache         Clear generated audio cache
  --no-server           Don't start STT server (assume already running)
  --help                Show this help message

Scenarios:
${scenarios.map(s => `  ${s.id.padEnd(20)} Phase ${s.phase} - ${s.name}`).join('\n')}
`);
}


/**
 * Self-improvement loop
 */
async function runImprovementLoop(maxIterations: number = 10): Promise<void> {
  let iteration = 0;
  let previousReport: DiagnosticReport | null = null;
  
  console.log('\n🔄 Starting Self-Improvement Loop\n');
  console.log(`Max iterations: ${maxIterations}`);
  console.log('─'.repeat(60));
  
  while (iteration < maxIterations) {
    iteration++;
    console.log(`\n=== Iteration ${iteration}/${maxIterations} ===\n`);
    
    // Run all tests
    const results = await runAllScenarios();
    
    // Analyze results
    const report = analyzeResults(results);
    
    // Print report
    console.log('\n' + formatReport(report));
    
    // Save report
    saveReport(report, iteration);
    
    // Check if all passed
    if (report.summary.failed === 0) {
      console.log('\n🎉 All tests passed! Masterpiece achieved!\n');
      break;
    }
    
    // Compare with previous
    if (previousReport) {
      const { improvements, regressions } = await import('./analyzer').then(m => 
        m.compareReports(previousReport!, report)
      );
      
      if (improvements.length > 0) {
        console.log('\n📈 Improvements from last iteration:');
        improvements.forEach(i => console.log(`  ✅ ${i}`));
      }
      
      if (regressions.length > 0) {
        console.log('\n📉 Regressions from last iteration:');
        regressions.forEach(r => console.log(`  ⚠️ ${r}`));
      }
    }
    
    // Show suggestions for next iteration
    if (report.overallSuggestions.length > 0) {
      console.log('\n💡 Suggestions for improvement:');
      report.overallSuggestions.forEach(s => console.log(s));
    }
    
    previousReport = report;
    
    // Pause between iterations (in real use, code changes would happen here)
    if (iteration < maxIterations && report.summary.failed > 0) {
      console.log('\n⏳ Waiting 5 seconds before next iteration...');
      console.log('   (In real use, apply fixes based on suggestions above)');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  if (iteration >= maxIterations) {
    console.log(`\n⚠️ Reached maximum iterations (${maxIterations}). Manual review recommended.\n`);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Register cleanup handlers FIRST to catch signals from piped commands
  registerCleanupHandlers();
  
  // Kill any orphaned processes from previous runs BEFORE starting
  await killOrphanedProcesses();
  
  const options = parseArgs();
  
  // Handle cache clearing
  if (options.clearCache) {
    console.log('Clearing audio cache...');
    clearCache();
    console.log('Cache cleared.\n');
    if (!options.phase && !options.scenario && !options.improve) {
      return;
    }
  }
  
  try {
    // Run based on options
    if (options.improve) {
      await runImprovementLoop(options.maxIterations);
    } else if (options.scenario) {
      const scenario = getScenarioById(options.scenario);
      if (!scenario) {
        console.error(`Unknown scenario: ${options.scenario}`);
        console.log('Available scenarios:', scenarios.map(s => s.id).join(', '));
        process.exit(1);
      }
      
      console.log(`\nRunning scenario: ${scenario.name}\n`);
      const result = await runScenario(scenario);
      const report = analyzeResults([result]);
      console.log('\n' + formatReport(report));
    } else if (options.phase) {
      const results = await runPhaseScenarios(options.phase);
      const report = analyzeResults(results);
      console.log('\n' + formatReport(report));
    } else {
      // Run all
      const results = await runAllScenarios();
      const report = analyzeResults(results);
      console.log('\n' + formatReport(report));
      saveReport(report, 0);
    }
  } catch (error) {
    console.error('Test engine error:', error);
    process.exit(1);
  }
}

// Run
main().catch(console.error);
