## Learned User Preferences

- Prefers one Cursor workspace for Rift (app, website, release tooling) so work stays in a single context instead of splitting across folders.
- When using Cursor, prefers choosing a specific chat model from the selector over Auto if the goal is to avoid weaker or unpredictably routed models.
- For Rift branding and icons, prefers a minimal liquid-glass look with accretion-style color and a readable black-hole silhouette (e.g. lensing or a non-flat beam), not heavy 3D chrome or busy detail.
- Prefers running long or heavy MLX/LLM eval suites (e.g. full model comparison, full `evals`) in a cloud or remote environment when practical so the local Mac stays responsive; adopt the validated model or config on-device afterward.
- For the website (`website/`), strongly prefers minimal, scannable layouts with clear visual hierarchy over text-dense sections; stacked same-weight text blocks are a recurring pain point — fewer elements with more breathing room.

## Learned Workspace Facts

- Git: `origin` is the private app repo (`mkmk10k/rift-dev`); `public` is the open-source mirror (`mkmk10k/rift`). Sync to public with `bun run publish-public` — do not push the `public` remote by hand.
- The marketing site source lives under `website/` in this repo; production deploy is `bun run deploy:website` (wrangler to Cloudflare Pages project `myrift-dev`).
- `bun run release` runs eval gates (LLM suite, paste E2E, headless E2E); a failing gate blocks release even when the app build is fine.
- macOS distribution: keep Apple notarization secrets in `.env` (gitignored). For electron-builder, use the signing identity string without the `Developer ID Application:` prefix when the tool asks to strip that prefix.
- Website uses Pretext (`@chenglou/pretext`) for text measurement: multi-file vendor under `website/vendor/`. Run `bun run website:vendor-pretext` after install; commit vendor files (Cloudflare Pages has no `postinstall`). Pretext must only target **block-level** text (`h1`–`h4`, `p`, `li`, `summary`, `figcaption`); never `span`, `td`, `th`, `a`, or nav/footer text — setting `min-height` on inline/table/sticky elements breaks layout. Follow `.cursor/skills/pretext-layout-math.md` for computing text heights at every viewport × font-scale before writing CSS; cover all layout components (card grids, tables, demos); use `walkLineRanges()` for shrink-wrap card widths.
- Website accessibility controls (font scale, theme) are behind a discreet "Aa" disclosure in the nav, hidden on mobile. Theme defaults to system `prefers-color-scheme` via "Auto" mode.
- `cursor-ide-browser` MCP tools are available after enabling `cursor.browserTabEnabled: true` in Cursor user settings and restarting. Use for visual QA at multiple viewports.
- Website QA (three gates): **`bun run design:audit`** (Gate 0 — design principles + programmatic checks; see `.cursor/skills/design-audit.md` and `.cursor/rules/design-principles.mdc`) → **`bun run test:website`** (pixel diff vs `test-engine/website-baselines/`) → **`bun run website:lighthouse`**. **`bun run test:website:update`** refreshes baselines after intentional layout/CSS changes. The agent acts as **design owner** for `website/`, not only QA. First-time setup: `bun install` then `./node_modules/.bin/agent-browser install`. Full skill at `.cursor/skills/website-qa.md`.
- Known remaining issue: tech quartet cards can clip on narrower viewports when grid min-width does not account for the longest card description (e.g. Qwen3); needs `walkLineRanges()`-style min-width.
- Multi-model LLM benchmarking: `RIFT_MODEL_CONFIG` env var in `python/llm_server.py` selects between model configs (`qwen3`, `gemma4-e4b`, `gemma4-e4b-6bit`, `gemma4-moe`); non-Qwen3 families use `tokenizer.apply_chat_template()` for prompt formatting. CI runs via `gh workflow run "Model Comparison Evals" -f models=...` on `macos-15-xlarge` runners.
- Rift's LLM models must be MLX-format from the `mlx-community` HuggingFace org; NVIDIA-specific quantizations (NVFP4/AWQ) and models requiring vLLM are incompatible with Apple Silicon.
- Website Lighthouse scores (accessibility, SEO, best-practices) are all 1.0. `website/robots.txt` must exist for the SEO score to hold.
