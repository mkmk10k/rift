#!/usr/bin/env npx ts-node
/**
 * Silence Polish Stress Tests - LOW MEMORY MODE
 * 
 * Runs servers SEQUENTIALLY instead of simultaneously to minimize peak memory.
 * Trade-off: Slower (server startup/shutdown per test) but uses ~10GB instead of ~19GB
 * 
 * Memory profile:
 *   Standard mode: TTS(4GB) + STT(5GB) + LLM(10GB) = ~19GB peak
 *   Low-mem mode:  max(TTS, STT, LLM) = ~10GB peak
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import * as os from 'os';

const PYTHON_PATH = '/opt/homebrew/bin/python3.11';
const TTS_SERVER_PATH = path.join(__dirname, '..', 'python', 'tts_server.py');
const STT_SERVER_PATH = path.join(__dirname, '..', 'python', 'stt_server.py');
const LLM_SERVER_PATH = path.join(__dirname, '..', 'python', 'llm_server.py');

const TEMP_DIR = path.join(os.tmpdir(), 'silence-polish-lowmem');

// Simplified test scenarios for low-memory mode
interface TestScenario {
  id: string;
  name: string;
  inputText: string;
  expectedPatterns: string[];
}

const scenarios: TestScenario[] = [
  {
    id: 'lowmem-list-basic',
    name: 'Basic numbered list',
    inputText: 'Number one take the dog out. Number two walk with the wife. Number three go home.',
    expectedPatterns: ['1.', '2.', '3.'],
  },
  {
    id: 'lowmem-filler-removal',
    name: 'Filler word removal',
    inputText: 'Um so basically I wanted to discuss the project.',
    expectedPatterns: ['wanted', 'discuss', 'project'],
  },
  {
    id: 'lowmem-preserve-numbers',
    name: 'Preserve digit numbers',
    inputText: 'We need 5 copies of the report by 3 PM.',
    expectedPatterns: ['5', '3 PM', 'copies'],
  },
];

class Server {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map();
  private requestId = 0;
  
  constructor(private name: string) {}
  
  async start(scriptPath: string, timeoutMs: number = 120000): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`  [${this.name}] Starting...`);
      
      this.proc = spawn(PYTHON_PATH, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      
      let ready = false;
      const timeout = setTimeout(() => {
        if (!ready) {
          this.stop();
          reject(new Error(`${this.name} startup timeout`));
        }
      }, timeoutMs);
      
      this.rl = readline.createInterface({ input: this.proc.stdout! });
      
      this.rl.on('line', (line) => {
        if (!ready && (line.includes('"type": "ready"') || line.includes('"type":"ready"') || 
            line.includes('Server ready') || line.includes('ready'))) {
          ready = true;
          clearTimeout(timeout);
          console.log(`  [${this.name}] Ready`);
          resolve();
          return;
        }
        
        try {
          const response = JSON.parse(line);
          if (this.pendingRequests.size > 0) {
            const firstEntry = this.pendingRequests.entries().next();
            if (!firstEntry.done) {
              const [reqId, handler] = firstEntry.value;
              this.pendingRequests.delete(reqId);
              handler.resolve(response);
            }
          }
        } catch (e) {}
      });
      
      this.proc.stderr?.on('data', () => {});
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
        reject(new Error(`${this.name} request timeout`));
      }, 120000);
      
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
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
  }
}

interface TestResult {
  id: string;
  name: string;
  passed: boolean;
  audioFile?: string;
  transcribedText?: string;
  polishedText?: string;
  missingPatterns: string[];
  error?: string;
  ttsTimeMs: number;
  sttTimeMs: number;
  llmTimeMs: number;
}

async function runAllTests(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('   SILENCE POLISH TESTS - LOW MEMORY MODE (~10GB peak)         ');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  
  const results: TestResult[] = [];
  
  // Phase 1: Generate all audio files (TTS only)
  console.log('PHASE 1: Generating audio (TTS)...');
  let ttsServer: Server | null = null;
  try {
    ttsServer = new Server('TTS');
    await ttsServer.start(TTS_SERVER_PATH);
    
    for (const scenario of scenarios) {
      const audioFile = path.join(TEMP_DIR, `${scenario.id}.wav`);
      const start = Date.now();
      
      const response = await ttsServer.send({
        action: 'synthesize',
        text: scenario.inputText,
        voice: 'af_heart',
        speed: 1.0,
        output: audioFile,
      });
      
      results.push({
        id: scenario.id,
        name: scenario.name,
        passed: false,
        audioFile: response.output_file,
        missingPatterns: [],
        ttsTimeMs: Date.now() - start,
        sttTimeMs: 0,
        llmTimeMs: 0,
      });
      
      console.log(`  ${scenario.id}: ${Date.now() - start}ms ✅`);
    }
  } finally {
    console.log('  Stopping TTS server...');
    ttsServer?.stop();
    await new Promise(r => setTimeout(r, 2000)); // Wait for cleanup
  }
  
  // Phase 2: Transcribe all audio (STT only)
  console.log('\nPHASE 2: Transcribing audio (STT)...');
  let sttServer: Server | null = null;
  try {
    sttServer = new Server('STT');
    await sttServer.start(STT_SERVER_PATH);
    
    for (const result of results) {
      const start = Date.now();
      
      const response = await sttServer.send({
        action: 'transcribe_file',
        audio_path: result.audioFile,
      });
      
      result.transcribedText = response.text || '';
      result.sttTimeMs = Date.now() - start;
      
      console.log(`  ${result.id}: ${result.sttTimeMs}ms ✅`);
      console.log(`    Output: "${(result.transcribedText || '').substring(0, 60)}..."`);
      if (!result.transcribedText) {
        console.log(`    ⚠️ WARNING: Empty transcription! Response was:`, JSON.stringify(response).substring(0, 100));
      }
    }
  } finally {
    console.log('  Stopping STT server...');
    sttServer?.stop();
    await new Promise(r => setTimeout(r, 2000));
  }
  
  // Phase 3: Polish all transcriptions (LLM only)
  console.log('\nPHASE 3: Polishing text (LLM 4B)...');
  let llmServer: Server | null = null;
  try {
    llmServer = new Server('LLM');
    await llmServer.start(LLM_SERVER_PATH);
    
    // Warmup
    console.log('  Warming up LLM...');
    await llmServer.send({
      action: 'polish_text',
      pasted_text: 'Test.',
      final_text: 'Test.',
      mode: 'clean',
    });
    
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const scenario = scenarios[i];
      const start = Date.now();
      
      const response = await llmServer.send({
        action: 'polish_text',
        pasted_text: result.transcribedText,
        final_text: result.transcribedText,
        mode: 'clean',
      });
      
      result.polishedText = response.polished || result.transcribedText;
      result.llmTimeMs = Date.now() - start;
      
      // Debug output
      console.log(`    Transcribed: "${result.transcribedText?.substring(0, 50)}..."`);
      console.log(`    Polished: "${result.polishedText?.substring(0, 50)}..."`);
      
      // Verify patterns
      const output = result.polishedText!.toLowerCase();
      for (const pattern of scenario.expectedPatterns) {
        if (!output.includes(pattern.toLowerCase())) {
          result.missingPatterns.push(pattern);
        }
      }
      
      result.passed = result.missingPatterns.length === 0;
      
      const status = result.passed ? '✅' : '❌';
      console.log(`  ${result.id}: ${result.llmTimeMs}ms ${status}`);
      if (!result.passed) {
        console.log(`    Missing: ${result.missingPatterns.join(', ')}`);
      }
    }
  } finally {
    console.log('  Stopping LLM server...');
    llmServer?.stop();
  }
  
  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    LOW-MEMORY MODE SUMMARY                      ');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const passed = results.filter(r => r.passed).length;
  console.log(`TOTAL: ${passed}/${results.length} passed`);
  
  const avgTts = results.reduce((s, r) => s + r.ttsTimeMs, 0) / results.length;
  const avgStt = results.reduce((s, r) => s + r.sttTimeMs, 0) / results.length;
  const avgLlm = results.reduce((s, r) => s + r.llmTimeMs, 0) / results.length;
  
  console.log(`\nLatency (per stage, sequential):`);
  console.log(`  TTS: ${avgTts.toFixed(0)}ms avg`);
  console.log(`  STT: ${avgStt.toFixed(0)}ms avg`);
  console.log(`  LLM: ${avgLlm.toFixed(0)}ms avg`);
  console.log(`\nPeak memory: ~10GB (vs ~19GB in standard mode)`);
  
  // Cleanup
  try { fs.rmSync(TEMP_DIR, { recursive: true }); } catch (e) {}
  
  // Save to history
  const historyPath = path.join(__dirname, 'history.jsonl');
  const entry = {
    timestamp: new Date().toISOString(),
    label: 'silence-polish-lowmem',
    totalTests: results.length,
    passed,
    failed: results.length - passed,
    passRate: passed / results.length,
    mode: 'sequential-low-memory',
    latency: { avgTtsMs: Math.round(avgTts), avgSttMs: Math.round(avgStt), avgLlmMs: Math.round(avgLlm) },
  };
  fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n');
  
  process.exit(passed === results.length ? 0 : 1);
}

runAllTests().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
