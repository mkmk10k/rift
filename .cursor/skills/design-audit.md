# Skill: design-audit (Gate 0 — autonomous design critic)

## Trigger phrases

- "design audit", "Gate 0 website", "visual design check", "design critic", "before pixel diff", "Jony Ive rubric"

## Purpose

Run **before** pixel-diff regression and Lighthouse. Combines **multimodal vision** (screenshots) with **programmatic** checks (`scripts/design-audit-eval.js` via `agent-browser`) against `.cursor/rules/design-principles.mdc`. Pixel baselines prove *unchanged*; this gate pushes toward *better* (hierarchy, legibility, touch targets).

**Critical:** `bun run design:audit` can pass while the page still looks wrong (clipped display type, crowded nav, “wall of meta” in footer). **Vision review of screenshots is never optional** — it catches layout and composition bugs that DOM metrics miss.

## What “world class” agent design review looks like (research synthesis)

Industry patterns for **AI + web UI** converge on a few ideas (2024–2026):

1. **Layered checks** — Combine **semantic / accessibility automation** (Lighthouse, axe-style rules) with **vision** for spatial bugs (overflow, alignment, density). Multi-agent a11y systems (e.g. scanner + vision + orchestrator) show large score gains when structure and perception are both used.
2. **Large, versioned rule sets** — Organize guidance by category (typography, motion, forms, focus, images) with **severity** so agents fix P0 first. Public examples: **Vercel Labs “Web Design Guidelines”** agent skill (100+ rules, `file:line` output) — see [OpenCodeDocs overview](https://lzw.me/docs/opencodedocs/vercel-labs/agent-skills/platforms/web-design-guidelines/index.html) and the [skill hub](https://playbooks.com/skills/vercel-labs/agent-skills/web-design-guidelines).
3. **Landing-page / marketing discipline** — Modern landing pages emphasize **clarity above the fold**, **one primary CTA per section**, **modular sections** with breathing room, and **proof blocks** that don’t collapse into unreadable grey stacks. That maps well to a **vision rubric** + your principles doc.
4. **Multimodal RAG / OCR mindset** — High-contrast type, clear hierarchy, and uncluttered regions help **both** humans and models interpret marketing pages reliably; ambiguous or low-contrast UI isn’t just “ugly,” it’s **fragile** under automation.

Rift does **not** need a separate rules server: the agent’s vision + `design-audit-eval.js` + Lighthouse is enough, provided **vision is mandatory** and the rubric below is explicit.

## Vision rubric (screenshot inspection — “Jony Ive pass”)

For **each** screenshot, answer these **before** trusting programmatic pass/fail:

| Severity | Look for |
|----------|----------|
| **P0 — Ship blocker** | Any **clipped** headline, logo, or CTA (top/side/bottom). **Unreadable** body or meta (contrast or size). **Fixed nav** overlapping anchor targets after scroll. |
| **P1 — Quality** | **Crowded** nav or inconsistent link spacing. **One focal point** per section — if two elements fight, hierarchy fails. **Stacked meta** (build + links + legal) without vertical rhythm. Harsh **edge** between sticky bar and section (no transition or mismatched tone). |
| **P2 — Polish** | Micro-spacing, slightly weak secondary text, animation that feels busy under `prefers-reduced-motion`. |

**Explicit checks:**

- Scroll to **`#download`** (and other in-page targets): does the **first line of display type** clear the sticky header and viewport?
- At **375px** and **1440px**: does the **nav** wrap or crowd? Are touch targets still plausible?
- **Dark / high-contrast**: are secondary greys still **readable** on `var(--void)` (not just passing WCAG on wrong background pairs)?

If P0/P1 issues exist, **fix CSS/HTML** and re-screenshot — even if `design-audit` exited 0.

## Prerequisites

Same as `website-qa`: `bun install`, `./node_modules/.bin/agent-browser install` once per machine.

## Workflow (6 steps)

### 1 — Screenshot capture

At **minimum**, cover **3 viewports** × **3 themes** (matches `scripts/design-audit.sh`):

| Viewports | Themes |
|-----------|--------|
| 375×812, 1024×768, 1440×900 | `light`, `dark`, `high-contrast` |

Screenshots are written to `test-engine/.cache/design-audit/` (gitignored). **You** (the agent) should **inspect** these for hierarchy, orphan grid rows, awkward whitespace, and motion (see principles doc).

### 2 — Vision evaluation

For each screenshot, apply the **Vision rubric** (above), then the **five pillars** in `design-principles.mdc`: hierarchy, whitespace, legibility, consistency, motion/interaction. Note pass / issue / suggestion per pillar, with **severity** (P0/P1/P2).

### 2b — Walk the heuristics checklist

Read `scripts/design-audit-heuristics.json`. It contains **88 rules** across **16 categories** — each with an `id`, `severity` (P0/P1/P2), and a one-line `check`.

**Procedure:**

1. Read the file (once per session — it's ~6KB).
2. For **every P0 rule**, answer pass/fail against the screenshots and your knowledge of the current CSS/HTML. **Any P0 fail is a ship blocker.**
3. For **every P1 rule**, answer pass/fail. Log failures; fix in the same session if practical.
4. **P2 rules** are polish — scan and log, fix if trivial, otherwise note for next session.
5. Include rule IDs (e.g. `LC-01`, `VH-03`) in your **Design report** (step 4) so findings are traceable.

**Categories covered:** layout-clipping, visual-hierarchy, whitespace, contrast-legibility, touch-interaction, nav-header, typography, color-theme, motion-animation, focus-keyboard, images-media, responsive, forms-inputs, performance, semantic-structure, content-composition.

The checklist is **additive** to the vision rubric and programmatic checks — it catches the structural/semantic/motion issues that neither screenshots nor contrast ratios cover alone.

### 3 — Programmatic checks

From repo root:

```bash
bun run design:audit
```

This starts a local server, runs `scripts/design-audit-eval.js` in the browser (via `agent-browser eval --stdin`), unwraps JSON with `scripts/design-audit-extract-json.js`, aggregates results, and writes:

- `test-engine/design-audit-last.json` — full per-run payloads
- Appends one JSON line to `test-engine/history.jsonl` with `label: "design-audit"`, `aggregateIssueCount`, `programmaticPassRate`

**Exit code 1** if any run reports `summary.issueCount > 0`.

### 4 — Design report

Summarize:

- **Vision:** strengths / risks (1 short paragraph).
- **Heuristics:** cite failing rule IDs grouped by severity (P0 first, then P1, then P2). Example: `LC-01 FAIL — download headline clipped under sticky nav at 1024×768 dark`.
- **Programmatic:** cite failing buckets (`contrast`, `fontSizes`, `touchTargets`, `lineLengths`, `lineHeights`, `headingRatio`) and example elements from `design-audit-last.json`.
- **Suggested CSS/HTML fixes** (no copy rewrites without the user).

### 5 — Autonomous fix

If failures are **layout/CSS/HTML** only:

1. Apply minimal fixes (tokens, `max(14px, …)`, nav hit targets, `max-width` on prose).
2. Re-run `bun run design:audit` until exit 0.
3. If a change would fight intentional design (e.g. display type over imagery), narrow the **eval** selectors or document a **vision-only** exception in the report — do not “paper over” real bugs.

### 6 — Track over time

`history.jsonl` already records `design-audit` runs. Compare `programmaticPassRate` and `aggregateIssueCount` across sessions when triaging regressions.

## Relation to `website-qa`

This is **Gate 0**. Order:

1. **design-audit** (this skill) — judgment + programmatic gate  
2. **`bun run test:website`** — pixel regression  
3. **`bun run website:lighthouse`** — a11y / SEO / best practices  

After Gate 0 fixes that change layout, run **`bun run test:website:update`** to refresh goldens.

## Key files

| File | Purpose |
|------|---------|
| `scripts/design-audit-heuristics.json` | 88-rule checklist (16 categories × P0/P1/P2) |
| `scripts/design-audit-eval.js` | Browser-context programmatic checks (contrast, fonts, touch, line-length) |
| `scripts/design-audit.sh` | Shell runner: server, screenshots, eval, finalize |
| `scripts/design-audit-extract-json.js` | Unwrap `agent-browser eval --json` envelope |
| `scripts/design-audit-append-run.js` | Append one viewport run to temp aggregation file |
| `scripts/design-audit-finalize.js` | Aggregate runs → `design-audit-last.json` + `history.jsonl` |
| `.cursor/rules/design-principles.mdc` | Five-pillar principles rubric (always-loaded for `website/**`) |
| `test-engine/design-audit-last.json` | Last full audit payload (gitignored via `.cache` parent) |

## Env overrides

| Variable | Purpose |
|----------|---------|
| `WEBSITE_VISUAL_PORT` | HTTP port (default `8899`) |
| `DESIGN_AUDIT_JSON` | Output path for last JSON |
| `DESIGN_AUDIT_SHOTS` | Screenshot directory |
| `AB` | Path to `agent-browser` binary |
