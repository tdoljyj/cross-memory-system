// Reissues the scoped controller qualification and the preentry controller runtime acceptance
// against the root6 controller, the root6 generation and the Owner-approved root6 window.
//
// Produces PREPARED documents only. It does not stamp accepted_at and does not set the ACCEPTED_*
// state: acceptance is a separate step that runs after review, so that no document timestamps a
// review which has not happened. That was a real defect in the previous attempt at this.
//
// Everything not listed in EDITS below is carried over from the predecessor byte for byte.
// In particular the window5/7/8/9 continuation records are historical statements about what those
// windows were, and are preserved untouched; root6 is recorded as a new window10 entry beside them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const V16_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v16';
const V17_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v17';
const CONTROLLER_REL = 'scripts/phase2-qualification/control-context-verifier-root6-window10-successor';

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const blobSha = b => crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
const blobUri = id => 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + id;

// ---- fixed inputs, all independently verified before this script was written ----
const ROOT6_GENERATION = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b';
const ROOT5_GENERATION = 'ctrgen_e5df432221344996afc04b5638121d96';
const NOT_BEFORE = '2026-09-12T00:00:00Z';
const EXPIRES_AT = '2026-09-19T00:00:00Z';
const OLD_WINDOW = '2026-09-11T10:21:05Z';
const OLD_DIGEST = 'ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa';
const NEW_DIGEST = '72d9eb92cf287ee6fda1fdbb97d90d02ed7f0e368398cba4ddb517233413d145';
// source_commit must contain the root6 directory, because verifySourcePublication requires every
// declared source to be present in BOTH source_ref.tree and the owner merge tree. 4d33717 is the
// second parent of the owner merge, so the required ancestor relation holds.
const SOURCE_COMMIT = '4d33717914868051b119095004246343f9cc9164';
const SOURCE_TREE = '16fa4d165d1285b02cbe9444e49dd826827dccbb';
const OWNER_MERGE = '7ac27f343fb3a39e4fea07dcbd000b3e0d30e2fb';
const FORWARD_CAP_FROM = 15, FORWARD_CAP_TO = 16;

const readJson = rel => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
const changes = [];

// Sets a value at a dotted path, refusing unless the current value is exactly what we expected.
// A mismatch means the predecessor is not the document this script was written against.
function setPath(doc, label, dotted, expected, next) {
  const parts = dotted.split('.');
  let node = doc;
  for (const p of parts.slice(0, -1)) {
    node = node?.[p];
    if (node === undefined) throw Error('PATH_ABSENT:' + label + ':' + dotted);
  }
  const leaf = parts.at(-1);
  const current = node[leaf];
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw Error('UNEXPECTED_PREDECESSOR_VALUE:' + label + ':' + dotted +
      ':found=' + JSON.stringify(current)?.slice(0, 120));
  node[leaf] = next;
  changes.push({ document: label, path: dotted, from: expected, to: next });
}

// ---- the complete ordered source reference set ----
// verifySourcePublication requires source_ref.blobs to cover EVERY REPOSITORY_SOURCE declared by
// the manifest (COMPLETE_MANIFEST_FILE_BLOB_COVERAGE), and requires the manifest's own blob to be
// present with sha256 === controller digest (EXACT_SOURCE_MANIFEST_BLOB_REF). The predecessor's
// 131 refs were built for a tree that does not contain the root6 directory at all, so the set is
// rebuilt rather than patched.
function buildSourceRef() {
  const manifestRel = CONTROLLER_REL + '/ControllerSourceManifest.candidate.json';
  const manifestBytes = fs.readFileSync(path.join(REPO, manifestRel));
  if (sha(manifestBytes) !== NEW_DIGEST) throw Error('MANIFEST_NOT_AT_EXPECTED_DIGEST:' + sha(manifestBytes));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));

  const blobs = [];
  const seen = new Set();
  // The manifest blob leads the set, matching the predecessor's ordering.
  blobs.push({ uri: blobUri(blobSha(manifestBytes)), sha256: NEW_DIGEST });
  seen.add(blobUri(blobSha(manifestBytes)));

  let sources = 0;
  for (const entry of manifest.files) {
    if (entry.role !== 'REPOSITORY_SOURCE') continue;
    sources++;
    if (entry.path === manifestRel) continue;
    const bytes = fs.readFileSync(path.join(REPO, entry.path));
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256)
      throw Error('SOURCE_BYTES_DISAGREE_WITH_MANIFEST:' + entry.path);
    const uri = blobUri(blobSha(bytes));
    if (seen.has(uri)) continue;
    seen.add(uri);
    blobs.push({ uri, sha256: entry.sha256 });
  }
  return {
    ref: { commit: SOURCE_COMMIT, tree: SOURCE_TREE, blobs },
    repository_source_count: sources,
  };
}

const { ref: sourceRef, repository_source_count } = buildSourceRef();

// Real guard, not a tautology. verifySourcePublication requires every declared source to be a blob
// in SOURCE_TREE, so a source tree that predates the current controller silently produces documents
// pinning a tree that cannot satisfy the check. Verify against the actual git object store before
// writing anything, and name the fix rather than emitting a broken document.
{
  const {execFileSync} = await import('node:child_process');
  const listed = execFileSync('git', ['ls-tree', '-r', SOURCE_TREE], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const inTree = new Map();
  for (const line of listed.split('\n')) {
    if (!line) continue;
    const [meta, p] = line.split('\t');
    const [mode, type, id] = meta.split(/\s+/);
    inTree.set(p, { mode, type, id });
  }
  const manifestRel = CONTROLLER_REL + '/ControllerSourceManifest.candidate.json';
  const manifestBytes = fs.readFileSync(path.join(REPO, manifestRel));
  const entry = inTree.get(manifestRel);
  if (!entry || entry.id !== blobSha(manifestBytes))
    throw Error('SOURCE_TREE_DOES_NOT_CONTAIN_THIS_CONTROLLER:' + SOURCE_TREE +
      ' — the controller was rebuilt after that tree. Commit and Owner-merge the controller, then set ' +
      'SOURCE_COMMIT/SOURCE_TREE/OWNER_MERGE to the new merge before reissuing.');
  const missing = [];
  for (const f of JSON.parse(manifestBytes.toString('utf8')).files) {
    if (f.role !== 'REPOSITORY_SOURCE') continue;
    const e = inTree.get(f.path);
    if (!e || e.type !== 'blob' || e.mode !== '100644' ||
        e.id !== blobSha(fs.readFileSync(path.join(REPO, f.path)))) missing.push(f.path);
  }
  if (missing.length)
    throw Error('SOURCES_ABSENT_OR_DIVERGENT_IN_SOURCE_TREE:' + missing.length + ':' + missing.slice(0, 3).join(','));
}

// Provenance pointer to the predecessor, used to extend the chain rather than replace it.
function predecessorRef(rel) {
  const raw = fs.readFileSync(path.join(REPO, rel));
  return { path: rel, sha256: sha(raw), bytes: raw.length, blob_sha: blobSha(raw) };
}

const DELTA =
  'Root6 window migration. The predecessor was bound to the root5 generation ' + ROOT5_GENERATION +
  ' and the window ending ' + OLD_WINDOW + ', which lapsed before the qualification run could use it. ' +
  'This successor is bound to the root6 generation ' + ROOT6_GENERATION + ', the Owner-approved window ' +
  NOT_BEFORE + ' .. ' + EXPIRES_AT + ', and the root6 controller ' + NEW_DIGEST + ' published by Owner ' +
  'merge ' + OWNER_MERGE + '. The controller forward cap was raised from ' + FORWARD_CAP_FROM + ' to ' +
  FORWARD_CAP_TO + ' under an Owner override recorded in OwnerForwardCapExtensionOverride.json, which ' +
  'conflicts with the cap extension exclusion in BoundedSeriesApplicability20260910 and is not ' +
  'independently reviewed. No scope, oracle, limit other than that cap, capacity, reviewer identity or ' +
  'historical record is changed; the window5, window7, window8 and window9 continuation records are ' +
  'preserved byte for byte as statements about those windows.';

// ---------------- qualification ----------------
{
  const rel = V16_REL + '/ScopedRoot5FinalControllerQualification.json';
  const doc = readJson(rel);
  const L = 'qualification';

  setPath(doc, L, 'controller_digest', OLD_DIGEST, NEW_DIGEST);
  setPath(doc, L, 'root_generation', ROOT5_GENERATION, ROOT6_GENERATION);
  setPath(doc, L, 'authority_basis.root_generation', ROOT5_GENERATION, ROOT6_GENERATION);
  setPath(doc, L, 'not_before', doc.not_before, NOT_BEFORE);
  setPath(doc, L, 'expires_at', OLD_WINDOW, EXPIRES_AT);
  setPath(doc, L, 'source_ref', doc.source_ref, sourceRef);
  setPath(doc, L, 'source_commit', doc.source_commit, SOURCE_COMMIT);
  setPath(doc, L, 'source_tree', doc.source_tree, SOURCE_TREE);
  setPath(doc, L, 'source_owner_merge', doc.source_owner_merge, OWNER_MERGE);
  setPath(doc, L, 'actual_repository_source_files', doc.actual_repository_source_files, repository_source_count);
  setPath(doc, L, 'ordered_source_ref_count', doc.ordered_source_ref_count, sourceRef.blobs.length);

  // window5_continuation_constraints is left exactly as it is: it records what window 5 was.
  // Root6 is recorded beside it.
  const w5 = doc.window5_continuation_constraints;
  doc.window10_continuation_constraints = {
    ...structuredClone(w5),
    root_generation: ROOT6_GENERATION,
    expires_at: EXPIRES_AT,
    not_before: NOT_BEFORE,
    maximum_new_forward: FORWARD_CAP_TO,
    forward_cap_extension: {
      from: FORWARD_CAP_FROM,
      to: FORWARD_CAP_TO,
      basis: 'artifacts/clued-validation/phase2-entry-preparation-20260908/OwnerForwardCapExtensionOverride.json',
      conflicts_with_governing_exclusion: true,
      independently_reviewed: false,
    },
  };
  changes.push({ document: L, path: 'window10_continuation_constraints', added: true });

  // Extend the provenance chain instead of overwriting it.
  doc.supersedes_chain = [...(doc.supersedes_chain ?? []), doc.supersedes];
  doc.supersedes = predecessorRef(rel);
  doc.prior_successor_deltas = [...(doc.prior_successor_deltas ?? []), doc.successor_delta];
  doc.successor_delta = DELTA;
  changes.push({ document: L, path: 'supersedes_chain', added: true, length: doc.supersedes_chain.length });

  // Acceptance has not happened. State and timestamp are set by the separate signing step.
  doc.state = 'PREPARED_SCOPED_CONTROLLER_QUALIFICATION_ROOT6_NOT_ACCEPTED';
  doc.acceptance_issued = false;
  delete doc.accepted_at;
  changes.push({ document: L, path: 'accepted_at', removed: true, why: 'acceptance has not occurred' });

  fs.mkdirSync(path.join(REPO, V17_REL), { recursive: true });
  fs.writeFileSync(path.join(REPO, V17_REL, 'ScopedRoot5FinalControllerQualification.json'),
    JSON.stringify(doc, null, 2) + '\n');
}

// ---------------- runtime acceptance ----------------
{
  const rel = V16_REL + '/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json';
  const doc = readJson(rel);
  const L = 'runtime_acceptance';
  const controller = p => {
    const bytes = fs.readFileSync(path.join(REPO, CONTROLLER_REL + '/' + p));
    return { uri: blobUri(blobSha(bytes)), sha256: sha(bytes) };
  };

  setPath(doc, L, 'controller_digest', OLD_DIGEST, NEW_DIGEST);
  setPath(doc, L, 'not_before', doc.not_before, NOT_BEFORE);
  setPath(doc, L, 'expires_at', OLD_WINDOW, EXPIRES_AT);
  setPath(doc, L, 'accepted_subject.expected_ga.control_trust_root_generation', ROOT5_GENERATION, ROOT6_GENERATION);
  setPath(doc, L, 'accepted_subject.expected_ga.controller_digest', OLD_DIGEST, NEW_DIGEST);
  setPath(doc, L, 'accepted_subject.expected_ga.source_ref', doc.accepted_subject.expected_ga.source_ref, sourceRef);

  // Both schemas are compiled and executed by the controller, and both now const the root6
  // generation, so the accepted refs must point at the merged root6 blobs.
  setPath(doc, L, 'accepted_subject.control_schema_refs.StatusManifest',
    doc.accepted_subject.control_schema_refs.StatusManifest, controller('status-manifest.root5.schema.json'));
  setPath(doc, L, 'accepted_subject.control_schema_refs.GateResultReceipt',
    doc.accepted_subject.control_schema_refs.GateResultReceipt, controller('gate-result-receipt.root5.schema.json'));

  // window5/7/8/9 continuation evidence is historical and untouched. Root6 is added beside it.
  doc.window10_continuation_evidence = {
    controller_publication: { owner_merge: OWNER_MERGE, source_commit: SOURCE_COMMIT, source_tree: SOURCE_TREE },
    controller_digest: NEW_DIGEST,
    continuation_constraints: {
      ...structuredClone(doc.window9_continuation_evidence.continuation_constraints),
      root_generation: ROOT6_GENERATION,
      expires_at: EXPIRES_AT,
      not_before: NOT_BEFORE,
      maximum_new_forward: FORWARD_CAP_TO,
    },
    forward_cap_extension: {
      from: FORWARD_CAP_FROM,
      to: FORWARD_CAP_TO,
      basis: 'artifacts/clued-validation/phase2-entry-preparation-20260908/OwnerForwardCapExtensionOverride.json',
      conflicts_with_governing_exclusion: true,
      independently_reviewed: false,
    },
  };
  changes.push({ document: L, path: 'window10_continuation_evidence', added: true });

  doc.supersedes_chain = [...(doc.supersedes_chain ?? []), doc.supersedes];
  doc.supersedes = predecessorRef(rel);
  changes.push({ document: L, path: 'supersedes_chain', added: true, length: doc.supersedes_chain.length });

  doc.state = 'PREPARED_EXACT_PREENTRY_CONTROLLER_RUNTIME_ROOT6_NOT_ACCEPTED';
  doc.acceptance_issued = false;
  delete doc.accepted_at;
  changes.push({ document: L, path: 'accepted_at', removed: true, why: 'acceptance has not occurred' });

  fs.writeFileSync(path.join(REPO, V17_REL, 'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json'),
    JSON.stringify(doc, null, 2) + '\n');
}

// ---- report ----
const out = {};
for (const f of ['ScopedRoot5FinalControllerQualification.json', 'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json']) {
  const raw = fs.readFileSync(path.join(REPO, V17_REL, f));
  const doc = JSON.parse(raw.toString('utf8'));
  out[f] = {
    bytes: raw.length, sha256: sha(raw), blob_sha: blobSha(raw), state: doc.state,
    acceptance_issued: doc.acceptance_issued,
    residual_root5_generation: (raw.toString('utf8').split(ROOT5_GENERATION).length - 1),
    residual_old_window: (raw.toString('utf8').split(OLD_WINDOW).length - 1),
    residual_old_digest: (raw.toString('utf8').split(OLD_DIGEST).length - 1),
  };
}
console.log(JSON.stringify({
  output_directory: V17_REL,
  source_ref: { commit: SOURCE_COMMIT, tree: SOURCE_TREE, blob_refs: sourceRef.blobs.length, repository_sources: repository_source_count },
  change_count: changes.length,
  changes,
  documents: out,
  note: 'PREPARED only. No acceptance issued, no accepted_at stamped, no state set to ACCEPTED_*. ' +
        'Residual root5/old-window/old-digest counts above are expected to be non-zero: they are the ' +
        'preserved historical window5/7/8/9 records and the supersedes chain, not live bindings.',
}, null, 2));
