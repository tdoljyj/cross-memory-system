// verify-issuer-realized.mjs -- Round 33 finding R33-F2.
//
// After work/f12/realize-issuer.mjs --write substituted the four sentinels, the only checker the
// two root7 issuer qualification documents ever had -- work/f12/verify-issuer-candidates.mjs --
// became permanently RED: it asserts the four fields still hold their SENTINEL strings, which the
// realization removed by design. Two consequences, both measured in Round 33:
//   1. Its --tamper negative control is vacuous. The clean run already refuses with 16 problems,
//      so the tampered run refusing with 18 proves nothing about the tamper.
//   2. realize-issuer.mjs guards itself by running that script (CANDIDATES_DO_NOT_VERIFY), so it
//      can never run again either.
// Nothing else in the tree reads these two files (measured: grep over *.mjs/*.py/*.json/*.md), and
// check-digest-pins.mjs exempts both digests as DECLARED_NON_FILE "not a local file" -- which is
// false, they ARE local files here. Measured: append one byte to the STATUS document and the gate
// still prints "48 literal(s) accounted for, 0 unexplained" and exits 0.
//
// This script is the post-realization replacement. It proves, on the realized bytes:
//   A. each document's sha256 equals the literal context.mjs:317 pins for its purpose -- and the
//      pins are PARSED OUT OF context.mjs, not copied here, so a controller repin is tracked.
//   B. the change set versus the root5-era predecessors (blobs c1749399 / 3ae8bd41) is exactly the
//      declared budget, now stated in REALIZED values instead of sentinel names.
//   C. the realized window equals the bounds root-window-validation.mjs actually enforces.
//   D. authority_basis is tied to the real merge: the named commit exists, is a merge (2 parents),
//      its committer date equals not_before, and the approval digest equals sha256 of the carrier
//      bytes AS MERGED at that commit -- read with git, not carried by hand.
//   E. no sentinel of any shape survives.
//
// Discriminator: --tamper flips one untouched byte in memory and requires a refusal. Unlike the
// predecessor's, this one runs against an otherwise-clean baseline, so it can actually fail.
//
// READ-ONLY. No write, no Supabase, no network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = path.join(ROOT, 'artifacts/clued-validation/phase2-entry-preparation-20260908');
const CAND = path.join(A, 'root6-capacity/f12-issuer');
const CARRIER_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/next-window-m3/ExplicitOwnerApprovalM3.candidate.json';
const CTRL = path.join(ROOT, 'scripts/phase2-qualification/control-context-verifier-root6-linux-successor');
const TAMPER = process.argv.includes('--tamper');

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], {encoding: 'utf8'}).trim();
const gitBuf = (...a) => execFileSync('git', ['-C', ROOT, ...a], {maxBuffer: 1 << 28});

let failures = 0;
const bad = m => { console.error('  ' + m); failures++; };
const ok = m => console.log('  ok      ' + m);

// ---- pins parsed out of the controller, never copied ------------------------------------------
const contextSrc = fs.readFileSync(path.join(CTRL, 'context.mjs'), 'utf8');
const pinLine = contextSrc.split('\n').find(l => l.includes('EXACT_ACCEPTED_PURPOSE_ALGORITHM_METADATA'));
if (!pinLine) throw new Error('PIN_SITE_NOT_FOUND: context.mjs no longer carries EXACT_ACCEPTED_PURPOSE_ALGORITHM_METADATA');
const pinHex = [...pinLine.matchAll(/'([a-f0-9]{64})'/g)].map(m => m[1]);
if (pinHex.length !== 2) throw new Error('PIN_SHAPE_CHANGED: expected exactly 2 digest literals on the pin line, found ' + pinHex.length);
const PINS = {STATUS: pinHex[0], GATE: pinHex[1]};   // ternary order: STATUS ? ... : GATE

// ---- window parsed out of the validator, never copied -----------------------------------------
const rwv = fs.readFileSync(path.join(CTRL, 'root-window-validation.mjs'), 'utf8');
const wline = rwv.split('\n').find(l => l.includes("'Owner window'"));
if (!wline) throw new Error('WINDOW_SITE_NOT_FOUND');
const wIso = [...wline.matchAll(/'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)'/g)].map(m => m[1]);
if (wIso.length !== 2) throw new Error('WINDOW_SHAPE_CHANGED: found ' + wIso.length + ' ISO literals');
const [WIN_START, WIN_END] = wIso;

// ---- D: the merge the documents cite ----------------------------------------------------------
const PAIRS = [
  ['Root7StatusIssuerPurposeMetadata.candidate.json', 'c1749399c047a5b88461ef8df54ea80b1b59938a', 'STATUS'],
  ['Root7GateIssuerPurposeMetadata.candidate.json',   '3ae8bd4196f80266e2c2fda04a323a7b9d084840', 'GATE'],
];
const first = JSON.parse(fs.readFileSync(path.join(CAND, PAIRS[0][0]), 'utf8'));
const MERGE = first.authority_basis?.actual_verified_owner_merge;
if (!/^[a-f0-9]{40}$/.test(MERGE ?? '')) throw new Error('MERGE_SHA_ABSENT_OR_MALFORMED');
const parents = git('show', '-s', '--format=%P', MERGE).split(/\s+/).filter(Boolean);
if (parents.length !== 2) bad('MERGE_NOT_A_MERGE: ' + MERGE + ' has ' + parents.length + ' parent(s)');
else ok('M3 merge ' + MERGE.slice(0, 8) + ' is a merge commit (2 parents)');
const committed = new Date(git('show', '-s', '--format=%cI', MERGE)).toISOString().replace(/\.\d{3}Z$/, 'Z');
if (committed !== WIN_START) bad('WINDOW_START_IS_NOT_THE_MERGE_TIME: committer.date=' + committed + ', controller window starts ' + WIN_START);
else ok('window start ' + WIN_START + ' equals the M3 merge committer.date');
const endExpected = new Date(Date.parse(WIN_START) + 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
if (endExpected !== WIN_END) bad('WINDOW_IS_NOT_T_PLUS_86400: end=' + WIN_END + ', T+86400=' + endExpected);
else ok('window end ' + WIN_END + ' equals T+86400s');
const APPROVAL = sha256(gitBuf('show', MERGE + ':' + CARRIER_REL));
if (APPROVAL !== sha256(fs.readFileSync(path.join(ROOT, CARRIER_REL)))) bad('CARRIER_DRIFTED_SINCE_MERGE: the working-tree M3 carrier no longer matches its merged bytes');
else ok('M3 carrier bytes unchanged since the merge (' + APPROVAL.slice(0, 8) + ')');

// ---- A/B/C/E per document ---------------------------------------------------------------------
const EXPECTED_CHANGES = {
  control_trust_root_generation: null,   // filled below from the controller
  not_before: WIN_START,
  expires_at: WIN_END,
  'authority_basis.actual_owner_approval_sha256': APPROVAL,
  'authority_basis.actual_verified_owner_merge': MERGE,
  'accepted_scope.cumulative_controlled_execution_seconds': 10506,
  'accepted_scope.cumulative_evidence_bytes': 2335812531,
};
const genLine = contextSrc.split('\n').find(l => l.includes('root7Generation=') && l.includes('root4Expiry='));
const gen = genLine && genLine.match(/root7Generation='(ctrgen_[a-f0-9]{32})'/)?.[1];
if (!gen) throw new Error('ROOT7_GENERATION_NOT_FOUND_IN_CONTROLLER');
EXPECTED_CHANGES.control_trust_root_generation = gen;
// The two caps must be the controller's live qualificationLimits, not numbers frozen here.
const limits = contextSrc.match(/seconds:(\d+),evidenceBytes:(\d+)/);
if (!limits) throw new Error('QUALIFICATION_LIMITS_SHAPE_CHANGED');
if (Number(limits[1]) !== EXPECTED_CHANGES['accepted_scope.cumulative_controlled_execution_seconds']
 || Number(limits[2]) !== EXPECTED_CHANGES['accepted_scope.cumulative_evidence_bytes'])
  bad('CAPS_DIVERGED_FROM_CONTROLLER: context.mjs says ' + limits[1] + '/' + limits[2]);
else ok('accepted_scope caps equal context.mjs qualificationLimits (' + limits[1] + '/' + limits[2] + ')');

const diffPaths = (a, b, prefix = '', out = []) => {
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const p = prefix ? prefix + '.' + k : k, va = a?.[k], vb = b?.[k];
    if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va) && !Array.isArray(vb)) diffPaths(va, vb, p, out);
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push([p, va, vb]);
  }
  return out;
};

for (const [file, blob, purpose] of PAIRS) {
  const raw = fs.readFileSync(path.join(CAND, file), 'utf8');
  const digest = sha256(Buffer.from(raw, 'utf8'));
  if (digest !== PINS[purpose]) bad('PIN_MISMATCH ' + file + ': sha256=' + digest.slice(0, 12) + ', context.mjs pins ' + PINS[purpose].slice(0, 12));
  else ok(file + ': sha256 ' + digest.slice(0, 12) + ' equals the context.mjs ' + purpose + ' pin');

  const stray = raw.match(/__[A-Z0-9_]*PENDING[A-Z0-9_]*__/g);
  if (stray) bad('SENTINEL_SURVIVED ' + file + ': ' + [...new Set(stray)].join(', '));

  const newDoc = JSON.parse(raw);
  if (TAMPER) newDoc.accepted_scope.per_ga_maximum_seconds = 601;   // untouched by the change budget
  const oldDoc = JSON.parse(gitBuf('cat-file', '-p', blob).toString('utf8'));
  const want = new Map(Object.entries(EXPECTED_CHANGES));
  for (const [p, oldV, newV] of diffPaths(oldDoc, newDoc)) {
    if (!want.has(p)) bad('UNDECLARED CHANGE ' + file + ': ' + p + ' (' + JSON.stringify(oldV) + ' -> ' + JSON.stringify(newV) + ')');
    else if (JSON.stringify(newV) !== JSON.stringify(want.get(p))) bad('WRONG VALUE ' + file + ': ' + p + ' = ' + JSON.stringify(newV) + ', realized value should be ' + JSON.stringify(want.get(p)));
    else want.delete(p);
  }
  for (const p of want.keys()) bad('MISSING CHANGE ' + file + ': ' + p + ' still at the predecessor value');
  if (!raw.endsWith('\n')) bad(file + ': no trailing LF');
}
{
  const a = JSON.parse(fs.readFileSync(path.join(CAND, PAIRS[0][0]), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(CAND, PAIRS[1][0]), 'utf8'));
  for (const [p] of diffPaths(a, b).filter(([p]) => !p.startsWith('accepted_issuer_purposes'))) bad('CROSS-DOC DRIFT: ' + p + ' differs between the two realized documents');
}

if (failures) { console.error('REFUSED: ' + failures + ' problem(s)' + (TAMPER ? '  <- expected under --tamper' : '')); process.exit(1); }
if (TAMPER) { console.error('DISCRIMINATOR_DID_NOT_FIRE: --tamper was accepted'); process.exit(1); }
console.log('realized issuer documents verified: bytes match the controller pins, change set exactly as declared, window tied to the real merge.');
