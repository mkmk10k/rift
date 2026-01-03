/**
 * Paste Capture System
 * 
 * Captures all paste operations for end-to-end testing.
 * Enables verification of the full pipeline:
 *   STT Input → LLM Processing → Live Paste → Silence Polish → Final Polish → Final Output
 * 
 * Usage:
 *   1. Enable capture mode in the app
 *   2. Speak/transcribe text
 *   3. Retrieve captured paste events
 *   4. Verify output matches expectations
 */

import * as fs from 'fs';
import * as path from 'path';

// Types for paste events
export interface PasteEvent {
  timestamp: string;
  type: 'live-paste' | 'silence-polish' | 'final-polish' | 'correct-paste';
  input: string;          // What was sent to be pasted
  previousLength: number; // Previous pasted length (for delta calculation)
  delta: string;          // New text added
  totalPasted: string;    // Full pasted text so far
  success: boolean;
  latencyMs?: number;
}

export interface CaptureSession {
  sessionId: string;
  startTime: string;
  endTime?: string;
  events: PasteEvent[];
  summary?: {
    totalPasteEvents: number;
    silencePolishCount: number;
    finalPolishCount: number;
    duplicateCount: number;
    finalOutput: string;
  };
}

// Capture file location
const CAPTURE_DIR = path.join(__dirname, 'captures');
const ACTIVE_SESSION_FILE = path.join(CAPTURE_DIR, 'active-session.json');

// Ensure capture directory exists
if (!fs.existsSync(CAPTURE_DIR)) {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
}

/**
 * Start a new capture session
 */
export function startCaptureSession(): string {
  const sessionId = `session-${Date.now()}`;
  const session: CaptureSession = {
    sessionId,
    startTime: new Date().toISOString(),
    events: [],
  };
  
  fs.writeFileSync(ACTIVE_SESSION_FILE, JSON.stringify(session, null, 2));
  console.log(`[Paste Capture] Session started: ${sessionId}`);
  return sessionId;
}

/**
 * Record a paste event
 */
export function recordPasteEvent(event: Omit<PasteEvent, 'timestamp'>): void {
  const timestampedEvent: PasteEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  
  // Load current session
  if (!fs.existsSync(ACTIVE_SESSION_FILE)) {
    console.warn('[Paste Capture] No active session, starting one');
    startCaptureSession();
  }
  
  const session: CaptureSession = JSON.parse(fs.readFileSync(ACTIVE_SESSION_FILE, 'utf-8'));
  session.events.push(timestampedEvent);
  fs.writeFileSync(ACTIVE_SESSION_FILE, JSON.stringify(session, null, 2));
  
  console.log(`[Paste Capture] Event recorded: ${event.type} (${event.delta.length} chars)`);
}

/**
 * End the capture session and analyze results
 */
export function endCaptureSession(): CaptureSession {
  if (!fs.existsSync(ACTIVE_SESSION_FILE)) {
    throw new Error('No active capture session');
  }
  
  const session: CaptureSession = JSON.parse(fs.readFileSync(ACTIVE_SESSION_FILE, 'utf-8'));
  session.endTime = new Date().toISOString();
  
  // Analyze for duplicates and issues
  session.summary = analyzeSession(session);
  
  // Save final session to archive
  const archiveFile = path.join(CAPTURE_DIR, `${session.sessionId}.json`);
  fs.writeFileSync(archiveFile, JSON.stringify(session, null, 2));
  
  // Clear active session
  fs.unlinkSync(ACTIVE_SESSION_FILE);
  
  console.log(`[Paste Capture] Session ended: ${session.sessionId}`);
  console.log(`[Paste Capture] Summary:`, session.summary);
  
  return session;
}

/**
 * Analyze session for issues
 */
function analyzeSession(session: CaptureSession): CaptureSession['summary'] {
  const events = session.events;
  
  // Count event types
  const silencePolishCount = events.filter(e => e.type === 'silence-polish').length;
  const finalPolishCount = events.filter(e => e.type === 'final-polish').length;
  
  // Detect duplicates: same content appearing twice
  const contentCounts = new Map<string, number>();
  for (const event of events) {
    const normalizedContent = event.delta.toLowerCase().trim();
    if (normalizedContent.length > 20) { // Only check substantial content
      const count = contentCounts.get(normalizedContent) || 0;
      contentCounts.set(normalizedContent, count + 1);
    }
  }
  
  const duplicateCount = Array.from(contentCounts.values()).filter(c => c > 1).length;
  
  // Get final output (last totalPasted or last delta from final-polish)
  const lastEvent = events[events.length - 1];
  const finalOutput = lastEvent?.totalPasted || '';
  
  return {
    totalPasteEvents: events.length,
    silencePolishCount,
    finalPolishCount,
    duplicateCount,
    finalOutput,
  };
}

/**
 * Get the current session (if active)
 */
export function getCurrentSession(): CaptureSession | null {
  if (!fs.existsSync(ACTIVE_SESSION_FILE)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(ACTIVE_SESSION_FILE, 'utf-8'));
}

/**
 * Verify final output against expectations
 */
export interface VerificationResult {
  passed: boolean;
  expectedPatterns: { pattern: string; found: boolean }[];
  forbiddenPatterns: { pattern: string; found: boolean }[];
  duplicates: string[];
  issues: string[];
}

export function verifySession(
  session: CaptureSession,
  expectedPatterns: string[],
  forbiddenPatterns: string[] = []
): VerificationResult {
  const finalOutput = session.summary?.finalOutput || '';
  
  const expectedResults = expectedPatterns.map(pattern => ({
    pattern,
    found: finalOutput.toLowerCase().includes(pattern.toLowerCase()),
  }));
  
  const forbiddenResults = forbiddenPatterns.map(pattern => ({
    pattern,
    found: finalOutput.toLowerCase().includes(pattern.toLowerCase()),
  }));
  
  // Find duplicate segments
  const duplicates: string[] = [];
  const events = session.events;
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    
    // Check if current event contains content from previous
    if (prev.delta.length > 20 && curr.totalPasted.includes(prev.delta)) {
      const count = (curr.totalPasted.match(new RegExp(escapeRegex(prev.delta), 'g')) || []).length;
      if (count > 1) {
        duplicates.push(prev.delta.substring(0, 50) + '...');
      }
    }
  }
  
  const issues: string[] = [];
  
  // Check for expected patterns
  const missingPatterns = expectedResults.filter(r => !r.found).map(r => r.pattern);
  if (missingPatterns.length > 0) {
    issues.push(`Missing patterns: ${missingPatterns.join(', ')}`);
  }
  
  // Check for forbidden patterns
  const foundForbidden = forbiddenResults.filter(r => r.found).map(r => r.pattern);
  if (foundForbidden.length > 0) {
    issues.push(`Found forbidden patterns: ${foundForbidden.join(', ')}`);
  }
  
  // Check for duplicates
  if (duplicates.length > 0) {
    issues.push(`Duplicate content detected: ${duplicates.length} instances`);
  }
  
  return {
    passed: issues.length === 0,
    expectedPatterns: expectedResults,
    forbiddenPatterns: forbiddenResults,
    duplicates,
    issues,
  };
}

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * List all capture sessions
 */
export function listCaptureSessions(): string[] {
  if (!fs.existsSync(CAPTURE_DIR)) {
    return [];
  }
  
  return fs.readdirSync(CAPTURE_DIR)
    .filter(f => f.startsWith('session-') && f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

/**
 * Load a specific session
 */
export function loadSession(sessionId: string): CaptureSession | null {
  const filePath = path.join(CAPTURE_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
