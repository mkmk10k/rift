# Skill: pretext-layout-math

## Trigger phrases
- "layout math", "dimension map", "measure sections", "Pretext framework", "compute layout", "section sizing"

## Purpose

Use Pretext's `prepare()` + `layout()` to **compute exact text heights** at every viewport x font-scale combination BEFORE writing CSS. This replaces guessing with padding values.

## The measurement tool

`website/measure.html` is a standalone page that runs Pretext in the browser and dumps a complete dimension map. Serve `website/` and open `http://127.0.0.1:PORT/measure.html`.

To add sections to the measurement, edit the `SECTIONS` array in `measure.html`.

## Framework: how to use math instead of guessing

### Step 1: Compute text heights

For every text element, compute `height` at each viewport × scale:

```
height = lineCount × lineHeight
where lineCount = Pretext layout(prepare(text, fontStr), containerWidth, lineHeight).lineCount
```

Key inputs:
- `containerWidth` = `min(maxWidth, viewportWidth - horizontalPadding)`
- `fontStr` = `"{weight} {fontSize * scale}px Plus Jakarta Sans"`
- `lineHeight` = `fontSize * lineHeightRatio` (e.g. 1.5 for body, 1.1 for display)

### Step 2: Sum section content height

```
sectionContentHeight = sum(text heights) + sum(visual heights) + sum(internal gaps)
```

Internal gaps: heading-to-body = `0.5 × bodyLineHeight`, body-to-body = `1.0 × bodyLineHeight`.

### Step 3: Determine section min-height strategy

| Condition | Strategy |
|-----------|----------|
| Content fits viewport (contentH < 0.7 × viewportH) | `min-height: 100vh` + `justify-content: center` — theatrical |
| Content fills viewport (contentH ≈ viewportH) | `min-height: auto` — no extra space needed |
| Content exceeds viewport (contentH > viewportH) | `min-height: auto` — content scrolls naturally |

**Critical insight from measurements:** At small viewports with 1.5x scale, most sections exceed the viewport height. `min-height: 100vh` only makes sense on desktop at 1x scale for short content.

### Step 4: Set proportional padding

For `auto` sections:
```
padTop = clamp(24px, contentHeight × 0.2, 64px)
padBot = clamp(24px, contentHeight × 0.15, 48px)
```

For `section-full` sections, CSS centering handles spacing — no JS padding needed.

### Step 5: Set min-heights on block text elements

Pretext `layout().height` → `el.style.minHeight`. This prevents CLS when:
- Font scale changes (1x → 1.5x)
- Webfont loads (fallback → Plus Jakarta Sans)
- Viewport resizes

## Dimension reference (from measure.html)

### Container widths at each viewport

| Viewport | Horizontal pad | Available | 65ch (@16px) | 600px max |
|----------|---------------|-----------|--------------|-----------|
| 320px    | 48px          | 272px     | 272px        | 272px     |
| 375px    | 48px          | 327px     | 327px        | 327px     |
| 768px    | 64px          | 704px     | 560px        | 600px     |
| 1024px   | 64px          | 960px     | 560px        | 600px     |
| 1440px   | 64px          | 1376px    | 560px        | 600px     |

### Font sizes at each scale (type scale vars)

| Tier | 1x  | 1.25x | 1.5x |
|------|-----|-------|------|
| text-xs | 12 | 15 | 18 |
| text-sm | 13 | 16 | 20 |
| text-base | 16 | 20 | 24 |
| text-lg | 18 | 23 | 27 |
| text-xl | 20 | 25 | 30 |
| text-2xl | 24 | 30 | 36 |
| text-3xl | 32 | 40 | 48 |
| text-4xl | 40 | 50 | 60 |
| text-display | 64 | 80 | 96 |

### Key insight: when content exceeds viewport

At iPhone SE (320×568) with 1.5x scale:
- Hero text alone = 717px > 568px viewport
- Story text = ~900px > 568px viewport
- Feature sections with visuals = 400-600px

This means **`min-height: 100vh` is wrong for mobile at large scales**. The `section-full` class should use `min-height: max(100vh, auto)` pattern or conditional logic.

## Beyond text: grids, cards, tables, demos

Pretext math is not just for paragraph heights. Every component with text-driven sizing needs it:

### Cards / grid items

Use `walkLineRanges()` to find the **minimum width** that keeps text from clipping:

```js
import { prepareWithSegments, walkLineRanges } from '@chenglou/pretext';
const prepared = prepareWithSegments(cardText, fontStr);
let maxLineW = 0;
walkLineRanges(prepared, Infinity, line => { if (line.width > maxLineW) maxLineW = line.width; });
// maxLineW = single-line width; for multi-line cards, binary-search a width
// where lineCount stays acceptable (e.g. <= 4 lines)
```

Then set `grid-template-columns: repeat(auto-fit, minmax(${maxCardWidth}px, 1fr))`.

### Tables

For each column, measure the widest cell text with `prepare()` + single-line layout. Set `min-width` on `th`/`td` from those measurements.

### Demo blocks

Measure the final/longest text state (not the empty initial state). Set `min-height` from that measurement so the container doesn't collapse during animation.

### General principle

**If a component contains text and has a width or height constraint, compute the constraint from Pretext measurements rather than hardcoding pixels or relying on CSS to figure it out.** CSS handles flex/grid structure; Pretext handles "how much space does this text need?"

## When to run this skill

1. Before any layout CSS changes — compute the math first
2. After adding/removing text content — dimensions change
3. When changing the type scale — all heights change
4. Before deploying — verify measurements match expectations
5. When any component clips, overflows, or has unexpected whitespace — the math will tell you exactly why
