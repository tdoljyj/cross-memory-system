// realize-f12.mjs -- the ONLY post-M3 entry for turning the F12 pre-image into a freezable tree.
//
//   node realize-f12.mjs --t <M3 committed_at ISO> \
//       --issuer-status-sha <64hex> --issuer-gate-sha <64hex> [--write]
//
// Substitutes the four sentinel values at their seven sites (exact counts asserted), computes
// window end = T + 86400s, then leaves the tree ready for: check-digest-pins ->
// selftest-runtime-pins -> build-linux-manifest (which yields the F12 freeze digest).
// Without --write it prints the planned substitutions and exits non-zero if anything is off.
//
// The sentinels are non-hex on purpose: an unrealized tree CANNOT pass check-digest-pins
// (context.mjs 20/22 and check-digest-pins.mjs 6/8 literal shortfalls, demonstrated 2026-09-13),
// so skipping this step is mechanically loud rather than a process promise.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'scripts/phase2-qualification/control-context-verifier-root6-linux-successor');

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const WRITE = process.argv.includes('--write');
const T = arg('t'), STATUS_SHA = arg('issuer-status-sha'), GATE_SHA = arg('issuer-gate-sha');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
if (!T || !ISO.test(T) || Number.isNaN(Date.parse(T))) throw new Error('BAD_T: --t must be the M3 merge committed_at as UTC ISO (seconds precision, Z)');
for (const [n, v] of [['issuer-status-sha', STATUS_SHA], ['issuer-gate-sha', GATE_SHA]])
  if (!v || !/^[a-f0-9]{64}$/.test(v)) throw new Error('BAD_SHA: --' + n + ' must be 64 lowercase hex');
if (STATUS_SHA === GATE_SHA) throw new Error('ISSUER_SHAS_IDENTICAL: STATUS and GATE issuer docs are distinct documents');
const END = new Date(Date.parse(T) + 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// [file, sentinel, replacement, expected occurrences] -- must stay the mirror of build-f12.mjs's
// sentinel census (7 sites, 4 distinct values). Any drift refuses.
const SUBS = [
  ['context.mjs', '__F12_PENDING_WINDOW_END__', END, 1],
  ['context.mjs', '__F12_PENDING_ISSUER_STATUS_SHA256__', STATUS_SHA, 1],
  ['context.mjs', '__F12_PENDING_ISSUER_GATE_SHA256__', GATE_SHA, 1],
  ['check-digest-pins.mjs', '__F12_PENDING_ISSUER_STATUS_SHA256__', STATUS_SHA, 1],
  ['check-digest-pins.mjs', '__F12_PENDING_ISSUER_GATE_SHA256__', GATE_SHA, 1],
  ['root-window-validation.mjs', '__F12_PENDING_WINDOW_START__', T, 1],
  ['root-window-validation.mjs', '__F12_PENDING_WINDOW_END__', END, 1],
];
const count = (hay, needle) => hay.split(needle).length - 1;

let ok = true;
const texts = new Map();
for (const [file] of SUBS) if (!texts.has(file)) texts.set(file, fs.readFileSync(path.join(DIR, file), 'utf8'));
for (const [file, sentinel, value, expected] of SUBS) {
  const n = count(texts.get(file), sentinel);
  console.log((n === expected ? '  ok      ' : '  WRONG   ') + file + ': ' + sentinel + ' x' + n + ' -> ' + value);
  if (n !== expected) ok = false;
}
if (!ok) throw new Error('SENTINEL_CENSUS_DRIFT: pre-image does not match build-f12.mjs; do not realize over an unknown tree');

if (WRITE) {
  for (const [file, sentinel, value] of SUBS) texts.set(file, texts.get(file).split(sentinel).join(value));
  for (const [file, text] of texts) fs.writeFileSync(path.join(DIR, file), text);
  // Post-condition: no sentinel anywhere in the controller directory.
  for (const f of fs.readdirSync(DIR)) {
    const p = path.join(DIR, f);
    if (!fs.statSync(p).isFile()) continue;
    let t; try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (/__F12_PENDING[A-Z0-9_]*__/.test(t)) throw new Error('SENTINEL_SURVIVED_REALIZE: ' + f);
  }
  console.log('realized: window [' + T + ', ' + END + '], issuer pins set.');
  console.log('NEXT (in order, all must pass before any freeze is cited):');
  console.log('  node check-digest-pins.mjs   (context.mjs back to 22/22, this file 8/8)');
  console.log('  node selftest-runtime-pins.mjs');
  console.log('  node build-linux-manifest.mjs  -> the manifest self-sha IS F12');
} else {
  console.log('dry run only; re-run with --write to substitute.');
}
