/**
 * TTS Model Test Scenarios
 * 
 * Defines test cases for evaluating TTS model quality and performance.
 * Each scenario includes expected metrics for automated pass/fail determination.
 * 
 * This framework is designed to be MODEL-AGNOSTIC - when testing a new TTS model,
 * simply add it to the TTS_MODELS config and run the same scenarios.
 */

export interface TTSTestScenario {
  id: string;
  name: string;
  text: string;                    // Text to synthesize
  description: string;
  category: 'short' | 'medium' | 'long' | 'edge_case';
  
  // Expected metrics (model-agnostic baseline)
  expectedMetrics: {
    maxGenerationTimeMs?: number;   // Max time to generate audio
    minRealTimeFactor?: number;     // audio_duration / generation_time (>1 = faster than real-time)
    minAudioDurationMs?: number;    // Minimum expected audio length
    maxAudioDurationMs?: number;    // Maximum expected audio length
    minWordsPerSecond?: number;     // Minimum speech rate
    maxWordsPerSecond?: number;     // Maximum speech rate
  };
  
  // Quality expectations
  qualityExpectations: {
    mustNotBeSilent: boolean;       // Audio RMS must be > threshold
    mustNotBeNoise: boolean;        // Zero-crossing rate must be in speech range
    mustHaveSpeechSpectrum: boolean; // Spectral centroid in speech range
  };
}

/**
 * TTS Model Configuration
 * 
 * Add new models here to test them with the same scenarios.
 */
export interface TTSModelConfig {
  id: string;
  name: string;
  type: 'mlx' | 'pytorch' | 'onnx';
  
  // Model-specific performance expectations (can be stricter than scenario defaults)
  performanceTargets: {
    maxTTFA: number;                // Time to first audio in ms
    minRTF: number;                 // Minimum real-time factor
    maxMemoryMB: number;            // Max memory usage during synthesis
    maxMemoryGrowthMB: number;      // Max memory growth over 10 generations
  };
  
  // How to initialize this model (Python code path)
  initFunction: string;             // Function name in tts_server.py
  synthesizeFunction: string;       // Function name for synthesis
}

/**
 * Available TTS models for testing
 */
export const TTS_MODELS: TTSModelConfig[] = [
  {
    id: 'kokoro',
    name: 'Kokoro (MLX)',
    type: 'mlx',
    performanceTargets: {
      maxTTFA: 500,
      minRTF: 5.0,         // Kokoro is very fast
      maxMemoryMB: 800,
      maxMemoryGrowthMB: 50,
    },
    initFunction: 'initialize_kokoro',
    synthesizeFunction: 'synthesize_realtime_kokoro',
  },
  {
    id: 'chatterbox-turbo-mlx',
    name: 'Chatterbox Turbo (Native MLX)',
    type: 'mlx',
    performanceTargets: {
      maxTTFA: 3000,       // Target: <3s to first audio
      minRTF: 1.0,         // Target: at least real-time
      maxMemoryMB: 1500,
      maxMemoryGrowthMB: 100,
    },
    initFunction: 'initialize_chatterbox_turbo_mlx',
    synthesizeFunction: 'synthesize_realtime_chatterbox_turbo_mlx',
  },
  {
    id: 'chatterbox-full-mlx',
    name: 'Chatterbox Full (Native MLX)',
    type: 'mlx',
    performanceTargets: {
      maxTTFA: 5000,       // Full model is slower
      minRTF: 0.5,         // May be slower than real-time
      maxMemoryMB: 3000,
      maxMemoryGrowthMB: 200,
    },
    initFunction: 'initialize_chatterbox_full_mlx',
    synthesizeFunction: 'synthesize_realtime_chatterbox_full_mlx',
  },
  {
    id: 'chatterbox-pytorch',
    name: 'Chatterbox (PyTorch/MPS) - BASELINE',
    type: 'pytorch',
    performanceTargets: {
      maxTTFA: 30000,      // Current slow implementation
      minRTF: 0.1,         // Much slower than real-time
      maxMemoryMB: 2000,
      maxMemoryGrowthMB: 500,
    },
    initFunction: 'initialize_chatterbox',
    synthesizeFunction: 'synthesize_realtime_chatterbox',
  },
];

/**
 * Test scenarios for TTS evaluation
 */
export const TTS_SCENARIOS: TTSTestScenario[] = [
  // === SHORT TEXT (< 50 chars) ===
  {
    id: 'minimal',
    name: 'Minimal Text',
    text: 'Hello.',
    description: 'Single word to test fastest possible TTFA',
    category: 'short',
    expectedMetrics: {
      maxGenerationTimeMs: 5000,
      minRealTimeFactor: 0.5,
      minAudioDurationMs: 200,
      maxAudioDurationMs: 2000,
    },
    qualityExpectations: {
      mustNotBeSilent: true,
      mustNotBeNoise: true,
      mustHaveSpeechSpectrum: true,
    },
  },
  {
    id: 'greeting',
    name: 'Greeting',
    text: 'Hello, how are you today?',
    description: 'Common greeting phrase',
    category: 'short',
    expectedMetrics: {
      maxGenerationTimeMs: 8000,
      minRealTimeFactor: 0.5,
      minAudioDurationMs: 1000,
      maxAudioDurationMs: 4000,
    },
    qualityExpectations: {
      mustNotBeSilent: true,
      mustNotBeNoise: true,
      mustHaveSpeechSpectrum: true,
    },
  },
  {
    id: 'short-sentence',
    name: 'Short Sentence',
    text: 'The quick brown fox jumps over the lazy dog.',
    description: 'Pangram - tests all letters',
    category: 'short',
    expectedMetrics: {
      maxGenerationTimeMs: 10000,
      minRealTimeFactor: 0.5,
      minAudioDurationMs: 2000,
      maxAudioDurationMs: 6000,
      minWordsPerSecond: 1.5,
      maxWordsPerSecond: 4.0,
    },
    qualityExpectations: {
      mustNotBeSilent: true,
      mustNotBeNoise: true,
      mustHaveSpeechSpectrum: true,
    },
  },

  // === MEDIUM TEXT (50-200 chars) ===
  {
    id: 'paragraph',
    name: 'Single Paragraph',
    text: 'This is a test of the text-to-speech system. It should generate natural sounding speech that is clear and easy to understand.',
    description: 'Two sentences - typical screen reader use case',
    category: 'medium',
    expectedMetrics: {
      maxGenerationTimeMs: 15000,
      minRealTimeFactor: 0.3,
      minAudioDurationMs: 5000,
      maxAudioDurationMs: 15000,
    },
    qualityExpectations: {
      mustNotBeSilent: true,
      mustNotBeNoise: true,
      mustHaveSpeechSpectrum: true,
    },
  },
  {
    id: 'technical',
    name: 'Technical Content',
    text: 'The API returns a JSON object with status code 200. Check the documentation at docs.example.com for more details.',
    description: 'Technical text with numbers and URLs',
    category: 'medium',
    expectedMetrics: {
      maxGenerationTimeMs: 15000,
      minRealTimeFactor: 0.3,
    },
    qualityExpectations: {
      mustNotBeSilent: true,
      mustNotBeNoise: true,
      mustHaveSpeechSpectrum: true,
    },
  },
  {
    id: 'numbers',
    name: 'Numbers and Dates',
    text: 'The meeting is scheduled for January 15th, 2026 at 3:30 PM. Please bring the Q4 2025 report.',
    description: 'Tests number and date pronunciation',
    category: 'medium',
    expectedMetrics: {
      maxGenerationTimeMs: 12000,
      minRealTimeFactor: 0.3,
    },
    qualityExpectations: {
      mustNotBeSilent: true,
      mustNotBeNoise: true,
      mustHaveSpeechSpectrum: true,
    },
  },

  // === LONG TEXT (200+ chars) ===
  {
    id: 'long-paragraph',
    name: 'Long Paragraph',
    text: 'Artificial intelligence has transformed many aspects of our daily lives, from voice assistants that help us manage our schedules to recommendation systems that suggest what we might want to watch or read next. As these systems become more sophisticated, they are being integrated into healthcare, education, and transportation.',
    description: 'Long paragraph - tests sustained synthesis',
    category: 'long',
    expectedMetrics: {
      maxGenerationTimeMs: 60000,  // Up to 1 minute acceptable
      minRealTimeFactor: 0.2,
    },
    qualityExpectations: {
      mustNotBeSilent: true,
      mustNotBeNoise: true,
      mustHaveSpeechSpectrum: true,
    },
  },

  // === EDGE CASES ===
  {
    id: 'punctuation',
    name: 'Heavy Punctuation',
    text: 'Wait... what? No! I mean - yes, definitely. Right? Okay!',
    description: 'Tests punctuation handling',
    category: 'edge_case',
    expectedMetrics: {
      maxGenerationTimeMs: 10000,
    },
    qualityExpectations: {
      mustNotBeSilent: true,
      mustNotBeNoise: true,
      mustHaveSpeechSpectrum: true,
    },
  },
  {
    id: 'abbreviations',
    name: 'Abbreviations',
    text: 'Dr. Smith works at NASA. The CEO and CTO will meet ASAP.',
    description: 'Tests abbreviation expansion',
    category: 'edge_case',
    expectedMetrics: {
      maxGenerationTimeMs: 10000,
    },
    qualityExpectations: {
      mustNotBeSilent: true,
      mustNotBeNoise: true,
      mustHaveSpeechSpectrum: true,
    },
  },
  {
    id: 'mixed-case',
    name: 'Mixed Case',
    text: 'iPhone users LOVE their devices. MacBook Pro is THE choice for developers.',
    description: 'Tests case handling',
    category: 'edge_case',
    expectedMetrics: {
      maxGenerationTimeMs: 10000,
    },
    qualityExpectations: {
      mustNotBeSilent: true,
      mustNotBeNoise: true,
      mustHaveSpeechSpectrum: true,
    },
  },
];

/**
 * Get scenarios by category
 */
export function getScenariosByCategory(category: TTSTestScenario['category']): TTSTestScenario[] {
  return TTS_SCENARIOS.filter(s => s.category === category);
}

/**
 * Get model config by ID
 */
export function getModelConfig(modelId: string): TTSModelConfig | undefined {
  return TTS_MODELS.find(m => m.id === modelId);
}
