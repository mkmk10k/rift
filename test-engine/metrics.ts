/**
 * Metrics Calculator for Live Paste Testing
 * 
 * Calculates:
 * - Word Error Rate (WER)
 * - Time to first feedback
 * - Time to first real text
 * - Update smoothness
 * - Sentence correction rate
 */

export interface PasteEvent {
  timestamp: number;      // Epoch ms
  text: string;           // Transcription at this point
  isPlaceholder: boolean; // True if this is "..." placeholder
}

export interface TestMetrics {
  // Phase 1 metrics
  timeToFirstFeedback: number;    // ms until placeholder appears
  timeToFirstRealText: number;    // ms until actual words appear
  
  // Phase 2 metrics
  updateCount: number;            // Total number of paste updates
  updateIntervals: number[];      // ms between each update
  updateSmoothness: number;       // stddev of intervals (lower = smoother)
  
  // Phase 3 metrics
  sentenceCorrections: number;    // Number of sentence-level corrections
  sentenceCorrectionRate: number; // % of sentences corrected before end
  
  // Phase 4 metrics (if applicable)
  silenceCorrectionTriggered: boolean;
  
  // Accuracy metrics
  intermediateWER: number[];      // WER at each paste event
  finalWER: number;               // Final word error rate
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FREEZE DETECTION METRICS
  // ═══════════════════════════════════════════════════════════════════════════
  chunkLatencies: number[];       // ms for each chunk transcription
  maxChunkLatency: number;        // Maximum single chunk latency
  avgChunkLatency: number;        // Average chunk latency
  chunkLatencyStdDev: number;     // Standard deviation of chunk latencies
  freezeCount: number;            // Number of chunks that exceeded freeze threshold
  freezeThresholdMs: number;      // Threshold used for freeze detection (default: 5000ms)
  frozenChunkIndices: number[];   // Which chunk indices froze
  
  // Raw data
  pasteTimeline: PasteEvent[];
  groundTruth: string;
  finalOutput: string;
  totalDurationMs: number;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate Word Error Rate (WER)
 * WER = (Substitutions + Deletions + Insertions) / Reference Words
 */
export function calculateWER(reference: string, hypothesis: string): number {
  const refWords = normalizeText(reference).split(/\s+/).filter(w => w);
  const hypWords = normalizeText(hypothesis).split(/\s+/).filter(w => w);
  
  if (refWords.length === 0) {
    return hypWords.length === 0 ? 0 : 1;
  }
  
  const distance = levenshteinDistance(refWords.join(' '), hypWords.join(' '));
  return Math.min(1, distance / refWords.length);
}

/**
 * Normalize text for comparison
 * - Lowercase
 * - Remove punctuation
 * - Collapse whitespace
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"()\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate standard deviation
 */
function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

/**
 * Extract sentences from text
 */
function extractSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// Default freeze detection threshold (5 seconds)
export const DEFAULT_FREEZE_THRESHOLD_MS = 5000;

/**
 * Calculate all metrics from a paste timeline
 * 
 * @param timeline - Array of paste events with timestamps
 * @param groundTruth - Expected transcription text
 * @param recordStartTime - Epoch ms when recording started
 * @param chunkLatencies - Optional array of per-chunk transcription times in ms
 * @param freezeThresholdMs - Optional freeze detection threshold (default: 5000ms)
 */
export function calculateMetrics(
  timeline: PasteEvent[],
  groundTruth: string,
  recordStartTime: number,
  chunkLatencies: number[] = [],
  freezeThresholdMs: number = DEFAULT_FREEZE_THRESHOLD_MS
): TestMetrics {
  const metrics: TestMetrics = {
    timeToFirstFeedback: -1,
    timeToFirstRealText: -1,
    updateCount: timeline.length,
    updateIntervals: [],
    updateSmoothness: 0,
    sentenceCorrections: 0,
    sentenceCorrectionRate: 0,
    silenceCorrectionTriggered: false,
    intermediateWER: [],
    finalWER: 0,
    // Freeze detection metrics
    chunkLatencies,
    maxChunkLatency: chunkLatencies.length > 0 ? Math.max(...chunkLatencies) : 0,
    avgChunkLatency: chunkLatencies.length > 0 
      ? chunkLatencies.reduce((a, b) => a + b, 0) / chunkLatencies.length 
      : 0,
    chunkLatencyStdDev: 0,
    freezeCount: 0,
    freezeThresholdMs,
    frozenChunkIndices: [],
    pasteTimeline: timeline,
    groundTruth,
    finalOutput: '',
    totalDurationMs: 0,
  };
  
  // Calculate freeze detection metrics
  if (chunkLatencies.length > 0) {
    // Standard deviation of chunk latencies
    const mean = metrics.avgChunkLatency;
    const squaredDiffs = chunkLatencies.map(v => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / chunkLatencies.length;
    metrics.chunkLatencyStdDev = Math.sqrt(avgSquaredDiff);
    
    // Detect frozen chunks
    for (let i = 0; i < chunkLatencies.length; i++) {
      if (chunkLatencies[i] > freezeThresholdMs) {
        metrics.freezeCount++;
        metrics.frozenChunkIndices.push(i);
      }
    }
  }
  
  if (timeline.length === 0) {
    return metrics;
  }
  
  // Calculate timing metrics
  for (let i = 0; i < timeline.length; i++) {
    const event = timeline[i];
    
    // First feedback (including placeholder)
    if (metrics.timeToFirstFeedback === -1 && event.text.length > 0) {
      metrics.timeToFirstFeedback = event.timestamp - recordStartTime;
    }
    
    // First real text (not placeholder)
    if (metrics.timeToFirstRealText === -1 && !event.isPlaceholder && event.text.length > 0) {
      metrics.timeToFirstRealText = event.timestamp - recordStartTime;
    }
    
    // Update intervals
    if (i > 0) {
      metrics.updateIntervals.push(event.timestamp - timeline[i - 1].timestamp);
    }
    
    // Intermediate WER
    if (!event.isPlaceholder) {
      metrics.intermediateWER.push(calculateWER(groundTruth, event.text));
    }
  }
  
  // Calculate update smoothness
  if (metrics.updateIntervals.length > 0) {
    metrics.updateSmoothness = standardDeviation(metrics.updateIntervals);
  }
  
  // Final output and WER
  const finalEvent = timeline[timeline.length - 1];
  metrics.finalOutput = finalEvent.text;
  metrics.finalWER = calculateWER(groundTruth, finalEvent.text);
  
  // Total duration
  if (timeline.length > 0) {
    metrics.totalDurationMs = timeline[timeline.length - 1].timestamp - recordStartTime;
  }
  
  // Sentence correction detection (simplified - counts major text changes)
  const groundSentences = extractSentences(groundTruth);
  let correctedSentences = new Set<number>();
  
  // Track sentence-level changes across timeline
  let lastSentenceStates: string[] = [];
  for (const event of timeline) {
    if (event.isPlaceholder) continue;
    
    const currentSentences = extractSentences(event.text);
    
    // Compare with previous state
    for (let i = 0; i < currentSentences.length && i < lastSentenceStates.length; i++) {
      if (currentSentences[i] !== lastSentenceStates[i]) {
        // Sentence changed - this is a correction
        if (i < groundSentences.length) {
          // Check if it got closer to ground truth
          const prevWER = calculateWER(groundSentences[i], lastSentenceStates[i]);
          const currWER = calculateWER(groundSentences[i], currentSentences[i]);
          if (currWER < prevWER) {
            correctedSentences.add(i);
          }
        }
      }
    }
    
    lastSentenceStates = currentSentences;
  }
  
  metrics.sentenceCorrections = correctedSentences.size;
  metrics.sentenceCorrectionRate = groundSentences.length > 0 
    ? correctedSentences.size / groundSentences.length 
    : 0;
  
  return metrics;
}

/**
 * Check if a metric passes its expected threshold
 */
export function checkMetricThreshold(
  metricName: string,
  actual: number,
  expected: number | undefined,
  isMaxThreshold: boolean
): { passed: boolean; message: string } {
  if (expected === undefined) {
    return { passed: true, message: 'No threshold defined' };
  }
  
  const passed = isMaxThreshold ? actual <= expected : actual >= expected;
  const comparison = isMaxThreshold ? '<=' : '>=';
  const symbol = passed ? '✅' : '❌';
  
  return {
    passed,
    message: `${symbol} ${metricName}: ${actual.toFixed(2)} (expected ${comparison} ${expected})`,
  };
}
