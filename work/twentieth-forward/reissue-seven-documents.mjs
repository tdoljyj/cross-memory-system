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
// VERSION CHAINS. Five of the six carry an explicit lineage that substitution alone does not
// advance, and leaving it alone would make each new document claim it supersedes its
// grandparent rather than the version it actually replaces:
//
//   QUAL, RTA, APPL, REPR   supersedes + supersedes_chain
//   APPR                    reissue.supersedes + reissue.reason
//
// The two families record lineage differently, and each is advanced in its own form:
//   QUAL/RTA use {path, sha256, bytes, blob_sha}; APPL/REPR use {uri, sha256}.
//
// WHERE THE OUTPUT GOES is a judgement call, flagged in the report for review rather than
// buried. History shows QUAL and RTA moving directory each time they are re-issued
// (root5-final-runtime-v15 -> v16 -> root6-runtime-v17), and their supersedes entries carry a
// path, so they go to a new directory. The capacity documents record lineage by blob uri and
// have never moved, so they are rewritten in place. If the reviewer disagrees, only OUT_SUBDIR
// and the in-place flag change.
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
const OLD_RUNTIME_DIR = `${A}/bootstrap/root6-runtime-v17`;
const NEW_RUNTIME_DIR = `${A}/bootstrap/root6-runtime-v18`;

// lineage: 'pathRef'  -> supersedes/supersedes_chain carrying {path, sha256, bytes, blob_sha}
//          'uriRef'   -> supersedes/supersedes_chain carrying {uri, sha256}
//          'reissue'  -> reissue.supersedes {path, sha256, bytes, blob_sha, owner_merge} + reason
//          null       -> no lineage node
const DOCS = [
  {id: 'QUAL', p: `${OLD_RUNTIME_DIR}/ScopedRoot5FinalControllerQualification.json`,                     issuedAt: '2026-09-12T02:12:54.730Z', lineage: 'pathRef', moveTo: NEW_RUNTIME_DIR},
  {id: 'PROP', p: `${A}/root6-capacity/Root6OriginalInput4000000CapacityProposal20260912.json`,          issuedAt: '2026-09-12T00:54:15.197Z', lineage: null},
  {id: 'APPR', p: `${A}/root6-capacity/Root6OriginalInput4000000CapacityApproval20260912.v2.json`,       issuedAt: '2026-09-12T00:54:15.197Z', lineage: 'reissue'},
  {id: 'APPL', p: `${A}/root6-capacity/Root6CurrentController4000000CapacityApplicability20260912.json`, issuedAt: '2026-09-12T01:31:02.664Z', lineage: 'uriRef'},
  {id: 'REPR', p: `${A}/root6-capacity/Root6Current043CapacityRepairAcceptance20260912.json`,            issuedAt: null,                       lineage: 'uriRef'},
  {id: 'RTA',  p: `${OLD_RUNTIME_DIR}/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json`,          issuedAt: '2026-09-12T02:12:54.730Z', lineage: 'pathRef', moveTo: NEW_RUNTIME_DIR},
];

// The Owner merge that made the version now being superseded authoritative. Only APPR records one.
const APPR_SUPERSEDED_OWNER_MERGE = '77330e254896a02c09cc8e22555819dcf5018fdc';
const REISSUE_REASON =
  'The root6 controller was rebuilt because root6Expiry was set to 2026-09-19T00:00:00Z, a value ' +
  'the Owner window mechanism can never produce: every window is exactly 86400 seconds from a ' +
  'verified Owner merge. This approval pinned that window in limitations[1], which scoped the one ' +
  'remaining 600-second allocation to it, so the approval no longer authorises the allocation ' +
  'actually being made. Found by the successor independent reviewer (round 8, addendum A, item 8). ' +
  'The substance of the capacity decision is unchanged; only the window it is scoped to, and the ' +
  'controller digest it is issued against, differ.';

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

  // Advance the version chain. Substitution alone leaves the lineage node pointing at this
  // document's predecessor, so the re-issued version would claim to supersede its grandparent.
  // Re-serialising is only safe because every one of these is stored as two-space indent plus a
  // newline, which is asserted against the file on disk rather than assumed.
  const beforeText = before.toString('utf8');
  assert.equal(JSON.stringify(JSON.parse(beforeText), null, 2) + '\n', beforeText,
    'PREDECESSOR_NOT_INDENT2_SERIALISED_REFUSING_TO_REWRITE:' + doc.id);
  const parsed = JSON.parse(text);
  const pathRef = {path: doc.p, sha256: oldSha, bytes: before.length, blob_sha: oldBlob};
  const uriRef = {uri: 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + oldBlob, sha256: oldSha};
  if (doc.lineage === 'pathRef' || doc.lineage === 'uriRef') {
    assert.ok(parsed.supersedes && Array.isArray(parsed.supersedes_chain), 'LINEAGE_NODE_ABSENT:' + doc.id);
    parsed.supersedes_chain = [parsed.supersedes, ...parsed.supersedes_chain];
    parsed.supersedes = doc.lineage === 'pathRef' ? pathRef : uriRef;
    applied.version_chain = 'supersedes advanced, chain depth ' + parsed.supersedes_chain.length;
  } else if (doc.lineage === 'reissue') {
    assert.ok(parsed.reissue?.supersedes, 'REISSUE_NODE_ABSENT:' + doc.id);
    parsed.reissue = {
      supersedes: {...pathRef, owner_merge: APPR_SUPERSEDED_OWNER_MERGE},
      reason: REISSUE_REASON,
      substance_unchanged: false,
      what_changed: 'limitations[1] window, and the controller digest this approval is issued against',
    };
    applied.version_chain = 'reissue.supersedes advanced';
  }
  text = JSON.stringify(parsed, null, 2) + '\n';
  JSON.parse(text); // must still be valid JSON

  // Re-check for superseded values AFTER the lineage node is written, since that node is added
  // later than the substitution pass. One exemption, and only one: reissue.reason narrates why the
  // old window was unsatisfiable and has to name it. A reason that will not say which value was
  // wrong is worth little to the Owner reading it. Everything outside that field must still be
  // clean, so the check runs on the document with that one field blanked rather than being skipped.
  {
    const probe = structuredClone(parsed);
    if (probe.reissue?.reason) probe.reissue.reason = '';
    const probeText = JSON.stringify(probe);
    for (const t of table) {
      assert.equal(probeText.split(t.from).length, 1,
        'SUPERSEDED_VALUE_SURVIVED_OUTSIDE_NARRATION:' + doc.id + ':' + t.what);
    }
    if (doc.issuedAt) assert.equal(probeText.split(doc.issuedAt).length, 1, 'OLD_ISSUED_AT_SURVIVED:' + doc.id);
    if (parsed.reissue?.reason) applied.narrated_old_values = 'reissue.reason names the superseded window deliberately';
  }

  const after = Buffer.from(text, 'utf8');
  const outAbs = doc.moveTo
    ? path.join(OUT_ROOT, doc.moveTo, path.basename(doc.p))
    : path.join(OUT_ROOT, doc.p);
  fs.mkdirSync(path.dirname(outAbs), {recursive: true});
  fs.writeFileSync(outAbs, after);

  const newSha = sha(after), newBlob = blobSha(after);
  assert.notEqual(newSha, oldSha, 'DOCUMENT_DID_NOT_CHANGE:' + doc.id);

  // Downstream documents reference this one by both digests.
  table.push({what: doc.id + ' sha256', from: oldSha, to: newSha});
  table.push({what: doc.id + ' blob',   from: oldBlob, to: newBlob});

  report.push({
    id: doc.id,
    from: doc.p,
    to: path.relative(OUT_ROOT, outAbs),
    moved: Boolean(doc.moveTo),
    lineage: doc.lineage ?? 'none',
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
  for_review: {
    placement: 'QUAL and RTA move to ' + NEW_RUNTIME_DIR + ' because their lineage carries a path and ' +
      'the three prior re-issues each moved directory (v15 -> v16 -> v17). The four capacity documents ' +
      'record lineage by blob uri, have never moved, and are rewritten in place. This is a judgement ' +
      'call by the implementing side, not an established rule -- if it is wrong, only the directory ' +
      'constants change.',
    not_reissued: 'Root6OriginalInput4000000CapacityApproval20260912.json (the pre-v2 approval) is left ' +
      'byte-identical: it is on main, its authority_effect is None, v2 references it only as a ' +
      'supersedes pointer, and rewriting it would breach old_signed_objects_rewritten:false. The ' +
      'reviewer counted it as an eighth document to re-issue; that push-back is open.',
  },
}, null, 2));
