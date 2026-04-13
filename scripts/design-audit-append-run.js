#!/usr/bin/env node
const fs = require('fs');
const onePath = process.argv[2];
const aggPath = process.argv[3];
const viewportLabel = process.argv[4];
const j = JSON.parse(fs.readFileSync(onePath, 'utf8'));
const row = Object.assign({}, j, { viewportLabel });
fs.appendFileSync(aggPath, JSON.stringify(row) + '\n');
