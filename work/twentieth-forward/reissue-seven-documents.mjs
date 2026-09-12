// Re-issues the six signed documents that pin the controller digest or the window, against a
// rebuilt controller and a real Owner window.
//
// The seventh document is the ControllerSourceManifest itself, produced by
// rebuild-controller-window11.mjs, whose digest is an input here.
//
// These documents carry no cryptographic signature. Their authority comes from the owner-merge
// signature chain (web-flow merge + GitHub verification), so re-issuing them is a content rewrite
// followed by a fresh Owner merge, not a re-signing operation. That is why mechanical substitution
// is legitimate here and would not be if they carried an in-document signature.
//
// They reference each other by BOTH sha256 and git blob sha1, so they must be processed in
// dependency order, each one's new digests feeding the next. The order below is a topological sort
// of the reference graph measured from the files themselves:
//
//   QUAL, PROP  ->  APPR  ->  APPL  ->  REPR  ->  RTA
//
// Usage:
//   node reissue-seven-documents.mjs <newNotBeforeZ> <newExpiryZ> <newControllerSha256> [outputRoot]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const blobSha = b => {
  if (!Buffer.isBuffer(b)) throw Error('blobSha_REQUIRES_A_BUFFER_NOT_A_STRING');
  return crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
};

const A = 'artifacts/clued-validation/phase2-entry-preparation-20260908';
const OLD_CTRL_DIR = 'scripts/phase2-qualification/control-context-verifier-root6-window10-successor';
const NEW_CTRL_DIR = 'scripts/phase2-qualification/control-context-verifier-root6-window11-successor';

// Topological order. Each entry lists the timestamp literal it stamps as "when this was issued".
const DOCS = [
  {id: 'QUAL', p: `${A}/bootstrap/root6-runtime-v17/ScopedRoot5FinalControllerQualification.json`,          issuedAt: '2026-09-12T02:12:54.730Z'},
  {id: 'PROP', p: `${A}/root6-capacity/Root6OriginalInput4000000CapacityProposal20260912.json`,             issuedAt: '2026-09-12T00:54:15.197Z'},
  {id: 'APPR', p: `${A}/root6-capacity/Root6OriginalInput4000000CapacityApproval20260912.v2.json`,          issuedAt: '2026-09-12T00:54:15.197Z'},
  {id: 'APPL', p: `${A}/root6-capacity/Root6CurrentController4000000CapacityApplicability20260912.json`,    issuedAt: '2026-09-12T01:31:02.664Z'},
  {id: 'REPR', p: `${A}/root6-capacity/Root6Current043CapacityRepairAcceptance20260912.json`,               issuedAt: null},
  {id: 'RTA',  p: `${A}/bootstrap/root6-runtime-v17/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json`, issuedAt: '2026-09-12T02:12:54.730Z'},
];

const OLD = {
  ctrlSha:  '72d9eb92cf287ee6fda1fdbb97d90d02ed7f0e368398cba4ddb517233413d145',
  ctrlBlob: 'c27f94214d5e55889861f933e111b53241ecbc86',
  notBefore: '2026-09-12T00:00:00Z',
  expiry:    '2026-09-19T00:00:00Z',
};

const [newNotBefore, newExpiry, newCtrlSha, outputRootArg] = process.argv.slice(2);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
assert.match(newNotBefore ?? '', ISO, 'USAGE: <newNotBeforeZ> <newExpiryZ> <newControllerSha256> [outputRoot]');
assert.match(newExpiry ?? '', ISO, 'USAGE: <newNotBeforeZ> <newExpiryZ> <newControllerSha256> [outputRoot]');
assert.match(newCtrlSha ?? '', /^[a-f0-9]{64}$/, 'NEW_CONTROLLER_SHA256_REQUIRED');
assert.equal(Date.parse(newExpiry) - Date.parse(newNotBefore), 86400000, 'OWNER_WINDOW_MUST_BE_EXACTLY_86400_SECONDS');
const now = new Date();
assert.ok(Date.parse(newNotBefore) <= now.getTime() && now.getTime() < Date.parse(newExpiry),
  'DOCUMENTS_MUST_BE_ISSUED_INSIDE_THE_WINDOW_THEY_DECLARE');
assert.notEqual(newCtrlSha, OLD.ctrlSha, 'CONTROLLER_DIGEST_DID_NOT_CHANGE');
const OUT_ROOT = outputRootArg ? path.resolve(outputRootArg) : REPO;

// The controller manifest must already have been rebuilt, and must match the digest passed in.
const newManifestPath = path.join(OUT_ROOT, NEW_CTRL_DIR, 'ControllerSourceManifest.candidate.json');
assert.ok(fs.existsSync(newManifestPath), 'REBUILD_THE_CONTROLLER_FIRST: ' + NEW_CTRL_DIR);
const newManifestRaw = fs.readFileSync(newManifestPath);
assert.equal(sha(newManifestRaw), newCtrlSha, 'REBUILT_MANIFEST_DOES_NOT_MATCH_THE_DIGEST_SUPPLIED');
const newCtrlBlob = blobSha(newManifestRaw);

// Substitution table, extended as each document is re-issued.
const table = [
  {what: 'controller sha256',   from: OLD.ctrlSha,   to: newCtrlSha},
  {what: 'controller blob',     from: OLD.ctrlBlob,  to: newCtrlBlob},
  {what: 'controller dir',      from: OLD_CTRL_DIR,  to: NEW_CTRL_DIR},
  {what: 'window not_before',   from: OLD.notBefore, to: newNotBefore},
  {what: 'window expires_at',   from: OLD.expiry,    to: newExpiry},
];

const issuedAtStamp = now.toISOString().replace(/\.(\d{3})Z$/, '.$1Z');
const report = [];

for (const doc of DOCS) {
  const srcAbs = path.join(REPO, doc.p);
  const before = fs.readFileSync(srcAbs);
  const oldSha = sha(before), oldBlob = blobSha(before);

  let text = before.toString('utf8');
  const applied = {};
  for (const t of table) {
    const n = text.split(t.from).length - 1;
    if (n === 0) continue;
    text = text.replaceAll(t.from, t.to);
    applied[t.what] = n;
  }
  if (doc.issuedAt) {
    const n = text.split(doc.issuedAt).length - 1;
    assert.ok(n > 0, 'ISSUED_AT_LITERAL_NOT_FOUND:' + doc.id + ':' + doc.issuedAt);
    text = text.replaceAll(doc.issuedAt, issuedAtStamp);
    applied['issued_at'] = n;
  }

  // Nothing superseded may survive anywhere in the document.
  for (const t of table) assert.equal(text.split(t.from).length, 1, 'SUPERSEDED_VALUE_SURVIVED:' + doc.id + ':' + t.what);
  if (doc.issuedAt) assert.equal(text.split(doc.issuedAt).length, 1, 'OLD_ISSUED_AT_SURVIVED:' + doc.id);
  JSON.parse(text); // must still be valid JSON

  const after = Buffer.from(text, 'utf8');
  const outAbs = path.join(OUT_ROOT, doc.p);
  fs.mkdirSync(path.dirname(outAbs), {recursive: true});
  fs.writeFileSync(outAbs, after);

  const newSha = sha(after), newBlob = blobSha(after);
  assert.notEqual(newSha, oldSha, 'DOCUMENT_DID_NOT_CHANGE:' + doc.id);

  // Downstream documents reference this one by both digests.
  table.push({what: doc.id + ' sha256', from: oldSha, to: newSha});
  table.push({what: doc.id + ' blob',   from: oldBlob, to: newBlob});

  report.push({
    id: doc.id,
    path: doc.p,
    bytes: {before: before.length, after: after.length},
    sha256: {before: oldSha, after: newSha},
    blob_sha1: {before: oldBlob, after: newBlob},
    substitutions: applied,
  });
}

console.log(JSON.stringify({
  state: 'DOCUMENTS_REISSUED_NOT_MERGED_NO_AUTHORITY',
  output_root: OUT_ROOT === REPO ? '<repository>' : OUT_ROOT,
  window: {not_before: newNotBefore, expires_at: newExpiry, duration_seconds: 86400},
  issued_at: issuedAtStamp,
  controller: {sha256: {before: OLD.ctrlSha, after: newCtrlSha}, blob_sha1: {before: OLD.ctrlBlob, after: newCtrlBlob}},
  documents: report,
  authority_effect: 'NONE_UNTIL_VERIFIED_OWNER_MERGE',
  note: 'Six documents plus the ControllerSourceManifest are the seven that pin the controller digest or the window. All must reach the Owner in one merge.',
}, null, 2));
