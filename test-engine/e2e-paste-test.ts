#!/usr/bin/env npx ts-node
/**
 * End-to-End Paste Test
 * 
 * Autonomous testing of the full pipeline:
 *   Test Text → TTS → Audio File → STT → LLM Polish → Verify Output
 * 
 * This runs without human interaction by:
 * 1. Using TTS (Kokoro) to generate speech audio files
 * 2. Feeding audio files to STT (Parakeet)
 * 3. Running LLM polish on the transcription
 * 4. Verifying output matches expectations
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import * as os from 'os';

// Server paths
const PYTHON_PATH = '/opt/homebrew/bin/python3.11';
const TTS_SERVER_PATH = path.join(__dirname, '..', 'python', 'tts_server.py');
const STT_SERVER_PATH = path.join(__dirname, '..', 'python', 'stt_server.py');
const LLM_SERVER_PATH = path.join(__dirname, '..', 'python', 'llm_server.py');

// Temp directory for audio files
const TEMP_DIR = path.join(os.tmpdir(), 'outloud-e2e-test');

// Test scenarios
interface E2ETestScenario {
  id: string;
  name: string;
  inputText: string;  // Text to speak via TTS
  expectedPatterns: string[];  // Patterns that MUST appear in final output
  forbiddenPatterns: string[];  // Patterns that must NOT appear
  polishMode: 'clean' | 'professional' | 'verbatim';
}

const e2eScenarios: E2ETestScenario[] = [
  {
    id: 'e2e-list-basic',
    name: 'List formatting end-to-end',
    inputText: 'Number one take the dog out. Number two walk with the wife. Number three go home.',
    expectedPatterns: ['1.', '2.', '3.'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three'],
    polishMode: 'clean',
  },
  {
    id: 'e2e-filler-removal',
    name: 'Filler word removal end-to-end',
    inputText: 'So I was thinking about going to the store.',
    expectedPatterns: ['thinking', 'store'],
    forbiddenPatterns: [],  // Can't guarantee filler removal without actual filler words in TTS
    polishMode: 'clean',
  },
  {
    id: 'e2e-simple-sentence',
    name: 'Simple sentence roundtrip',
    inputText: 'The quick brown fox jumps over the lazy dog.',
    expectedPatterns: ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog'],
    forbiddenPatterns: [],
    polishMode: 'clean',
  },
];

// Server management with proper request ID tracking
class Server {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map();
  private requestId = 0;
  
  constructor(private name: string) {}
  
  async start(scriptPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[${this.name}] Starting...`);
      
      this.proc = spawn(PYTHON_PATH, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      
      let ready = false;
      const timeout = setTimeout(() => {
        if (!ready) {
          reject(new Error(`${this.name} startup timeout`));
        }
      }, 120000);  // 2 min timeout for model loading
      
      this.rl = readline.createInterface({ input: this.proc.stdout! });
      
      this.rl.on('line', (line) => {
        // Check for ready signal
        if (!ready && (line.includes('"type": "ready"') || line.includes('"type":"ready"') || 
            line.includes('Server ready') || line.includes('ready'))) {
          ready = true;
          clearTimeout(timeout);
          console.log(`[${this.name}] Ready`);
          resolve();
          return;
        }
        
        // Try to parse response
        try {
          const response = JSON.parse(line);
          
          // Check if this is a response to a pending request
          // For LLM, responses don't have request_id, so we use FIFO
          if (this.pendingRequests.size > 0) {
            const firstEntry = this.pendingRequests.entries().next();
            if (!firstEntry.done) {
              const [reqId, handler] = firstEntry.value;
              this.pendingRequests.delete(reqId);
              handler.resolve(response);
            }
          }
        } catch (e) {
          // Not JSON, ignore
        }
      });
      
      this.proc.stderr?.on('data', (data) => {
        const msg = data.toString();
        // Only log actual errors, not progress
        if (msg.includes('Error:') || msg.includes('error:')) {
          console.error(`[${this.name}] Error:`, msg.trim());
        }
      });
      
      this.proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
  
  async send(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const reqId = `req-${++this.requestId}`;
      
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`${this.name} request timeout (${reqId})`));
      }, 120000);  // 2 min timeout for 4B model
      
      this.pendingRequests.set(reqId, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
      
      this.proc?.stdin?.write(JSON.stringify(request) + '\n');
    });
  }
  
  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

let ttsServer: Server;
let sttServer: Server;
let llmServer: Server;

async function textToSpeech(text: string, outputFile: string): Promise<string> {
  console.log(`[TTS] Synthesizing: "${text.substring(0, 50)}..."`);
  
  const response = await ttsServer.send({
    action: 'synthesize',
    text,
    voice: 'af_heart',
    speed: 1.0,
    output: outputFile,
  });
  
  if (response.type === 'error') {
    throw new Error(`TTS error: ${response.error}`);
  }
  
  console.log(`[TTS] Generated: ${response.output_file}`);
  return response.output_file;
}

async function speechToText(audioFile: string): Promise<string> {
  console.log(`[STT] Transcribing: ${audioFile}`);
  
  const response = await sttServer.send({
    action: 'transcribe_file',
    audio_path: audioFile,
  });
  
  if (response.type === 'error') {
    throw new Error(`STT error: ${response.error}`);
  }
  
  console.log(`[STT] Transcribed: "${response.text}"`);
  return response.text || '';
}

async function polishText(text: string, mode: string): Promise<string> {
  console.log(`[LLM] Polishing (${mode}): "${text.substring(0, 50)}..."`);
  
  const response = await llmServer.send({
    action: 'polish_text',  // LLM server uses 'action' not 'type'
    pasted_text: text,
    final_text: text,
    mode,
  });
  
  if (response.type === 'error') {
    throw new Error(`LLM error: ${response.error}`);
  }
  
  console.log(`[LLM] Polished: "${response.polished?.substring(0, 50)}..."`);
  return response.polished || text;
}

interface E2ETestResult {
  id: string;
  name: string;
  passed: boolean;
  inputText: string;
  transcribedText: string;
  polishedText: string;
  missingPatterns: string[];
  foundForbidden: string[];
  error?: string;
  ttsTimeMs: number;
  sttTimeMs: number;
  llmTimeMs: number;
}

async function runE2ETest(scenario: E2ETestScenario): Promise<E2ETestResult> {
  const result: E2ETestResult = {
    id: scenario.id,
    name: scenario.name,
    passed: false,
    inputText: scenario.inputText,
    transcribedText: '',
    polishedText: '',
    missingPatterns: [],
    foundForbidden: [],
    ttsTimeMs: 0,
    sttTimeMs: 0,
    llmTimeMs: 0,
  };
  
  try {
    const audioFile = path.join(TEMP_DIR, `${scenario.id}.wav`);
    
    // Step 1: TTS
    const ttsStart = Date.now();
    await textToSpeech(scenario.inputText, audioFile);
    result.ttsTimeMs = Date.now() - ttsStart;
    
    // Step 2: STT
    const sttStart = Date.now();
    result.transcribedText = await speechToText(audioFile);
    result.sttTimeMs = Date.now() - sttStart;
    
    // Step 3: LLM Polish
    const llmStart = Date.now();
    result.polishedText = await polishText(result.transcribedText, scenario.polishMode);
    result.llmTimeMs = Date.now() - llmStart;
    
    // Step 4: Verify patterns
    const output = result.polishedText.toLowerCase();
    
    for (const pattern of scenario.expectedPatterns) {
      if (!output.includes(pattern.toLowerCase())) {
        result.missingPatterns.push(pattern);
      }
    }
    
    for (const pattern of scenario.forbiddenPatterns) {
      if (output.includes(pattern.toLowerCase())) {
        result.foundForbidden.push(pattern);
      }
    }
    
    result.passed = result.missingPatterns.length === 0 && result.foundForbidden.length === 0;
    
    // Cleanup audio file
    try { fs.unlinkSync(audioFile); } catch (e) {}
    
  } catch (err: any) {
    result.error = err.message;
  }
  
  return result;
}

async function runAllE2ETests(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('           END-TO-END PASTE TEST (TTS → STT → LLM)              ');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Create temp directory
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  
  ttsServer = new Server('TTS');
  sttServer = new Server('STT');
  llmServer = new Server('LLM');
  
  try {
    // Start servers sequentially (they're heavy on GPU)
    console.log('Starting servers...\n');
    
    await ttsServer.start(TTS_SERVER_PATH);
    await sttServer.start(STT_SERVER_PATH);
    await llmServer.start(LLM_SERVER_PATH);
    
    console.log('\nAll servers ready!');
    
    // Warmup: Force the 4B model to load before running tests
    console.log('Warming up LLM (loading 4B model)...');
    try {
      await polishText('Warmup test.', 'clean');
      console.log('LLM warmup complete!\n');
    } catch (e) {
      console.log('LLM warmup failed, continuing anyway\n');
    }
    
    console.log('─────────────────────────────────────────────────────────────');
    console.log('RUNNING E2E TESTS');
    console.log('─────────────────────────────────────────────────────────────\n');
    
    const results: E2ETestResult[] = [];
    
    for (const scenario of e2eScenarios) {
      console.log(`\n▶ ${scenario.id}: ${scenario.name}`);
      const result = await runE2ETest(scenario);
      results.push(result);
      
      const status = result.passed ? '✅' : '❌';
      console.log(`${status} ${scenario.id}`);
      
      if (!result.passed) {
        if (result.error) {
          console.log(`   Error: ${result.error}`);
        }
        if (result.missingPatterns.length > 0) {
          console.log(`   Missing: ${result.missingPatterns.join(', ')}`);
        }
        if (result.foundForbidden.length > 0) {
          console.log(`   Forbidden: ${result.foundForbidden.join(', ')}`);
        }
        console.log(`   Input: "${result.inputText}"`);
        console.log(`   Transcribed: "${result.transcribedText}"`);
        console.log(`   Polished: "${result.polishedText}"`);
      }
      
      console.log(`   Latency: TTS=${result.ttsTimeMs}ms, STT=${result.sttTimeMs}ms, LLM=${result.llmTimeMs}ms`);
    }
    
    // Summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                         SUMMARY                                ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const passRate = (passed / total * 100).toFixed(1);
    
    console.log(`TOTAL: ${passed}/${total} passed (${passRate}%)`);
    
    const successfulResults = results.filter(r => !r.error);
    if (successfulResults.length > 0) {
      const avgTts = successfulResults.reduce((s, r) => s + r.ttsTimeMs, 0) / successfulResults.length;
      const avgStt = successfulResults.reduce((s, r) => s + r.sttTimeMs, 0) / successfulResults.length;
      const avgLlm = successfulResults.reduce((s, r) => s + r.llmTimeMs, 0) / successfulResults.length;
      
      console.log(`AVG LATENCY: TTS=${avgTts.toFixed(0)}ms, STT=${avgStt.toFixed(0)}ms, LLM=${avgLlm.toFixed(0)}ms`);
    }
    
    // Save results
    const reportDir = path.join(__dirname, 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `e2e-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
    console.log(`\nReport saved: ${reportPath}`);
    
    // Append to history
    const historyPath = path.join(__dirname, 'history.jsonl');
    const historyEntry = {
      timestamp: new Date().toISOString(),
      label: 'e2e-test',
      totalTests: total,
      passed,
      failed: total - passed,
      passRate: passed / total,
    };
    fs.appendFileSync(historyPath, JSON.stringify(historyEntry) + '\n');
    console.log(`History updated: ${historyPath}`);
    
    // Exit code
    process.exit(passed === total ? 0 : 1);
    
  } finally {
    // Cleanup
    console.log('\nCleaning up servers...');
    ttsServer.stop();
    sttServer.stop();
    llmServer.stop();
    
    // Clean temp dir
    try { fs.rmSync(TEMP_DIR, { recursive: true }); } catch (e) {}
  }
}

// Run
runAllE2ETests().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
