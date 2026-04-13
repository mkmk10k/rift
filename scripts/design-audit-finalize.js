#!/usr/bin/env node
const fs = require('fs');
const pathResults = process.argv[2];
const outPath = process.argv[3];
const historyPath = process.argv[4];

const lines = fs.readFileSync(pathResults, 'utf8').trim().split('\n').filter(Boolean);
const runs = lines.map((line) => JSON.parse(line));

let issues = 0;
let checks = 0;
for (const r of runs) {
  if (r.summary) {
    issues += r.summary.issueCount || 0;
    checks += r.summary.checksPerformed || 0;
  }
}
const programmaticPassRate = checks > 0 ? (checks - issues) / checks : 1;

const payload = {
  timestamp: new Date().toISOString(),
  label: 'design-audit',
  runs,
  aggregateIssueCount: issues,
  runCount: runs.length,
  programmaticPassRate,
};

fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');

const historyLine = {
  timestamp: new Date().toISOString(),
  label: 'design-audit',
  totalRuns: runs.length,
  aggregateIssueCount: issues,
  programmaticPassRate,
};
fs.appendFileSync(historyPath, JSON.stringify(historyLine) + '\n');

process.exit(issues > 0 ? 1 : 0);
