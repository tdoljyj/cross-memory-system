// verify-issuer-candidates.mjs -- READ-ONLY check of the two root7 issuer qualification
// candidates against their root5-era predecessors (git blobs c1749399 / 3ae8bd41).
//
// Property proved: each candidate differs from its predecessor at EXACTLY the declared paths
// and nowhere else. The declared set is the honest change budget for the F12 issuer re-issue:
//   control_trust_root_generation        root5 gen -> root7 gen (context.mjs:319 equality)
//   not_before / expires_at              expired root4-era window -> F12 window sentinels
//   authority_basis.*                    root5-era owner merge -> M3 sentinels
//   accepted_scope.cumulative_*  (x2)    7506/1664723891 (root5 caps) -> 10506/2335812531
//                                        (current qualificationLimits, context.mjs:18)
// Discriminator: run with --tamper to flip one untouched byte in memory and watch it refuse.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAND = path.join(ROOT, 'artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/f12-issuer');
const TAMPER = process.argv.includes('--tamper');

const NEW_GEN = 'ctrgen_26769cc7109ced40bc4016b2af678198';
const EXPECTED_CHANGES = {
  'control_trust_root_generation': NEW_GEN,
  'not_before': '__F12_PENDING_WINDOW_START__',
  'expires_at': '__F12_PENDING_WINDOW_END__',
  'authority_basis.actual_owner_approval_sha256': '__F12_PENDING_M3_APPROVAL_SHA256__',
  'authority_basis.actual_verified_owner_merge': '__F12_PENDING_M3_MERGE_SHA__',
  'accepted_scope.cumulative_controlled_execution_seconds': 10506,
  'accepted_scope.cumulative_evidence_bytes': 2335812531,
};
const PAIRS = [
  ['Root7StatusIssuerPurposeMetadata.candidate.json', 'c1749399c047a5b88461ef8df54ea80b1b59938a'],
  ['Root7GateIssuerPurposeMetadata.candidate.json', '3ae8bd4196f80266e2c2fda04a323a7b9d084840'],
];

const diffPaths = (a, b, prefix = '', out = []) => {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const p = prefix ? prefix + '.' + k : k;
    const va = a?.[k], vb = b?.[k];
    if (typeof va === 'object' && va !== null && typeof vb === 'object' && vb !== null && !Array.isArray(va) && !Array.isArray(vb)) diffPaths(va, vb, p, out);
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push([p, va, vb]);
  }
  return out;
};

let failures = 0;
for (const [file, blob] of PAIRS) {
  const oldDoc = JSON.parse(execFileSync('git', ['-C', ROOT, 'cat-file', '-p', blob], {encoding: 'utf8'}));
  const raw = fs.readFileSync(path.join(CAND, file), 'utf8');
  const newDoc = JSON.parse(raw);
  if (TAMPER) newDoc.accepted_scope.per_ga_maximum_seconds = 601; // discriminator: must refuse below
  if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(newDoc) && !TAMPER) { console.error(file + ': round-trip unstable'); failures++; }
  const changes = diffPaths(oldDoc, newDoc);
  const want = new Map(Object.entries(EXPECTED_CHANGES));
  for (const [p, oldV, newV] of changes) {
    if (!want.has(p)) { console.error('  UNDECLARED CHANGE ' + file + ': ' + p + ' (' + JSON.stringify(oldV) + ' -> ' + JSON.stringify(newV) + ')'); failures++; }
    else if (JSON.stringify(newV) !== JSON.stringify(want.get(p))) { console.error('  WRONG VALUE ' + file + ': ' + p + ' = ' + JSON.stringify(newV) + ', declared ' + JSON.stringify(want.get(p))); failures++; }
    else want.delete(p);
  }
  for (const p of want.keys()) { console.error('  MISSING CHANGE ' + file + ': ' + p + ' still at predecessor value'); failures++; }
  if (!raw.endsWith('\n')) { console.error(file + ': no trailing LF'); failures++; }
  console.log(file + ': ' + changes.length + ' changed path(s) vs blob ' + blob.slice(0, 8) + (failures ? '' : ' -- all declared'));
}
// The two candidates must still differ from EACH OTHER only in accepted_issuer_purposes.
{
  const a = JSON.parse(fs.readFileSync(path.join(CAND, PAIRS[0][0]), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(CAND, PAIRS[1][0]), 'utf8'));
  const between = diffPaths(a, b).filter(([p]) => !p.startsWith('accepted_issuer_purposes'));
  for (const [p] of between) { console.error('  CROSS-DOC DRIFT: ' + p + ' differs between the two candidates'); failures++; }
}
if (failures) { console.error('REFUSED: ' + failures + ' problem(s)'); process.exit(1); }
console.log('issuer candidates verified: change set exactly as declared, cross-doc drift zero.');
console.log('realize order: M3 merges -> substitute the four sentinel values in both candidates');
console.log('(window start=T, end=T+86400s, M3 approval sha256, M3 merge sha) -> sha256 of the two');
console.log('final byte streams feed realize-f12.mjs --issuer-status-sha/--issuer-gate-sha.');
