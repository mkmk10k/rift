/**
 * Test Server - Enables external test automation
 * 
 * Provides a TCP server that accepts test commands from external test runners.
 * This allows integration tests to control the app without human intervention.
 * 
 * Started when app runs with --test-mode flag.
 */

import * as net from 'net';
import { BrowserWindow } from 'electron';
import { recordCaptureEvent, getCaptureEvents } from './testCaptureService';
import { llmServer } from './llmService';

const DEFAULT_PORT = 19876;

let server: net.Server | null = null;
let mainWindow: BrowserWindow | null = null;
let captureActive = false;
let capturedEvents: any[] = [];

export function startTestServer(window: BrowserWindow, port: number = DEFAULT_PORT): void {
  mainWindow = window;
  
  server = net.createServer((socket) => {
    console.log('[TestServer] Client connected');
    
    let buffer = '';
    
    socket.on('data', async (data) => {
      buffer += data.toString();
      
      // Try to parse complete JSON messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const command = JSON.parse(line);
          const response = await handleCommand(command);
          socket.write(JSON.stringify(response) + '\n');
        } catch (err: any) {
          socket.write(JSON.stringify({ 
            success: false, 
            error: err.message 
          }) + '\n');
        }
      }
    });
    
    socket.on('close', () => {
      console.log('[TestServer] Client disconnected');
    });
    
    socket.on('error', (err) => {
      console.error('[TestServer] Socket error:', err.message);
    });
  });
  
  server.listen(port, '127.0.0.1', () => {
    console.log(`[TestServer] Listening on port ${port}`);
  });
  
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[TestServer] Port ${port} in use, trying ${port + 1}`);
      server?.close();
      startTestServer(window, port + 1);
    } else {
      console.error('[TestServer] Server error:', err);
    }
  });
}

export function stopTestServer(): void {
  if (server) {
    server.close();
    server = null;
    console.log('[TestServer] Stopped');
  }
}

async function handleCommand(command: any): Promise<any> {
  const action = command.action;
  
  switch (action) {
    case 'ping':
      return { success: true, message: 'pong' };
    
    case 'start-capture':
      captureActive = true;
      capturedEvents = [];
      console.log('[TestServer] Capture started');
      return { success: true, message: 'Capture started' };
    
    case 'stop-capture':
      captureActive = false;
      console.log('[TestServer] Capture stopped');
      
      // Analyze captured events
      const summary = analyzeEvents(capturedEvents);
      
      return {
        success: true,
        summary,
        events: capturedEvents,
      };
    
    case 'inject-speech':
      // Simulate speech input by sending text to the LLM service
      const text = command.text;
      console.log(`[TestServer] Injecting speech: "${text.substring(0, 40)}..."`);
      
      // Notify LLM service of speech
      llmServer.onSpeechDetected();
      
      // Send text to renderer for live paste simulation
      if (mainWindow) {
        mainWindow.webContents.send('test:inject-speech', { text });
      }
      
      // Record the event
      if (captureActive) {
        capturedEvents.push({
          type: 'speech-injected',
          text,
          timestamp: new Date().toISOString(),
        });
      }
      
      return { success: true, message: 'Speech injected' };
    
    case 'speech-stopped':
      // Notify that speech has stopped (triggers silence detection)
      console.log('[TestServer] Speech stopped notification');
      
      // The LLM service tracks this via onSpeechDetected timing
      // We just need to NOT call onSpeechDetected for a while
      
      if (captureActive) {
        capturedEvents.push({
          type: 'speech-stopped',
          timestamp: new Date().toISOString(),
        });
      }
      
      return { success: true, message: 'Speech stop notified' };
    
    case 'stop-recording':
      // Simulate recording stop (triggers Final Polish)
      console.log('[TestServer] Recording stop simulation');
      
      if (mainWindow) {
        mainWindow.webContents.send('test:stop-recording');
      }
      
      if (captureActive) {
        capturedEvents.push({
          type: 'recording-stopped',
          timestamp: new Date().toISOString(),
        });
      }
      
      return { success: true, message: 'Recording stopped' };
    
    case 'get-events':
      return { 
        success: true, 
        events: capturedEvents,
        captureActive,
      };
    
    case 'record-paste':
      // Record a paste event from the app
      if (captureActive) {
        capturedEvents.push({
          type: command.pasteType || 'unknown',
          text: command.text,
          delta: command.delta,
          totalPasted: command.totalPasted,
          timestamp: new Date().toISOString(),
        });
      }
      return { success: true };
    
    case 'get-llm-status':
      const status = await llmServer.getStatus();
      return { success: true, status };
    
    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

function analyzeEvents(events: any[]): any {
  const silencePolishEvents = events.filter(e => e.type === 'silence-polish');
  const finalPolishEvents = events.filter(e => e.type === 'final-polish');
  const pasteEvents = events.filter(e => 
    e.type === 'live-paste' || 
    e.type === 'silence-polish' || 
    e.type === 'final-polish'
  );
  
  // Get final output from last paste event
  const lastPaste = pasteEvents[pasteEvents.length - 1];
  const finalOutput = lastPaste?.totalPasted || lastPaste?.text || '';
  
  // Detect duplicates
  const duplicates: string[] = [];
  for (let i = 1; i < pasteEvents.length; i++) {
    const prev = pasteEvents[i - 1];
    const curr = pasteEvents[i];
    
    if (prev.delta && prev.delta.length > 20 && curr.totalPasted) {
      // Check if previous delta appears more than once in current total
      try {
        const escapedDelta = prev.delta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedDelta, 'g');
        const matches = curr.totalPasted.match(regex);
        if (matches && matches.length > 1) {
          duplicates.push(prev.delta.substring(0, 50));
        }
      } catch (e) {}
    }
  }
  
  return {
    totalEvents: events.length,
    silencePolishCount: silencePolishEvents.length,
    finalPolishCount: finalPolishEvents.length,
    finalOutput,
    duplicateCount: duplicates.length,
    duplicates,
  };
}

// Hook into the capture system
export function recordTestEvent(type: string, data: any): void {
  if (captureActive) {
    capturedEvents.push({
      type,
      ...data,
      timestamp: new Date().toISOString(),
    });
    console.log(`[TestServer] Recorded ${type}`);
  }
}

export function isTestMode(): boolean {
  return process.argv.includes('--test-mode');
}

export function getTestPort(): number {
  const portArg = process.argv.find(arg => arg.startsWith('--test-port='));
  if (portArg) {
    return parseInt(portArg.split('=')[1], 10) || DEFAULT_PORT;
  }
  return DEFAULT_PORT;
}
