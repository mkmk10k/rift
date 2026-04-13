/**
 * Browser context: run via `agent-browser eval --stdin < scripts/design-audit-eval.js`
 * Returns JSON-serializable programmatic checks vs `.cursor/rules/design-principles.mdc`.
 */
(function designAuditEval() {
  function parseRgb(color) {
    if (!color || color === 'transparent') return null;
    const s = String(color).trim();
    let m = s.match(
      /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i
    );
    if (m) {
      return {
        r: parseFloat(m[1]) / 255,
        g: parseFloat(m[2]) / 255,
        b: parseFloat(m[3]) / 255,
        a: m[4] !== undefined ? parseFloat(m[4]) : 1,
      };
    }
    m = s.match(/^rgb\(\s*([\d.]+)%\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
    if (m) {
      return {
        r: parseFloat(m[1]) / 100,
        g: parseFloat(m[2]) / 100,
        b: parseFloat(m[3]) / 100,
        a: 1,
      };
    }
    return null;
  }

  function relLum(rgb) {
    const f = (v) =>
      v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
  }

  function contrastRatio(fg, bg) {
    const L1 = relLum(fg);
    const L2 = relLum(bg);
    const lighter = Math.max(L1, L2);
    const darker = Math.min(L1, L2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function effectiveBackground(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      const bg = getComputedStyle(n).backgroundColor;
      const p = parseRgb(bg);
      if (p && p.a >= 0.99 && bg !== 'transparent') {
        return { r: p.r, g: p.g, b: p.b };
      }
      n = n.parentElement;
    }
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const p = parseRgb(bodyBg);
    return p ? { r: p.r, g: p.g, b: p.b } : { r: 1, g: 1, b: 1 };
  }

  function isVisible(el) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  const theme = document.documentElement.dataset.theme || 'light';
  const minRatio = theme === 'high-contrast' ? 7 : 4.5;

  function isGradientOrClipText(el) {
    const cs = getComputedStyle(el);
    if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text')
      return true;
    if (cs.webkitTextFillColor && cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)')
      return true;
    return false;
  }

  const contrastFailures = [];
  const contrastSelectors =
    'main .story-body p.story-desc, main .story-body p.story-kicker, main p.hero-story-sub, main h2.why-heading, main h2.chapter-title, main h2.privacy-headline, main h2.tech-headline, main h3.demo-section-title, footer p, footer li';
  document.querySelectorAll(contrastSelectors).forEach((el) => {
    if (!isVisible(el)) return;
    if (isGradientOrClipText(el)) return;
    if (
      el.closest(
        '.rift-demo-window, .typing-demo, .autofix-demo, .realtime-demo, .instant-demo, .pause-demo, .demo-terminal, .comparison-table, .tech-quartet'
      )
    )
      return;
    const t = el.textContent && el.textContent.trim();
    if (!t || t.length < 2) return;
    const fg = parseRgb(getComputedStyle(el).color);
    if (!fg) return;
    const bgRgb = effectiveBackground(el);
    const ratio = contrastRatio(fg, bgRgb);
    if (ratio < minRatio) {
      contrastFailures.push({
        tag: el.tagName,
        ratio: Math.round(ratio * 100) / 100,
        min: minRatio,
        sample: t.slice(0, 48).replace(/\s+/g, ' '),
      });
    }
  });

  const fontFailures = [];
  const fontSelectors =
    'main p.research-badge, main p.hero-story-sub, main .story-body p.story-desc, main .story-body p.story-kicker, main p.hero-meta, footer p, footer a';
  document.querySelectorAll(fontSelectors).forEach((el) => {
    if (!isVisible(el)) return;
    if (el.closest('.rift-demo-window, .realtime-demo, .instant-demo, .pause-demo')) return;
    const t = el.textContent && el.textContent.trim();
    if (!t) return;
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize);
    if (px > 0 && px < 14) {
      fontFailures.push({
        tag: el.tagName,
        px: Math.round(px * 100) / 100,
        sample: t.slice(0, 40),
      });
    }
  });

  const touchFailures = [];
  const touchSelectors =
    'header nav a[href], header nav button, .theme-btn, #fontDec, #fontReset, #fontInc, footer a[href]';
  document.querySelectorAll(touchSelectors).forEach((el) => {
    if (!isVisible(el)) return;
    const r = el.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    if (w > 0 && h > 0 && (w < 44 || h < 44)) {
      touchFailures.push({
        tag: el.tagName,
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className.slice(0, 40) : '',
        w: Math.round(w),
        h: Math.round(h),
      });
    }
  });

  const lineLengthFailures = [];
  const wideEnough = window.innerWidth >= 900;
  document.querySelectorAll('main .story-body p.story-desc').forEach((el) => {
    if (!wideEnough || !isVisible(el)) return;
    if (el.closest('.rift-demo-window')) return;
    const t = el.textContent && el.textContent.trim();
    if (!t || t.length < 80) return;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    const cw = el.clientWidth;
    if (!fs || !cw) return;
    const cpl = Math.round(cw / (fs * 0.52));
    if (cpl < 45 || cpl > 82) {
      lineLengthFailures.push({
        cpl,
        width: cw,
        fontSize: fs,
        sample: t.slice(0, 40),
      });
    }
  });

  const lineHeightFailures = [];
  document.querySelectorAll('main .story-body p.story-desc').forEach((el) => {
    if (!isVisible(el)) return;
    if (el.closest('.rift-demo-window')) return;
    const t = el.textContent && el.textContent.trim();
    if (!t || t.length < 80) return;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    const lh = cs.lineHeight;
    let ratio;
    if (lh === 'normal') ratio = 1.2;
    else {
      const lhp = parseFloat(lh);
      ratio = fs ? lhp / fs : 1.2;
    }
    if (ratio < 1.4) {
      lineHeightFailures.push({
        lineHeightRatio: Math.round(ratio * 1000) / 1000,
        sample: t.slice(0, 40),
      });
    }
  });

  const headingRatioFailures = [];
  const h2 = document.querySelector('main h2.chapter-title');
  const bodyP = document.querySelector('main .story-body p.story-desc');
  if (h2 && bodyP && isVisible(h2) && isVisible(bodyP) && !isGradientOrClipText(h2)) {
    const h2s = parseFloat(getComputedStyle(h2).fontSize);
    const ps = parseFloat(getComputedStyle(bodyP).fontSize);
    if (h2s > 0 && ps > 0 && h2s / ps < 1.5) {
      headingRatioFailures.push({
        h2px: h2s,
        bodyPx: ps,
        ratio: Math.round((h2s / ps) * 100) / 100,
      });
    }
  }

  const issueCount =
    contrastFailures.length +
    fontFailures.length +
    touchFailures.length +
    lineLengthFailures.length +
    lineHeightFailures.length +
    headingRatioFailures.length;

  const proseSelectors = 'main .story-body p.story-desc';
  const checksPerformed =
    document.querySelectorAll(contrastSelectors).length +
    document.querySelectorAll(fontSelectors).length +
    document.querySelectorAll(touchSelectors).length +
    document.querySelectorAll(proseSelectors).length * 2 +
    1;

  return {
    theme,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    contrast: {
      minRequired: minRatio,
      failures: contrastFailures.slice(0, 50),
    },
    fontSizes: { failures: fontFailures.slice(0, 50) },
    touchTargets: { failures: touchFailures.slice(0, 50) },
    lineLengths: { failures: lineLengthFailures.slice(0, 30) },
    lineHeights: { failures: lineHeightFailures.slice(0, 30) },
    headingRatio: { failures: headingRatioFailures },
    summary: {
      issueCount,
      checksPerformed,
      passRate:
        checksPerformed > 0
          ? Math.max(
              0,
              Math.min(1, (checksPerformed - issueCount) / checksPerformed)
            )
          : 1,
    },
  };
})();
