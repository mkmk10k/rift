/**
 * Test Capture Service
 * 
 * Enables capture mode for end-to-end testing of the paste pipeline.
 * Records all paste operations for verification.
 */

import { ipcMain } from 'electron';

interface CaptureEvent {
  timestamp: string;
  type: 'live-paste' | 'silence-polish' | 'final-polish' | 'correct-paste';
  text: string;
  delta: string;
  previousLength: number;
  totalPasted: string;
  success: boolean;
}

let captureMode = false;
let captureEvents: CaptureEvent[] = [];

export function setupTestCaptureHandlers(): void {
  ipcMain.handle('test:start-capture', async () => {
    console.log('[Test Capture] Starting capture mode');
    captureMode = true;
    captureEvents = [];
    return { success: true, message: 'Capture mode started' };
  });
  
  ipcMain.handle('test:stop-capture', async () => {
    console.log('[Test Capture] Stopping capture mode');
    captureMode = false;
    
    // Analyze for issues
    const duplicates: string[] = [];
    for (let i = 1; i < captureEvents.length; i++) {
      const prev = captureEvents[i - 1];
      const curr = captureEvents[i];
      
      // Check for duplicate content
      if (prev.delta.length > 20) {
        try {
          const regex = new RegExp(prev.delta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
          const matches = curr.totalPasted.match(regex);
          if (matches && matches.length > 1) {
            duplicates.push(prev.delta.substring(0, 50));
          }
        } catch (e) {
          // Regex failed, skip
        }
      }
    }
    
    const lastEvent = captureEvents[captureEvents.length - 1];
    
    return {
      success: true,
      summary: {
        totalEvents: captureEvents.length,
        silencePolishCount: captureEvents.filter(e => e.type === 'silence-polish').length,
        finalPolishCount: captureEvents.filter(e => e.type === 'final-polish').length,
        finalOutput: lastEvent?.totalPasted || '',
        duplicateCount: duplicates.length,
        duplicates,
      },
      events: captureEvents,
    };
  });
  
  ipcMain.handle('test:get-capture-events', async () => {
    return { events: captureEvents, active: captureMode };
  });
  
  // Direct record from main process
  ipcMain.on('test:record-paste', (_event, data: Omit<CaptureEvent, 'timestamp'>) => {
    recordCaptureEvent(data);
  });
}

export function isCaptureActive(): boolean {
  return captureMode;
}

export function recordCaptureEvent(data: Omit<CaptureEvent, 'timestamp'>): void {
  if (captureMode) {
    const event: CaptureEvent = {
      ...data,
      timestamp: new Date().toISOString(),
    };
    captureEvents.push(event);
    console.log(`[Test Capture] Recorded ${data.type}: "${data.delta.substring(0, 30)}..." (total: ${captureEvents.length} events)`);
  }
}

export function getCaptureEvents(): CaptureEvent[] {
  return captureEvents;
}
