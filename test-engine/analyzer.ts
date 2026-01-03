/**
 * Result Analyzer - Analyzes test results and generates improvement suggestions
 * 
 * This analyzer:
 * 1. Aggregates results across scenarios
 * 2. Identifies patterns in failures
 * 3. Generates specific improvement suggestions
 * 4. Tracks progress across iterations
 */

import * as fs from 'fs';
import * as path from 'path';
import { TestResult } from './runner';
import { TestScenario } from './scenarios';

export interface DiagnosticReport {
  summary: {
    totalScenarios: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  phaseResults: {
    phase: number;
    passed: number;
    failed: number;
    avgWER: number;
    avgFirstTextMs: number;
  }[];
  failures: {
    scenario: string;
    phase: number;
    issues: string[];
    suggestions: string[];
  }[];
  overallSuggestions: string[];
  metrics: {
    avgTimeToFirstFeedback: number;
    avgTimeToFirstText: number;
    avgFinalWER: number;
    avgUpdateSmoothness: number;
  };
  // Freeze detection summary
  freezeAnalysis: {
    totalFreezes: number;
    scenariosWithFreezes: number;
    maxChunkLatencyAcrossAll: number;
    avgMaxChunkLatency: number;
    freezeDetails: {
      scenario: string;
      freezeCount: number;
      maxLatency: number;
      frozenChunks: number[];
    }[];
  };
}

/**
 * Analyze test results and generate a diagnostic report
 */
export function analyzeResults(results: TestResult[]): DiagnosticReport {
  const report: DiagnosticReport = {
    summary: {
      totalScenarios: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      passRate: 0,
    },
    phaseResults: [],
    failures: [],
    overallSuggestions: [],
    metrics: {
      avgTimeToFirstFeedback: 0,
      avgTimeToFirstText: 0,
      avgFinalWER: 0,
      avgUpdateSmoothness: 0,
    },
    freezeAnalysis: {
      totalFreezes: 0,
      scenariosWithFreezes: 0,
      maxChunkLatencyAcrossAll: 0,
      avgMaxChunkLatency: 0,
      freezeDetails: [],
    },
  };
  
  report.summary.passRate = results.length > 0 
    ? report.summary.passed / results.length 
    : 0;
  
  // Calculate average metrics
  const validResults = results.filter(r => r.metrics.timeToFirstFeedback !== undefined);
  if (validResults.length > 0) {
    report.metrics.avgTimeToFirstFeedback = validResults.reduce(
      (sum, r) => sum + r.metrics.timeToFirstFeedback, 0
    ) / validResults.length;
    
    report.metrics.avgTimeToFirstText = validResults.reduce(
      (sum, r) => sum + r.metrics.timeToFirstRealText, 0
    ) / validResults.length;
    
    report.metrics.avgFinalWER = validResults.reduce(
      (sum, r) => sum + r.metrics.finalWER, 0
    ) / validResults.length;
    
    report.metrics.avgUpdateSmoothness = validResults.reduce(
      (sum, r) => sum + r.metrics.updateSmoothness, 0
    ) / validResults.length;
  }
  
  // Analyze by phase
  for (let phase = 1; phase <= 4; phase++) {
    const phaseResults = results.filter(r => r.scenario.phase === phase);
    if (phaseResults.length > 0) {
      report.phaseResults.push({
        phase,
        passed: phaseResults.filter(r => r.passed).length,
        failed: phaseResults.filter(r => !r.passed).length,
        avgWER: phaseResults.reduce((sum, r) => sum + r.metrics.finalWER, 0) / phaseResults.length,
        avgFirstTextMs: phaseResults.reduce((sum, r) => sum + r.metrics.timeToFirstRealText, 0) / phaseResults.length,
      });
    }
  }
  
  // Analyze freeze detection across all scenarios
  let totalMaxLatencies: number[] = [];
  for (const result of results) {
    if (result.metrics.maxChunkLatency > 0) {
      totalMaxLatencies.push(result.metrics.maxChunkLatency);
      
      if (result.metrics.maxChunkLatency > report.freezeAnalysis.maxChunkLatencyAcrossAll) {
        report.freezeAnalysis.maxChunkLatencyAcrossAll = result.metrics.maxChunkLatency;
      }
      
      if (result.metrics.freezeCount > 0) {
        report.freezeAnalysis.totalFreezes += result.metrics.freezeCount;
        report.freezeAnalysis.scenariosWithFreezes++;
        report.freezeAnalysis.freezeDetails.push({
          scenario: result.scenario.name,
          freezeCount: result.metrics.freezeCount,
          maxLatency: result.metrics.maxChunkLatency,
          frozenChunks: result.metrics.frozenChunkIndices,
        });
      }
    }
  }
  
  if (totalMaxLatencies.length > 0) {
    report.freezeAnalysis.avgMaxChunkLatency = 
      totalMaxLatencies.reduce((a, b) => a + b, 0) / totalMaxLatencies.length;
  }

  // Analyze failures and generate suggestions
  for (const result of results.filter(r => !r.passed)) {
    const failure = {
      scenario: result.scenario.name,
      phase: result.scenario.phase,
      issues: result.failures,
      suggestions: [] as string[],
    };
    
    // Generate suggestions based on failure types
    for (const issue of result.failures) {
      if (issue.includes('Time to first feedback')) {
        failure.suggestions.push('Reduce placeholder display delay in App.tsx');
        failure.suggestions.push('Check if pre-warm is being called on app start');
      }
      
      if (issue.includes('Time to first text')) {
        failure.suggestions.push('Reduce MIN_SAMPLES_FIRST in handlers.ts');
        failure.suggestions.push('Check AudioWorklet first chunk size');
        failure.suggestions.push('Verify STT warmup completed before first recording');
      }
      
      if (issue.includes('Final WER')) {
        failure.suggestions.push('Check if rolling window is truncating too aggressively');
        failure.suggestions.push('Verify final reconciliation is working');
        failure.suggestions.push('Check for hallucination patterns in transcription');
      }
      
      if (issue.includes('Sentence correction rate')) {
        failure.suggestions.push('Rolling sentence correction may not be triggering');
        failure.suggestions.push('Check sentence boundary detection regex');
        failure.suggestions.push('Increase rolling window size if sentences are being truncated');
      }
      
      if (issue.includes('FREEZE DETECTED')) {
        failure.suggestions.push('Check anchor detection in stable-prefix algorithm');
        failure.suggestions.push('Verify rolling window is not truncating mid-word');
        failure.suggestions.push('Check for long silences causing model confusion');
        failure.suggestions.push('Review chunk at frozen index for silence/noise patterns');
        failure.suggestions.push('Consider implementing never-freeze fallback');
      }
    }
    
    report.failures.push(failure);
  }
  
  // Generate overall suggestions
  if (report.metrics.avgTimeToFirstText > 2500) {
    report.overallSuggestions.push(
      'First text is slow across scenarios. Consider:' +
      '\n  1. Pre-warming AudioContext on app start' +
      '\n  2. Reducing first chunk threshold in AudioWorklet' +
      '\n  3. Optimizing STT server startup time'
    );
  }
  
  if (report.metrics.avgFinalWER > 0.15) {
    report.overallSuggestions.push(
      'Accuracy is below target. Consider:' +
      '\n  1. Increasing rolling window size' +
      '\n  2. Improving divergence recovery logic' +
      '\n  3. Adding post-processing cleanup'
    );
  }
  
  if (report.metrics.avgUpdateSmoothness > 300) {
    report.overallSuggestions.push(
      'Updates are not smooth. Consider:' +
      '\n  1. Reducing transcription chunk interval' +
      '\n  2. Improving IPC performance' +
      '\n  3. Checking for transcription blocking'
    );
  }
  
  // Check phase-specific issues
  const phase3Results = report.phaseResults.find(p => p.phase === 3);
  if (phase3Results && phase3Results.failed > 0) {
    report.overallSuggestions.push(
      'Rolling sentence correction needs work:' +
      '\n  1. Verify correctSentence IPC handler is implemented' +
      '\n  2. Check sentence tracking state management' +
      '\n  3. Test sentence boundary detection with edge cases'
    );
  }
  
  const phase4Results = report.phaseResults.find(p => p.phase === 4);
  if (phase4Results && phase4Results.failed > 0) {
    report.overallSuggestions.push(
      'Silence detection/correction needs work:' +
      '\n  1. Verify silence detection timer is implemented' +
      '\n  2. Check if correction pass runs during silence' +
      '\n  3. Test with various pause durations'
    );
  }
  
  // Freeze-specific suggestions
  if (report.freezeAnalysis.totalFreezes > 0) {
    report.overallSuggestions.push(
      `🔴 FREEZE BUGS DETECTED (${report.freezeAnalysis.totalFreezes} total in ${report.freezeAnalysis.scenariosWithFreezes} scenario(s)):` +
      '\n  1. Review stable-prefix anchor detection algorithm' +
      '\n  2. Add never-freeze fallback (force append after threshold)' +
      '\n  3. Check for infinite loops in text comparison logic' +
      '\n  4. Monitor memory pressure during transcription' +
      '\n  5. Review frozen chunk indices for patterns (middle, end, after pause)'
    );
  } else if (report.freezeAnalysis.maxChunkLatencyAcrossAll > 3000) {
    report.overallSuggestions.push(
      `⚠️ HIGH LATENCY WARNING (max: ${report.freezeAnalysis.maxChunkLatencyAcrossAll}ms):` +
      '\n  Chunk latency is approaching freeze threshold.' +
      '\n  Consider optimizing transcription pipeline.'
    );
  }
  
  return report;
}

/**
 * Format report for console output
 */
export function formatReport(report: DiagnosticReport): string {
  const lines: string[] = [];
  
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('                    TEST SUITE ANALYSIS                        ');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  
  // Summary
  lines.push('SUMMARY');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push(`Total Scenarios: ${report.summary.totalScenarios}`);
  lines.push(`Passed: ${report.summary.passed} ✅`);
  lines.push(`Failed: ${report.summary.failed} ❌`);
  lines.push(`Pass Rate: ${(report.summary.passRate * 100).toFixed(1)}%`);
  lines.push('');
  
  // Average Metrics
  lines.push('AVERAGE METRICS');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push(`Time to First Feedback: ${report.metrics.avgTimeToFirstFeedback.toFixed(0)}ms`);
  lines.push(`Time to First Text: ${report.metrics.avgTimeToFirstText.toFixed(0)}ms`);
  lines.push(`Final WER: ${(report.metrics.avgFinalWER * 100).toFixed(1)}%`);
  lines.push(`Update Smoothness (stddev): ${report.metrics.avgUpdateSmoothness.toFixed(0)}ms`);
  lines.push('');
  
  // Freeze Analysis
  lines.push('FREEZE ANALYSIS');
  lines.push('───────────────────────────────────────────────────────────────');
  const freezeStatus = report.freezeAnalysis.totalFreezes === 0 ? '✅ No freezes' : `❌ ${report.freezeAnalysis.totalFreezes} freezes detected`;
  lines.push(`Status: ${freezeStatus}`);
  lines.push(`Max Chunk Latency: ${report.freezeAnalysis.maxChunkLatencyAcrossAll.toFixed(0)}ms`);
  lines.push(`Avg Max Latency: ${report.freezeAnalysis.avgMaxChunkLatency.toFixed(0)}ms`);
  lines.push(`Scenarios with Freezes: ${report.freezeAnalysis.scenariosWithFreezes}`);
  
  if (report.freezeAnalysis.freezeDetails.length > 0) {
    lines.push('');
    lines.push('Freeze Details:');
    for (const detail of report.freezeAnalysis.freezeDetails) {
      lines.push(`  ❄️ ${detail.scenario}: ${detail.freezeCount} freeze(s), max ${detail.maxLatency}ms at chunks [${detail.frozenChunks.join(', ')}]`);
    }
  }
  lines.push('');
  
  // Phase Results
  lines.push('RESULTS BY PHASE');
  lines.push('───────────────────────────────────────────────────────────────');
  for (const phase of report.phaseResults) {
    const status = phase.failed === 0 ? '✅' : '❌';
    lines.push(`Phase ${phase.phase}: ${status} ${phase.passed}/${phase.passed + phase.failed} passed`);
    lines.push(`  - Avg WER: ${(phase.avgWER * 100).toFixed(1)}%`);
    lines.push(`  - Avg First Text: ${phase.avgFirstTextMs.toFixed(0)}ms`);
  }
  lines.push('');
  
  // Failures
  if (report.failures.length > 0) {
    lines.push('FAILURES');
    lines.push('───────────────────────────────────────────────────────────────');
    for (const failure of report.failures) {
      lines.push(`❌ ${failure.scenario} (Phase ${failure.phase})`);
      for (const issue of failure.issues) {
        lines.push(`   Issue: ${issue}`);
      }
      if (failure.suggestions.length > 0) {
        lines.push('   Suggestions:');
        for (const suggestion of failure.suggestions) {
          lines.push(`   → ${suggestion}`);
        }
      }
      lines.push('');
    }
  }
  
  // Overall Suggestions
  if (report.overallSuggestions.length > 0) {
    lines.push('IMPROVEMENT SUGGESTIONS');
    lines.push('───────────────────────────────────────────────────────────────');
    for (const suggestion of report.overallSuggestions) {
      lines.push(suggestion);
      lines.push('');
    }
  }
  
  lines.push('═══════════════════════════════════════════════════════════════');
  
  return lines.join('\n');
}

/**
 * Save report to file
 */
export function saveReport(report: DiagnosticReport, iteration: number): void {
  const reportsDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `report_iter${iteration}_${timestamp}.json`;
  const filepath = path.join(reportsDir, filename);
  
  fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
  console.log(`Report saved to: ${filepath}`);
}

/**
 * Compare two reports to detect regressions or improvements
 */
export function compareReports(
  previous: DiagnosticReport,
  current: DiagnosticReport
): { improvements: string[]; regressions: string[] } {
  const improvements: string[] = [];
  const regressions: string[] = [];
  
  // Compare pass rate
  if (current.summary.passRate > previous.summary.passRate) {
    improvements.push(`Pass rate improved: ${(previous.summary.passRate * 100).toFixed(1)}% → ${(current.summary.passRate * 100).toFixed(1)}%`);
  } else if (current.summary.passRate < previous.summary.passRate) {
    regressions.push(`Pass rate decreased: ${(previous.summary.passRate * 100).toFixed(1)}% → ${(current.summary.passRate * 100).toFixed(1)}%`);
  }
  
  // Compare metrics
  if (current.metrics.avgTimeToFirstText < previous.metrics.avgTimeToFirstText - 100) {
    improvements.push(`First text faster: ${previous.metrics.avgTimeToFirstText.toFixed(0)}ms → ${current.metrics.avgTimeToFirstText.toFixed(0)}ms`);
  } else if (current.metrics.avgTimeToFirstText > previous.metrics.avgTimeToFirstText + 100) {
    regressions.push(`First text slower: ${previous.metrics.avgTimeToFirstText.toFixed(0)}ms → ${current.metrics.avgTimeToFirstText.toFixed(0)}ms`);
  }
  
  if (current.metrics.avgFinalWER < previous.metrics.avgFinalWER - 0.02) {
    improvements.push(`WER improved: ${(previous.metrics.avgFinalWER * 100).toFixed(1)}% → ${(current.metrics.avgFinalWER * 100).toFixed(1)}%`);
  } else if (current.metrics.avgFinalWER > previous.metrics.avgFinalWER + 0.02) {
    regressions.push(`WER worsened: ${(previous.metrics.avgFinalWER * 100).toFixed(1)}% → ${(current.metrics.avgFinalWER * 100).toFixed(1)}%`);
  }
  
  return { improvements, regressions };
}
