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
const blobSha = b => {
  // Must be a Buffer. Given a string, b.length is the UTF-16 code unit count, not the byte
  // length, and the git blob header would be wrong -- producing a plausible but incorrect id.
  if (!Buffer.isBuffer(b)) throw Error('blobSha_REQUIRES_A_BUFFER_NOT_A_STRING');
  return crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
};
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
const SOURCE_COMMIT = 'a8fb29ed94a8325a848e3289c362164bce4d15d0';
const SOURCE_TREE = 'b9e508bd7b1d8213fbd8c4a13ef79e5babc1c44a';
const OWNER_MERGE = 'ad3d589c03ded47110eaecbb47c48ff90600acdc';
const FORWARD_CAP_FROM = 15, FORWARD_CAP_TO = 16;


// Real predecessor values, transcribed from the v16 documents. Successor review found that 11 of
// 19 setPath guards passed doc.<same path> as the expected value -- a tautology that can never
// fire -- and that the three constants which actually went stale (source_commit, source_tree,
// source_owner_merge) were all on the tautological side. These make the guard mean something.
const PREDECESSOR_NOT_BEFORE = '2026-09-11T05:40:27.015Z';
const PREDECESSOR_SOURCE_COMMIT = '46e1b0e412b0b8e016f67f27ebf2c6235822b1f3';
const PREDECESSOR_SOURCE_TREE = '375b5726d574c69cc008e91b85be31825e61256c';
const PREDECESSOR_SOURCE_FILES = 142;
const PREDECESSOR_REF_COUNT = 131;
const V16_REF_COUNT = 131;
const PREDECESSOR_STATUS_SCHEMA = { uri: blobUri('3dd72dbd45d7d66691f5c391889cd0a90acc5c69'), sha256: '76bb79f7278905122474f86fe195cb803e3cb5185a4a50899403fa5567726ae0' };
const PREDECESSOR_GRR_SCHEMA = { uri: blobUri('d3dcba7d9950d6f5f029512a162fbdb9f665884d'), sha256: '831b2f415d72a82adc1d8c3b5f5b4e286527712d5cb3293085249499193d20a1' };

// source_ref is a 131-entry structure; comparing it whole would mean transcribing all of it.
// Assert its identifying shape instead, which is what actually goes stale.
function setPathShape(doc, label, dotted, expectedShape, next) {
  const parts = dotted.split('.');
  let node = doc;
  for (const p of parts.slice(0, -1)) node = node?.[p];
  const cur = node?.[parts.at(-1)];
  if (cur?.commit !== expectedShape.commit || cur?.tree !== expectedShape.tree ||
      cur?.blobs?.length !== expectedShape.refs)
    throw Error('UNEXPECTED_PREDECESSOR_SOURCE_REF:' + label + ':' + dotted +
      ':found commit=' + cur?.commit + ' tree=' + cur?.tree + ' refs=' + cur?.blobs?.length);
  node[parts.at(-1)] = next;
  changes.push({ document: label, path: dotted, from: expectedShape, to: { commit: next.commit, tree: next.tree, refs: next.blobs.length } });
}


// ---- the four capacity documents, all now Owner-published ----
// Each descriptor's publication is checked by verifyOwnerMergeArtifact (context.mjs:214), so each
// must sit in an Owner-merged tree at the stated path with exactly these bytes.
const CAP_DIR = 'artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/';
const APPROVAL_V2 = {
  path: CAP_DIR + 'Root6OriginalInput4000000CapacityApproval20260912.v2.json',
  publication_commit: '01ea76755526c2d20b93dc56b06ed6f24be801c1',
};
const APPLICABILITY = {
  path: CAP_DIR + 'Root6CurrentController4000000CapacityApplicability20260912.json',
  publication_commit: 'ad3d589c03ded47110eaecbb47c48ff90600acdc',
};
const REPAIR_043 = {
  path: CAP_DIR + 'Root6Current043CapacityRepairAcceptance20260912.json',
  publication_commit: 'ad3d589c03ded47110eaecbb47c48ff90600acdc',
};
// v1 is also on main. Binding it instead of v2 fails outright, and the successor's applicability
// says so explicitly, so the descriptor is built from the path rather than from a copied hash.
const descriptor = d => {
  const raw = fs.readFileSync(path.join(REPO, d.path));
  return {
    ref: { uri: blobUri(blobSha(raw)), sha256: sha(raw) },
    publication: { commitSha: d.publication_commit, artifactPath: d.path },
  };
};


// The controller's frozen capacity delta, extracted rather than retyped.
const capacityDelta = (0, eval)('(' + /const capacityDelta=Object\.freeze\((\{.*?\})\);/s
  .exec(fs.readFileSync(path.join(REPO, CONTROLLER_REL + '/context.mjs'), 'utf8'))[1] + ')');
if (capacityDelta.source_refs_maximum !== 133) throw Error('CONTROLLER_NOT_AT_133');

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
  // SOURCE_COMMIT and OWNER_MERGE are checked too, not just SOURCE_TREE. Successor review found
  // that guarding the tree alone lets a partial update through: bump SOURCE_TREE without
  // SOURCE_COMMIT and the guard passes, then verifySourcePublication dies at
  // ACTUAL_SOURCE_COMMIT_TREE inside the billed 600-second window.
  const commitTree = execFileSync('git', ['rev-parse', SOURCE_COMMIT + '^{tree}'], { cwd: REPO, encoding: 'utf8' }).trim();
  if (commitTree !== SOURCE_TREE)
    throw Error('SOURCE_COMMIT_TREE_MISMATCH:' + SOURCE_COMMIT + ' has tree ' + commitTree + ', not ' + SOURCE_TREE);
  const mergeParents = execFileSync('git', ['rev-list', '--parents', '-n', '1', OWNER_MERGE], { cwd: REPO, encoding: 'utf8' })
    .trim().split(/\s+/).slice(1);
  if (mergeParents.length !== 2)
    throw Error('OWNER_MERGE_NOT_A_MERGE_COMMIT:' + OWNER_MERGE + ' has ' + mergeParents.length + ' parents');
  if (!mergeParents.includes(SOURCE_COMMIT))
    throw Error('SOURCE_COMMIT_NOT_A_PARENT_OF_OWNER_MERGE:' + SOURCE_COMMIT + ' vs ' + mergeParents.join(','));

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
  setPath(doc, L, 'not_before', PREDECESSOR_NOT_BEFORE, NOT_BEFORE);
  setPath(doc, L, 'expires_at', OLD_WINDOW, EXPIRES_AT);
  setPathShape(doc, L, 'source_ref', {commit: PREDECESSOR_SOURCE_COMMIT, tree: PREDECESSOR_SOURCE_TREE, refs: V16_REF_COUNT}, sourceRef);
  setPath(doc, L, 'source_commit', PREDECESSOR_SOURCE_COMMIT, SOURCE_COMMIT);
  setPath(doc, L, 'source_tree', PREDECESSOR_SOURCE_TREE, SOURCE_TREE);
  setPath(doc, L, 'source_owner_merge', PREDECESSOR_SOURCE_COMMIT, OWNER_MERGE);
  setPath(doc, L, 'actual_repository_source_files', PREDECESSOR_SOURCE_FILES, repository_source_count);
  setPath(doc, L, 'ordered_source_ref_count', PREDECESSOR_REF_COUNT, sourceRef.blobs.length);

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
  setPath(doc, L, 'not_before', PREDECESSOR_NOT_BEFORE, NOT_BEFORE);
  setPath(doc, L, 'expires_at', OLD_WINDOW, EXPIRES_AT);
  setPath(doc, L, 'accepted_subject.expected_ga.control_trust_root_generation', ROOT5_GENERATION, ROOT6_GENERATION);
  setPath(doc, L, 'accepted_subject.expected_ga.controller_digest', OLD_DIGEST, NEW_DIGEST);
  setPathShape(doc, L, 'accepted_subject.expected_ga.source_ref', {commit: PREDECESSOR_SOURCE_COMMIT, tree: PREDECESSOR_SOURCE_TREE, refs: V16_REF_COUNT}, sourceRef);

  // Both schemas are compiled and executed by the controller, and both now const the root6
  // generation, so the accepted refs must point at the merged root6 blobs.
  setPath(doc, L, 'accepted_subject.control_schema_refs.StatusManifest',
    PREDECESSOR_STATUS_SCHEMA, controller('status-manifest.root5.schema.json'));
  setPath(doc, L, 'accepted_subject.control_schema_refs.GateResultReceipt',
    PREDECESSOR_GRR_SCHEMA, controller('gate-result-receipt.root5.schema.json'));

  // ---- the three capacity bindings, all now Owner-published ----
  // This is the third and last place source_refs_maximum had to move to 133. The approval and the
  // applicability carry it too; the successor reviewer found this one, which an earlier round here
  // missed while claiming to have enumerated the conflict.
  setPath(doc, L, 'accepted_subject.capacity_delta',
    doc.accepted_subject.capacity_delta.source_refs_maximum === 131
      ? doc.accepted_subject.capacity_delta : null,
    capacityDelta);
  setPath(doc, L, 'accepted_subject.capacity_materials.approval',
    doc.accepted_subject.capacity_materials.approval, descriptor(APPROVAL_V2));
  setPath(doc, L, 'accepted_subject.capacity_materials.applicability',
    doc.accepted_subject.capacity_materials.applicability, descriptor(APPLICABILITY));

  // ---- repairs: drop two dead 043 entries, append the live one, repair one publication ----
  // context.mjs:237 caps this list at qualificationLimits.allocations, which is 9. An earlier draft
  // here appended without checking that cap and produced 10, which fails on the FIRST step of every
  // operation including the RESULT_RECONCILIATION used to close a reserved budget. Found by the
  // successor reviewer (R4-F1); introduced by this session.
  const repairs = doc.accepted_subject.bounded_series_materials.repairs;
  const before = repairs.length;

  // Three entries claim ga_04377008. Only one can satisfy isApprovedCapacityRepair under the root6
  // capacity binding -- the two older ones pin superseded approval/applicability refs and can never
  // match again. They are dead weight, not backups. Removed by sha256, never by index: the removal
  // itself shifts every later index, which is exactly how the publication fix below would be
  // applied to the wrong entry.
  const dead043Paths = [
    'EnvOriginal043CapacityRepairAcceptance20260910.json',
    'Current043CapacityRepairApplicability20260911.json',
  ];
  const removed = [];
  for (let i = repairs.length - 1; i >= 0; i--) {
    if (dead043Paths.some(n => repairs[i].publication?.artifactPath?.endsWith(n))) {
      removed.push(repairs[i].publication.artifactPath);
      repairs.splice(i, 1);
    }
  }
  if (removed.length !== 2) throw Error('EXPECTED_TWO_DEAD_043_ENTRIES:found=' + removed.length);

  repairs.push(descriptor(REPAIR_043));
  if (repairs.length > 9) throw Error('REPAIRS_EXCEED_ALLOCATIONS_CAP:' + repairs.length);

  // repairs[5] in the predecessor carried publication 58aff4da, a SINGLE-PARENT commit authored and
  // committed by Codex@Windows. verifyOwnerMergeArtifact requires two parents, a web-flow committer
  // and a valid signature, so it could never have passed. Inherited from v16 and carried here by
  // wholesale copy, never triggered because nothing reached that check. The ref is correct and is
  // not touched; only the pointer moves, to an Owner merge that already contains the same blob at
  // the same path. Located by sha256 because the removals above renumber the list.
  const BAD_PUBLICATION_COMMIT = '58aff4daa91b4d23ae8546ec051080746f16c44c';
  const REPLACEMENT_MERGE = 'ad3d589c03ded47110eaecbb47c48ff90600acdc';
  const repointed = [];
  for (const e of repairs) {
    if (e.publication?.commitSha === BAD_PUBLICATION_COMMIT) {
      e.publication = { commitSha: REPLACEMENT_MERGE, artifactPath: e.publication.artifactPath };
      repointed.push(e.publication.artifactPath);
    }
  }
  if (repointed.length !== 1) throw Error('EXPECTED_ONE_SINGLE_PARENT_PUBLICATION:found=' + repointed.length);

  changes.push({ document: L, path: 'bounded_series_materials.repairs',
    removed_dead_043: removed, appended: REPAIR_043.path, repointed_publication: repointed,
    from_count: before, to_count: repairs.length });

  // Stated so no downstream reader mistakes the forward cap for independently reviewed.
  doc.forward_cap_not_covered_by_independent_review = {
    change: 'qualificationLimits.forwards ' + FORWARD_CAP_FROM + ' to ' + FORWARD_CAP_TO,
    covered_by_this_acceptance: false,
    covered_by_the_independent_capacity_applicability: false,
    basis: 'artifacts/clued-validation/phase2-entry-preparation-20260908/OwnerForwardCapExtensionOverride.json',
    note: 'A controller constant, outside both the root3 appendix scope and capacity_delta. Its problem ' +
          'is not that it violates the excluded clause but that no document backs it at all. The ' +
          'successor reviewer stated explicitly that signing the capacity applicability does not ' +
          'endorse it. Recorded here so that is not lost.',
  };

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
