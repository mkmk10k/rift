/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LLM Test Scenarios for Live Paste Enhancement
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * These scenarios specifically test the Qwen3 LLM integration for text processing.
 * They complement the existing STT scenarios in scenarios.ts.
 * 
 * TESTING ARCHITECTURE:
 * - LLM tests run SEPARATELY from STT tests
 * - Input: Pre-defined text pairs (pasted + new transcription)
 * - Output: Expected LLM response
 * - No audio generation needed (text-to-text tests)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PHASE 2 TESTS: Intelligent Text Merge
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Test cases where anchor detection fails but LLM should succeed:
 * - Punctuation differences
 * - Contraction changes
 * - Rolling window truncation
 * - STT revisions of earlier words
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PHASE 3 TESTS: Rolling Sentence Correction
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Test cases for sentence-level correction:
 * - Grammar fixes
 * - Stuttering removal
 * - Repeated word cleanup
 * - Punctuation standardization
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PHASE 4 TESTS: Final Polish
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Test cases for full text cleanup:
 * - Filler word removal (clean/professional modes)
 * - Homophone correction with context
 * - Grammar and style polish
 * - Technical vocabulary preservation
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: INTELLIGENT MERGE SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

export interface MergeTestScenario {
  id: string;
  name: string;
  description: string;
  pasted: string;           // Text already pasted
  newText: string;          // New STT transcription
  expectedNewWords: string; // Expected words to append (or "" if nothing new)
  category: 'punctuation' | 'contraction' | 'truncation' | 'revision' | 'edge-case';
}

export const mergeScenarios: MergeTestScenario[] = [
  // ─────────────────────────────────────────────────────────────────────────────
  // PUNCTUATION DIFFERENCES
  // ─────────────────────────────────────────────────────────────────────────────
  // These test cases verify the LLM correctly identifies that punctuation 
  // changes don't constitute new content
  
  {
    id: 'punct-comma-added',
    name: 'Comma Added Mid-Sentence',
    description: 'STT adds comma that wasnt in original paste',
    pasted: 'Hello world how are you',
    newText: 'Hello, world, how are you today',
    expectedNewWords: 'today',
    category: 'punctuation',
  },
  {
    id: 'punct-period-change',
    name: 'Period vs No Period',
    description: 'Final period added/removed by STT',
    pasted: 'This is a test',
    newText: 'This is a test.',
    expectedNewWords: '',
    category: 'punctuation',
  },
  {
    id: 'punct-question-mark',
    name: 'Question Mark Detection',
    description: 'Statement becomes question in STT',
    pasted: 'Are you going to the store',
    newText: 'Are you going to the store?',
    expectedNewWords: '',
    category: 'punctuation',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // CONTRACTION CHANGES
  // ─────────────────────────────────────────────────────────────────────────────
  // STT often switches between contractions and full forms. The LLM must 
  // recognize these as equivalent.
  
  {
    id: 'contract-i-am',
    name: 'I am vs I\'m',
    description: 'Contraction I\'m equivalent to I am',
    pasted: 'I am going to the store',
    newText: "I'm going to the store to buy groceries",
    expectedNewWords: 'to buy groceries',
    category: 'contraction',
  },
  {
    id: 'contract-do-not',
    name: 'Do not vs Don\'t',
    description: 'Contraction don\'t equivalent to do not',
    pasted: "I don't want to go",
    newText: 'I do not want to go there',
    expectedNewWords: 'there',
    category: 'contraction',
  },
  {
    id: 'contract-we-are',
    name: 'We are vs We\'re',
    description: 'Contraction we\'re equivalent to we are',
    pasted: "We're going to the park",
    newText: 'We are going to the park later',
    expectedNewWords: 'later',
    category: 'contraction',
  },
  {
    id: 'contract-would-have',
    name: 'Would have vs Would\'ve',
    description: 'Complex contraction handling',
    pasted: 'I would have gone',
    newText: "I would've gone if you asked",
    expectedNewWords: 'if you asked',
    category: 'contraction',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // ROLLING WINDOW TRUNCATION
  // ─────────────────────────────────────────────────────────────────────────────
  // When the rolling window truncates, new transcription starts mid-sentence.
  // The LLM must find overlap and extract only truly new content.
  
  {
    id: 'truncate-start-lost',
    name: 'Beginning Truncated',
    description: 'First words of pasted text missing from new STT',
    pasted: 'The quick brown fox jumps over the lazy dog',
    newText: 'fox jumps over the lazy dog and runs away',
    expectedNewWords: 'and runs away',
    category: 'truncation',
  },
  {
    id: 'truncate-heavy',
    name: 'Heavy Truncation',
    description: 'Most of pasted text truncated',
    pasted: 'I was walking down the street and I saw a cat sitting on the fence',
    newText: 'cat sitting on the fence watching birds',
    expectedNewWords: 'watching birds',
    category: 'truncation',
  },
  {
    id: 'truncate-with-revision',
    name: 'Truncation Plus Revision',
    description: 'Beginning truncated AND middle revised',
    pasted: 'The meeting is scheduled for three thirty',
    newText: 'meeting is scheduled for 3:30 PM tomorrow',
    expectedNewWords: 'PM tomorrow',
    category: 'truncation',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // STT REVISIONS
  // ─────────────────────────────────────────────────────────────────────────────
  // Parakeet sometimes revises earlier words based on new context.
  // The LLM must not treat revised words as new content.
  
  {
    id: 'revision-capitalization',
    name: 'Capitalization Change',
    description: 'STT changes capitalization of proper noun',
    pasted: 'I visited the white house',
    newText: 'I visited the White House yesterday',
    expectedNewWords: 'yesterday',
    category: 'revision',
  },
  {
    id: 'revision-number-format',
    name: 'Number Format Change',
    description: 'STT changes word numbers to digits',
    pasted: 'I have twenty five dollars',
    newText: 'I have 25 dollars in my wallet',
    expectedNewWords: 'in my wallet',
    category: 'revision',
  },
  {
    id: 'revision-homophone',
    name: 'Homophone Revision',
    description: 'STT corrects homophone based on context',
    pasted: 'Their going to the store',
    newText: "They're going to the store now",
    expectedNewWords: 'now',
    category: 'revision',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // EDGE CASES
  // ─────────────────────────────────────────────────────────────────────────────
  // Unusual scenarios that might trip up the LLM
  
  {
    id: 'edge-nothing-new',
    name: 'No New Content',
    description: 'New transcription is subset of pasted',
    pasted: 'I want to go to the store and buy some groceries',
    newText: 'I want to go to the store',
    expectedNewWords: '',
    category: 'edge-case',
  },
  {
    id: 'edge-complete-rewrite',
    name: 'Complete Rewrite',
    description: 'STT completely rewrote the content',
    pasted: 'Send the email to John',
    newText: 'Please forward the message to John Smith',
    expectedNewWords: 'Please forward the message to John Smith', // No overlap found
    category: 'edge-case',
  },
  {
    id: 'edge-stuttering-pattern',
    name: 'Stuttering in Source',
    description: 'Pasted text has stuttering that STT cleaned up',
    pasted: 'I I I want to go',
    newText: 'I want to go to the movies',
    expectedNewWords: 'to the movies',
    category: 'edge-case',
  },
  {
    id: 'edge-filler-removed',
    name: 'Filler Words Removed',
    description: 'STT cleaned up filler words',
    pasted: 'So like I was um thinking about it',
    newText: 'I was thinking about it and decided to go',
    expectedNewWords: 'and decided to go',
    category: 'edge-case',
  },
];


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: SENTENCE CORRECTION SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

export interface CorrectionTestScenario {
  id: string;
  name: string;
  description: string;
  original: string;         // Original pasted sentence
  latest: string;           // Latest STT version
  expectedCorrected: string; // Expected corrected output
  category: 'grammar' | 'stuttering' | 'punctuation' | 'artifact' | 'formatting';
}

export const correctionScenarios: CorrectionTestScenario[] = [
  // ─────────────────────────────────────────────────────────────────────────────
  // GRAMMAR FIXES
  // ─────────────────────────────────────────────────────────────────────────────
  
  {
    id: 'grammar-subject-verb',
    name: 'Subject-Verb Agreement',
    description: 'Fix "I goes" to "I go"',
    original: 'I goes to the store every day',
    latest: 'I goes to the store every day.',
    expectedCorrected: 'I go to the store every day.',
    category: 'grammar',
  },
  {
    id: 'grammar-tense-consistency',
    name: 'Tense Consistency',
    description: 'Fix mixed tenses',
    original: 'Yesterday I go to the store and bought milk',
    latest: 'Yesterday I go to the store and bought milk.',
    expectedCorrected: 'Yesterday I went to the store and bought milk.',
    category: 'grammar',
  },
  {
    id: 'grammar-article',
    name: 'Article Correction',
    description: 'Fix a/an usage',
    original: 'I saw a elephant at the zoo',
    latest: 'I saw a elephant at the zoo.',
    expectedCorrected: 'I saw an elephant at the zoo.',
    category: 'grammar',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // STUTTERING REMOVAL
  // ─────────────────────────────────────────────────────────────────────────────
  
  {
    id: 'stutter-word-repeat',
    name: 'Word Repetition',
    description: 'Remove repeated words',
    original: 'I I I want to go to the the store',
    latest: 'I want to go to the store.',
    expectedCorrected: 'I want to go to the store.',
    category: 'stuttering',
  },
  {
    id: 'stutter-partial',
    name: 'Partial Word Stutter',
    description: 'Handle partial word repetition',
    original: 'I was th- th- thinking about it',
    latest: 'I was thinking about it.',
    expectedCorrected: 'I was thinking about it.',
    category: 'stuttering',
  },
  {
    id: 'stutter-phrase',
    name: 'Phrase Repetition',
    description: 'Handle repeated phrases',
    original: 'Can you can you please help me',
    latest: 'Can you please help me.',
    expectedCorrected: 'Can you please help me.',
    category: 'stuttering',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // PUNCTUATION STANDARDIZATION
  // ─────────────────────────────────────────────────────────────────────────────
  
  {
    id: 'punct-add-period',
    name: 'Add Missing Period',
    description: 'Add period at end of sentence',
    original: 'This is a complete sentence',
    latest: 'This is a complete sentence',
    expectedCorrected: 'This is a complete sentence.',
    category: 'punctuation',
  },
  {
    id: 'punct-question',
    name: 'Question Punctuation',
    description: 'Add question mark for questions',
    original: 'Are you coming to the party',
    latest: 'Are you coming to the party',
    expectedCorrected: 'Are you coming to the party?',
    category: 'punctuation',
  },
  {
    id: 'punct-comma-list',
    name: 'Comma in List',
    description: 'Add commas to list',
    original: 'I need milk eggs and bread',
    latest: 'I need milk eggs and bread.',
    expectedCorrected: 'I need milk, eggs, and bread.',
    category: 'punctuation',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // TRANSCRIPTION ARTIFACTS
  // ─────────────────────────────────────────────────────────────────────────────
  
  {
    id: 'artifact-noise',
    name: 'Noise Transcribed',
    description: 'Remove transcribed background noise',
    original: 'I want to hmm uh go home',
    latest: 'I want to go home.',
    expectedCorrected: 'I want to go home.',
    category: 'artifact',
  },
  {
    id: 'artifact-self-correct',
    name: 'Self-Correction Cleanup',
    description: 'Handle spoken self-corrections',
    original: 'I want to go to the mall no wait the store',
    latest: 'I want to go to the store.',
    expectedCorrected: 'I want to go to the store.',
    category: 'artifact',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // SMART FORMATTING
  // ─────────────────────────────────────────────────────────────────────────────
  
  {
    id: 'format-time-pm',
    name: 'Format Time: three pm',
    description: 'Format spoken time to 3 PM',
    original: 'The meeting is at three pm',
    latest: 'The meeting is at three pm today',
    expectedCorrected: 'The meeting is at 3 PM today.',
    category: 'formatting',
  },
  {
    id: 'format-phone-number',
    name: 'Format Phone: spoken digits',
    description: 'Format spoken phone number',
    original: 'Call me at five five five one two three four',
    latest: 'Call me at five five five one two three four please',
    expectedCorrected: 'Call me at 555-1234, please.',
    category: 'formatting',
  },
  {
    id: 'format-year',
    name: 'Format Year: twenty twenty five',
    description: 'Format spoken year to 2025',
    original: 'Its gonna be in twenty twenty five',
    latest: 'Its gonna be in twenty twenty five I think',
    expectedCorrected: "It's going to be in 2025, I think.",
    category: 'formatting',
  },
];


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4: FINAL POLISH SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

export interface PolishTestScenario {
  id: string;
  name: string;
  description: string;
  pastedText: string;       // Text live-pasted during dictation
  finalText: string;        // Final STT transcription
  mode: 'verbatim' | 'clean' | 'professional';
  expectedPolished: string; // Expected polished output
  category: 'filler' | 'homophone' | 'grammar' | 'technical' | 'formatting';
}

export const polishScenarios: PolishTestScenario[] = [
  // ─────────────────────────────────────────────────────────────────────────────
  // FILLER WORD REMOVAL
  // ─────────────────────────────────────────────────────────────────────────────
  
  {
    id: 'filler-um-uh',
    name: 'Remove Um and Uh',
    description: 'Remove common filler sounds',
    pastedText: 'So um I was uh thinking about the uh project',
    finalText: 'So um I was uh thinking about the uh project',
    mode: 'clean',
    expectedPolished: 'I was thinking about the project.',
    category: 'filler',
  },
  {
    id: 'filler-like',
    name: 'Remove Filler "Like"',
    description: 'Remove "like" when used as filler',
    pastedText: 'It was like really like amazing you know',
    finalText: 'It was like really like amazing you know',
    mode: 'clean',
    expectedPolished: 'It was really amazing.',
    category: 'filler',
  },
  {
    id: 'filler-verbatim',
    name: 'Preserve in Verbatim Mode',
    description: 'Keep filler words in verbatim mode',
    pastedText: 'Um I was like thinking about it',
    finalText: 'Um I was like thinking about it',
    mode: 'verbatim',
    expectedPolished: 'Um, I was like thinking about it.',
    category: 'filler',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // HOMOPHONE CORRECTION
  // ─────────────────────────────────────────────────────────────────────────────
  
  {
    id: 'homo-their-theyre',
    name: 'Their vs They\'re',
    description: 'Correct based on context',
    pastedText: 'Their going to the store',
    finalText: 'Their going to the store',
    mode: 'professional',
    expectedPolished: "They're going to the store.",
    category: 'homophone',
  },
  {
    id: 'homo-your-youre',
    name: 'Your vs You\'re',
    description: 'Correct based on context',
    pastedText: 'Your the best person for this job',
    finalText: 'Your the best person for this job',
    mode: 'professional',
    expectedPolished: "You're the best person for this job.",
    category: 'homophone',
  },
  {
    id: 'homo-affect-effect',
    name: 'Affect vs Effect',
    description: 'Correct based on usage',
    pastedText: 'This will effect the outcome',
    finalText: 'This will effect the outcome',
    mode: 'professional',
    expectedPolished: 'This will affect the outcome.',
    category: 'homophone',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // TECHNICAL VOCABULARY PRESERVATION
  // ─────────────────────────────────────────────────────────────────────────────
  
  {
    id: 'tech-preserve-api',
    name: 'Preserve API Terms',
    description: 'Keep technical terms unchanged',
    pastedText: 'The API returns a JSON object with OAuth tokens',
    finalText: 'The API returns a JSON object with OAuth tokens',
    mode: 'professional',
    expectedPolished: 'The API returns a JSON object with OAuth tokens.',
    category: 'technical',
  },
  {
    id: 'tech-preserve-code',
    name: 'Preserve Code References',
    description: 'Keep code identifiers unchanged',
    pastedText: 'Call the calculateTotal function with userId parameter',
    finalText: 'Call the calculateTotal function with userId parameter',
    mode: 'professional',
    expectedPolished: 'Call the calculateTotal function with the userId parameter.',
    category: 'technical',
  },
  {
    id: 'tech-preserve-urls',
    name: 'Preserve URLs',
    description: 'Keep URLs unchanged',
    pastedText: 'Check out https://example.com/api for docs',
    finalText: 'Check out https://example.com/api for docs',
    mode: 'clean',
    expectedPolished: 'Check out https://example.com/api for docs.',
    category: 'technical',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // FORMATTING & STYLE
  // ─────────────────────────────────────────────────────────────────────────────
  
  {
    id: 'format-numbers',
    name: 'Number Formatting',
    description: 'Format numbers appropriately',
    pastedText: 'The meeting is at three thirty on the fifth',
    finalText: 'The meeting is at three thirty on the fifth',
    mode: 'professional',
    expectedPolished: 'The meeting is at 3:30 on the 5th.',
    category: 'formatting',
  },
  {
    id: 'format-run-on',
    name: 'Run-on Sentence Fix',
    description: 'Break up run-on sentences',
    pastedText: 'I went to the store and I bought milk and then I came home and I made dinner',
    finalText: 'I went to the store and I bought milk and then I came home and I made dinner',
    mode: 'professional',
    expectedPolished: 'I went to the store and bought milk. Then I came home and made dinner.',
    category: 'formatting',
  },
  {
    id: 'format-sentence-case',
    name: 'Sentence Capitalization',
    description: 'Fix capitalization',
    pastedText: 'this is a sentence. this is another one.',
    finalText: 'this is a sentence this is another one',
    mode: 'clean',
    expectedPolished: 'This is a sentence. This is another one.',
    category: 'formatting',
  },
  {
    id: 'format-date-full',
    name: 'Date Formatting: Full Date',
    description: 'Format spoken date to January 15, 2026',
    pastedText: 'The deadline is january fifteenth twenty twenty six',
    finalText: 'The deadline is january fifteenth twenty twenty six',
    mode: 'professional',
    expectedPolished: 'The deadline is January 15, 2026.',
    category: 'formatting',
  },
  {
    id: 'format-email',
    name: 'Email Formatting',
    description: 'Format spoken email address',
    pastedText: 'Contact me at john dot smith at company dot com',
    finalText: 'Contact me at john dot smith at company dot com',
    mode: 'clean',
    expectedPolished: 'Contact me at john.smith@company.com.',
    category: 'formatting',
  },
  {
    id: 'format-phone-full',
    name: 'Phone Formatting: Full Number',
    description: 'Format spoken phone number with area code',
    pastedText: 'Call five five five eight six seven five three oh nine',
    finalText: 'Call five five five eight six seven five three oh nine',
    mode: 'clean',
    expectedPolished: 'Call 555-867-5309.',
    category: 'formatting',
  },
  {
    id: 'format-url',
    name: 'URL Formatting',
    description: 'Format spoken URL',
    pastedText: 'Check out w w w dot example dot com slash docs for more info',
    finalText: 'Check out w w w dot example dot com slash docs for more info',
    mode: 'clean',
    expectedPolished: 'Check out www.example.com/docs for more info.',
    category: 'formatting',
  },
  {
    id: 'format-time-full',
    name: 'Time Formatting: Full Time',
    description: 'Format spoken time with minutes',
    pastedText: 'The meeting is at two thirty pm',
    finalText: 'The meeting is at two thirty pm',
    mode: 'professional',
    expectedPolished: 'The meeting is at 2:30 PM.',
    category: 'formatting',
  },
];


// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACT NEW WORDS SCENARIOS (for rolling window recovery)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ExtractNewWordsTestScenario {
  id: string;
  name: string;
  description: string;
  pastedEnd: string;         // Last ~50-100 chars of pasted text
  tailWords: string;         // New words that might be appended
  expectedNewWords: string;  // Expected words to append (or "" if all overlap)
  category: 'partial-overlap' | 'complete-overlap' | 'no-overlap' | 'punctuation' | 'edge-case';
}

export const extractNewWordsScenarios: ExtractNewWordsTestScenario[] = [
  // ─────────────────────────────────────────────────────────────────────────────
  // PARTIAL OVERLAP (most common case)
  // ─────────────────────────────────────────────────────────────────────────────
  // Some words in tail already exist at end of pasted, need to extract only new ones
  
  {
    id: 'extract-partial-nineteen',
    name: 'Partial Overlap: Nineteen',
    description: 'nineteen exists in both, extract only "twenty twenty one"',
    pastedEnd: 'seventeen eighteen nineteen',
    tailWords: 'nineteen twenty twenty one',
    expectedNewWords: 'twenty twenty one',
    category: 'partial-overlap',
  },
  {
    id: 'extract-partial-brown',
    name: 'Partial Overlap: Brown',
    description: 'brown exists in both, extract only "fox jumps"',
    pastedEnd: 'the quick brown',
    tailWords: 'brown fox jumps',
    expectedNewWords: 'fox jumps',
    category: 'partial-overlap',
  },
  {
    id: 'extract-partial-world',
    name: 'Partial Overlap: World',
    description: 'world exists in both, extract only "test"',
    pastedEnd: 'hello world',
    tailWords: 'world test',
    expectedNewWords: 'test',
    category: 'partial-overlap',
  },
  {
    id: 'extract-partial-multiple',
    name: 'Partial Overlap: Multiple Words',
    description: 'Multiple words overlap, extract only new ones',
    pastedEnd: 'I went to the store',
    tailWords: 'to the store and bought milk',
    expectedNewWords: 'and bought milk',
    category: 'partial-overlap',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // COMPLETE OVERLAP
  // ─────────────────────────────────────────────────────────────────────────────
  // All words in tail already exist in pasted end
  
  {
    id: 'extract-complete-all-exist',
    name: 'Complete Overlap: All Exist',
    description: 'All tail words already in pasted end',
    pastedEnd: 'hello world',
    tailWords: 'hello world',
    expectedNewWords: '',
    category: 'complete-overlap',
  },
  {
    id: 'extract-complete-subset',
    name: 'Complete Overlap: Subset',
    description: 'Tail is subset of pasted end',
    pastedEnd: 'I went to the store yesterday',
    tailWords: 'to the store',
    expectedNewWords: '',
    category: 'complete-overlap',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // NO OVERLAP
  // ─────────────────────────────────────────────────────────────────────────────
  // No words overlap, all tail words are new
  
  {
    id: 'extract-no-overlap',
    name: 'No Overlap: All New',
    description: 'No overlap, all tail words are new',
    pastedEnd: 'finished the meeting',
    tailWords: 'and went home',
    expectedNewWords: 'and went home',
    category: 'no-overlap',
  },
  {
    id: 'extract-no-overlap-divergence',
    name: 'No Overlap: Divergence',
    description: 'Complete divergence, no overlap found',
    pastedEnd: 'send the email',
    tailWords: 'please forward the message',
    expectedNewWords: 'please forward the message',
    category: 'no-overlap',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // PUNCTUATION DIFFERENCES
  // ─────────────────────────────────────────────────────────────────────────────
  // Same words but different punctuation
  
  {
    id: 'extract-punct-comma',
    name: 'Punctuation: Comma',
    description: 'Same words, comma added',
    pastedEnd: 'hello world',
    tailWords: 'hello, world test',
    expectedNewWords: 'test',
    category: 'punctuation',
  },
  {
    id: 'extract-punct-period',
    name: 'Punctuation: Period',
    description: 'Same words, period added',
    pastedEnd: 'this is a test',
    tailWords: 'test. new words',
    expectedNewWords: 'new words',
    category: 'punctuation',
  },
  
  // ─────────────────────────────────────────────────────────────────────────────
  // EDGE CASES
  // ─────────────────────────────────────────────────────────────────────────────
  
  {
    id: 'extract-edge-empty-tail',
    name: 'Edge Case: Empty Tail',
    description: 'Tail is empty',
    pastedEnd: 'some text',
    tailWords: '',
    expectedNewWords: '',
    category: 'edge-case',
  },
  {
    id: 'extract-edge-single-word',
    name: 'Edge Case: Single Word',
    description: 'Single word overlap detection',
    pastedEnd: 'the quick',
    tailWords: 'quick brown',
    expectedNewWords: 'brown',
    category: 'edge-case',
  },
  {
    id: 'extract-edge-repeated',
    name: 'Edge Case: Repeated Words',
    description: 'Handle repeated words in tail',
    pastedEnd: 'one two three',
    tailWords: 'three three four',
    expectedNewWords: 'four',
    category: 'edge-case',
  },
  {
    id: 'extract-edge-case-sensitive',
    name: 'Edge Case: Case Sensitivity',
    description: 'Handle case differences',
    pastedEnd: 'Hello World',
    tailWords: 'world test',
    expectedNewWords: 'test',
    category: 'edge-case',
  },
];


// ═══════════════════════════════════════════════════════════════════════════════
// DEEP CLEANUP SCENARIOS (Cleanup Crew - 4B Model)
// ═══════════════════════════════════════════════════════════════════════════════
// Tests for the secondary deep cleanup layer using the larger 4B model.
// These tests verify thorough cleanup of already-pasted text.

export interface DeepCleanupTestScenario {
  id: string;
  name: string;
  description: string;
  sentence: string;           // Sentence to clean up
  expectedCleaned: string;    // Expected cleaned result
  category: 'homophone' | 'grammar' | 'filler' | 'stutter' | 'technical' | 'complex' | 'formatting';
}

export const deepCleanupScenarios: DeepCleanupTestScenario[] = [
  // Homophone corrections
  {
    id: 'deep-homophone-their',
    name: 'Homophone: their → they\'re',
    description: 'Fix common their/they\'re mistake',
    sentence: 'Their going to the store.',
    expectedCleaned: 'They\'re going to the store.',
    category: 'homophone',
  },
  {
    id: 'deep-homophone-your',
    name: 'Homophone: your → you\'re',
    description: 'Fix common your/you\'re mistake',
    sentence: 'Your the best person for this job.',
    expectedCleaned: 'You\'re the best person for this job.',
    category: 'homophone',
  },
  {
    id: 'deep-homophone-affect',
    name: 'Homophone: affect → effect',
    description: 'Fix affect/effect usage',
    sentence: 'The affect of this will be significant.',
    expectedCleaned: 'The effect of this will be significant.',
    category: 'homophone',
  },
  {
    id: 'deep-homophone-there',
    name: 'Homophone: their → there',
    description: 'Fix their/there usage in location context',
    sentence: 'I want to go their too.',
    expectedCleaned: 'I want to go there too.',
    category: 'homophone',
  },
  
  // Grammar corrections
  {
    id: 'deep-grammar-subject-verb',
    name: 'Grammar: Subject-verb agreement',
    description: 'Fix subject-verb agreement',
    sentence: 'The team are ready for the meeting.',
    expectedCleaned: 'The team is ready for the meeting.',
    category: 'grammar',
  },
  {
    id: 'deep-grammar-article',
    name: 'Grammar: Article usage',
    description: 'Fix article usage',
    sentence: 'I need a information about this.',
    expectedCleaned: 'I need information about this.',
    category: 'grammar',
  },
  {
    id: 'deep-grammar-tense',
    name: 'Grammar: Tense consistency',
    description: 'Fix tense consistency',
    sentence: 'Yesterday I go to the store and buy some milk.',
    expectedCleaned: 'Yesterday I went to the store and bought some milk.',
    category: 'grammar',
  },
  
  // Filler word removal
  {
    id: 'deep-filler-um-uh',
    name: 'Filler: Remove um and uh',
    description: 'Remove common filler words',
    sentence: 'So um I was uh thinking about the project.',
    expectedCleaned: 'I was thinking about the project.',
    category: 'filler',
  },
  {
    id: 'deep-filler-like-basically',
    name: 'Filler: Remove like and basically',
    description: 'Remove filler words like and basically',
    sentence: 'So basically like I want to discuss this.',
    expectedCleaned: 'I want to discuss this.',
    category: 'filler',
  },
  {
    id: 'deep-filler-you-know',
    name: 'Filler: Remove you know',
    description: 'Remove you know filler',
    sentence: 'The thing is, you know, we need to move faster.',
    expectedCleaned: 'The thing is, we need to move faster.',
    category: 'filler',
  },
  
  // Stuttering removal
  {
    id: 'deep-stutter-simple',
    name: 'Stutter: Simple word repetition',
    description: 'Remove simple stuttering',
    sentence: 'I I I want to go.',
    expectedCleaned: 'I want to go.',
    category: 'stutter',
  },
  {
    id: 'deep-stutter-phrase',
    name: 'Stutter: Phrase repetition',
    description: 'Remove repeated phrase',
    sentence: 'The meeting the meeting starts at noon.',
    expectedCleaned: 'The meeting starts at noon.',
    category: 'stutter',
  },
  {
    id: 'deep-stutter-mixed',
    name: 'Stutter: Mixed with filler',
    description: 'Remove stutter and filler together',
    sentence: 'I um I want to I want to discuss this.',
    expectedCleaned: 'I want to discuss this.',
    category: 'stutter',
  },
  
  // Technical content preservation
  {
    id: 'deep-technical-code',
    name: 'Technical: Preserve code terms',
    description: 'Preserve technical code terminology',
    sentence: 'We need to refactor the getUserById function in the API.',
    expectedCleaned: 'We need to refactor the getUserById function in the API.',
    category: 'technical',
  },
  {
    id: 'deep-technical-medical',
    name: 'Technical: Preserve medical terms',
    description: 'Preserve medical terminology',
    sentence: 'The patient has um hypertension and like diabetes.',
    expectedCleaned: 'The patient has hypertension and diabetes.',
    category: 'technical',
  },
  {
    id: 'deep-technical-numbers',
    name: 'Technical: Preserve numbers and dates',
    description: 'Preserve precise numbers and dates',
    sentence: 'The deadline is um December 15th 2024 for the $1,500 budget.',
    expectedCleaned: 'The deadline is December 15th 2024 for the $1,500 budget.',
    category: 'technical',
  },
  
  // Complex multi-issue sentences
  {
    id: 'deep-complex-multi-1',
    name: 'Complex: Multiple issues combined',
    description: 'Fix multiple issues in one sentence',
    sentence: 'So um their their going to like affect the the outcome.',
    expectedCleaned: 'They\'re going to affect the outcome.',
    category: 'complex',
  },
  {
    id: 'deep-complex-multi-2',
    name: 'Complex: Grammar and filler',
    description: 'Fix grammar and remove fillers',
    sentence: 'So basically the team are um not ready for the meeting.',
    expectedCleaned: 'The team is not ready for the meeting.',
    category: 'complex',
  },
  {
    id: 'deep-complex-multi-3',
    name: 'Complex: Homophone and stutter',
    description: 'Fix homophone and remove stutter',
    sentence: 'Your your the best person for for this role.',
    expectedCleaned: 'You\'re the best person for this role.',
    category: 'complex',
  },
  
  // Smart formatting
  {
    id: 'deep-format-time',
    name: 'Formatting: Time',
    description: 'Format spoken time to 3:30 PM',
    sentence: 'The meeting is at three thirty pm on january fifteenth twenty twenty six.',
    expectedCleaned: 'The meeting is at 3:30 PM on January 15, 2026.',
    category: 'formatting',
  },
  {
    id: 'deep-format-phone',
    name: 'Formatting: Phone Number',
    description: 'Format spoken phone number',
    sentence: 'Call me at five five five eight six seven five three oh nine.',
    expectedCleaned: 'Call me at 555-867-5309.',
    category: 'formatting',
  },
  {
    id: 'deep-format-email',
    name: 'Formatting: Email',
    description: 'Format spoken email address',
    sentence: 'Send it to john dot smith at company dot com.',
    expectedCleaned: 'Send it to john.smith@company.com.',
    category: 'formatting',
  },
  {
    id: 'deep-format-mixed',
    name: 'Formatting: Mixed with Filler',
    description: 'Format and clean fillers together',
    sentence: 'So um the deadline is like january fifteenth twenty twenty six at you know three pm.',
    expectedCleaned: 'The deadline is January 15, 2026 at 3 PM.',
    category: 'formatting',
  },
];


// ═══════════════════════════════════════════════════════════════════════════════
// LIST DETECTION SCENARIOS (Critical for Silence Polish)
// ═══════════════════════════════════════════════════════════════════════════════
// These test the specific list formatting capability that has been failing.
// "Number one... Number two..." should become "1. ... 2. ..."

export interface ListDetectionScenario {
  id: string;
  name: string;
  description: string;
  input: string;
  mode: 'clean' | 'professional';
  // Expected patterns that MUST appear in output
  expectedPatterns: string[];
  // Forbidden patterns that must NOT appear in output
  forbiddenPatterns: string[];
  // Word ratio bounds (polished/original)
  minWordRatio: number;
  maxWordRatio: number;
}

export const listDetectionScenarios: ListDetectionScenario[] = [
  {
    id: 'list-number-one-basic',
    name: 'Number one/two/three to 1/2/3',
    description: 'Basic numbered list conversion',
    input: 'Number one take the dog out. Number two walk with wife. Number three go home.',
    mode: 'clean',
    expectedPatterns: ['1.', '2.', '3.'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three'],
    minWordRatio: 0.5,
    maxWordRatio: 1.0,  // Can be same length if content preserved
  },
  {
    id: 'list-first-second-third',
    name: 'First/second/third to 1/2/3',
    description: 'Ordinal list conversion',
    input: 'First I need to buy groceries. Second I need to exercise. Third I need to cook dinner.',
    mode: 'clean',
    expectedPatterns: ['1.', '2.', '3.'],
    forbiddenPatterns: [],  // "First" might appear as content, so don't forbid
    minWordRatio: 0.6,
    maxWordRatio: 1.1,  // Word count can stay same or slightly increase with better structure
  },
  {
    id: 'list-with-filler',
    name: 'List with filler words',
    description: 'List conversion + filler removal',
    input: 'Um so number one uh take the dog out. Number two like walk with the wife.',
    mode: 'clean',
    expectedPatterns: ['1.', '2.'],
    forbiddenPatterns: ['Number one', 'Number two', ' um ', ' uh ', ' like '],
    minWordRatio: 0.3,
    maxWordRatio: 0.7,
  },
  {
    id: 'list-with-context',
    name: 'List with surrounding text',
    description: 'List in middle of other content',
    input: 'Here is my todo list. Number one buy milk. Number two get eggs. That is all for now.',
    mode: 'clean',
    expectedPatterns: ['1.', '2.'],
    forbiddenPatterns: ['Number one', 'Number two'],
    minWordRatio: 0.5,
    maxWordRatio: 1.0,  // Allow slight variation
  },
];

/**
 * Get all list detection scenarios
 */
export function getListDetectionScenarios(): ListDetectionScenario[] {
  return listDetectionScenarios;
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get all merge scenarios
 */
export function getMergeScenarios(): MergeTestScenario[] {
  return mergeScenarios;
}

/**
 * Get all deep cleanup scenarios
 */
export function getDeepCleanupScenarios(): DeepCleanupTestScenario[] {
  return deepCleanupScenarios;
}

/**
 * Get deep cleanup scenarios by category
 */
export function getDeepCleanupScenariosByCategory(category: DeepCleanupTestScenario['category']): DeepCleanupTestScenario[] {
  return deepCleanupScenarios.filter(s => s.category === category);
}

/**
 * Get merge scenarios by category
 */
export function getMergeScenariosByCategory(category: MergeTestScenario['category']): MergeTestScenario[] {
  return mergeScenarios.filter(s => s.category === category);
}

/**
 * Get all correction scenarios
 */
export function getCorrectionScenarios(): CorrectionTestScenario[] {
  return correctionScenarios;
}

/**
 * Get all polish scenarios
 */
export function getPolishScenarios(): PolishTestScenario[] {
  return polishScenarios;
}

/**
 * Get polish scenarios by mode
 */
export function getPolishScenariosByMode(mode: PolishTestScenario['mode']): PolishTestScenario[] {
  return polishScenarios.filter(s => s.mode === mode);
}

/**
 * Get all extract new words scenarios
 */
export function getExtractNewWordsScenarios(): ExtractNewWordsTestScenario[] {
  return extractNewWordsScenarios;
}

/**
 * Get extract new words scenarios by category
 */
export function getExtractNewWordsScenariosByCategory(category: ExtractNewWordsTestScenario['category']): ExtractNewWordsTestScenario[] {
  return extractNewWordsScenarios.filter(s => s.category === category);
}

/**
 * Summary of all LLM test scenarios
 */
export function getLLMTestSummary() {
  return {
    phase2_merge: {
      total: mergeScenarios.length,
      byCategory: {
        punctuation: mergeScenarios.filter(s => s.category === 'punctuation').length,
        contraction: mergeScenarios.filter(s => s.category === 'contraction').length,
        truncation: mergeScenarios.filter(s => s.category === 'truncation').length,
        revision: mergeScenarios.filter(s => s.category === 'revision').length,
        'edge-case': mergeScenarios.filter(s => s.category === 'edge-case').length,
      },
    },
    phase3_correction: {
      total: correctionScenarios.length,
      byCategory: {
        grammar: correctionScenarios.filter(s => s.category === 'grammar').length,
        stuttering: correctionScenarios.filter(s => s.category === 'stuttering').length,
        punctuation: correctionScenarios.filter(s => s.category === 'punctuation').length,
        artifact: correctionScenarios.filter(s => s.category === 'artifact').length,
        formatting: correctionScenarios.filter(s => s.category === 'formatting').length,
      },
    },
    phase4_polish: {
      total: polishScenarios.length,
      byCategory: {
        filler: polishScenarios.filter(s => s.category === 'filler').length,
        homophone: polishScenarios.filter(s => s.category === 'homophone').length,
        grammar: polishScenarios.filter(s => s.category === 'grammar').length,
        technical: polishScenarios.filter(s => s.category === 'technical').length,
        formatting: polishScenarios.filter(s => s.category === 'formatting').length,
      },
    },
    extract_new_words: {
      total: extractNewWordsScenarios.length,
      byCategory: {
        'partial-overlap': extractNewWordsScenarios.filter(s => s.category === 'partial-overlap').length,
        'complete-overlap': extractNewWordsScenarios.filter(s => s.category === 'complete-overlap').length,
        'no-overlap': extractNewWordsScenarios.filter(s => s.category === 'no-overlap').length,
        punctuation: extractNewWordsScenarios.filter(s => s.category === 'punctuation').length,
        'edge-case': extractNewWordsScenarios.filter(s => s.category === 'edge-case').length,
      },
    },
    deep_cleanup: {
      total: deepCleanupScenarios.length,
      byCategory: {
        homophone: deepCleanupScenarios.filter(s => s.category === 'homophone').length,
        grammar: deepCleanupScenarios.filter(s => s.category === 'grammar').length,
        filler: deepCleanupScenarios.filter(s => s.category === 'filler').length,
        stutter: deepCleanupScenarios.filter(s => s.category === 'stutter').length,
        technical: deepCleanupScenarios.filter(s => s.category === 'technical').length,
        complex: deepCleanupScenarios.filter(s => s.category === 'complex').length,
        formatting: deepCleanupScenarios.filter(s => s.category === 'formatting').length,
      },
    },
  };
}
