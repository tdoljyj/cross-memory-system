// Rebuilds the root6 controller with root6Expiry set to a window the Owner mechanism can actually
// produce.
//
// Why this exists: root6Expiry was set to 2026-09-19T00:00:00Z, and expiryForBudget(sequence >= 89)
// requires a new budget to declare exactly that value. The Owner window rule fixes every window at
// exactly 86400 seconds from a verified merge, so that value can never be produced. The constant
// was unsatisfiable from the moment it was written.
//
// The rebuild is four exact substitutions and nothing else. It does not re-scan a filesystem: 187
// of the manifest's 331 entries are Windows runtime dependencies that do not exist in this
// environment, so their recorded bytes and digests are carried through untouched. Only entries
// belonging to the controller directory are touched, and the script proves exactly which.
//
// WHAT CARRYING THEM THROUGH MEANS, which this comment used to leave unsaid:
// those 187 entries are 200,048,638 bytes of files on one Windows machine -- node.exe, gh.exe,
// docker.exe, 44 Python .pyc caches, 106 files under AppData. The digest this script emits is
// therefore built on the assumption that all of them are still, right now, the bytes recorded when
// the manifest was collected on 2026-09-08. Nothing here verifies that, and the sources of drift
// are ordinary: GitHub CLI and Docker Desktop auto-update, and a .pyc is regenerated whenever its
// source's mtime changes. If any entry has drifted, the emitted digest is computed from a premise
// that never held, and every document re-issued against it inherits the error -- surfacing only
// when the controller finally runs, possibly after the budget is spent.
// Before the Owner's second merge, rescan all 187 on that machine. See
// artifacts/.../root6-capacity/ControllerDigestDependsOnUnverifiedHostFinding.md.
//
// Usage:
//   node rebuild-controller-window11.mjs <newExpiryZ> [outputRoot]
//
// newExpiryZ must be the materialized expires_at of the Owner window created by the merge of
// artifacts/.../bootstrap/next-window-20260912/, i.e. that merge's committed_at plus 86400 seconds.
// Until that merge exists, run this with a rehearsal value and an outputRoot outside the repository.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

const SRC_REL = 'scripts/phase2-qualification/control-context-verifier-root6-window10-successor';
const DST_REL = 'scripts/phase2-qualification/control-context-verifier-root6-window11-successor';
const OLD_EXPIRY = '2026-09-19T00:00:00Z';
const OLD_DIRTOKEN = 'root6-window10-successor';
const NEW_DIRTOKEN = 'root6-window11-successor';
const PREDECESSOR_DIGEST = '72d9eb92cf287ee6fda1fdbb97d90d02ed7f0e368398cba4ddb517233413d145';

const [newExpiry, outputRootArg] = process.argv.slice(2);
assert.match(newExpiry ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'USAGE: <newExpiryZ as 2026-09-13T03:30:00Z> [outputRoot]');
assert.equal(newExpiry.length, OLD_EXPIRY.length, 'EXPIRY_LITERAL_MUST_BE_THE_SAME_WIDTH');
assert.ok(Number.isFinite(Date.parse(newExpiry)), 'UNPARSEABLE_EXPIRY');
assert.ok(Date.parse(newExpiry) > Date.now(), 'NEW_EXPIRY_MUST_BE_IN_THE_FUTURE');
assert.ok(Date.parse(newExpiry) < Date.parse(OLD_EXPIRY), 'NEW_EXPIRY_MUST_NOT_EXCEED_THE_UNSATISFIABLE_ONE_IT_REPLACES');
const OUT_ROOT = outputRootArg ? path.resolve(outputRootArg) : REPO;

// ---- the four files whose bytes change, and the exact substitutions each takes ----
// The occurrence counts are pinned. tool-entry.functions.js carries the directory name twice, once
// for the manifest path and once for the cli.mjs invocation; counting matching LINES rather than
// occurrences said one, and the pinned count is what caught that.
const SUBSTITUTIONS = {
  'context.mjs':                 {from: OLD_EXPIRY,   to: newExpiry,    count: 1, why: 'root6Expiry'},
  'root-window-validation.mjs':  {from: OLD_EXPIRY,   to: newExpiry,    count: 1, why: 'Owner window upper bound'},
  'source-publication.mjs':      {from: OLD_DIRTOKEN, to: NEW_DIRTOKEN, count: 1, why: 'self manifest path'},
  'tool-entry.functions.js':     {from: OLD_DIRTOKEN, to: NEW_DIRTOKEN, count: 2, why: 'self manifest path and cli.mjs invocation'},
};

// ---- encoder, replicated from the project's own builder ----
function encodeManifest(entries) {
  const seen = new Set();
  for (const e of entries) {
    if (!e || typeof e.path !== 'string' || e.path.includes('..') ||
        /ControllerSourceManifest|Acceptance|ReviewSubject|SigningPayload|CandidateEvidence|SourceBindings|build-controller-manifest|python-import-catalog/.test(e.path))
      throw Error('SOURCE_ONLY_NO_SELF_OR_ACCEPTANCE_METADATA:' + e?.path);
    const key = e.path.toLowerCase();
    if (seen.has(key)) throw Error('DUPLICATE_SOURCE_PATH:' + e.path);
    seen.add(key);
    const exactEmptyDependency = e.role === 'RUNTIME_DEPENDENCY' && e.bytes === 0 &&
      e.sha256 === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    if (!Number.isSafeInteger(e.bytes) || (e.bytes <= 0 && !exactEmptyDependency) ||
        !/^[a-f0-9]{64}$/.test(e.sha256) || !['REPOSITORY_SOURCE', 'RUNTIME_DEPENDENCY'].includes(e.role))
      throw Error('ACTUAL_TYPED_SOURCE_BYTES_REQUIRED:' + e.path);
  }
  return JSON.stringify({
    object_type: 'ControllerSourceManifest',
    format: 'EXACT_SORTED_SOURCE_BYTES_V1_CANDIDATE',
    scope: 'ISOLATED_TEST/SKILL_COEXISTENCE_QUALIFICATION',
    files: [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    authority_effect: 'NONE',
    qualification_issued: false,
  }) + '\n';
}

// ---- self-test: the encoder must reproduce the predecessor manifest byte for byte ----
const oldManifestRaw = fs.readFileSync(path.join(REPO, SRC_REL, 'ControllerSourceManifest.candidate.json'));
assert.equal(sha(oldManifestRaw), PREDECESSOR_DIGEST, 'PREDECESSOR_MANIFEST_DRIFTED');
const oldManifest = JSON.parse(oldManifestRaw.toString('utf8'));
assert.equal(encodeManifest(oldManifest.files), oldManifestRaw.toString('utf8'),
  'ENCODER_DOES_NOT_REPRODUCE_PREDECESSOR_MANIFEST_BYTES');

// ---- copy the controller directory, substituting in exactly four files ----
const dstAbs = path.join(OUT_ROOT, DST_REL);
fs.mkdirSync(dstAbs, {recursive: true});
const changedBytes = new Map();
for (const name of fs.readdirSync(path.join(REPO, SRC_REL))) {
  const src = fs.readFileSync(path.join(REPO, SRC_REL, name));
  const sub = SUBSTITUTIONS[name];
  if (!sub) { fs.writeFileSync(path.join(dstAbs, name), src); continue; }
  const before = src.toString('utf8');
  assert.equal(before.split(sub.from).length - 1, sub.count,
    'OCCURRENCE_COUNT_NOT_AS_PINNED:' + name + ':' + sub.from + ':' + (before.split(sub.from).length - 1));
  const after = before.replaceAll(sub.from, sub.to);
  assert.equal(Buffer.byteLength(after), Buffer.byteLength(before), 'SUBSTITUTION_CHANGED_LENGTH:' + name);
  assert.equal(after.split(sub.from).length, 1, 'OLD_VALUE_SURVIVED:' + name);
  assert.equal(after.split(sub.to).length - 1, sub.count, 'NEW_VALUE_COUNT_MISMATCH:' + name);
  fs.writeFileSync(path.join(dstAbs, name), after);
  changedBytes.set(name, {before: sha(src), after: sha(Buffer.from(after, 'utf8')), why: sub.why});
}
assert.equal(changedBytes.size, 4, 'EXPECTED_EXACTLY_FOUR_SUBSTITUTED_FILES');

// ---- rewrite the manifest: repoint the controller's own entries, rehash the four ----
let repointed = 0, rehashed = 0, carried = 0;
const newFiles = oldManifest.files.map(e => {
  if (!e.path.startsWith(SRC_REL + '/')) { carried++; return {...e}; }
  const name = e.path.slice(SRC_REL.length + 1);
  repointed++;
  const out = {...e, path: DST_REL + '/' + name};
  const ch = changedBytes.get(name);
  if (ch) {
    assert.equal(ch.before, e.sha256, 'MANIFEST_DIGEST_DISAGREES_WITH_FILE_ON_DISK:' + name);
    out.sha256 = ch.after;
    rehashed++;
  }
  return out;
});
assert.equal(repointed, 17, 'EXPECTED_EXACTLY_SEVENTEEN_CONTROLLER_ENTRIES');
assert.equal(rehashed, 4, 'EXPECTED_EXACTLY_FOUR_REHASHED_ENTRIES');
assert.equal(carried, oldManifest.files.length - 17);

// ---- prove nothing else moved ----
const byName = a => new Map(a.map(e => [e.path.replace(SRC_REL, '').replace(DST_REL, ''), e]));
const oldByName = byName(oldManifest.files), newByName = byName(newFiles);
assert.equal(oldByName.size, newByName.size);
const digestChanges = [];
for (const [k, o] of oldByName) {
  const n = newByName.get(k);
  assert.ok(n, 'ENTRY_DISAPPEARED:' + k);
  assert.equal(n.role, o.role, 'ROLE_CHANGED:' + k);
  assert.equal(n.bytes, o.bytes, 'BYTES_CHANGED:' + k);
  if (n.sha256 !== o.sha256) digestChanges.push(k);
}
assert.deepEqual(digestChanges.sort(), Object.keys(SUBSTITUTIONS).map(n => '/' + n).sort(),
  'DIGEST_CHANGES_ARE_NOT_EXACTLY_THE_FOUR_SUBSTITUTED_FILES');

const newManifestRaw = encodeManifest(newFiles);
fs.writeFileSync(path.join(dstAbs, 'ControllerSourceManifest.candidate.json'), newManifestRaw);
const newDigest = sha(Buffer.from(newManifestRaw, 'utf8'));

console.log(JSON.stringify({
  state: 'CONTROLLER_REBUILT_NOT_SIGNED_NOT_ACCEPTED',
  output_root: OUT_ROOT === REPO ? '<repository>' : OUT_ROOT,
  directory: DST_REL,
  new_expiry: newExpiry,
  replaces_unsatisfiable_expiry: OLD_EXPIRY,
  predecessor_controller_sha256: PREDECESSOR_DIGEST,
  new_controller_sha256: newDigest,
  manifest_entries: newFiles.length,
  entries_repointed: repointed,
  entries_rehashed: rehashed,
  entries_carried_unchanged: carried,
  substituted_files: Object.fromEntries([...changedBytes].map(([k, v]) => [k, v.why])),
  authority_effect: 'NONE',
  note: 'The qualification, runtime acceptance and the four capacity documents all pin the controller digest or the window and must be re-issued against new_controller_sha256 before any Owner merge.',
}, null, 2));
