#!/usr/bin/env python3
"""
Comprehensive edge case tests for LLM text enhancement
"""

import json
import os
import subprocess
import sys
import re

# ═══════════════════════════════════════════════════════════════════════════════
# ALL TEST CASES
# ═══════════════════════════════════════════════════════════════════════════════

TEST_CASES = {
    # ═══════════════════════════════════════════════════════════════════════════
    # LISTS AND BULLET POINTS
    # ═══════════════════════════════════════════════════════════════════════════
    "numbered_list": {
        "input": "um first go to the store second uh pick up milk third um get bread fourth return home",
        "expected_contains": ["first", "store", "second", "milk", "third", "bread", "fourth", "home"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "bullet_points_spoken": {
        "input": "bullet point buy groceries bullet point call mom bullet point um finish report",
        "expected_contains": ["buy groceries", "call mom", "finish report"],
        "expected_not_contains": ["um"],
        "mode": "clean"
    },
    "action_items": {
        "input": "action item one review the proposal action item two uh send feedback action item three schedule meeting",
        "expected_contains": ["review", "proposal", "send feedback", "meeting"],
        "expected_not_contains": ["uh"],
        "mode": "clean"
    },
    "shopping_list": {
        "input": "shopping list um eggs milk uh bread cheese and um some vegetables like um carrots and broccoli",
        "expected_contains": ["eggs", "milk", "bread", "cheese", "vegetables", "carrots", "broccoli"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "agenda_items": {
        "input": "agenda um item one budget review uh item two project updates item three um open discussion and um item four next steps",
        "expected_contains": ["budget review", "project updates", "open discussion", "next steps"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    
    # ═══════════════════════════════════════════════════════════════════════════
    # MULTIPLE PARAGRAPHS / SECTIONS
    # ═══════════════════════════════════════════════════════════════════════════
    "two_paragraphs": {
        "input": "The first point is about efficiency um we need to improve our processes. New paragraph the second point uh concerns quality we must maintain high standards",
        "expected_contains": ["efficiency", "processes", "quality", "standards"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "email_format": {
        "input": "Dear John comma um I hope this email finds you well period new line I wanted to discuss the uh project timeline",
        "expected_contains": ["Dear John", "hope", "email", "project timeline"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "meeting_notes": {
        "input": "meeting notes from um December 30th attendees John Sarah and Mike topics discussed uh budget review and timeline",
        "expected_contains": ["meeting notes", "30", "John", "Sarah", "Mike", "budget", "timeline"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "blog_post_intro": {
        "input": "um today I want to talk about productivity uh first let me share my experience new paragraph um when I started working from home uh I struggled with focus",
        "expected_contains": ["productivity", "experience", "working from home", "focus"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "three_sections": {
        "input": "section one introduction um this is about machine learning section two uh the methodology we use neural networks section three um results",
        "expected_contains": ["introduction", "machine learning", "methodology", "neural networks", "results"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },

    # ═══════════════════════════════════════════════════════════════════════════
    # SELF-CORRECTIONS AND HESITATIONS
    # ═══════════════════════════════════════════════════════════════════════════
    "self_correction": {
        "input": "I want to go to the beach no wait I mean the mountains for vacation",
        "expected_contains": ["mountains", "vacation"],
        "expected_not_contains": [],
        "mode": "clean"
    },
    "thinking_pauses": {
        "input": "The the solution is is to implement a a caching layer",
        "expected_contains": ["solution", "implement", "caching layer"],
        "expected_not_contains": [],
        "mode": "clean"
    },
    "stuttering": {
        "input": "I I I really think we we should proceed with with the plan",
        "expected_contains": ["think", "proceed", "plan"],
        "expected_not_contains": [],
        "mode": "clean"
    },

    # ═══════════════════════════════════════════════════════════════════════════
    # TECHNICAL CONTENT
    # ═══════════════════════════════════════════════════════════════════════════
    "technical_terms": {
        "input": "um configure the nginx reverse proxy with SSL termination and uh enable HTTP 2",
        "expected_contains": ["nginx", "reverse proxy", "SSL", "HTTP"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "code_dictation": {
        "input": "function um calculate total open paren items close paren uh returns the sum",
        "expected_contains": ["function", "calculate", "total", "items"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "api_names": {
        "input": "um call the REST API endpoint slash users slash ID and uh pass the auth token",
        "expected_contains": ["REST API", "endpoint", "users", "auth token"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "code_with_explanation": {
        "input": "um the function takes two parameters uh first is the user ID second is um the callback then it returns a promise",
        "expected_contains": ["function", "parameters", "user ID", "callback", "promise"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },

    # ═══════════════════════════════════════════════════════════════════════════
    # NUMBERS, DATES, AND FORMATTING
    # ═══════════════════════════════════════════════════════════════════════════
    "dates_and_times": {
        "input": "um the meeting is on January 15th 2025 at 3 30 PM in uh conference room B",
        "expected_contains": ["meeting", "January", "15", "2025", "3", "30", "PM", "conference room"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "currency_amounts": {
        "input": "the total cost is um 1500 dollars and uh 50 cents including tax",
        "expected_contains": ["total cost", "1500", "tax"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "phone_numbers": {
        "input": "call me at um 555 123 4567 or uh email me at john at example dot com",
        "expected_contains": ["555", "123", "4567", "email", "john", "example"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },

    # ═══════════════════════════════════════════════════════════════════════════
    # PROFESSIONAL POLISH MODE
    # ═══════════════════════════════════════════════════════════════════════════
    "professional_email": {
        "input": "hey so like I was thinking maybe we could um you know push the deadline back a bit",
        "expected_contains": ["deadline"],
        "expected_not_contains": ["hey", "like", "um", "you know"],
        "mode": "professional"
    },
    "business_report": {
        "input": "so basically um the quarterly results show uh like a 15 percent increase in revenue",
        "expected_contains": ["quarterly", "results", "15", "percent", "increase", "revenue"],
        "expected_not_contains": ["so basically", "um", "uh", "like"],
        "mode": "professional"
    },
    "executive_summary": {
        "input": "so like basically um this quarter we saw um you know significant growth uh in the tech sector the numbers show like a 25 percent increase",
        "expected_contains": ["quarter", "significant growth", "tech sector", "25 percent"],
        "expected_not_contains": ["so like basically", "um", "uh", "you know"],
        "mode": "professional"
    },
    "formal_letter": {
        "input": "hey um I am writing to um you know formally request a meeting uh to discuss the project timeline",
        "expected_contains": ["writing", "request", "meeting", "project timeline"],
        "expected_not_contains": ["hey", "um", "uh", "you know"],
        "mode": "professional"
    },

    # ═══════════════════════════════════════════════════════════════════════════
    # VERBATIM MODE (should keep filler words)
    # ═══════════════════════════════════════════════════════════════════════════
    "verbatim_interview": {
        "input": "um I think the the defendant was uh present at the scene",
        "expected_contains": ["um", "uh", "defendant", "scene"],
        "expected_not_contains": [],
        "mode": "verbatim"
    },
    "legal_testimony": {
        "input": "and um I saw the defendant uh at approximately 3 PM um near the location",
        "expected_contains": ["um", "uh", "defendant", "3 PM", "location"],
        "expected_not_contains": [],
        "mode": "verbatim"
    },
    "interview_transcript": {
        "input": "well um I think the the company culture is is um you know very important to me",
        "expected_contains": ["um", "you know", "company culture", "important"],
        "expected_not_contains": [],
        "mode": "verbatim"
    },

    # ═══════════════════════════════════════════════════════════════════════════
    # QUESTIONS AND COMMANDS
    # ═══════════════════════════════════════════════════════════════════════════
    "question_format": {
        "input": "um do you think we should proceed with the um acquisition plan",
        "expected_contains": ["think", "proceed", "acquisition plan"],
        "expected_not_contains": ["um"],
        "mode": "clean"
    },
    "command_format": {
        "input": "um send the report to marketing uh copy Sarah and uh schedule follow up",
        "expected_contains": ["send", "report", "marketing", "Sarah"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "instructions_with_warnings": {
        "input": "step one um open the terminal step two uh run npm install warning um do not use sudo step three start the server",
        "expected_contains": ["step one", "terminal", "npm install", "warning", "sudo", "step three", "server"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },

    # ═══════════════════════════════════════════════════════════════════════════
    # ABBREVIATIONS AND ACRONYMS
    # ═══════════════════════════════════════════════════════════════════════════
    "acronyms": {
        "input": "the CEO of the LLC filed documents with the SEC and um the FDA",
        "expected_contains": ["CEO", "LLC", "SEC", "FDA"],
        "expected_not_contains": ["um"],
        "mode": "clean"
    },
    
    # ═══════════════════════════════════════════════════════════════════════════
    # MIXED CONTENT AND EDGE CASES
    # ═══════════════════════════════════════════════════════════════════════════
    "question_answer_format": {
        "input": "question um what is the capital of France answer uh Paris question um what is the largest ocean answer uh the Pacific",
        "expected_contains": ["question", "capital", "France", "Paris", "largest ocean", "Pacific"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
    "quoted_speech": {
        "input": "she said um I will be there at 5 and he replied uh that sounds good",
        "expected_contains": ["she said", "5", "he replied", "sounds good"],
        "expected_not_contains": ["um", "uh"],
        "mode": "clean"
    },
}


def run_test(name, test_case):
    """Run a single test case"""
    cmd = {
        "action": "polish_text",
        "pasted_text": test_case["input"],
        "final_text": test_case["input"],
        "mode": test_case["mode"]
    }
    
    return {
        "name": name,
        "input": test_case["input"],
        "mode": test_case["mode"],
        "expected_contains": test_case["expected_contains"],
        "expected_not_contains": test_case["expected_not_contains"],
        "command": json.dumps(cmd)
    }


def check_result(test_info, polished):
    """Check if result matches expectations"""
    errors = []
    
    # Check expected_contains
    for expected in test_info["expected_contains"]:
        if expected.lower() not in polished.lower():
            errors.append(f"Missing: '{expected}'")
    
    # Check expected_not_contains
    for not_expected in test_info["expected_not_contains"]:
        not_expected_lower = not_expected.lower()
        polished_lower = polished.lower()
        
        # Check for standalone filler words
        pattern = r'\b' + re.escape(not_expected_lower) + r'\b'
        if re.search(pattern, polished_lower):
            errors.append(f"Should be removed: '{not_expected}'")
    
    return errors


def main():
    print("=" * 70)
    print("LLM EDGE CASE TESTS")
    print("=" * 70)
    print()
    
    # Prepare all test commands
    tests = []
    for name, test_case in TEST_CASES.items():
        tests.append(run_test(name, test_case))
    
    # Build input for the server
    commands = "\n".join([t["command"] for t in tests])
    commands += '\n{"action": "quit"}\n'
    
    print(f"Running {len(tests)} tests...")
    print()
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    proc = subprocess.Popen(
        ["python3", os.path.join(script_dir, "llm_server.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    
    stdout, stderr = proc.communicate(commands)
    
    # Parse results
    lines = [l for l in stdout.strip().split("\n") if l.startswith("{")]
    
    # Skip the ready message
    result_lines = [l for l in lines if '"type": "ready"' not in l]
    
    # Match results to tests
    passed = 0
    failed = 0
    
    for i, test_info in enumerate(tests):
        if i >= len(result_lines):
            print(f"❌ {test_info['name']}: No response")
            failed += 1
            continue
        
        try:
            result = json.loads(result_lines[i])
            polished = result.get("polished", "")
            
            errors = check_result(test_info, polished)
            
            if errors:
                print(f"❌ {test_info['name']} ({test_info['mode']})")
                print(f"   Input:  {test_info['input'][:60]}...")
                print(f"   Output: {polished[:60]}...")
                for err in errors:
                    print(f"   Error:  {err}")
                failed += 1
            else:
                print(f"✅ {test_info['name']} ({test_info['mode']})")
                print(f"   → {polished[:70]}{'...' if len(polished) > 70 else ''}")
                passed += 1
                
        except Exception as e:
            print(f"❌ {test_info['name']}: Parse error - {e}")
            failed += 1
    
    print()
    print("=" * 70)
    print(f"RESULTS: {passed} passed, {failed} failed out of {len(tests)} tests")
    print("=" * 70)
    
    if failed > 0:
        print("\nServer logs (last 20 lines):")
        for line in stderr.strip().split("\n")[-20:]:
            print(f"  {line}")
    
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
