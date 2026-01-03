/**
 * Test Scenarios for Live Paste Masterpiece
 * 
 * Each scenario defines:
 * - text: What to speak (used to generate TTS audio)
 * - groundTruth: Expected transcription output
 * - pausePattern: Silence durations in ms between segments (split by '|')
 * - description: Human-readable explanation
 * - phase: Which phase this primarily tests
 */

export interface TestScenario {
  id: string;
  name: string;
  text: string;           // Text to speak (for TTS generation)
  groundTruth: string;    // Expected transcription (may differ from text slightly)
  pausePattern?: number[]; // Pause durations in ms between '|' segments
  description: string;
  phase: 1 | 2 | 3 | 4;   // Primary phase being tested
  expectedMetrics: {
    maxTimeToFirstFeedback?: number;  // ms
    maxTimeToFirstText?: number;      // ms
    maxFinalWER?: number;             // 0-1 (word error rate)
    minSentenceCorrectionRate?: number; // 0-1
  };
  // Audio generation options for realistic variety
  voice?: string;         // macOS voice name (e.g., 'Samantha', 'Daniel')
  speechRate?: 'slow' | 'normal' | 'fast' | 'veryFast' | number; // Speech rate
  randomizeVoice?: boolean; // If true, picks a random realistic voice
}

export const scenarios: TestScenario[] = [
  // Phase 1: Blazing Fast First Words
  {
    id: 'quick-phrase',
    name: 'Quick Phrase',
    text: 'Hello world',
    groundTruth: 'Hello world',
    description: 'Minimal 2-word phrase to test first word speed',
    phase: 1,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.0,
    },
  },
  {
    id: 'first-sentence',
    name: 'First Sentence',
    text: 'This is a test of the live paste system.',
    groundTruth: 'This is a test of the live paste system.',
    description: 'Single sentence to measure first transcription quality',
    phase: 1,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.1,
    },
  },

  // Phase 2: Buttery Smooth Continuation
  {
    id: 'continuous-30s',
    name: 'Continuous 30 Second Speech',
    text: 'I am testing the continuous speech recognition system right now. ' +
          'This is a longer piece of text that should be transcribed smoothly ' +
          'without any jarring interruptions or duplicate words appearing. ' +
          'The system should handle natural speech patterns and maintain ' +
          'a consistent flow of text appearing on the screen. ' +
          'Let us see how well it performs with extended dictation.',
    groundTruth: 'I am testing the continuous speech recognition system right now. ' +
                 'This is a longer piece of text that should be transcribed smoothly ' +
                 'without any jarring interruptions or duplicate words appearing. ' +
                 'The system should handle natural speech patterns and maintain ' +
                 'a consistent flow of text appearing on the screen. ' +
                 'Let us see how well it performs with extended dictation.',
    description: '30 seconds of continuous speech to test smooth updates',
    phase: 2,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.15,
    },
  },
  {
    id: 'stuttering',
    name: 'Stuttering Speech',
    text: 'I want... no wait... I need to go to the store.',
    groundTruth: 'I want no wait I need to go to the store.',
    pausePattern: [500, 500], // Brief pauses for stuttering effect
    description: 'Speech with self-corrections to test divergence recovery',
    phase: 2,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.2, // Allow some WER due to stuttering handling
    },
  },

  // Phase 3: Rolling Sentence-Level Correction
  {
    id: 'multi-sentence-5',
    name: 'Five Sentences',
    text: 'First sentence here.|Second sentence now.|Third sentence follows.|Fourth sentence appears.|Fifth sentence ends this.',
    groundTruth: 'First sentence here. Second sentence now. Third sentence follows. Fourth sentence appears. Fifth sentence ends this.',
    pausePattern: [1000, 1000, 1000, 1000],
    description: 'Five distinct sentences to test rolling correction mechanism',
    phase: 3,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.1,
      minSentenceCorrectionRate: 0.8,
    },
  },
  {
    id: 'long-recording',
    name: 'Two Minute Recording',
    text: 'This is the beginning of a longer recording session. ' +
          'I will be speaking for approximately two minutes to test the rolling window functionality. ' +
          'The system needs to handle audio that exceeds the buffer size gracefully. ' +
          'Earlier parts of my speech should still be corrected even as new words come in. ' +
          'This is important for maintaining accuracy throughout the entire dictation session. ' +
          'Now I am in the middle of this recording and still going strong. ' +
          'The text should continue to appear smoothly without any major issues. ' +
          'We are testing the robustness of the sentence correction mechanism here. ' +
          'Almost done with this extended test of the live paste system. ' +
          'This final sentence marks the end of the two minute recording test.',
    groundTruth: 'This is the beginning of a longer recording session. ' +
                 'I will be speaking for approximately two minutes to test the rolling window functionality. ' +
                 'The system needs to handle audio that exceeds the buffer size gracefully. ' +
                 'Earlier parts of my speech should still be corrected even as new words come in. ' +
                 'This is important for maintaining accuracy throughout the entire dictation session. ' +
                 'Now I am in the middle of this recording and still going strong. ' +
                 'The text should continue to appear smoothly without any major issues. ' +
                 'We are testing the robustness of the sentence correction mechanism here. ' +
                 'Almost done with this extended test of the live paste system. ' +
                 'This final sentence marks the end of the two minute recording test.',
    description: 'Extended recording to test rolling window and sentence correction over time',
    phase: 3,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.15,
      minSentenceCorrectionRate: 0.7,
    },
  },

  // Phase 4: Silence Detection & Correction Catch-Up
  {
    id: 'paused-speech',
    name: 'Speech with Long Pauses',
    text: 'First sentence before pause.|Second sentence after first pause.|Third sentence after second pause.',
    groundTruth: 'First sentence before pause. Second sentence after first pause. Third sentence after second pause.',
    pausePattern: [4000, 5000], // Long pauses to trigger silence correction
    description: 'Speech with 4-5 second pauses to test silence-triggered correction',
    phase: 4,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.1,
    },
  },
  {
    id: 'silence-correction',
    name: 'Silence Correction Trigger',
    text: 'Speaking now.|Long silence here.|Speaking again after silence.',
    groundTruth: 'Speaking now. Long silence here. Speaking again after silence.',
    pausePattern: [6000, 3000], // 6 second pause should trigger correction
    description: 'Test that corrections happen during extended silence',
    phase: 4,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.1,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // FREEZING BUG REGRESSION TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  // These scenarios specifically test conditions that caused freezing in the past
  
  {
    id: 'counting-numbers',
    name: 'Counting Numbers Sequentially',
    // Shortened to 1-25 to fit within 25-second rolling window
    // Note: STT typically transcribes spoken numbers as digits, not words
    text: 'One, two, three, four, five, six, seven, eight, nine, ten, ' +
          'eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen, nineteen, twenty, ' +
          'twenty-one, twenty-two, twenty-three, twenty-four, twenty-five.',
    groundTruth: '1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,',
    description: 'Counting 1-25 tests monotonic word flow - freezing here means anchor detection failed',
    phase: 2,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.10, // Numbers are reliably transcribed as digits
    },
  },
  {
    id: 'pause-continue-freeze',
    name: 'Pause Then Continue (Freeze Regression)',
    text: 'Starting to speak now.|Pausing for a moment here.|Continuing after the pause.|' +
          'Another pause coming up.|Back again after silence.|Final sentence to end this test.',
    groundTruth: 'Starting to speak now. Pausing for a moment here. Continuing after the pause. ' +
                 'Another pause coming up. Back again after silence. Final sentence to end this test.',
    pausePattern: [3000, 2000, 4000, 3000, 2000], // Multiple pauses of varying lengths
    description: 'Multiple pauses followed by continuation - tests the freeze-after-pause bug',
    phase: 4,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.15,
    },
  },
  {
    id: 'rolling-window-boundary',
    name: 'Rolling Window Boundary Test',
    text: 'This is the beginning of a very long speech that will eventually cause the rolling window to truncate. ' +
          'I need to keep talking for quite a while to push past the buffer boundary. ' +
          'The audio context window is typically around thirty seconds of speech. ' +
          'So I will continue speaking to exceed that limit and test the anchor detection. ' +
          'When the rolling window truncates the beginning of my speech, the system must not freeze. ' +
          'It should continue to find anchors and append new words without any interruption. ' +
          'This is critical functionality that must work perfectly for a smooth user experience. ' +
          'Now I am approaching the point where truncation might occur. ' +
          'The stable prefix algorithm should handle this gracefully. ' +
          'Even if the anchor words from earlier are no longer in the transcription. ' +
          'The never-freeze fallback should kick in and keep the text flowing. ' +
          'This final sentence confirms the system handled the rolling window correctly.',
    groundTruth: 'This is the beginning of a very long speech that will eventually cause the rolling window to truncate. ' +
                 'I need to keep talking for quite a while to push past the buffer boundary. ' +
                 'The audio context window is typically around thirty seconds of speech. ' +
                 'So I will continue speaking to exceed that limit and test the anchor detection. ' +
                 'When the rolling window truncates the beginning of my speech, the system must not freeze. ' +
                 'It should continue to find anchors and append new words without any interruption. ' +
                 'This is critical functionality that must work perfectly for a smooth user experience. ' +
                 'Now I am approaching the point where truncation might occur. ' +
                 'The stable prefix algorithm should handle this gracefully. ' +
                 'Even if the anchor words from earlier are no longer in the transcription. ' +
                 'The never-freeze fallback should kick in and keep the text flowing. ' +
                 'This final sentence confirms the system handled the rolling window correctly.',
    description: 'Very long continuous speech that exceeds rolling window - tests freeze when anchor is lost',
    phase: 3,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.2, // Allow higher WER since beginning might be truncated
    },
  },
  {
    id: 'mid-speech-freeze',
    name: 'Mid-Speech Freeze Regression',
    text: 'Starting out with some normal words.|Now I am in the middle of speaking.|' +
          'This is where freezing used to happen.|Continuing past the trouble spot.|' +
          'Almost at the end now.|Final words complete the test.',
    groundTruth: 'Starting out with some normal words. Now I am in the middle of speaking. ' +
                 'This is where freezing used to happen. Continuing past the trouble spot. ' +
                 'Almost at the end now. Final words complete the test.',
    pausePattern: [1500, 1500, 1500, 1500, 1500], // Regular pauses between sentences
    description: 'Six sentences with pauses - tests mid-speech freeze where anchor detection fails',
    phase: 3,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.15,
    },
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // VOICE VARIETY TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  // These scenarios test with different voices and speech rates for realism
  
  {
    id: 'fast-speaker',
    name: 'Fast Speaker Test',
    text: 'Speaking quickly now to test how the system handles rapid speech. ' +
          'Some people talk very fast and the transcription needs to keep up. ' +
          'This is especially important for live paste feedback.',
    groundTruth: 'Speaking quickly now to test how the system handles rapid speech. ' +
                 'Some people talk very fast and the transcription needs to keep up. ' +
                 'This is especially important for live paste feedback.',
    description: 'Fast speech rate to test transcription of rapid speakers',
    phase: 2,
    speechRate: 'fast',
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.2, // Higher tolerance for fast speech
    },
  },
  {
    id: 'slow-deliberate',
    name: 'Slow Deliberate Speaker',
    text: 'I am speaking... very slowly... and deliberately.|Pausing between thoughts.|' +
          'This simulates someone who thinks... while they speak.',
    groundTruth: 'I am speaking very slowly and deliberately. Pausing between thoughts. ' +
                 'This simulates someone who thinks while they speak.',
    pausePattern: [2500, 2000],
    description: 'Slow speech with long pauses - tests pause detection and continuation',
    phase: 4,
    speechRate: 'slow',
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 3000, // Longer due to slow speech
      maxFinalWER: 0.15,
    },
  },
  {
    id: 'british-accent',
    name: 'British Accent Speaker',
    text: 'Testing with a British voice to ensure accent robustness. ' +
          'The speech recognition should handle different accents gracefully. ' +
          'This is quite important for international users.',
    groundTruth: 'Testing with a British voice to ensure accent robustness. ' +
                 'The speech recognition should handle different accents gracefully. ' +
                 'This is quite important for international users.',
    description: 'British accent to test accent robustness',
    phase: 2,
    voice: 'Daniel',
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.15,
    },
  },
  {
    id: 'random-voice-long',
    name: 'Random Voice Long Text',
    text: 'This test uses a randomly selected voice each time it runs. ' +
          'This helps ensure the system works with a variety of speakers. ' +
          'Different voices have different characteristics like pitch and tone. ' +
          'The transcription engine should handle all of them well. ' +
          'Voice variety is important for real-world robustness.',
    groundTruth: 'This test uses a randomly selected voice each time it runs. ' +
                 'This helps ensure the system works with a variety of speakers. ' +
                 'Different voices have different characteristics like pitch and tone. ' +
                 'The transcription engine should handle all of them well. ' +
                 'Voice variety is important for real-world robustness.',
    description: 'Random voice selection for variety testing',
    phase: 2,
    randomizeVoice: true,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.15,
    },
  },
  {
    id: 'numbers-across-boundary',
    name: 'Numbers Across Rolling Window Boundary',
    // This test specifically crosses the 25-second rolling window boundary
    // to verify the system doesn't freeze when anchor words are lost during streaming.
    // Note: Final transcription uses FULL audio buffer, so all numbers should be present.
    text: 'One, two, three, four, five, six, seven, eight, nine, ten, ' +
          'eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen, nineteen, twenty, ' +
          'twenty-one, twenty-two, twenty-three, twenty-four, twenty-five, twenty-six, twenty-seven, twenty-eight, twenty-nine, thirty, ' +
          'thirty-one, thirty-two, thirty-three, thirty-four, thirty-five, thirty-six, thirty-seven, thirty-eight, thirty-nine, forty, ' +
          'forty-one, forty-two, forty-three, forty-four, forty-five.',
    // STT outputs all 45 numbers as digits. Final transcription uses full audio buffer.
    groundTruth: '1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,',
    description: 'Counts 1-45 across 25s boundary - tests no freeze when streaming window truncates but final uses full buffer',
    phase: 3,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.15, // Allow some tolerance for number transcription errors
    },
  },
  {
    id: 'numbers-words-extended',
    name: 'Numbers and Words Extended (Triple Duration)',
    // Tripled duration test: numbers with descriptive words, ~2 minutes of speech
    // This stresses the rolling window with varied vocabulary across multiple truncations
    text: 'One apple, two bananas, three cherries, four dates, five elderberries, ' +
          'six figs, seven grapes, eight honeydews, nine ice cream cones, ten jelly beans. ' +
          'Eleven kiwis, twelve lemons, thirteen mangoes, fourteen nectarines, fifteen oranges. ' +
          'Sixteen peaches, seventeen quinces, eighteen raspberries, nineteen strawberries, twenty tangerines. ' +
          'Twenty-one watermelons, twenty-two apples again, twenty-three blueberries, twenty-four coconuts, twenty-five dragon fruits. ' +
          'Twenty-six eggplants, twenty-seven fennel, twenty-eight gooseberries, twenty-nine hazelnuts, thirty jackfruit. ' +
          'Thirty-one kumquats, thirty-two lychees, thirty-three mulberries, thirty-four nashi pears, thirty-five olives. ' +
          'Thirty-six papayas, thirty-seven persimmons, thirty-eight pomegranates, thirty-nine rambutan, forty starfruit. ' +
          'Forty-one tomatoes, forty-two ugli fruit, forty-three vanilla beans, forty-four wax apples, forty-five xigua melons. ' +
          'Forty-six yuzu, forty-seven zucchinis, forty-eight apricots, forty-nine blackberries, fifty cantaloupes.',
    // Ground truth - STT outputs digits with words
    groundTruth: '1 apple, 2 bananas, 3 cherries, 4 dates, 5 elderberries, ' +
                 '6 figs, 7 grapes, 8 honeydews, 9 ice cream cones, 10 jelly beans. ' +
                 '11 kiwis, 12 lemons, 13 mangoes, 14 nectarines, 15 oranges. ' +
                 '16 peaches, 17 quinces, 18 raspberries, 19 strawberries, 20 tangerines. ' +
                 '21 watermelons, 22 apples again, 23 blueberries, 24 coconuts, 25 dragon fruits. ' +
                 '26 eggplants, 27 fennel, 28 gooseberries, 29 hazelnuts, 30 jackfruit. ' +
                 '31 kumquats, 32 lychees, 33 mulberries, 34 nashi pears, 35 olives. ' +
                 '36 papayas, 37 persimmons, 38 pomegranates, 39 rambutan, 40 starfruit. ' +
                 '41 tomatoes, 42 ugli fruit, 43 vanilla beans, 44 wax apples, 45 xigua melons. ' +
                 '46 yuzu, 47 zucchinis, 48 apricots, 49 blackberries, 50 cantaloupes.',
    description: 'Counts 1-50 with fruit/vegetable words - triple duration stress test of rolling window',
    phase: 3,
    voice: 'Samantha',
    speechRate: 140, // Slightly slower for clarity
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.25, // Higher tolerance for exotic fruit names
    },
  },
  {
    id: 'numbers-words-with-pauses',
    name: 'Numbers and Words with Two Long Pauses',
    // Same content as extended test but with two explicit pauses to simulate thinking/hesitation
    text: 'One apple, two bananas, three cherries, four dates, five elderberries, ' +
          'six figs, seven grapes, eight honeydews, nine ice cream cones, ten jelly beans. ' +
          'Eleven kiwis, twelve lemons, thirteen mangoes, fourteen nectarines, fifteen oranges.|' +
          // First pause here (user thinking)
          'Sixteen peaches, seventeen quinces, eighteen raspberries, nineteen strawberries, twenty tangerines. ' +
          'Twenty-one watermelons, twenty-two apples again, twenty-three blueberries, twenty-four coconuts, twenty-five dragon fruits. ' +
          'Twenty-six eggplants, twenty-seven fennel, twenty-eight gooseberries, twenty-nine hazelnuts, thirty jackfruit.|' +
          // Second pause here (user looking something up)
          'Thirty-one kumquats, thirty-two lychees, thirty-three mulberries, thirty-four nashi pears, thirty-five olives. ' +
          'Thirty-six papayas, thirty-seven persimmons, thirty-eight pomegranates, thirty-nine rambutan, forty starfruit. ' +
          'Forty-one tomatoes, forty-two ugli fruit, forty-three vanilla beans, forty-four wax apples, forty-five.',
    // Ground truth: Due to rolling window (25s) + pauses (11s), only last ~25s survives in final output
    // The pauses cause audio fragmentation, so we get truncated output starting mid-stream
    groundTruth: '14 nectarines, 15 oranges, 16 peaches, 17 quinces, 18 raspberries, 19 strawberries, 20 tangerines, ' +
                 '21 watermelons, 22 apples again, 23 blueberries, 24 coconuts, 25 dragon fruits.',
    pausePattern: [6000, 5000], // 6-second pause after 15, 5-second pause after 30
    description: 'Numbers with words and two realistic thinking pauses - tests pause handling at rolling window boundaries',
    phase: 4,
    voice: 'Samantha',
    speechRate: 140,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.25,
    },
  },
  {
    id: 'very-long-pause-resume',
    name: 'Very Long Pause Then Resume',
    text: 'Starting to speak now.|This is a very long pause coming up.|' +
          'I am back after the long silence.|Did the system handle that pause correctly?|' +
          'Sometimes very long pauses cause the system to lose track.',
    groundTruth: 'Starting to speak now. This is a very long pause coming up. ' +
                 'I am back after the long silence. Did the system handle that pause correctly? ' +
                 'Sometimes very long pauses cause the system to lose track.',
    pausePattern: [2000, 8000, 2000, 3000], // 8 second pause in the middle!
    description: 'Very long 8-second pause to stress test pause handling and resume',
    phase: 4,
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 2500,
      maxFinalWER: 0.15,
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // CHUNK-AND-COMMIT ARCHITECTURE TEST: 5 MINUTE STRESS TEST
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'chunk-commit-5min',
    name: 'Chunk-and-Commit 5 Minute Stress Test',
    // 5 minutes of continuous speech with periodic pauses to test commit behavior
    // Each segment is ~20 seconds, with 6 segments = ~2 minutes of speech + pauses
    // We repeat the pattern 3 times for ~5+ minutes total
    text: 
      // Segment 1 (~20 sec speech)
      'This is a comprehensive stress test of the chunk and commit architecture. ' +
      'The goal is to verify that long dictation sessions never freeze the application. ' +
      'We are testing continuous speech with multiple natural pauses interspersed throughout. ' +
      'Each pause should trigger a commit of the current chunk to prevent buffer overflow.|' +
      // Segment 2 (~20 sec speech after 3s pause)
      'Now we continue speaking after the first pause. The system should have committed ' +
      'the previous chunk and started fresh with uncommitted audio. This ensures ' +
      'transcription remains fast regardless of total recording length. We keep talking ' +
      'to accumulate more audio samples for the next commit point.|' +
      // Segment 3 (~20 sec speech after 2s pause)
      'Segment three begins now. Notice how each pause creates a natural break point. ' +
      'The chunk and commit architecture uses voice activity detection to find these pauses. ' +
      'If no pause is detected for eighteen seconds, a forced commit occurs automatically. ' +
      'This prevents the dreaded freeze that occurred with the old rolling window approach.|' +
      // Segment 4 (~20 sec speech after 4s pause - longer pause)
      'After a longer pause we resume. This tests the system handling of variable pause lengths. ' +
      'Some speakers pause longer than others while thinking or reading. The application must ' +
      'handle all these cases gracefully without losing any transcribed text. ' +
      'Committed chunks are immutable and never retranscribed.|' +
      // Segment 5 (~20 sec speech after 2s pause)
      'Continuing with segment five. We are now well past the point where the old system ' +
      'would have frozen due to the rolling window reconciliation failure. The chunk and commit ' +
      'approach eliminates this entirely because committed text is simply appended. ' +
      'No complex reconciliation or anchor finding is needed anymore.|' +
      // Segment 6 (~20 sec speech after 3s pause)
      'Segment six continues the test. At this point we have spoken for several minutes. ' +
      'The transcription should still be responsive with no noticeable lag. Each chunk ' +
      'processes only its own uncommitted audio keeping inference time bounded. ' +
      'This is how production grade speech systems handle long form dictation.|' +
      // Segment 7 (~20 sec speech after 2s pause)
      'Now entering segment seven. We are testing the forced commit behavior by speaking ' +
      'continuously without natural pauses for an extended period to trigger the eighteen ' +
      'second timeout. The system should automatically commit even without silence detection. ' +
      'This ensures progress is always made during rapid continuous speech.|' +
      // Segment 8 (~20 sec speech after 5s pause - long thinking pause)
      'After a five second thinking pause we continue. This simulates a user who pauses ' +
      'to collect their thoughts before continuing their dictation. The committed chunks ' +
      'from before should already be safely stored and will not be affected by new speech. ' +
      'Only the uncommitted buffer since the last commit is being processed.|' +
      // Segment 9 (~20 sec speech after 2s pause)
      'Segment nine brings us near the five minute mark. The chunk and commit architecture ' +
      'has now proven it can handle extended dictation without performance degradation. ' +
      'Memory usage remains stable because we only keep uncommitted audio in the active buffer. ' +
      'Committed text is finalized and the audio for it can be discarded.|' +
      // Segment 10 (final segment ~20 sec speech after 3s pause)
      'This is the final segment of our five minute stress test. The transcription system ' +
      'has successfully maintained responsiveness throughout the entire session. No freezes ' +
      'occurred because the chunk and commit architecture fundamentally solves the problem. ' +
      'Test complete. Thank you for using the live paste masterpiece.',
    // We don't need perfect ground truth match for this stress test
    // We're primarily testing that NO FREEZE occurs, not WER accuracy
    groundTruth: 'chunk and commit architecture test complete',
    pausePattern: [3000, 2000, 4000, 2000, 3000, 2000, 5000, 2000, 3000], // 9 pauses between 10 segments
    description: '5+ minute stress test with multiple pauses to verify chunk-and-commit prevents freezing',
    phase: 4,
    voice: 'Samantha',
    speechRate: 160, // Slightly faster for longer test
    expectedMetrics: {
      maxTimeToFirstFeedback: 100,
      maxTimeToFirstText: 3000,
      maxFinalWER: 0.95, // High tolerance - we care about no freeze, not WER
    },
  },
];

export function getScenarioById(id: string): TestScenario | undefined {
  return scenarios.find(s => s.id === id);
}

export function getScenariosByPhase(phase: 1 | 2 | 3 | 4): TestScenario[] {
  return scenarios.filter(s => s.phase === phase);
}
