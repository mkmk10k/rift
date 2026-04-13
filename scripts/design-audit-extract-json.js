#!/usr/bin/env node
/**
 * agent-browser eval --json wraps the return value as
 * { success, data: { origin, result } } }. Extract `result` for downstream tools.
 */
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  let parsed = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const j = JSON.parse(lines[i]);
      if (j.success && j.data && j.data.result !== undefined) {
        parsed = j.data.result;
        break;
      }
      if (j.summary && j.theme !== undefined) {
        parsed = j;
        break;
      }
    } catch {
      /* try previous line */
    }
  }
  if (!parsed) {
    console.error('design-audit: could not parse agent-browser eval JSON');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(parsed));
});
