// realize-issuer.mjs -- closes R32-F6: the two root7 issuer qualification candidates carried
// four sentinels each with no mechanical realization entry, leaving "substitute by hand, then
// self-compute sha256" as the only path. A hand step here feeds context.mjs:317 and the root7
// registration body's issuer_bindings, so a transcription slip would be discovered only when the
// 600-second run aborts at :319 -- after the allocation is spent.
//
//   node realize-issuer.mjs --t <M3 committed_at ISO> --m3-merge-sha <40hex> [--write]
//
// Runs BEFORE realize-f12.mjs: the two digests it prints are that script's
// --issuer-status-sha / --issuer-gate-sha inputs, and it prints the exact command.
//
// The M3 approval digest is NOT a parameter. It is sha256 of the merged carrier bytes, read from
// disk here, because a 64-hex value passed by hand between two scripts is the transcription risk
// this file exists to remove. The carrier is merged WITH its 26 placeholders intact -- that is by
// design (validate-m3-candidate.mjs A4 forbids a materialized T inside it), so its bytes and
// therefore this digest are deterministic at merge time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = path.join(ROOT, 'artifacts/clued-validation/phase2-entry-preparation-20260908');
const ISSUER_DIR = path.join(A, 'root6-capacity/f12-issuer');
const CARRIER = path.join(A, 'bootstrap/next-window-m3/ExplicitOwnerApprovalM3.candidate.json');

const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const WRITE = process.argv.includes('--write');
const T = arg('t'), MERGE_SHA = arg('m3-merge-sha');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
if (!T || !ISO.test(T) || Number.isNaN(Date.parse(T))) throw new Error('BAD_T: --t must be the M3 merge committed_at as UTC ISO (seconds precision, Z)');
if (!MERGE_SHA || !/^[a-f0-9]{40}$/.test(MERGE_SHA)) throw new Error('BAD_MERGE_SHA: --m3-merge-sha must be 40 lowercase hex');
const END = new Date(Date.parse(T) + 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const APPROVAL_SHA = sha256(fs.readFileSync(CARRIER));

// Guard: refuse to realize documents that do not currently pass their own change-set check.
// Realizing an already-drifted candidate would bake the drift into a digest that context.mjs
// then pins, which is the expensive direction to be wrong in.
try {
  execFileSync(process.execPath, [path.join(ROOT, 'work/f12/verify-issuer-candidates.mjs')], {stdio: 'pipe'});
} catch (e) {
  throw new Error('CANDIDATES_DO_NOT_VERIFY: run verify-issuer-candidates.mjs and fix before realizing\n' + String(e.stdout ?? '') + String(e.stderr ?? ''));
}

const FILES = ['Root7StatusIssuerPurposeMetadata.candidate.json', 'Root7GateIssuerPurposeMetadata.candidate.json'];
// Mirror of the census measured on the candidates: four distinct sentinels, one site each, in
// both files. Drift in either direction refuses rather than silently realizing a different set.
const SUBS = [
  ['__F12_PENDING_WINDOW_START__', T],
  ['__F12_PENDING_WINDOW_END__', END],
  ['__F12_PENDING_M3_APPROVAL_SHA256__', APPROVAL_SHA],
  ['__F12_PENDING_M3_MERGE_SHA__', MERGE_SHA],
];
const count = (hay, needle) => hay.split(needle).length - 1;

const out = {};
let ok = true;
for (const f of FILES) {
  let text = fs.readFileSync(path.join(ISSUER_DIR, f), 'utf8');
  for (const [sentinel, value] of SUBS) {
    const n = count(text, sentinel);
    if (n !== 1) { console.error('  WRONG   ' + f + ': ' + sentinel + ' x' + n + ', expected 1'); ok = false; continue; }
    console.log('  ok      ' + f + ': ' + sentinel + ' -> ' + value);
    text = text.split(sentinel).join(value);
  }
  out[f] = text;
}
if (!ok) throw new Error('SENTINEL_CENSUS_DRIFT: the issuer candidates do not match the measured 4x2 sentinel set');

// A realized document must carry no sentinel of any shape, not merely none of the four expected.
for (const [f, text] of Object.entries(out)) {
  const stray = text.match(/__[A-Z0-9_]*PENDING[A-Z0-9_]*__/g);
  if (stray) throw new Error('SENTINEL_SURVIVED:' + f + ': ' + [...new Set(stray)].join(', '));
}

const digests = Object.fromEntries(Object.entries(out).map(([f, t]) => [f, sha256(Buffer.from(t, 'utf8'))]));
const statusSha = digests[FILES[0]], gateSha = digests[FILES[1]];
if (statusSha === gateSha) throw new Error('IDENTICAL_DIGESTS: the two issuer documents must differ (accepted_issuer_purposes)');

if (WRITE) {
  for (const [f, text] of Object.entries(out)) fs.writeFileSync(path.join(ISSUER_DIR, f), text);
  console.log('\nrealized both issuer documents; window [' + T + ', ' + END + ']');
} else {
  console.log('\ndry run only; re-run with --write to substitute.');
}
console.log('  M3 approval sha256 (read from the merged carrier): ' + APPROVAL_SHA);
console.log('  STATUS issuer digest: ' + statusSha);
console.log('  GATE   issuer digest: ' + gateSha);
console.log('\nNEXT -- feed these into the controller realization, then freeze:');
console.log('  node work/f12/realize-f12.mjs --t ' + T + ' \\');
console.log('      --issuer-status-sha ' + statusSha + ' \\');
console.log('      --issuer-gate-sha ' + gateSha + ' --write');
console.log('  (then check-digest-pins -> selftest-runtime-pins -> build-linux-manifest = F12)');
console.log('\nThese two digests are also the issuer_bindings qualification_ref.sha256 values in the');
console.log('root7 registration body; their blob uris come from the M4 publication of these files.');
