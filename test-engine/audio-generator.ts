/**
 * Audio Generator - Creates test audio using macOS TTS
 * 
 * Generates WAV files from text for automated testing.
 * Supports pause patterns by splitting text and stitching with silence.
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TestScenario } from './scenarios';

const CACHE_DIR = path.join(__dirname, '.cache');
const SAMPLE_RATE = 16000; // Match STT expected sample rate

/**
 * Available macOS voices for more realistic/varied speech testing.
 * These are the more natural-sounding voices (excludes novelty voices like Bells, Boing, etc.)
 */
export const REALISTIC_VOICES = [
  'Samantha',           // Default female voice - most natural
  'Daniel',             // British male - very natural
  'Kathy',              // Female - clear
  'Fred',               // Male - classic
  'Flo (English (US))', // Female - newer
  'Reed (English (US))', // Male - newer
  'Shelley (English (US))', // Female - newer
  'Grandma (English (US))', // Older female - tests different speaking patterns
  'Grandpa (English (US))', // Older male - tests different speaking patterns
] as const;

export type VoiceName = typeof REALISTIC_VOICES[number] | string;

/**
 * Speech rate options (words per minute approximations)
 * macOS say uses 175-225 WPM as normal range
 */
export const SPEECH_RATES = {
  slow: 150,
  normal: 185,
  fast: 220,
  veryFast: 260,
} as const;

export type SpeechRate = keyof typeof SPEECH_RATES | number;

export interface GeneratedAudio {
  filePath: string;
  durationMs: number;
  segments: { text: string; startMs: number; endMs: number }[];
}

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

export interface AudioGenerationOptions {
  voice?: VoiceName;
  rate?: SpeechRate;
}

/**
 * Get a random realistic voice for variety in testing
 */
export function getRandomVoice(): VoiceName {
  return REALISTIC_VOICES[Math.floor(Math.random() * REALISTIC_VOICES.length)];
}

/**
 * Generate audio for a single text segment using macOS 'say' command
 * 
 * @param text - Text to speak
 * @param outputPath - Path to output WAV file
 * @param options - Voice and rate options for variety
 */
async function generateSegmentAudio(
  text: string, 
  outputPath: string,
  options: AudioGenerationOptions = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    // Use macOS say command with AIFF output, then convert to WAV
    const aiffPath = outputPath.replace('.wav', '.aiff');
    
    // Build say command with options
    let sayCmd = 'say';
    
    // Voice selection
    const voice = options.voice || 'Samantha';
    sayCmd += ` -v "${voice}"`;
    
    // Speech rate
    if (options.rate) {
      const rateWPM = typeof options.rate === 'number' 
        ? options.rate 
        : SPEECH_RATES[options.rate];
      sayCmd += ` -r ${rateWPM}`;
    }
    
    // Output file and text
    sayCmd += ` -o "${aiffPath}" "${text.replace(/"/g, '\\"')}"`;
    
    try {
      // Generate AIFF first (say command's native format)
      execSync(sayCmd, {
        stdio: 'pipe',
        timeout: 60000, // Increased for longer texts
      });
      
      // Convert AIFF to WAV at 16kHz mono using afconvert
      execSync(`afconvert -f WAVE -d LEI16@${SAMPLE_RATE} -c 1 "${aiffPath}" "${outputPath}"`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      
      // Clean up AIFF
      if (fs.existsSync(aiffPath)) {
        fs.unlinkSync(aiffPath);
      }
      
      // Get duration from WAV file
      const stats = fs.statSync(outputPath);
      const headerSize = 44; // Standard WAV header
      const bytesPerSample = 2; // 16-bit
      const dataSize = stats.size - headerSize;
      const samples = dataSize / bytesPerSample;
      const durationMs = (samples / SAMPLE_RATE) * 1000;
      
      resolve(durationMs);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Generate silence WAV of specified duration
 */
function generateSilence(durationMs: number, outputPath: string): void {
  const samples = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const dataSize = samples * 2; // 16-bit = 2 bytes per sample
  
  // Create WAV header
  const header = Buffer.alloc(44);
  
  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  
  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(1, 22);  // mono
  header.writeUInt32LE(SAMPLE_RATE, 24); // sample rate
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);  // block align
  header.writeUInt16LE(16, 34); // bits per sample
  
  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  
  // Create silent audio data (all zeros)
  const data = Buffer.alloc(dataSize);
  
  // Write file
  fs.writeFileSync(outputPath, Buffer.concat([header, data]));
}

/**
 * Concatenate multiple WAV files
 */
function concatenateWavFiles(inputPaths: string[], outputPath: string): void {
  // Read all audio data (skip headers)
  const audioBuffers: Buffer[] = [];
  let totalDataSize = 0;
  
  for (const inputPath of inputPaths) {
    const fileData = fs.readFileSync(inputPath);
    const audioData = fileData.slice(44); // Skip WAV header
    audioBuffers.push(audioData);
    totalDataSize += audioData.length;
  }
  
  // Create new header for combined file
  const header = Buffer.alloc(44);
  
  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + totalDataSize, 4);
  header.write('WAVE', 8);
  
  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  
  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(totalDataSize, 40);
  
  // Write combined file
  fs.writeFileSync(outputPath, Buffer.concat([header, ...audioBuffers]));
}

/**
 * Generate audio for a test scenario
 * 
 * Handles:
 * - Single text → single WAV file
 * - Text with '|' separators + pausePattern → stitched WAV with silence gaps
 * - Voice and rate customization for realistic variety
 */
export async function generateScenarioAudio(scenario: TestScenario): Promise<GeneratedAudio> {
  ensureCacheDir();
  
  // Determine voice (random if requested, otherwise specified or default)
  const voice: VoiceName = scenario.randomizeVoice 
    ? getRandomVoice() 
    : (scenario.voice || 'Samantha');
  
  // Determine speech rate
  const rate: SpeechRate | undefined = scenario.speechRate;
  
  const audioOptions: AudioGenerationOptions = { voice, rate };
  
  // Include voice and rate in cache key so different voices get different cached files
  const cacheKey = Buffer.from(
    scenario.text + JSON.stringify(scenario.pausePattern) + voice + (rate || '')
  ).toString('base64').replace(/[/+=]/g, '_');
  const outputPath = path.join(CACHE_DIR, `${scenario.id}_${cacheKey.slice(0, 16)}.wav`);
  
  // Check cache
  if (fs.existsSync(outputPath)) {
    console.log(`[AudioGenerator] Using cached audio for ${scenario.id} (voice: ${voice})`);
    const stats = fs.statSync(outputPath);
    const headerSize = 44;
    const dataSize = stats.size - headerSize;
    const samples = dataSize / 2;
    const durationMs = (samples / SAMPLE_RATE) * 1000;
    return { filePath: outputPath, durationMs, segments: [] };
  }
  
  console.log(`[AudioGenerator] Generating audio for ${scenario.id} (voice: ${voice}, rate: ${rate || 'default'})...`);
  
  const textSegments = scenario.text.split('|');
  const pausePattern = scenario.pausePattern || [];
  
  if (textSegments.length === 1) {
    // Simple case: single segment, no pauses
    const durationMs = await generateSegmentAudio(textSegments[0], outputPath, audioOptions);
    return {
      filePath: outputPath,
      durationMs,
      segments: [{ text: textSegments[0], startMs: 0, endMs: durationMs }],
    };
  }
  
  // Complex case: multiple segments with pauses
  const tempFiles: string[] = [];
  const segments: { text: string; startMs: number; endMs: number }[] = [];
  let currentTimeMs = 0;
  
  try {
    for (let i = 0; i < textSegments.length; i++) {
      const segmentText = textSegments[i].trim();
      const segmentPath = path.join(CACHE_DIR, `${scenario.id}_segment_${i}.wav`);
      
      // Generate speech segment with voice/rate options
      const segmentDuration = await generateSegmentAudio(segmentText, segmentPath, audioOptions);
      tempFiles.push(segmentPath);
      
      segments.push({
        text: segmentText,
        startMs: currentTimeMs,
        endMs: currentTimeMs + segmentDuration,
      });
      currentTimeMs += segmentDuration;
      
      // Add pause if not last segment
      if (i < textSegments.length - 1 && pausePattern[i]) {
        const silencePath = path.join(CACHE_DIR, `${scenario.id}_silence_${i}.wav`);
        generateSilence(pausePattern[i], silencePath);
        tempFiles.push(silencePath);
        currentTimeMs += pausePattern[i];
      }
    }
    
    // Concatenate all segments
    concatenateWavFiles(tempFiles, outputPath);
    
    // Clean up temp files
    for (const tempFile of tempFiles) {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
    
    return {
      filePath: outputPath,
      durationMs: currentTimeMs,
      segments,
    };
  } catch (error) {
    // Clean up on error
    for (const tempFile of tempFiles) {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
    throw error;
  }
}

/**
 * Load WAV file as Float32Array (for feeding to STT)
 */
export function loadWavAsFloat32(filePath: string): Float32Array {
  const fileData = fs.readFileSync(filePath);
  
  // Skip 44-byte WAV header
  const audioData = fileData.slice(44);
  
  // Convert 16-bit signed integers to Float32
  const samples = audioData.length / 2;
  const float32 = new Float32Array(samples);
  
  for (let i = 0; i < samples; i++) {
    const sample = audioData.readInt16LE(i * 2);
    float32[i] = sample / 32768.0; // Normalize to -1.0 to 1.0
  }
  
  return float32;
}

/**
 * Split audio into chunks of specified duration
 */
export function chunkAudio(audio: Float32Array, chunkDurationMs: number): Float32Array[] {
  const samplesPerChunk = Math.floor((chunkDurationMs / 1000) * SAMPLE_RATE);
  const chunks: Float32Array[] = [];
  
  for (let i = 0; i < audio.length; i += samplesPerChunk) {
    const end = Math.min(i + samplesPerChunk, audio.length);
    chunks.push(audio.slice(i, end));
  }
  
  return chunks;
}

/**
 * Clear the audio cache
 */
export function clearCache(): void {
  if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(CACHE_DIR, file));
    }
  }
}
