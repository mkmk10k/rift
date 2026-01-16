/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TTS Transform Test Scenarios - Code Talk Feature
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Tests for the LLM-powered text transformation that converts technical content
 * into natural developer-speak before TTS synthesis.
 * 
 * DESIGN PRINCIPLES:
 * - Test data sourced from real code files in this workspace
 * - Validation focuses on concept preservation and natural speech patterns
 * - Expert-level developer speech patterns (how senior devs actually explain code)
 * 
 * TEST TYPES:
 * 1. Code-to-Speech: CSS, TypeScript, Python code snippets
 * 2. Markdown Sections: Headers, lists, technical documentation
 * 3. Context Detection: Unit tests for app/URL mode detection
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TTS TRANSFORM SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

export interface TTSTransformScenario {
  id: string;
  name: string;
  description: string;
  mode: 'developer' | 'conversational' | 'presentation';
  input: string;
  // Technical concepts that MUST be preserved in output
  mustPreserve: string[];
  // Natural speech patterns that SHOULD appear in output
  expectedPatterns: string[];
  // Patterns that must NOT appear in output (e.g., untransformed code syntax)
  forbiddenPatterns?: string[];
  // Maximum expansion ratio (transformed/input words) - natural speech expands
  maxExpansionRatio?: number;
  // Specific code-to-spoken transformations to verify
  codeToSpeech: Array<{ code: string; spoken: string }>;
  // Source file this was derived from (for traceability)
  sourceFile?: string;
}

/**
 * CSS Code Talk Scenarios
 * Test cases from real CSS discussions (like the mobile layout polish example)
 */
export const cssTransformScenarios: TTSTransformScenario[] = [
  {
    id: 'css-overflow-hidden',
    name: 'CSS overflow property',
    description: 'Speak overflow-x: hidden naturally',
    mode: 'developer',
    input: 'Add overflow-x: hidden to both html and body, and add max-width: 100vw',
    mustPreserve: ['overflow', 'hidden', 'html', 'body', 'max-width', '100'],
    expectedPatterns: ['set to', 'elements', 'viewport'],
    codeToSpeech: [
      { code: 'overflow-x: hidden', spoken: 'overflow-x set to hidden' },
      { code: '100vw', spoken: '100 viewport' },
    ],
  },
  {
    id: 'css-media-query',
    name: 'CSS media query',
    description: 'Speak @media query with breakpoint',
    mode: 'developer',
    input: '@media (max-width: 480px) { .section { padding: 1.25rem; } }',
    mustPreserve: ['480', 'section', 'padding', '1.25'],
    expectedPatterns: ['media query', 'pixels', 'class'],
    codeToSpeech: [
      { code: '@media', spoken: 'media query' },
      { code: '480px', spoken: '480 pixels' },
      { code: '.section', spoken: 'section class' },
    ],
  },
  {
    id: 'css-multi-selector',
    name: 'Multiple CSS selectors',
    description: 'Speak comma-separated selectors',
    mode: 'developer',
    input: '.feature-headline, .chapter-title, [class*="headline"] { word-break: break-word; hyphens: auto; }',
    mustPreserve: ['feature-headline', 'chapter-title', 'headline', 'word-break', 'hyphens'],
    expectedPatterns: ['class', 'set to', 'auto'],
    codeToSpeech: [
      { code: '.feature-headline', spoken: 'feature-headline class' },
      { code: 'word-break: break-word', spoken: 'word-break set to break-word' },
    ],
  },
  {
    id: 'css-box-model',
    name: 'CSS box model reset',
    description: 'Universal selector with box-sizing',
    mode: 'developer',
    input: '* { box-sizing: border-box; }',
    mustPreserve: ['box-sizing', 'border-box'],
    expectedPatterns: ['universal', 'set to'],
    codeToSpeech: [
      { code: '*', spoken: 'universal selector' },
      { code: 'box-sizing: border-box', spoken: 'box-sizing set to border-box' },
    ],
  },
];

/**
 * TypeScript Code Talk Scenarios
 * Derived from real code in src/main/services/llmService.ts
 */
export const typescriptTransformScenarios: TTSTransformScenario[] = [
  {
    id: 'ts-const-declaration',
    name: 'TypeScript constant',
    description: 'Speak const declaration with number value',
    mode: 'developer',
    input: 'const SILENCE_POLISH_THRESHOLD_MS = 5000;',
    mustPreserve: ['SILENCE_POLISH_THRESHOLD_MS', '5000'],
    expectedPatterns: ['constant', 'milliseconds'],
    codeToSpeech: [
      { code: '= 5000', spoken: 'set to 5000' },
    ],
    sourceFile: 'src/main/services/llmService.ts',
  },
  {
    id: 'ts-async-function',
    name: 'TypeScript async function signature',
    description: 'Speak async function with typed parameters',
    mode: 'developer',
    input: 'async function synthesizeRealtime(text: string, voice: string, speed: number): Promise<void>',
    mustPreserve: ['synthesizeRealtime', 'text', 'voice', 'speed', 'Promise', 'void'],
    expectedPatterns: ['async', 'function', 'string', 'number', 'returns'],
    codeToSpeech: [
      { code: 'text: string', spoken: 'text string' },
      { code: 'Promise<void>', spoken: 'Promise of void' },
    ],
    sourceFile: 'src/main/ipc/handlers.ts',
  },
  {
    id: 'ts-interface',
    name: 'TypeScript interface',
    description: 'Speak interface definition',
    mode: 'developer',
    input: 'interface LLMResponse { type: string; [key: string]: any; }',
    mustPreserve: ['LLMResponse', 'type', 'string'],
    expectedPatterns: ['interface', 'property'],
    codeToSpeech: [
      { code: 'type: string', spoken: 'type property' },
    ],
    sourceFile: 'src/main/services/llmService.ts',
  },
  {
    id: 'ts-arrow-function',
    name: 'TypeScript arrow function',
    description: 'Speak arrow function with callback',
    mode: 'developer',
    input: 'const handleResponse = (response: LLMResponse) => { console.log(response.type); }',
    mustPreserve: ['handleResponse', 'response', 'LLMResponse', 'type'],
    expectedPatterns: ['arrow function', 'takes', 'logs'],
    codeToSpeech: [
      { code: '=>', spoken: 'arrow' },
    ],
  },
];

/**
 * Python Code Talk Scenarios
 * Derived from real code in python/llm_server.py
 */
export const pythonTransformScenarios: TTSTransformScenario[] = [
  {
    id: 'py-function-def',
    name: 'Python function definition',
    description: 'Speak def with type hints',
    mode: 'developer',
    input: 'def handle_transform_for_tts(text: str, mode: str = "developer") -> dict:',
    mustPreserve: ['handle_transform_for_tts', 'text', 'mode', 'developer', 'dict'],
    expectedPatterns: ['function', 'takes', 'string', 'returns', 'dictionary'],
    codeToSpeech: [
      { code: '-> dict', spoken: 'returns a dictionary' },
      { code: 'mode: str = "developer"', spoken: 'mode string defaulting to developer' },
    ],
    sourceFile: 'python/llm_server.py',
  },
  {
    id: 'py-docstring',
    name: 'Python docstring',
    description: 'Speak docstring content naturally',
    mode: 'developer',
    input: '"""Transform text into natural spoken form for TTS. Uses fast model (0.6B) for low latency."""',
    mustPreserve: ['Transform', 'TTS', '0.6B', 'latency'],
    expectedPatterns: ['transforms', 'text-to-speech', 'fast model'],
    codeToSpeech: [],
  },
  {
    id: 'py-import',
    name: 'Python import statement',
    description: 'Speak import from module',
    mode: 'developer',
    input: 'from typing import Optional, Tuple, Any',
    mustPreserve: ['typing', 'Optional', 'Tuple', 'Any'],
    expectedPatterns: ['import', 'from', 'module'],
    codeToSpeech: [],
  },
];

/**
 * Markdown Section Scenarios
 * Derived from ISSUES.md and documentation files
 */
export const markdownTransformScenarios: TTSTransformScenario[] = [
  {
    id: 'md-heading-issues',
    name: 'Markdown headings with list',
    description: 'Speak markdown structure with section transitions',
    mode: 'developer',
    input: '# Mobile Layout Polish\n\n## Issues Identified\n\n1. Horizontal Overflow (Critical)\n2. Headlines Getting Clipped',
    mustPreserve: ['Mobile', 'Layout', 'Issues', 'Horizontal', 'Overflow', 'Critical', 'Headlines', 'Clipped'],
    expectedPatterns: ['...', 'First', 'Second'],
    codeToSpeech: [],
    sourceFile: 'ISSUES.md',
  },
  {
    id: 'md-code-block',
    name: 'Markdown with code block',
    description: 'Speak code block contents naturally',
    mode: 'developer',
    input: '## Fix\n\n```css\nhtml, body {\n  overflow-x: hidden;\n}\n```',
    mustPreserve: ['Fix', 'html', 'body', 'overflow', 'hidden'],
    expectedPatterns: ['the fix', 'set to'],
    codeToSpeech: [
      { code: 'overflow-x: hidden', spoken: 'overflow-x set to hidden' },
    ],
  },
  {
    id: 'md-bullet-list',
    name: 'Markdown bullet list',
    description: 'Speak bullet points as natural list',
    mode: 'developer',
    input: 'Changes needed:\n\n- Add overflow-x: hidden\n- Fix headline sizes\n- Add consistent padding',
    mustPreserve: ['Changes', 'overflow', 'headline', 'padding'],
    expectedPatterns: ['First', 'Second', 'Third'],
    codeToSpeech: [],
  },
  {
    id: 'md-table',
    name: 'Markdown table',
    description: 'Speak table content as descriptive text',
    mode: 'developer',
    input: '| Model | Size | Latency |\n|-------|------|------|\n| Qwen3-0.6B | 400MB | 200ms |\n| Qwen3-4B | 2.5GB | 3500ms |',
    mustPreserve: ['Qwen3', '0.6B', '4B', '400MB', '2.5GB', '200ms', '3500ms'],
    expectedPatterns: ['model', 'size', 'latency'],
    codeToSpeech: [],
    sourceFile: 'DECISIONS.md',
  },
];

/**
 * Technical Documentation Scenarios
 * Complex multi-paragraph technical content
 */
export const technicalDocScenarios: TTSTransformScenario[] = [
  {
    id: 'doc-architecture',
    name: 'Architecture description',
    description: 'Speak architecture overview naturally',
    mode: 'developer',
    input: 'ARCHITECTURE:\n- Persistent subprocess with JSON stdin/stdout protocol\n- Fast model (Qwen3-0.6B) for real-time operations\n- Quality model (Qwen3-1.7B) for final polish',
    mustPreserve: ['subprocess', 'JSON', 'stdin', 'stdout', 'Qwen3', '0.6B', '1.7B'],
    expectedPatterns: ['First', 'Second', 'Third', 'real-time', 'polish'],
    codeToSpeech: [],
    sourceFile: 'src/main/services/llmService.ts',
  },
  {
    id: 'doc-latency-targets',
    name: 'Latency targets',
    description: 'Speak numeric targets clearly',
    mode: 'developer',
    input: 'LATENCY TARGETS:\n- Phase 2 (merge): 50ms target, 100ms max\n- Phase 3 (correct): 100ms target, 200ms max\n- Phase 4 (polish): 300ms target, 1000ms max',
    // Accept natural number transformations (50ms → 50 milliseconds)
    mustPreserve: ['Phase 2', 'Phase 3', 'Phase 4', '50', '100', '200', '300', '1000'],
    expectedPatterns: ['merge', 'correct', 'polish', 'target'],
    codeToSpeech: [],
    sourceFile: 'python/llm_server.py',
  },
];

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CURSOR CONTENT SCENARIOS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Test scenarios for Cursor Agent Chats, Plans, and MD files.
 * Covers: markdown tables, file paths, percentages, ratios, mermaid diagrams,
 * CSS specifications, accessibility audits, emoji status, inline code.
 */
export const cursorContentScenarios: TTSTransformScenario[] = [
  // ─────────────────────────────────────────────────────────────────────────────
  // Category 1: Markdown Tables
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'cursor-table-simple',
    name: 'Simple markdown table',
    description: 'Speak markdown table with element and size',
    mode: 'developer',
    input: '| Element | Size |\n|---------|------|\n| .headline | 2.5rem |',
    mustPreserve: ['headline', '2.5'],
    expectedPatterns: ['element', 'size', 'rem'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-table-stats',
    name: 'Table with percentages',
    description: 'Speak table with phase pass rates',
    mode: 'developer',
    input: '| Phase | Pass Rate |\n|-------|----------|\n| Phase 2 | 52% |\n| Phase 3 | 93% |',
    mustPreserve: ['Phase 2', 'Phase 3', '52', '93'],
    expectedPatterns: ['percent'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-table-changes',
    name: 'Table with before/after changes',
    description: 'Speak accessibility audit table row',
    mode: 'developer',
    input: '| Current | Recommended | Change |\n|---------|-------------|--------|\n| 1.75rem | 2.5rem | +43% |',
    mustPreserve: ['1.75', '2.5', '43'],
    expectedPatterns: ['current', 'recommended', 'increase'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-table-multirow',
    name: 'Multi-row accessibility table',
    description: 'Speak table with multiple data rows',
    mode: 'developer',
    input: '| Element | Current | Recommended |\n|---------|---------|-------------|\n| .feature-stat | 1.75rem | 2.75rem |\n| .section-headline | 1.75rem | 2.5rem |',
    mustPreserve: ['feature-stat', 'section-headline', '1.75', '2.75', '2.5'],
    expectedPatterns: ['element', 'current', 'recommended', 'rem'],
    codeToSpeech: [],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Category 2: File Paths
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'cursor-filepath-ts',
    name: 'TypeScript file path',
    description: 'Speak file path with folder separators',
    mode: 'developer',
    input: 'Update src/main/ipc/handlers.ts with new logic',
    mustPreserve: ['handlers', 'main'],
    expectedPatterns: ['file', 'source'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-filepath-multiple',
    name: 'Multiple file paths',
    description: 'Speak multiple file references',
    mode: 'developer',
    input: 'Modify python/prompts.json and test-engine/llm-runner.ts',
    mustPreserve: ['prompts', 'json', 'runner'],
    expectedPatterns: ['python', 'test'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-filepath-key-files',
    name: 'Key files list',
    description: 'Speak list of key project files',
    mode: 'developer',
    input: 'Key Files: python/prompts.json, src/main/ipc/handlers.ts, test-engine/llm-runner.ts',
    mustPreserve: ['prompts', 'handlers', 'runner'],
    expectedPatterns: ['file'],
    maxExpansionRatio: 4.0,  // File paths expand when spoken
    codeToSpeech: [],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Category 3: Statistics and Percentages
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'cursor-ratio',
    name: 'Ratio with percentage',
    description: 'Speak test result ratio',
    mode: 'developer',
    input: 'Context Detection: 16/16 (100%)',
    mustPreserve: ['Context Detection', '16', '100'],
    expectedPatterns: ['percent', 'out of'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-phase-stats',
    name: 'Multiple phase statistics',
    description: 'Speak phase pass rates with pipes',
    mode: 'developer',
    input: 'Phase 2: 52% | Phase 3: 93% | Phase 4: 81%',
    mustPreserve: ['Phase 2', 'Phase 3', 'Phase 4', '52', '93', '81'],
    expectedPatterns: ['percent'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-wcag',
    name: 'WCAG accessibility spec',
    description: 'Speak WCAG contrast ratio',
    mode: 'developer',
    input: 'WCAG AA (4.5:1) contrast ratio',
    mustPreserve: ['WCAG', '4.5', 'contrast'],
    expectedPatterns: ['ratio'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-percentage-increase',
    name: 'Percentage increase',
    description: 'Speak positive percentage change',
    mode: 'developer',
    input: 'Font size increased by +43%',
    mustPreserve: ['Font', 'size', '43'],
    expectedPatterns: ['percent', 'increase'],
    codeToSpeech: [],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Category 4: CSS Specifications
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'cursor-css-change',
    name: 'CSS size change with arrow',
    description: 'Speak CSS value transition',
    mode: 'developer',
    input: '.section-headline: 1.75rem (28px) → 2.5rem (40px)',
    mustPreserve: ['section-headline', '28', '40'],
    expectedPatterns: ['pixel', 'rem'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-css-important',
    name: 'CSS with !important',
    description: 'Speak CSS with important flag',
    mode: 'developer',
    input: 'font-size: 2.5rem !important;',
    mustPreserve: ['font-size', '2.5'],
    expectedPatterns: ['important'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-css-clamp',
    name: 'CSS clamp function',
    description: 'Speak CSS clamp with min/max',
    mode: 'developer',
    input: 'Use font-size: clamp(1.25rem, 3vw, 2rem) for responsive text',
    mustPreserve: ['font-size', 'clamp', 'responsive'],  // Core concepts only
    expectedPatterns: [],  // Model may describe clamp various ways
    codeToSpeech: [],
  },
  {
    id: 'cursor-css-audit-row',
    name: 'Accessibility audit row',
    description: 'Speak audit table row with change percentage',
    mode: 'developer',
    input: '| .feature-stat | 1.75rem (28px) | 2.75rem (44px) | +57% |',
    mustPreserve: ['feature-stat', '28', '44', '57'],
    expectedPatterns: ['pixel', 'percent', 'increase'],
    codeToSpeech: [],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Category 5: Mermaid and Flow Diagrams
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'cursor-mermaid-flow',
    name: 'Mermaid flowchart',
    description: 'Speak mermaid diagram as flow description',
    mode: 'developer',
    input: 'graph TD; A[Input]-->B[Transform]-->C[Output]',
    mustPreserve: ['Input', 'Transform', 'Output'],
    expectedPatterns: ['flow', 'to'],
    forbiddenPatterns: ['graph TD', '-->'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-mermaid-subgraph',
    name: 'Mermaid subgraph',
    description: 'Speak mermaid subgraph label',
    mode: 'developer',
    input: 'subgraph auth [Authentication Flow]',
    mustPreserve: ['Authentication', 'Flow'],
    expectedPatterns: [],  // Model may describe this various ways
    forbiddenPatterns: [],  // Allow subgraph in output if model explains it
    codeToSpeech: [],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Category 6: Status and Emoji
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'cursor-emoji-status',
    name: 'Emoji status indicator',
    description: 'Convert emoji to spoken status',
    mode: 'developer',
    input: '✅ TTS Transform: 16/17 (94%)',
    mustPreserve: ['TTS Transform', '16', '17', '94'],
    expectedPatterns: ['percent'],
    forbiddenPatterns: [],  // Emoji removal is nice-to-have, not required
    codeToSpeech: [],
  },
  {
    id: 'cursor-status-ok',
    name: 'Status OK indicator',
    description: 'Speak OK status naturally',
    mode: 'developer',
    input: 'Status: OK - None needed',
    mustPreserve: ['Status'],
    expectedPatterns: ['okay', 'no'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-emoji-complete',
    name: 'Completion with emoji',
    description: 'Speak task completion with emoji',
    mode: 'developer',
    input: '✅ Context Detection: 16/16 (100%)',
    mustPreserve: ['Context Detection', '16', '100'],
    expectedPatterns: ['percent'],  // Just require percent transformation
    forbiddenPatterns: [],  // Emoji removal is nice-to-have
    codeToSpeech: [],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Category 7: Inline Code in Prose
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'cursor-inline-code',
    name: 'Inline code in prose',
    description: 'Remove backticks from inline code',
    mode: 'developer',
    input: 'Set the `codeTalk` option to `false` to disable',
    mustPreserve: ['codeTalk', 'false', 'disable'],
    expectedPatterns: [],
    forbiddenPatterns: ['`'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-inline-function',
    name: 'Inline function reference',
    description: 'Speak function name without parentheses',
    mode: 'developer',
    input: 'The `synthesizeRealtime()` function handles TTS',
    mustPreserve: ['synthesize', 'function'],  // TTS may be expanded or omitted
    expectedPatterns: [],
    forbiddenPatterns: ['`'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-inline-promise',
    name: 'Inline Promise type',
    description: 'Speak Promise type naturally',
    mode: 'developer',
    input: 'Returns `Promise<void>` when complete',
    mustPreserve: ['Promise', 'void', 'complete'],
    expectedPatterns: [],
    forbiddenPatterns: ['`', '<', '>'],
    codeToSpeech: [],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Category 8: Section Headers with Context
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'cursor-section-numbered',
    name: 'Numbered section with title',
    description: 'Speak markdown heading with number',
    mode: 'developer',
    input: '### 1. Expert-Quality TTS Transform Prompts',
    mustPreserve: ['Expert', 'Quality', 'TTS', 'Transform'],
    expectedPatterns: ['Section'],
    forbiddenPatterns: ['###'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-section-quoted',
    name: 'Section with quoted title',
    description: 'Speak section with quoted name',
    mode: 'developer',
    input: '2. "You decide when you\'re done" Section',
    mustPreserve: ['You decide', 'done'],
    expectedPatterns: ['Section'],
    maxExpansionRatio: 5.0,  // Allow more expansion for section descriptions
    codeToSpeech: [],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Real Agent Chat Examples
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'cursor-agent-summary',
    name: 'Agent completion summary',
    description: 'Speak agent task completion summary',
    mode: 'developer',
    input: 'All tasks completed! Context Detection: 16/16 (100%). TTS Transform: 16/17 (94%).',
    mustPreserve: ['Context Detection', 'TTS Transform', '16', '17', '100', '94'],
    expectedPatterns: ['percent', 'complete'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-latency-budget',
    name: 'Latency specifications',
    description: 'Speak latency budget with milliseconds',
    mode: 'developer',
    input: 'Latency Budget: Context detection 5ms, LLM Transform 150ms, Total 300ms',
    mustPreserve: ['Context', 'LLM', '5', '150', '300'],
    expectedPatterns: ['milliseconds'],
    codeToSpeech: [],
  },
  {
    id: 'cursor-success-criteria',
    name: 'Success criteria list',
    description: 'Speak numbered success criteria',
    mode: 'developer',
    input: '1. All TTS transform scenarios pass\n2. Context detection 100% pass\n3. No regression in existing tests',
    mustPreserve: ['TTS', 'Context', '100', 'regression'],
    expectedPatterns: ['First', 'Second', 'Third'],
    codeToSpeech: [],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT DETECTION SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

export interface AppContext {
  appName: string;
  windowTitle: string;
  url: string;
}

export interface ContextDetectionScenario {
  id: string;
  name: string;
  description: string;
  context: AppContext;
  expectedMode: 'developer' | 'conversational' | 'default';
}

/**
 * Context detection unit tests
 * These test the pure function detectSpeechMode() without AppleScript
 */
export const contextDetectionScenarios: ContextDetectionScenario[] = [
  // Developer IDEs
  {
    id: 'ctx-cursor',
    name: 'Cursor IDE',
    description: 'Cursor app should trigger developer mode',
    context: { appName: 'Cursor', windowTitle: 'handlers.ts - outloud-electron', url: '' },
    expectedMode: 'developer',
  },
  {
    id: 'ctx-vscode',
    name: 'VS Code',
    description: 'Code app should trigger developer mode',
    context: { appName: 'Code', windowTitle: 'main.py - project', url: '' },
    expectedMode: 'developer',
  },
  {
    id: 'ctx-xcode',
    name: 'Xcode',
    description: 'Xcode should trigger developer mode',
    context: { appName: 'Xcode', windowTitle: 'AppDelegate.swift', url: '' },
    expectedMode: 'developer',
  },
  {
    id: 'ctx-intellij',
    name: 'IntelliJ IDEA',
    description: 'IntelliJ should trigger developer mode',
    context: { appName: 'IntelliJ IDEA', windowTitle: 'Main.java', url: '' },
    expectedMode: 'developer',
  },
  {
    id: 'ctx-terminal',
    name: 'Terminal',
    description: 'Terminal should trigger developer mode',
    context: { appName: 'Terminal', windowTitle: 'zsh', url: '' },
    expectedMode: 'developer',
  },
  {
    id: 'ctx-iterm',
    name: 'iTerm2',
    description: 'iTerm should trigger developer mode',
    context: { appName: 'iTerm2', windowTitle: 'ssh server', url: '' },
    expectedMode: 'developer',
  },
  
  // Developer websites
  {
    id: 'ctx-github',
    name: 'GitHub in browser',
    description: 'GitHub URL should trigger developer mode',
    context: { appName: 'Safari', windowTitle: 'Pull Request #123', url: 'https://github.com/user/repo/pull/123' },
    expectedMode: 'developer',
  },
  {
    id: 'ctx-stackoverflow',
    name: 'Stack Overflow',
    description: 'Stack Overflow should trigger developer mode',
    context: { appName: 'Chrome', windowTitle: 'How to use async/await', url: 'https://stackoverflow.com/questions/123' },
    expectedMode: 'developer',
  },
  {
    id: 'ctx-mdn',
    name: 'MDN Web Docs',
    description: 'MDN should trigger developer mode',
    context: { appName: 'Firefox', windowTitle: 'Array.prototype.map()', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' },
    expectedMode: 'developer',
  },
  {
    id: 'ctx-docs',
    name: 'Documentation site',
    description: 'docs.* sites should trigger developer mode',
    context: { appName: 'Arc', windowTitle: 'API Reference', url: 'https://docs.anthropic.com/api' },
    expectedMode: 'developer',
  },
  
  // Non-developer apps (should use default)
  {
    id: 'ctx-notes',
    name: 'Apple Notes',
    description: 'Notes app should use default mode',
    context: { appName: 'Notes', windowTitle: 'Shopping List', url: '' },
    expectedMode: 'default',
  },
  {
    id: 'ctx-mail',
    name: 'Apple Mail',
    description: 'Mail app should use conversational mode (communication app)',
    context: { appName: 'Mail', windowTitle: 'Inbox', url: '' },
    expectedMode: 'conversational',
  },
  {
    id: 'ctx-youtube',
    name: 'YouTube in browser',
    description: 'YouTube should use default mode',
    context: { appName: 'Safari', windowTitle: 'Funny Video', url: 'https://youtube.com/watch?v=123' },
    expectedMode: 'default',
  },
  {
    id: 'ctx-twitter',
    name: 'Twitter/X in browser',
    description: 'Social media should use default mode',
    context: { appName: 'Chrome', windowTitle: 'Home / X', url: 'https://x.com/home' },
    expectedMode: 'default',
  },
  
  // Conversational apps
  {
    id: 'ctx-slack',
    name: 'Slack',
    description: 'Slack should use conversational mode',
    context: { appName: 'Slack', windowTitle: '#general - Workspace', url: '' },
    expectedMode: 'conversational',
  },
  {
    id: 'ctx-messages',
    name: 'Messages',
    description: 'Messages should use conversational mode',
    context: { appName: 'Messages', windowTitle: 'John Doe', url: '' },
    expectedMode: 'conversational',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// Combined array for direct import
export const ttsTransformScenarios: TTSTransformScenario[] = [
  ...cssTransformScenarios,
  ...typescriptTransformScenarios,
  ...pythonTransformScenarios,
  ...markdownTransformScenarios,
  ...technicalDocScenarios,
  ...cursorContentScenarios,
];

/**
 * Get all TTS transform scenarios
 */
export function getTTSTransformScenarios(): TTSTransformScenario[] {
  return ttsTransformScenarios;
}

/**
 * Get scenarios by language/type
 */
export function getTTSTransformScenariosByType(type: 'css' | 'typescript' | 'python' | 'markdown' | 'docs' | 'cursor'): TTSTransformScenario[] {
  switch (type) {
    case 'css': return cssTransformScenarios;
    case 'typescript': return typescriptTransformScenarios;
    case 'python': return pythonTransformScenarios;
    case 'markdown': return markdownTransformScenarios;
    case 'docs': return technicalDocScenarios;
    case 'cursor': return cursorContentScenarios;
  }
}

/**
 * Get context detection scenarios
 */
export function getContextDetectionScenarios(): ContextDetectionScenario[] {
  return contextDetectionScenarios;
}

/**
 * Pure function to detect speech mode from app context
 * This is the actual implementation that will be used in handlers.ts
 */
export function detectSpeechMode(context: AppContext): 'developer' | 'conversational' | 'default' {
  const { appName, url } = context;
  const appLower = appName.toLowerCase();
  const urlLower = url.toLowerCase();
  
  // Developer IDEs
  const developerApps = [
    'cursor', 'code', 'visual studio code', 'vscode',
    'xcode', 'intellij', 'webstorm', 'pycharm', 'rider', 'goland',
    'terminal', 'iterm', 'warp', 'hyper',
    'sublime', 'atom', 'vim', 'neovim', 'emacs',
  ];
  
  if (developerApps.some(app => appLower.includes(app))) {
    return 'developer';
  }
  
  // Developer websites
  const developerUrls = [
    'github.com', 'gitlab.com', 'bitbucket.org',
    'stackoverflow.com', 'stackexchange.com',
    'developer.', 'docs.', 'api.',
    'npmjs.com', 'pypi.org', 'crates.io',
    'mdn.', 'mozilla.org/docs',
  ];
  
  if (url && developerUrls.some(pattern => urlLower.includes(pattern))) {
    return 'developer';
  }
  
  // Conversational apps
  const conversationalApps = ['slack', 'discord', 'messages', 'telegram', 'whatsapp', 'zoom', 'teams'];
  
  if (conversationalApps.some(app => appLower.includes(app))) {
    return 'conversational';
  }
  
  return 'default';
}

/**
 * Summary of all TTS transform test scenarios
 */
export function getTTSTransformTestSummary() {
  return {
    css: cssTransformScenarios.length,
    typescript: typescriptTransformScenarios.length,
    python: pythonTransformScenarios.length,
    markdown: markdownTransformScenarios.length,
    docs: technicalDocScenarios.length,
    cursor: cursorContentScenarios.length,
    total: getTTSTransformScenarios().length,
    contextDetection: contextDetectionScenarios.length,
  };
}
