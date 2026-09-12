// Captures a verified Owner merge into the evidence file the NW-01 chain requires.
//
// Two stages use this:
//   --as approval    stage 0: the merge of next-window-20260912/{proposal,approval}
//                    -> OwnerApprovalVerification.json. Its committed_at IS the window's not_before.
//   --as signature   stage 2: the merge of the subject and its two acceptances
//                    -> ContinuationSubjectSignatureEvidence.json.
//
// It does NOT call GitHub. trusted-github.mjs reaches the API only through a specific gh.exe whose
// bytes it re-hashes on every call, which exists on one Windows machine; reimplementing that here
// would be inventing a second, weaker path to the same trust decision. Instead the caller fetches
// the five responses and passes them in, and this script applies the checks.
//
// THE CHECKS ARE NOT ORIGINAL. Each one below is annotated with the line of
// control-context-verifier-*/trusted-github.mjs verifyOwnerMergeArtifact it mirrors, so a reviewer
// can diff intent against the controller rather than take this file's word for it. This is a
// second implementation of the same conditions, and it is labelled as such in the output: it does
// not replace the controller's own verification at runtime.
//
// Collect the input with gh (on the host) or any authenticated client:
//   gh api repos/tdoljyj/cross-memory-system                                   > repo.json
//   gh api repos/tdoljyj/cross-memory-system/commits/<SHA>                     > commit.json
//   gh api repos/tdoljyj/cross-memory-system/commits/<SHA>/pulls               > pulls.json
//   gh api repos/tdoljyj/cross-memory-system/pulls/<N>                         > pr.json
//   gh api 'repos/tdoljyj/cross-memory-system/git/trees/<TREE>?recursive=1'    > tree.json
// then combine them as {repo, commit, pulls, pr, tree} in one file.
//
// Usage:
//   node capture-owner-merge.mjs <api-bundle.json> --as approval|signature --artifacts <p1,p2,...> [--out f]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';

const REPOSITORY = 'tdoljyj/cross-memory-system';
const OWNER = 'tdoljyj';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const blobSha = b => {
  if (!Buffer.isBuffer(b)) throw Error('blobSha_REQUIRES_A_BUFFER_NOT_A_STRING');
  return crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
};

const argv = process.argv.slice(2);
const bundlePath = argv[0];
const arg = n => argv.includes(n) ? argv[argv.indexOf(n) + 1] : null;
const mode = arg('--as');
const artifacts = (arg('--artifacts') ?? '').split(',').filter(Boolean);
const outPath = arg('--out');
assert.ok(bundlePath && !bundlePath.startsWith('--'), 'USAGE: see header');
assert.ok(['approval', 'signature'].includes(mode), '--as must be approval or signature');
assert.ok(artifacts.length, '--artifacts must list the repository paths this merge is being trusted for');

const B = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
for (const k of ['repo', 'commit', 'pulls', 'pr', 'tree']) assert.ok(B[k], 'BUNDLE_MISSING:' + k);

// --- verifyOwnerMergeArtifact, condition by condition -----------------------
// :36  repo.private === true && repo.full_name === repository
assert.equal(B.repo.private, true, 'PRIVATE_REPOSITORY_REQUIRED');
assert.equal(B.repo.full_name, REPOSITORY, 'PRIVATE_REPOSITORY_REQUIRED');

// :37-38  commit.sha, exactly 2 parents, committer web-flow, verification valid with sig+payload
const c = B.commit, v = c.commit?.verification;
const commitSha = c.sha;
assert.match(commitSha ?? '', /^[0-9a-f]{40}$/, 'FIXED_MERGE_REFERENCE');
assert.equal(c.parents?.length, 2, 'OWNER_MERGE_VALID_SIGNATURE_REQUIRED: parents');
assert.equal(c.committer?.login, 'web-flow', 'OWNER_MERGE_VALID_SIGNATURE_REQUIRED: committer');
assert.equal(v?.verified, true, 'OWNER_MERGE_VALID_SIGNATURE_REQUIRED: verified');
assert.equal(v?.reason, 'valid', 'OWNER_MERGE_VALID_SIGNATURE_REQUIRED: reason');
assert.ok(v?.signature && v?.payload, 'OWNER_MERGE_VALID_SIGNATURE_REQUIRED: signature/payload present');
// verified_at is when GitHub verified the signature, not when the commit was made -- for PR #149
// they differ by a second. It must come from the API. An earlier version of this script filled it
// from committed_at, which silently invented a value that looked right; rehearsing against the
// historical evidence file is what caught it.
assert.ok(v?.verified_at, 'VERIFICATION_VERIFIED_AT_MISSING_FROM_API_RESPONSE — do not substitute committed_at');

// :39-40  exactly one merged PR onto main whose merge_commit_sha is this commit
const matching = (B.pulls ?? []).filter(p => p.merge_commit_sha === commitSha && p.merged_at && p.base?.ref === 'main');
assert.equal(matching.length, 1, 'EXACT_MAIN_MERGED_PR_REQUIRED');

// :41  the PR itself: merged, merged_by the Owner, same merge commit
assert.equal(B.pr.number, matching[0].number, 'PR_BUNDLE_IS_A_DIFFERENT_PR');
assert.equal(B.pr.merged, true, 'ACTUAL_OWNER_MERGE_REQUIRED: merged');
assert.equal(B.pr.merged_by?.login, OWNER, 'ACTUAL_OWNER_MERGE_REQUIRED: merged_by');
assert.equal(B.pr.merge_commit_sha, commitSha, 'ACTUAL_OWNER_MERGE_REQUIRED: merge_commit_sha');

// :42-43  complete, untruncated tree for this commit
assert.equal(B.tree.sha, c.commit.tree.sha, 'COMPLETE_EXACT_TREE_REQUIRED: wrong tree');
assert.equal(B.tree.truncated, false, 'COMPLETE_EXACT_TREE_REQUIRED: truncated');
assert.ok(Array.isArray(B.tree.tree), 'COMPLETE_EXACT_TREE_REQUIRED: not an array');

// :47  each artifact appears exactly once, as a regular blob at mode 100644, and the bytes on disk
//      match the blob id the tree records. The controller re-reads the blob from the API; here the
//      equivalent is that the local file hashes to the same git blob id.
const artifactRefs = {};
for (const p of artifacts) {
  assert.ok(!p.includes('..') && !p.startsWith('/'), 'FIXED_MERGE_REFERENCE:' + p);
  const m = B.tree.tree.filter(e => e.path === p);
  assert.equal(m.length, 1, 'EXACT_REGULAR_STATIC_ARTIFACT: not unique in tree: ' + p);
  assert.equal(m[0].type, 'blob', 'EXACT_REGULAR_STATIC_ARTIFACT: not a blob: ' + p);
  assert.equal(m[0].mode, '100644', 'EXACT_REGULAR_STATIC_ARTIFACT: mode ' + m[0].mode + ': ' + p);
  const local = fs.readFileSync(p);
  assert.equal(blobSha(local), m[0].sha,
    'LOCAL_BYTES_DIFFER_FROM_WHAT_THE_OWNER_MERGED: ' + p + ' — the merged tree is authoritative');
  artifactRefs[p] = {path: p, blob_sha: m[0].sha, sha256: sha(local), bytes: local.length};
}

// The window rule: not_before is the merge's committed_at. The PR's merged_at and the commit's
// committer date are both recorded by GitHub and must agree; if they do not, which one is "the"
// timestamp is a question for the Owner, not a thing to pick silently.
const mergedAt = B.pr.merged_at;
const committedAt = c.commit?.committer?.date;
assert.ok(mergedAt && committedAt, 'MERGE_TIMESTAMPS_MISSING');
const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
assert.equal(iso(mergedAt), iso(committedAt),
  'MERGED_AT_AND_COMMITTED_AT_DISAGREE: ' + mergedAt + ' vs ' + committedAt);
const notBefore = iso(committedAt);
const expiresAt = iso(new Date(Date.parse(notBefore) + 86400000).toISOString());

const common = {
  status: 'VERIFIED',
  repository: {full_name: B.repo.full_name, private: B.repo.private},
  merge: {
    sha: commitSha,
    tree: B.tree.sha,
    parents: c.parents.map(p => p.sha),
    committer_login: c.committer.login,
    author_login: c.author?.login ?? null,
    verification: {verified: v.verified, reason: v.reason, verified_at: iso(v.verified_at)},
  },
  pr: {
    number: B.pr.number, merged_by: B.pr.merged_by.login, merged_at: iso(mergedAt),
    merge_commit_sha: commitSha, base_sha: c.parents[0].sha, head_sha: c.parents[1].sha,
  },
  verification_method: {
    performed_by: 'work/twentieth-forward/capture-owner-merge.mjs',
    mirrors: 'control-context-verifier-*/trusted-github.mjs verifyOwnerMergeArtifact',
    is_the_controller_verification: false,
    note: 'A second implementation of the same conditions, applied to API responses fetched by the ' +
          'caller. The controller performs its own verification at runtime through its pinned gh.exe; ' +
          'this does not substitute for it.',
  },
  authority_effect: mode === 'approval' ? 'FIXED_WINDOW_SCOPE_APPROVED_ONLY; NO_DATABASE_EFFECT'
                                        : 'NONE_UNTIL_EXACT_NW01_TRANSACTION',
};

const out = mode === 'approval'
  ? {
      schema_version: 1,
      kind: 'VERIFIED_OWNER_CONTINUATION_APPROVAL',
      ...common,
      fixed_window: {not_before: notBefore, expires_at: expiresAt, duration_seconds: 86400,
                     rolling: false, auto_renew: false, backdate: false},
      approval_artifacts: Object.fromEntries(Object.entries(artifactRefs).map(([p, r]) =>
        [p.endsWith('.md') ? 'proposal' : 'approval', r])),
      scope: {project_ref: 'uscrdifznmlvczcekqpw', namespace: 'clued_control',
              root_set_id: 'ctr_414bd3c724264a83894b0c55cf2ab878',
              purpose: 'SKILL_COEXISTENCE_QUALIFICATION', environment: 'ISOLATED_TEST',
              production_authority: false, paid_model_authority: false,
              new_trust_root: false, scope_expansion: false},
    }
  : {
      kind: 'EXACT_NW01_CONTINUATION_SUBJECT_SIGNATURE_EVIDENCE',
      ...common,
      observed_at_utc: iso(new Date().toISOString()),
      approved_window: {not_before: notBefore, expires_at: expiresAt},
      artifacts: artifactRefs,
      root_registered: false, status_registered: false, accepted_binding_updated: false, ga_created: false,
    };

const text = JSON.stringify(out, null, 2) + '\n';
if (outPath) fs.writeFileSync(outPath, text);
console.log(JSON.stringify({
  state: 'OWNER_MERGE_CAPTURED_NOT_APPLIED',
  mode, out: outPath ?? '(stdout only)',
  merge: commitSha, pr: B.pr.number,
  window: mode === 'approval' ? {not_before: notBefore, expires_at: expiresAt} : undefined,
  artifacts_verified_against_merged_tree: Object.keys(artifactRefs).length,
  conditions_applied: ['private repository', 'exactly two parents', 'committer web-flow',
                       'verification verified+valid with signature and payload',
                       'exactly one merged PR onto main', 'merged_by is the Owner',
                       'tree complete and untruncated', 'each artifact unique, blob, mode 100644',
                       'local bytes match the merged blob id', 'merged_at equals committed_at'],
  authority_effect: out.authority_effect,
}, null, 2));
if (!outPath) console.error('\n(no --out given; evidence printed to stdout only, nothing written)');
