#!/usr/bin/env node
// Rejects `.Count` read off a bare pipeline in any tracked PowerShell script. Under Set-StrictMode -Version 2+
// Windows PowerShell 5.1 throws PropertyNotFoundException when a pipeline yields one item or none, so the
// pipeline must be wrapped in @(...) first. DESK step P (2026-11-08) failed on exactly this after every real step had run.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function bareCountLines(text) {
  const lines = [];
  for (const m of text.matchAll(/\)\.Count\b/g)) {
    let depth = 0, j = m.index;
    for (; j >= 0; j--) { if (text[j] === ')') depth++; else if (text[j] === '(' && --depth === 0) break; }
    const inner = text.slice(j, m.index + 1);
    if (j > 0 && text[j - 1] === '@') continue;
    if (!inner.includes('|') || /^\(\s*\[regex\]/.test(inner)) continue;
    lines.push(text.slice(0, m.index).split('\n').length);
  }
  return lines;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.ps1'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const bad = files.flatMap((f) => bareCountLines(fs.readFileSync(f, 'utf8')).map((n) => `${f}:${n}`));
  if (bad.length) { console.error(`POWERSHELL_BARE_PIPELINE_COUNT: wrap the pipeline in @(...) before .Count\n${bad.join('\n')}`); process.exit(1); }
  console.log(`powershell-count: ${files.length} scripts, no bare-pipeline .Count`);
}
