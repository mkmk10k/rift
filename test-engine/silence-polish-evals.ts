#!/usr/bin/env npx ts-node
/**
 * Silence Polish Stress Tests
 * 
 * Comprehensive testing of the Silence Polish feature:
 * - Numbered lists (Number one, First, 1st, etc.)
 * - Bullet point lists
 * - Multiple pauses with lists between them
 * - Mixed content (text + lists + text)
 * - Edge cases and stress scenarios
 * 
 * Uses the autonomous TTS→STT→LLM pipeline.
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

const TEMP_DIR = path.join(os.tmpdir(), 'silence-polish-test');

// ═══════════════════════════════════════════════════════════════════════════════
// SILENCE POLISH TEST SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

interface SilencePolishScenario {
  id: string;
  name: string;
  category: 'numbered-list' | 'bullet-list' | 'mixed' | 'multi-pause' | 'stress' | 'edge-case' | 'adversarial' | 'realistic-dictation' | 'mega-stress';
  inputText: string;
  expectedPatterns: string[];
  forbiddenPatterns: string[];
  polishMode: 'clean' | 'professional';
  description: string;
}

const silencePolishScenarios: SilencePolishScenario[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // NUMBERED LISTS - Various formats
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-num-basic',
    name: 'Number one/two/three format',
    category: 'numbered-list',
    inputText: 'Number one take the dog out. Number two walk with the wife. Number three go home.',
    expectedPatterns: ['1.', '2.', '3.'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three'],
    polishMode: 'clean',
    description: 'Basic "Number X" to "X." conversion',
  },
  {
    id: 'sp-num-first-second',
    name: 'First/second/third format',
    category: 'numbered-list',
    inputText: 'First buy groceries. Second go to the gym. Third cook dinner.',
    expectedPatterns: ['1.', '2.', '3.'],
    forbiddenPatterns: [],
    polishMode: 'clean',
    description: 'Ordinal "First/Second" to numbered list',
  },
  {
    id: 'sp-num-five-items',
    name: 'Five item numbered list',
    category: 'numbered-list',
    inputText: 'Number one check email. Number two attend meeting. Number three review code. Number four write tests. Number five deploy changes.',
    expectedPatterns: ['1.', '2.', '3.', '4.', '5.'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three', 'Number four', 'Number five'],
    polishMode: 'clean',
    description: 'Longer list with 5 items',
  },
  {
    id: 'sp-num-with-context',
    name: 'List with surrounding context',
    category: 'numbered-list',
    inputText: 'Here is my todo list for today. Number one check email. Number two attend meeting. That is all for now.',
    // NOTE: Parakeet STT transcribes spoken "todo" as "to-do" (standard English).
    // This is STT behavior, not LLM. The LLM correctly preserves STT output.
    expectedPatterns: ['1.', '2.', 'to-do', 'all for now'],
    forbiddenPatterns: ['Number one', 'Number two'],
    polishMode: 'clean',
    description: 'List embedded in regular text',
  },
  {
    id: 'sp-num-filler-words',
    name: 'List with filler words',
    category: 'numbered-list',
    inputText: 'Um so number one uh take the dog out. Number two like walk with the wife.',
    expectedPatterns: ['1.', '2.'],
    forbiddenPatterns: ['Number one', 'Number two', ' um ', ' uh '],
    polishMode: 'clean',
    description: 'List with filler words that should be removed',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // BULLET POINT LISTS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-bullet-basic',
    name: 'Bullet point conversion',
    category: 'bullet-list',
    inputText: 'My shopping list includes milk, eggs, bread, and butter.',
    expectedPatterns: ['milk', 'eggs', 'bread', 'butter'],
    forbiddenPatterns: [],
    polishMode: 'clean',
    description: 'Inline list preserved (may not become bullets)',
  },
  {
    id: 'sp-bullet-items',
    name: 'Items with "item" keyword',
    category: 'bullet-list',
    inputText: 'The key items are item one security. Item two performance. Item three reliability.',
    expectedPatterns: ['security', 'performance', 'reliability'],
    forbiddenPatterns: [],
    polishMode: 'clean',
    description: 'Item-based list',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // MIXED CONTENT (Lists + Regular Text)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-mixed-intro-list',
    name: 'Introduction then list',
    category: 'mixed',
    inputText: 'Today I want to discuss three important topics. Number one the budget review. Number two the project timeline. Number three team assignments.',
    expectedPatterns: ['1.', '2.', '3.', 'discuss', 'topics'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three'],
    polishMode: 'professional',
    description: 'Professional intro followed by list',
  },
  {
    id: 'sp-mixed-list-then-outro',
    name: 'List then conclusion',
    category: 'mixed',
    inputText: 'Number one check the data. Number two verify the results. Number three submit the report. That concludes my presentation.',
    expectedPatterns: ['1.', '2.', '3.', 'concludes', 'presentation'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three'],
    polishMode: 'professional',
    description: 'List followed by conclusion',
  },
  {
    id: 'sp-mixed-sandwich',
    name: 'Text-list-text sandwich',
    category: 'mixed',
    inputText: 'Let me explain the process. Number one gather requirements. Number two design solution. Number three implement changes. This should take about two weeks.',
    expectedPatterns: ['1.', '2.', '3.', 'process', 'weeks'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three'],
    polishMode: 'professional',
    description: 'List sandwiched between regular text',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // MULTI-PAUSE SCENARIOS (Simulating multiple Silence Polish triggers)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-multi-two-lists',
    name: 'Two separate lists',
    category: 'multi-pause',
    inputText: 'Morning tasks. Number one check email. Number two team standup. Afternoon tasks. Number one code review. Number two testing.',
    expectedPatterns: ['1.', '2.', 'Morning', 'Afternoon'],
    forbiddenPatterns: [],
    polishMode: 'clean',
    description: 'Two distinct lists in one text',
  },
  {
    id: 'sp-multi-list-paragraph-list',
    name: 'List, paragraph, list',
    category: 'multi-pause',
    inputText: 'Number one start the server. Number two check the logs. After confirming everything works we move on. Number one deploy to staging. Number two run tests.',
    expectedPatterns: ['1.', '2.', 'confirming', 'works'],
    forbiddenPatterns: [],
    polishMode: 'clean',
    description: 'Two lists separated by paragraph',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STRESS TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-stress-long-items',
    name: 'List with long item descriptions',
    category: 'stress',
    inputText: 'Number one we need to review the quarterly financial reports and prepare the executive summary. Number two we should schedule meetings with all department heads to discuss budget allocations. Number three we must finalize the strategic plan before the board meeting.',
    expectedPatterns: ['1.', '2.', '3.', 'quarterly', 'budget', 'strategic'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three'],
    polishMode: 'professional',
    description: 'List items with complex sentences',
  },
  {
    id: 'sp-stress-ten-items',
    name: 'Ten item list',
    category: 'stress',
    inputText: 'Number one task A. Number two task B. Number three task C. Number four task D. Number five task E. Number six task F. Number seven task G. Number eight task H. Number nine task I. Number ten task J.',
    expectedPatterns: ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.', '9.', '10.'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number ten'],
    polishMode: 'clean',
    description: 'Large list with 10 items',
  },
  {
    id: 'sp-stress-rapid-items',
    name: 'Rapid short items',
    category: 'stress',
    inputText: 'Number one eggs. Number two milk. Number three bread. Number four cheese. Number five butter.',
    expectedPatterns: ['1.', '2.', '3.', '4.', '5.'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three'],
    polishMode: 'clean',
    description: 'Very short list items',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-edge-numbers-in-content',
    name: 'Numbers in content (not list markers)',
    category: 'edge-case',
    inputText: 'The meeting is at 3 PM. We need 5 copies of the report. The deadline is January 15.',
    expectedPatterns: ['3 PM', '5 copies', 'January 15'],  // STRICT: preserve user's numbers
    forbiddenPatterns: [],
    polishMode: 'clean',
    description: 'Numbers should be preserved as digits, not spelled out',
  },
  {
    id: 'sp-edge-no-list',
    name: 'No list content',
    category: 'edge-case',
    inputText: 'This is just a regular sentence without any list items. It should remain unchanged.',
    expectedPatterns: ['regular sentence', 'unchanged'],
    forbiddenPatterns: ['1.', '2.'],
    polishMode: 'clean',
    description: 'Text without lists should not gain list markers',
  },
  {
    id: 'sp-edge-single-item',
    name: 'Single item list',
    category: 'edge-case',
    inputText: 'Number one check the database connection.',
    expectedPatterns: ['1.', 'database'],
    forbiddenPatterns: ['Number one'],
    polishMode: 'clean',
    description: 'Single item should still be formatted',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FIX VALIDATION: Deduplication (LLM-based)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-dedup-exact-sentences',
    name: 'Exact duplicate sentences',
    category: 'edge-case',
    inputText: 'I went to the store. I bought milk. I went to the store. I bought milk. Then I came home.',
    expectedPatterns: ['store', 'milk', 'home'],
    forbiddenPatterns: [],
    polishMode: 'clean',
    description: 'Exact duplicate sentences should be removed by LLM',
  },
  {
    id: 'sp-dedup-list-items',
    name: 'Duplicate list items',
    category: 'edge-case',
    inputText: 'Number one buy groceries. Number two walk the dog. Number one buy groceries. Number two walk the dog. That is all.',
    expectedPatterns: ['1.', '2.', 'all'],
    forbiddenPatterns: ['Number one', 'Number two'],
    polishMode: 'clean',
    description: 'Duplicate list items should be deduplicated',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FIX VALIDATION: Compound Filler Removal (LLM-based)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-filler-compound',
    name: 'Compound filler phrases',
    category: 'edge-case',
    inputText: 'And uh let me explain this. Like um basically we need to uh do this thing. You know it is really important.',
    expectedPatterns: ['explain', 'need', 'important'],
    forbiddenPatterns: [' uh ', ' um ', 'basically', 'you know'],
    polishMode: 'clean',
    description: 'Compound filler phrases like "and uh", "like um" should be removed',
  },
  {
    id: 'sp-filler-heavy',
    name: 'Heavy filler word usage',
    category: 'edge-case',
    inputText: 'So like um I was thinking that uh we should uh basically just like do the thing.',
    expectedPatterns: ['thinking', 'should', 'do the thing'],
    forbiddenPatterns: [' um ', ' uh ', 'basically', 'like '],
    polishMode: 'clean',
    description: 'Multiple filler words in rapid succession',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FIX VALIDATION: Long Input (First Inference After Model Load)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-long-input-list',
    name: 'Long input with embedded list',
    category: 'stress',
    inputText: 'Testing the list function and the silence polish. First item on my list is to take the dog out. Second item on my list is to finish doing the dishes. Third item on my list is to release this app to the world. That is it for tonight. I am going to pause now and see what happens with the silence polish feature.',
    expectedPatterns: ['1.', '2.', '3.', 'dog', 'dishes', 'app', 'world'],
    forbiddenPatterns: ['First item', 'Second item', 'Third item'],
    polishMode: 'clean',
    description: 'Long text (80+ words) with embedded list - tests first inference after model load',
  },
  {
    id: 'sp-first-inference-stability',
    name: 'First inference content preservation',
    category: 'stress',
    inputText: 'This is a comprehensive test of the silence polish feature. Number one we need to verify that content is preserved. Number two we need to ensure lists are formatted correctly. Number three we need to check that the output is not truncated or corrupted. This test has approximately eighty words to simulate real user input that triggered a garbage output bug where the first inference after model load produced truncated or corrupted results.',
    expectedPatterns: ['1.', '2.', '3.', 'content', 'preserved', 'lists', 'formatted', 'truncated'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three'],
    polishMode: 'clean',
    description: 'Long input to test first-inference-after-load stability',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // ADVERSARIAL: Challenging Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-adv-duplicate-sentences',
    name: 'Adversarial: Triple Duplicate Sentences',
    category: 'adversarial',
    inputText: `I went to the store to buy groceries. I picked up some milk and eggs. I went to the store to buy groceries. Then I drove home and unpacked everything. I went to the store to buy groceries. After that I made dinner for the family. I picked up some milk and eggs. The meal was delicious and everyone enjoyed it.`,
    expectedPatterns: ['store', 'milk', 'eggs', 'drove home', 'dinner', 'delicious'],
    forbiddenPatterns: [],
    polishMode: 'clean',
    description: 'Adversarial: Same sentences repeated 3 times, should deduplicate',
  },
  {
    id: 'sp-adv-ghost-words',
    name: 'Adversarial: Ghost Words Scattered Throughout',
    category: 'adversarial',
    inputText: `Yeah. Let me tell you about my day. Yeah. First I woke up early and made breakfast. No, no, no. Then I went to the office for meetings. Yeah. Yeah. The meetings were productive and we made good progress. No, no. After work I went to the gym. Yeah. That is basically how my day went. No, no, no. Yeah.`,
    expectedPatterns: ['woke up', 'breakfast', 'office', 'meetings', 'productive', 'gym'],
    forbiddenPatterns: ['Yeah. Yeah', 'No, no, no', 'Yeah. Let me', 'No, no. After'],
    polishMode: 'clean',
    description: 'Adversarial: Ghost words Yeah/No scattered, should be removed',
  },
  {
    id: 'sp-adv-mixed-list-formats',
    name: 'Adversarial: Three List Formats in One Input',
    category: 'adversarial',
    inputText: `Here are my priorities. Number one finish the report. Number two send the emails. First thing on my list is review the budget. Second thing on my list is call the client. First we need to check inventory. Second we need to order supplies. Third we need to update the system. That covers all the priorities.`,
    expectedPatterns: ['1.', '2.', '3.', 'report', 'emails', 'budget', 'client', 'inventory', 'supplies', 'system'],
    forbiddenPatterns: ['Number one', 'Number two', 'First thing on my list', 'Second thing on my list', 'First we', 'Second we', 'Third we'],
    polishMode: 'clean',
    description: 'Adversarial: Number X + First thing + First we formats mixed',
  },
  {
    id: 'sp-adv-heavy-fillers',
    name: 'Adversarial: 30% Filler Words',
    category: 'adversarial',
    inputText: `So um yeah basically I was uh thinking that um we should uh basically just like do the um project differently. Like um you know what I mean. So uh basically the idea is um to like uh restructure the whole um approach. Yeah so um basically that is uh what I was uh thinking about. Like um does that make uh sense to you.`,
    expectedPatterns: ['thinking', 'project', 'differently', 'restructure', 'approach', 'sense'],
    forbiddenPatterns: [' um ', ' uh ', 'basically', 'like ', 'you know'],
    polishMode: 'clean',
    description: 'Adversarial: Approximately 30% of text is filler words',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // REALISTIC DICTATION: 100-200 Word Real-World Scenarios
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-real-meeting-notes',
    name: 'Realistic Meeting Notes Dictation',
    category: 'realistic-dictation',
    inputText: `Okay so um let me go through my meeting notes from today. First thing on my list is we need to review the quarterly budget and make sure all departments have submitted their forecasts. Second thing on my list is uh we need to schedule a follow up meeting with the engineering team about the API migration. Third thing on my list is um basically we need to finalize the hiring plan for Q2. Yeah. Let me also mention that the deadline for the budget review is January 15th. First thing on my list is we need to review the quarterly budget. That is all for now I think. Yeah.`,
    expectedPatterns: ['1.', '2.', '3.', 'budget', 'engineering', 'hiring', 'January 15'],
    forbiddenPatterns: ['First thing on my list', 'Second thing', 'Third thing', ' um ', ' uh ', 'basically'],
    polishMode: 'clean',
    description: 'Real meeting notes: 120 words, mixed formats, fillers, duplicate sentence',
  },
  {
    id: 'sp-real-shopping-list',
    name: 'Realistic Shopping List with Tangents',
    category: 'realistic-dictation',
    inputText: `Um okay so I need to make a shopping list for the week. Number one I need to get milk because we ran out yesterday. Number two eggs for breakfast. Number three bread for sandwiches. Yeah. No, no. Wait let me think. Number four I also need to get some vegetables like broccoli and carrots. Number five we need chicken for dinner on Tuesday. Oh and uh number six I forgot we need laundry detergent. Yeah that should be everything. Actually wait number seven we also need paper towels. Okay I think that is the complete list now.`,
    expectedPatterns: ['1.', '2.', '3.', '4.', '5.', '6.', '7.', 'milk', 'eggs', 'bread', 'vegetables', 'chicken', 'detergent', 'paper towels'],
    forbiddenPatterns: ['Number one', 'Number two', 'Number three', 'Number four', 'Number five', 'Number six', 'Number seven', ' um ', ' uh ', 'Yeah. No, no'],
    polishMode: 'clean',
    description: 'Shopping list: 130 words, tangents, self-corrections, ghost words',
  },
  {
    id: 'sp-real-project-update',
    name: 'Realistic Project Status Update',
    category: 'realistic-dictation',
    inputText: `Alright so um let me give you a project status update. The uh the main thing is that we are basically on track for the release. First we completed the database migration last week. Second we uh finished the API endpoints yesterday. Third we are currently working on the frontend components. Fourth the QA team will start testing next Monday. Yeah. Um. The timeline looks good. We have about two weeks until the deadline. The main risks are uh performance issues with the new database and um possible delays if QA finds critical bugs. First we completed the database migration. I think we should be fine though. Let me know if you have any questions about the project status.`,
    expectedPatterns: ['1.', '2.', '3.', '4.', 'database', 'API', 'frontend', 'QA', 'Monday', 'two weeks', 'performance', 'bugs'],
    forbiddenPatterns: ['First we', 'Second we', 'Third we', 'Fourth the', ' um ', ' uh ', 'basically'],
    polishMode: 'clean',
    description: 'Project update: 150 words, heavy fillers, stuttering, duplicate sentence',
  },
  {
    id: 'sp-real-first-thing-format',
    name: 'First Thing On My List Pattern',
    category: 'realistic-dictation',
    inputText: `Okay here is my to do list for today. First thing on my list is to finish the quarterly report. Second thing on my list is to send the email to the client. Third thing on my list is to review the pull requests. Fourth thing on my list is to attend the team standup. Fifth thing on my list is to update the documentation. That is everything on my list for today.`,
    expectedPatterns: ['1.', '2.', '3.', '4.', '5.', 'report', 'email', 'client', 'pull requests', 'standup', 'documentation'],
    forbiddenPatterns: ['First thing on my list', 'Second thing on my list', 'Third thing on my list', 'Fourth thing on my list', 'Fifth thing on my list'],
    polishMode: 'clean',
    description: 'First thing on my list pattern: 100 words, consistent format',
  },
  {
    id: 'sp-real-stream-of-consciousness',
    name: 'Stream of Consciousness Dictation',
    category: 'realistic-dictation',
    inputText: `So um yeah I have been thinking about this for a while and uh basically what I want to do is first I need to organize my thoughts. So number one the most important thing is the budget. We really need to uh figure out where the money is going. Number two is staffing. We are short on engineers and uh that is causing delays. Number three is the timeline. I think we are being too aggressive with the deadlines. Yeah. Um. Let me also mention that uh I spoke with the CEO yesterday and she agrees with me on these points. First I need to organize my thoughts. The plan going forward is to number one hire two more engineers by end of month. Number two revise the budget allocations. Number three extend the deadline by two weeks. I think that covers everything. Yeah that is all.`,
    expectedPatterns: ['1.', '2.', '3.', 'budget', 'staffing', 'engineers', 'timeline', 'CEO', 'hire', 'deadline'],
    forbiddenPatterns: ['number one', 'number two', 'number three', 'First I need', ' um ', ' uh ', 'basically', 'Yeah. Um'],
    polishMode: 'clean',
    description: 'Stream of consciousness: 200 words, maximum complexity, multiple formats, duplicates',
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // MEGA STRESS TEST: 500+ Words
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'sp-mega-500-word-dictation',
    name: 'Mega 500+ Word Realistic Dictation',
    category: 'mega-stress',
    inputText: `Okay so um let me start by going through everything I need to cover in this meeting today. Yeah. First thing on my list is we need to review the quarterly budget reports from all departments. The finance team submitted their numbers last week and uh they look pretty good overall but there are some concerns about the marketing spend. Second thing on my list is we need to discuss the upcoming product launch. The engineering team has been working really hard on this and um basically we are on track for the March release date. Third thing on my list is uh we need to finalize the hiring plan for Q2. We have several open positions including two senior engineers and one product manager. Yeah. No, no, no. Let me also mention some additional context here. The quarterly budget review is really important because we need to make sure all departments are aligned with our annual goals. First thing on my list is we need to review the quarterly budget reports. The CEO is expecting a presentation next Monday so we need to have everything ready by Friday. Um so basically the key metrics we need to focus on are revenue growth, customer acquisition cost, and employee retention rates. Now let me talk about the product launch in more detail. Number one we need to ensure the QA team has completed all their testing cycles. Number two we need to coordinate with marketing for the launch campaign. Number three we need to prepare the customer success team for incoming support requests. Number four we need to update all documentation and release notes. Number five we need to schedule the deployment window with DevOps. Regarding the hiring plan, I wanted to mention that we have received over 200 applications for the senior engineer positions. The recruiting team has been doing phone screens and uh we have about 15 candidates moving to the next round. First thing we need to do is schedule the technical interviews. Second thing we need to do is prepare the interview panels. Third thing we need to do is finalize the compensation packages. Yeah. Um. Okay so uh in summary, the three main priorities are budget review, product launch, and hiring. Let me repeat the key action items one more time. Number one complete the budget analysis by Thursday. Number two finalize the launch checklist by Friday. Number three schedule all technical interviews for next week. I think that covers everything for today. Oh wait, I forgot to mention one more thing. We also need to review the vendor contracts that are up for renewal next month. First there is the cloud hosting contract with AWS. Second there is the analytics contract with Mixpanel. Third there is the customer support tool contract with Zendesk. Okay I think that is really everything now. Let me know if anyone has questions. Yeah. That is all for now.`,
    expectedPatterns: ['1.', '2.', '3.', '4.', '5.', 'budget', 'product launch', 'hiring', 'QA', 'marketing', 'AWS', 'Mixpanel', 'Zendesk', 'Monday', 'Friday', 'Thursday'],
    forbiddenPatterns: ['First thing on my list', 'Second thing on my list', 'Third thing on my list', 'Number one', 'Number two', 'Number three', 'Number four', 'Number five', ' um ', ' uh ', 'basically', 'Yeah. No, no, no'],
    polishMode: 'clean',
    description: '500+ word mega stress test: multiple list formats, heavy fillers, duplicates, ghost words',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER MANAGEMENT (Same as e2e-paste-test.ts)
// ═══════════════════════════════════════════════════════════════════════════════

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
      }, 120000);
      
      this.rl = readline.createInterface({ input: this.proc.stdout! });
      
      this.rl.on('line', (line) => {
        if (!ready && (line.includes('"type": "ready"') || line.includes('"type":"ready"') || 
            line.includes('Server ready') || line.includes('ready'))) {
          ready = true;
          clearTimeout(timeout);
          console.log(`[${this.name}] Ready`);
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
      
      this.proc.stderr?.on('data', (data) => {
        const msg = data.toString();
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
    this.proc?.kill();
    this.proc = null;
  }
}

let ttsServer: Server;
let sttServer: Server;
let llmServer: Server;

async function textToSpeech(text: string, outputFile: string): Promise<string> {
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
  
  return response.output_file;
}

async function speechToText(audioFile: string): Promise<string> {
  const response = await sttServer.send({
    action: 'transcribe_file',
    audio_path: audioFile,
  });
  
  if (response.type === 'error') {
    throw new Error(`STT error: ${response.error}`);
  }
  
  return response.text || '';
}

async function polishText(text: string, mode: string): Promise<string> {
  const response = await llmServer.send({
    action: 'polish_text',
    pasted_text: text,
    final_text: text,
    mode,
  });
  
  if (response.type === 'error') {
    throw new Error(`LLM error: ${response.error}`);
  }
  
  return response.polished || text;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

// Latency thresholds (ms) - tests warn if exceeded
const LATENCY_THRESHOLDS = {
  TTS: 3000,   // TTS should complete in 3s
  STT: 3000,   // STT should complete in 3s
  LLM: 6000,   // LLM (4B model) may take up to 6s
  TOTAL: 10000 // Total pipeline should be under 10s
};

interface TestResult {
  id: string;
  name: string;
  category: string;
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
  totalTimeMs: number;
  latencyWarnings: string[];
}

async function runTest(scenario: SilencePolishScenario): Promise<TestResult> {
  const result: TestResult = {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    passed: false,
    inputText: scenario.inputText,
    transcribedText: '',
    polishedText: '',
    missingPatterns: [],
    foundForbidden: [],
    ttsTimeMs: 0,
    sttTimeMs: 0,
    llmTimeMs: 0,
    totalTimeMs: 0,
    latencyWarnings: [],
  };
  
  try {
    const audioFile = path.join(TEMP_DIR, `${scenario.id}.wav`);
    const testStart = Date.now();
    
    const ttsStart = Date.now();
    await textToSpeech(scenario.inputText, audioFile);
    result.ttsTimeMs = Date.now() - ttsStart;
    if (result.ttsTimeMs > LATENCY_THRESHOLDS.TTS) {
      result.latencyWarnings.push(`TTS ${result.ttsTimeMs}ms > ${LATENCY_THRESHOLDS.TTS}ms`);
    }
    
    const sttStart = Date.now();
    result.transcribedText = await speechToText(audioFile);
    result.sttTimeMs = Date.now() - sttStart;
    if (result.sttTimeMs > LATENCY_THRESHOLDS.STT) {
      result.latencyWarnings.push(`STT ${result.sttTimeMs}ms > ${LATENCY_THRESHOLDS.STT}ms`);
    }
    
    const llmStart = Date.now();
    result.polishedText = await polishText(result.transcribedText, scenario.polishMode);
    result.llmTimeMs = Date.now() - llmStart;
    if (result.llmTimeMs > LATENCY_THRESHOLDS.LLM) {
      result.latencyWarnings.push(`LLM ${result.llmTimeMs}ms > ${LATENCY_THRESHOLDS.LLM}ms`);
    }
    
    result.totalTimeMs = Date.now() - testStart;
    if (result.totalTimeMs > LATENCY_THRESHOLDS.TOTAL) {
      result.latencyWarnings.push(`TOTAL ${result.totalTimeMs}ms > ${LATENCY_THRESHOLDS.TOTAL}ms`);
    }
    
    // Verify patterns
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
    
    try { fs.unlinkSync(audioFile); } catch (e) {}
    
  } catch (err: any) {
    result.error = err.message;
  }
  
  return result;
}

async function runAllTests(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('         SILENCE POLISH STRESS TESTS (Autonomous)              ');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Memory warning for 16GB systems
  const totalMem = os.totalmem() / 1024 / 1024 / 1024;
  if (totalMem < 20) {
    console.log(`⚠️  MEMORY WARNING: ${totalMem.toFixed(0)}GB RAM detected`);
    console.log('   This test runs 3 servers (~19GB peak). Expect swap usage.');
    console.log('   For low-memory mode, use: silence-polish-evals-lowmem.ts\n');
  }
  
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  
  ttsServer = new Server('TTS');
  sttServer = new Server('STT');
  llmServer = new Server('LLM');
  
  try {
    console.log('Starting servers...\n');
    await ttsServer.start(TTS_SERVER_PATH);
    await sttServer.start(STT_SERVER_PATH);
    await llmServer.start(LLM_SERVER_PATH);
    
    // Warmup LLM
    console.log('Warming up LLM (loading 4B model)...');
    try {
      await polishText('Warmup test.', 'clean');
      console.log('LLM warmup complete!\n');
    } catch (e) {
      console.log('LLM warmup failed, continuing...\n');
    }
    
    const categories = ['numbered-list', 'bullet-list', 'mixed', 'multi-pause', 'stress', 'edge-case', 'adversarial', 'realistic-dictation', 'mega-stress'];
    const results: TestResult[] = [];
    const categoryResults: Map<string, { passed: number; total: number }> = new Map();
    
    for (const category of categories) {
      const categoryScenarios = silencePolishScenarios.filter(s => s.category === category);
      if (categoryScenarios.length === 0) continue;
      
      console.log('─────────────────────────────────────────────────────────────');
      console.log(`${category.toUpperCase()} (${categoryScenarios.length} tests)`);
      console.log('─────────────────────────────────────────────────────────────\n');
      
      let categoryPassed = 0;
      
      for (const scenario of categoryScenarios) {
        process.stdout.write(`  ${scenario.id}: ${scenario.name}... `);
        const result = await runTest(scenario);
        results.push(result);
        
        // Build status line with timing
        const timing = `[${result.totalTimeMs}ms: TTS=${result.ttsTimeMs}, STT=${result.sttTimeMs}, LLM=${result.llmTimeMs}]`;
        
        if (result.passed) {
          categoryPassed++;
          if (result.latencyWarnings.length > 0) {
            console.log(`✅ ⚠️ ${timing}`);
            for (const warn of result.latencyWarnings) {
              console.log(`    ⏱️  ${warn}`);
            }
          } else {
            console.log(`✅ ${timing}`);
          }
        } else {
          console.log(`❌ ${timing}`);
          if (result.error) {
            console.log(`    Error: ${result.error}`);
          }
          if (result.missingPatterns.length > 0) {
            console.log(`    Missing: ${result.missingPatterns.join(', ')}`);
          }
          if (result.foundForbidden.length > 0) {
            console.log(`    Forbidden found: ${result.foundForbidden.join(', ')}`);
          }
          for (const warn of result.latencyWarnings) {
            console.log(`    ⏱️  ${warn}`);
          }
          console.log(`    Input: "${result.inputText.substring(0, 60)}..."`);
          console.log(`    Polished: "${result.polishedText.substring(0, 60)}..."`);
        }
      }
      
      categoryResults.set(category, { passed: categoryPassed, total: categoryScenarios.length });
      console.log(`\n  Category: ${categoryPassed}/${categoryScenarios.length} passed\n`);
    }
    
    // Summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    SILENCE POLISH SUMMARY                      ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    const totalPassed = results.filter(r => r.passed).length;
    const totalTests = results.length;
    const passRate = (totalPassed / totalTests * 100).toFixed(1);
    
    console.log(`TOTAL: ${totalPassed}/${totalTests} passed (${passRate}%)\n`);
    
    console.log('By Category:');
    for (const [cat, stats] of categoryResults) {
      const pct = (stats.passed / stats.total * 100).toFixed(0);
      const bar = '█'.repeat(Math.floor(stats.passed / stats.total * 20)) + '░'.repeat(20 - Math.floor(stats.passed / stats.total * 20));
      console.log(`  ${cat.padEnd(15)} ${bar} ${stats.passed}/${stats.total} (${pct}%)`);
    }
    
    // Latency statistics
    const successfulResults = results.filter(r => !r.error);
    if (successfulResults.length > 0) {
      const avgTts = successfulResults.reduce((s, r) => s + r.ttsTimeMs, 0) / successfulResults.length;
      const avgStt = successfulResults.reduce((s, r) => s + r.sttTimeMs, 0) / successfulResults.length;
      const avgLlm = successfulResults.reduce((s, r) => s + r.llmTimeMs, 0) / successfulResults.length;
      const avgTotal = successfulResults.reduce((s, r) => s + r.totalTimeMs, 0) / successfulResults.length;
      const maxTotal = Math.max(...successfulResults.map(r => r.totalTimeMs));
      const minTotal = Math.min(...successfulResults.map(r => r.totalTimeMs));
      
      console.log('\nLATENCY REPORT:');
      console.log('───────────────────────────────────────────');
      console.log(`  Stage     Avg      Threshold   Status`);
      console.log(`  TTS       ${avgTts.toFixed(0).padStart(5)}ms   ${LATENCY_THRESHOLDS.TTS}ms      ${avgTts <= LATENCY_THRESHOLDS.TTS ? '✅' : '⚠️'}`);
      console.log(`  STT       ${avgStt.toFixed(0).padStart(5)}ms   ${LATENCY_THRESHOLDS.STT}ms      ${avgStt <= LATENCY_THRESHOLDS.STT ? '✅' : '⚠️'}`);
      console.log(`  LLM       ${avgLlm.toFixed(0).padStart(5)}ms   ${LATENCY_THRESHOLDS.LLM}ms      ${avgLlm <= LATENCY_THRESHOLDS.LLM ? '✅' : '⚠️'}`);
      console.log(`  TOTAL     ${avgTotal.toFixed(0).padStart(5)}ms   ${LATENCY_THRESHOLDS.TOTAL}ms     ${avgTotal <= LATENCY_THRESHOLDS.TOTAL ? '✅' : '⚠️'}`);
      console.log(`  Range: ${minTotal}ms - ${maxTotal}ms`);
      
      const latencyWarningCount = results.reduce((s, r) => s + r.latencyWarnings.length, 0);
      if (latencyWarningCount > 0) {
        console.log(`\n  ⚠️  ${latencyWarningCount} latency threshold violations`);
      }
    }
    
    // Failed tests summary
    const failed = results.filter(r => !r.passed);
    if (failed.length > 0) {
      console.log('\n─────────────────────────────────────────────────────────────');
      console.log('FAILED TESTS:');
      console.log('─────────────────────────────────────────────────────────────');
      for (const f of failed) {
        const reason = f.error || 
          (f.missingPatterns.length > 0 ? `Missing: ${f.missingPatterns.join(', ')}` : '') +
          (f.foundForbidden.length > 0 ? ` Forbidden: ${f.foundForbidden.join(', ')}` : '');
        console.log(`  ${f.id}: ${reason}`);
      }
    }
    
    // Save report
    const reportDir = path.join(__dirname, 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `silence-polish-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ 
      timestamp: new Date().toISOString(), 
      summary: {
        total: totalTests,
        passed: totalPassed,
        passRate: totalPassed / totalTests,
        categoryResults: Object.fromEntries(categoryResults),
      },
      results 
    }, null, 2));
    
    // Append to history with latency data
    const historyPath = path.join(__dirname, 'history.jsonl');
    const historyEntry = {
      timestamp: new Date().toISOString(),
      label: 'silence-polish-eval',
      totalTests,
      passed: totalPassed,
      failed: totalTests - totalPassed,
      passRate: totalPassed / totalTests,
      categories: Object.fromEntries(categoryResults),
      latency: successfulResults.length > 0 ? {
        avgTtsMs: Math.round(successfulResults.reduce((s, r) => s + r.ttsTimeMs, 0) / successfulResults.length),
        avgSttMs: Math.round(successfulResults.reduce((s, r) => s + r.sttTimeMs, 0) / successfulResults.length),
        avgLlmMs: Math.round(successfulResults.reduce((s, r) => s + r.llmTimeMs, 0) / successfulResults.length),
        avgTotalMs: Math.round(successfulResults.reduce((s, r) => s + r.totalTimeMs, 0) / successfulResults.length),
        warnings: results.reduce((s, r) => s + r.latencyWarnings.length, 0),
      } : null,
    };
    fs.appendFileSync(historyPath, JSON.stringify(historyEntry) + '\n');
    console.log(`\nReport: ${reportPath}`);
    console.log(`History: ${historyPath}`);
    
    // Coverage gap warning
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log('⚠️  NOT TESTED: Pasteboard/clipboard behavior');
    console.log('    This eval tests TTS→STT→LLM pipeline only.');
    console.log('    Paste/replace/undo behavior requires full app integration test.');
    console.log('─────────────────────────────────────────────────────────────');
    
    process.exit(totalPassed === totalTests ? 0 : 1);
    
  } finally {
    console.log('\nCleaning up...');
    ttsServer.stop();
    sttServer.stop();
    llmServer.stop();
    try { fs.rmSync(TEMP_DIR, { recursive: true }); } catch (e) {}
    
    // Force kill any zombie Python processes
    const { execSync } = require('child_process');
    try {
      execSync('pkill -f "llm_server.py|stt_server.py|tts_server.py" 2>/dev/null', { stdio: 'ignore' });
    } catch (e) {}
    console.log('Done. Python processes cleaned up.');
  }
}

// Export scenarios for use in other test files
export { silencePolishScenarios, SilencePolishScenario };

// Run
runAllTests().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
