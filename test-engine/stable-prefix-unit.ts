#!/usr/bin/env npx ts-node
/**
 * Unit tests for Stable Prefix Live Paste Algorithm
 * 
 * Tests the anchor detection and fallback logic to ensure no freezing occurs.
 * These tests run without the full STT pipeline - they test the paste logic directly.
 */

// Simulate the stable prefix algorithm logic from App.tsx
function simulateStablePrefixPaste(
  lockedText: string,
  newText: string,
  normalize: (w: string) => string = (w) => w.toLowerCase().replace(/[.,!?;:'"]+$/, '')
): { action: string; result: string } {
  const newWords = newText.trim().split(/\s+/).filter(w => w)
  const lockedWords = lockedText.trim().split(/\s+/).filter(w => w)
  
  if (newWords.length === 0) {
    return { action: 'skip-empty', result: lockedText }
  }
  
  // FIRST PASTE
  if (lockedText === '') {
    return { action: 'first-paste', result: newWords.join(' ') }
  }
  
  // ANCHOR SEARCH (3, 2, 1 words)
  const anchorSizes = [3, 2, 1]
  let newTailWords: string[] = []
  let anchorFound = false
  
  for (const anchorSize of anchorSizes) {
    if (lockedWords.length < anchorSize) continue
    
    const anchorWords = lockedWords.slice(-anchorSize)
    const anchorPattern = anchorWords.map(normalize)
    
    for (let i = 0; i <= newWords.length - anchorSize; i++) {
      let match = true
      for (let j = 0; j < anchorSize; j++) {
        if (normalize(newWords[i + j]) !== anchorPattern[j]) {
          match = false
          break
        }
      }
      
      if (match) {
        const tailStartIndex = i + anchorSize
        if (tailStartIndex < newWords.length) {
          newTailWords = newWords.slice(tailStartIndex)
          anchorFound = true
        }
        break
      }
    }
    if (anchorFound) break
  }
  
  // ANCHOR FOUND - append new words
  if (anchorFound && newTailWords.length > 0) {
    const normalizedTail = newTailWords.map(normalize).join(' ')
    const lockedEnd = lockedWords.slice(-newTailWords.length).map(normalize).join(' ')
    
    // Check for duplicates
    if (normalizedTail === lockedEnd) {
      return { action: 'skip-duplicate', result: lockedText }
    }
    
    const newLockedText = lockedText + ' ' + newTailWords.join(' ')
    return { action: 'anchor-append', result: newLockedText }
  }
  
  // FALLBACK 1: Divergence with much longer text
  if (!anchorFound && newWords.length > lockedWords.length + 3) {
    const normalizedNew = newWords.map(normalize)
    const normalizedLocked = lockedWords.map(normalize)
    
    let overlapEnd = -1
    for (let i = 0; i < normalizedLocked.length; i++) {
      const lockedSuffix = normalizedLocked.slice(i)
      const newPrefix = normalizedNew.slice(0, lockedSuffix.length)
      
      if (lockedSuffix.every((w, idx) => w === newPrefix[idx])) {
        overlapEnd = lockedSuffix.length
        break
      }
    }
    
    if (overlapEnd > 0 && overlapEnd < newWords.length) {
      const tailWords = newWords.slice(overlapEnd)
      const newLockedText = lockedText + ' ' + tailWords.join(' ')
      return { action: 'fallback1-overlap', result: newLockedText }
    }
  }
  
  // FALLBACK 2: Never-freeze - append last word if different
  if (!anchorFound && newWords.length > lockedWords.length) {
    const lastNewWord = newWords[newWords.length - 1]
    const lastLockedWord = lockedWords[lockedWords.length - 1] || ''
    
    if (normalize(lastNewWord) !== normalize(lastLockedWord)) {
      const newLockedText = lockedText + ' ' + lastNewWord
      return { action: 'fallback2-never-freeze', result: newLockedText }
    }
  }
  
  // FALLBACK 3: Re-anchor recovery
  if (!anchorFound && newWords.length >= 2) {
    const normalizedNew = newWords.map(normalize)
    const normalizedLocked = lockedWords.map(normalize)
    
    let lastMatchPos = -1
    for (let i = 0; i < normalizedNew.length; i++) {
      if (normalizedLocked.length > 0 && 
          normalizedNew[i] === normalizedLocked[normalizedLocked.length - 1]) {
        let matches = true
        const checkLen = Math.min(3, normalizedLocked.length)
        for (let j = 1; j < checkLen && i - j >= 0; j++) {
          if (normalizedNew[i - j] !== normalizedLocked[normalizedLocked.length - 1 - j]) {
            matches = false
            break
          }
        }
        if (matches) {
          lastMatchPos = i
        }
      }
    }
    
    if (lastMatchPos >= 0 && lastMatchPos < newWords.length - 1) {
      const tailWords = newWords.slice(lastMatchPos + 1)
      const newLockedText = lockedText + ' ' + tailWords.join(' ')
      return { action: 'fallback3-reanchor', result: newLockedText }
    }
  }
  
  return { action: 'no-action', result: lockedText }
}

// Test cases
interface TestCase {
  name: string;
  lockedText: string;
  newText: string;
  expectAction: string;
  expectContains?: string;
  mustNotFreeze?: boolean;
}

const testCases: TestCase[] = [
  // Basic cases
  {
    name: 'First paste',
    lockedText: '',
    newText: 'Hello world',
    expectAction: 'first-paste',
    expectContains: 'Hello world',
  },
  {
    name: 'Simple extension with anchor',
    lockedText: 'one two three',
    newText: 'one two three four five',
    expectAction: 'anchor-append',
    expectContains: 'four five',
  },
  {
    name: 'Extension with punctuation normalization',
    lockedText: 'Hello, world',
    newText: 'Hello world this is new',
    expectAction: 'anchor-append',
    expectContains: 'this is new',
  },
  
  // FREEZING BUG CASES
  {
    name: 'Anchor not found - should use never-freeze fallback',
    lockedText: 'the quick brown fox',
    newText: 'completely different text jumps over lazy dog',
    expectAction: 'fallback2-never-freeze',
    mustNotFreeze: true,
    expectContains: 'dog',
  },
  {
    name: 'Rolling window truncation - anchor lost but new words exist',
    lockedText: 'one two three four five',
    newText: 'four five six seven eight',
    expectAction: 'anchor-append', // Should find "four five" anchor
    expectContains: 'six seven eight',
  },
  {
    name: 'Partial overlap after rolling window shift',
    lockedText: 'ten eleven twelve thirteen fourteen',
    newText: 'twelve thirteen fourteen fifteen sixteen seventeen',
    expectAction: 'anchor-append',
    expectContains: 'fifteen sixteen seventeen',
  },
  {
    name: 'Numbers counting - mid-sequence',
    lockedText: 'thirty thirty one thirty two thirty three',
    newText: 'thirty one thirty two thirty three thirty four thirty five',
    expectAction: 'anchor-append',
    expectContains: 'thirty four thirty five',
  },
  {
    name: 'After pause - anchor still findable',
    lockedText: 'speaking before pause',
    newText: 'speaking before pause now continuing',
    expectAction: 'anchor-append',
    expectContains: 'now continuing',
  },
  {
    name: 'STT revision changes earlier words - should still append new',
    lockedText: 'I think this is working',
    newText: 'I believe this is working well now',
    expectAction: 'anchor-append',
    expectContains: 'well now',
  },
  {
    name: 'Very long text with rolling window truncating beginning',
    lockedText: 'earlier words are gone now middle words remain visible',
    newText: 'middle words remain visible new words at the end',
    expectAction: 'anchor-append',
    expectContains: 'new words at the end',
  },
  
  // Edge cases that should NOT cause freezing
  {
    name: 'Same text repeated - no new content',
    lockedText: 'hello world',
    newText: 'hello world',
    expectAction: 'no-action', // This is OK - genuinely no new content
  },
  {
    name: 'New text is shorter - rolling window edge case',
    lockedText: 'one two three four five',
    newText: 'three four five six',
    expectAction: 'anchor-append',
    expectContains: 'six',
  },
  {
    name: 'Single new word after anchor',
    lockedText: 'the cat sat on',
    newText: 'the cat sat on the',
    expectAction: 'anchor-append',
    expectContains: 'the',
  },
  
  // More aggressive freezing prevention tests
  {
    name: 'Complete transcription change - fallback must kick in',
    lockedText: 'I am speaking now',
    newText: 'He was running then quickly',
    expectAction: 'fallback2-never-freeze',
    mustNotFreeze: true,
    expectContains: 'quickly',
  },
  {
    name: 'User counted: thirty to forty-five (mid sequence freeze)',
    lockedText: 'thirty thirty-one thirty-two thirty-three thirty-four thirty-five thirty-six',
    newText: 'thirty-four thirty-five thirty-six thirty-seven thirty-eight thirty-nine forty',
    expectAction: 'anchor-append',
    expectContains: 'thirty-seven thirty-eight thirty-nine forty',
  },
  {
    name: 'Long pause then continuation - anchor found in middle',
    lockedText: 'first sentence before the pause',
    newText: 'second sentence after the pause continuing now',
    expectAction: 'anchor-append', // "the pause" is the anchor
    expectContains: 'continuing now',
  },
  {
    name: 'STT hallucination then correction',
    lockedText: 'I need to go to',
    newText: 'I need to go to the store',
    expectAction: 'anchor-append',
    expectContains: 'the store',
  },
  {
    name: 'Anchor at very start of new text',
    lockedText: 'hello world',
    newText: 'hello world goodbye universe',
    expectAction: 'anchor-append',
    expectContains: 'goodbye universe',
  },
  {
    name: 'Multiple possible anchors - should use rightmost',
    lockedText: 'the the the dog',
    newText: 'the the the dog ran fast',
    expectAction: 'anchor-append',
    expectContains: 'ran fast',
  },
  {
    name: 'New words same as locked end - no duplicate',
    lockedText: 'one two three',
    newText: 'one two three',
    expectAction: 'no-action', // Same content, genuinely nothing new
  },
  {
    name: 'Aggressive rolling window - only last few words visible',
    lockedText: 'word1 word2 word3 word4 word5 word6 word7 word8',
    newText: 'word7 word8 word9 word10 word11',
    expectAction: 'anchor-append',
    expectContains: 'word9 word10 word11',
  },
]

// Run tests
console.log('\n═══════════════════════════════════════════════════════════════')
console.log('     STABLE PREFIX ALGORITHM - FREEZING REGRESSION TESTS')
console.log('═══════════════════════════════════════════════════════════════\n')

let passed = 0
let failed = 0
const failures: string[] = []

for (const tc of testCases) {
  const result = simulateStablePrefixPaste(tc.lockedText, tc.newText)
  
  let testPassed = true
  let failReason = ''
  
  // Check action matches
  if (tc.expectAction && result.action !== tc.expectAction) {
    // Allow fallback2/fallback3 if mustNotFreeze is set
    if (tc.mustNotFreeze && result.action.startsWith('fallback')) {
      // OK - a fallback was used
    } else if (tc.mustNotFreeze && result.action === 'no-action') {
      testPassed = false
      failReason = `FREEZE! Expected fallback but got no-action`
    } else {
      testPassed = false
      failReason = `Expected action '${tc.expectAction}' but got '${result.action}'`
    }
  }
  
  // Check result contains expected text
  if (tc.expectContains && !result.result.includes(tc.expectContains)) {
    testPassed = false
    failReason = `Result missing expected text '${tc.expectContains}'`
  }
  
  // Check no freeze when required
  if (tc.mustNotFreeze && result.action === 'no-action' && result.result === tc.lockedText) {
    testPassed = false
    failReason = 'FREEZE DETECTED! No action taken when new words were present'
  }
  
  if (testPassed) {
    console.log(`✅ ${tc.name}`)
    console.log(`   Action: ${result.action}`)
    passed++
  } else {
    console.log(`❌ ${tc.name}`)
    console.log(`   Action: ${result.action}`)
    console.log(`   Locked: "${tc.lockedText}"`)
    console.log(`   New:    "${tc.newText}"`)
    console.log(`   Result: "${result.result}"`)
    console.log(`   Error:  ${failReason}`)
    failures.push(`${tc.name}: ${failReason}`)
    failed++
  }
  console.log()
}

console.log('═══════════════════════════════════════════════════════════════')
console.log(`RESULTS: ${passed} passed, ${failed} failed`)
console.log('═══════════════════════════════════════════════════════════════')

if (failures.length > 0) {
  console.log('\nFAILURES:')
  failures.forEach(f => console.log(`  - ${f}`))
  process.exit(1)
} else {
  console.log('\n🎉 All freezing regression tests passed!')
  process.exit(0)
}
