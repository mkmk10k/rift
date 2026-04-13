# Skill: website-qa

## Trigger phrases

- "QA the website", "test myrift.dev", "check website visually", "Pretext layout check", "before deploy website", "browser test the site", "visual regression website"

## Purpose

Close the loop on **`website/`** changes without asking the user to click around. Use **three gates**, in order:

1. **Gate 0 — Design audit** (`.cursor/skills/design-audit.md`) — principles + programmatic checks + screenshots; fix issues before baselines.
2. **Gate 1 — Pixel-diff regression** — deterministic `agent-browser` compares to PNG baselines.
3. **Gate 2 — Lighthouse** — accessibility / SEO / best practices.

Optional: Cursor browser tools for spot checks.

## Prerequisites

1. **Dependencies** (repo root):

   ```bash
   bun install
   ```

   First time only, download the automation Chrome build:

   ```bash
   ./node_modules/.bin/agent-browser install
   ```

2. **Vendor bundle** — Pretext is a **multi-file** import (`pretext.mjs` + `bidi.js`, `analysis.js`, `measurement.js`, `line-break.js`). After `bun install`, confirm:

   ```bash
   ls website/vendor/*.js website/vendor/pretext.mjs
   ```

## Gate 0 — Design audit (run first)

Judgment + measurable checks against `.cursor/rules/design-principles.mdc`. Full workflow: `.cursor/skills/design-audit.md`.

```bash
bun run design:audit
```

- Pass: script exits **0**; review `test-engine/design-audit-last.json` if you need detail.
- Fail: fix CSS/HTML (or adjust eval scope if the finding is a false positive), re-run Gate 0, then refresh baselines if layout changed.

## Gate 1 — Visual regression (after Gate 0)

Scripts start a local static server on **8899**, sweep **8 default-font viewports** + font-scale matrix, and compare to PNG baselines in **`test-engine/website-baselines/`**.

From repo root:

```bash
bun run test:website
```

- Pass: all diffs within threshold (default **0.1**, override with `WEBSITE_VISUAL_THRESHOLD`).
- Fail: review diffs; fix unintended regressions **or** refresh baselines after intentional design changes (including after Gate 0 fixes):

```bash
bun run test:website:update
```

**What is captured (80 baselines):**

- **8 viewports at default font:** 320×568 (iPhone SE), 375×812 (iPhone X), 768×1024 (iPad portrait), 1024×768 (iPad landscape), 1024×1366 (iPad Pro 12.9"), 1440×900 (laptop), 1920×1080 (Full HD), 2560×1440 (QHD)
- **Font-scale variants on 2 key viewports** (375×812 mobile + 1440×900 desktop): scales 0.875, 1.125, 1.25, 1.5 (matching `FONT_STEPS` in `main.js`)
- **5 shots per combination:** full-page + `#hero` + `.comparison-table` + `.tech-quartet` + `#download`

Baselines are **committed** in `test-engine/website-baselines/` so CI/agents share the same goldens.

**Env overrides:** `WEBSITE_VISUAL_PORT`, `WEBSITE_VISUAL_BASELINE_DIR`, `WEBSITE_VISUAL_THRESHOLD`, `AB` (path to `agent-browser` binary).

## Gate 2 — Lighthouse (after Gate 1 passes)

With a server on **8899** (the visual scripts already use one; for Lighthouse alone):

```bash
cd website && python3 -m http.server 8899
```

Then from repo root:

```bash
bun run website:lighthouse
```

Expect **Accessibility / SEO / Best practices** at **100** (or document regressions before deploy). Run **mobile** as well when changing nav or tap targets:

```bash
npx lighthouse@11 http://127.0.0.1:8899/ --only-categories=accessibility --device=mobile --chrome-flags="--headless --no-sandbox" --quiet
```

**Console/network sanity** (no 404s on Pretext chunks):

```bash
curl -sI http://127.0.0.1:8899/vendor/bidi.js | head -1
curl -sI http://127.0.0.1:8899/vendor/pretext.mjs | head -1
```

## Cursor-native Browser / Simple Browser (optional spot checks)

Do **all** of this on your Mac (agent sandboxes cannot flip IDE toggles for you):

1. **User settings** (already recommended for this machine):

   - `~/Library/Application Support/Cursor/User/settings.json` should include:
     - `"cursor.browserTabEnabled": true` — enables the **Browser** tab / embedded browser used by agent automation.
     - `"cursor.agent_layout_browser_beta_setting": true` — agent layout that includes the browser surface.

2. **Settings UI** (if tools still missing after restart):

   - **⌘⇧J** (macOS) → **Cursor Settings** → **Tools & MCP**.
   - Enable anything named **Browser**, **Browser automation**, or **cursor-ide-browser** (wording varies by release). If a toggle misbehaves: turn **off**, wait ~10s, turn **on** again (see [forum reports](https://forum.cursor.com)).

3. **Restart Cursor completely** (Quit, reopen — not only “Reload Window”). MCP and browser bridges load at startup.

4. **Verify in Agent chat**: the tool list should include browser actions (e.g. navigate, snapshot, screenshot). If not, update Cursor (you are on **dev** track) and repeat step 2.

`~/.cursor/mcp.json` does **not** need a manual `cursor-ide-browser` block for the built-in server; that server is shipped with Cursor and is gated by the settings above.

### Chrome DevTools MCP (`user-chrome-devtools`)

Requires **Google Chrome** listening on **port 9222**. On the Mac, start Chrome in a normal user session (not from a sandboxed agent):

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-mcp-profile" \
  "http://127.0.0.1:8899/"
```

Then use MCP tools: `navigate_page` → `take_snapshot` (refs for clicks) → `take_screenshot` (viewport or `fullPage: true`) → `resize_page` for **375×812** (phone) and **1280×800** (desktop) → `click` font/theme controls and re-screenshot.

### Cursor embedded browser (`cursor-ide-browser`)

If your Cursor build exposes **browser_navigate** / **browser_snapshot** / **browser_take_screenshot**, prefer that for the same flow. Tool availability is **environment-specific**; if tools are missing, rely on **Gate 1 + 2** above.

## Manual visual checklist (only if automation unavailable)

| Check | Pass criteria |
|--------|----------------|
| Hero + story | Story paragraphs readable; no horizontal scroll at **320px** width |
| Font buttons **A− / A / A+** | Text scales; no overlapping nav; `measureAllPretext` keeps story blocks from collapsing mid-layout |
| Theme **Light / Dark / High contrast** | Footer stays legible on black bar; links not `inherit`ing body ink on dark footer |
| Long sections | Sticky nav appears on scroll; anchor links land below fixed header (`scroll-padding`) |
| Demo / sliders | Range inputs have **labels** (`aria-labelledby` or `aria-label`) |

## Pretext vs CSS (scope)

- **Pretext**: line-breaking / **height** for scaled or dynamic copy (min-heights, demos).  
- **CSS**: grid, flex, spacing, color, motion. Do **not** replace all CSS with Pretext—see `.cursor/rules/pretext-frontend.mdc`.

When adding new measured blocks, follow **`website/main.js`** patterns and re-run **`bun run website:vendor-pretext`** after package updates.

## Deploy note

Cloudflare Pages serves **static files** only. **`website/vendor/*.js` must be committed** (or generated in CI before deploy); `postinstall` does not run on Pages.
