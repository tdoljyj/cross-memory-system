// Re-issues the NW-01 continuation subject for a new Owner window.
//
// Round 8 R8-F2: accepted_binding is the Owner's signature record, not a config value. Editing
// only expires_at would leave the row claiming a window the Owner never approved while still
// pointing at PR #149 and subject 46867dca, which both say 2026-09-12. The established mechanism
// re-issues the subject and its two acceptances, has the Owner merge them, and then NW-01 writes
// all seven fields together.
//
// The full sequence, of which this script is stage 1:
//
//   stage 0  Owner merges bootstrap/next-window-20260912/{OwnerApprovalProposal.md,
//            ExplicitOwnerApproval.candidate.json}. That merge's committed_at IS the window's
//            not_before. Capture the merge from the GitHub API into OwnerApprovalVerification.json.
//   stage 1  THIS SCRIPT. Emits the subject and the two acceptances, in dependency order.
//   stage 2  Owner merges those three. Capture that merge into
//            ContinuationSubjectSignatureEvidence.json -- it records the merge itself, so it
//            cannot exist before the merge.
//   stage 3  NW-01 writes all seven accepted_binding fields, per NW01ApplyCandidate.sql:126-151.
//   stage 4  Re-export read_root (metadata_binding_sha256 has now changed) and only then build the
//            root6 registration.
//
// Usage:
//   node reissue-continuation-subject.mjs <baseline.json> [outDir]
//
// baseline.json supplies the values that must come from observation rather than from this file:
//   { not_before, expires_at, owner_approval_commit,
//     execution: {sequence, charged_seconds, charged_evidence_bytes, active_ga_id,
//                 pending_budget_sequence},
//     root: {sequence, generation_id, generation_ordinal, signed_object_sha256},
//     accepted_binding_currently_expired: bool }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// The subject is stored in canonical form -- recursively key-sorted and compact -- while the two
// acceptances are stored with two-space indent. That is not cosmetic: the subject's file digest IS
// accepted_binding.subject_sha256, so serialising it any other way produces a different value for
// the field the Owner signature record commits to. Each form is asserted against the predecessor
// below rather than assumed.
function canonical(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('Unsafe or floating canonical number');
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) throw Error('Unsupported canonical value');
  return JSON.stringify(value);
}
const asCanonical = v => Buffer.from(canonical(v) + '\n', 'utf8');
const asIndented = v => Buffer.from(JSON.stringify(v, null, 2) + '\n', 'utf8');
const A = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap';
const PREV = `${A}/next-window-20260911`;
const NEXT = `${A}/next-window-20260912`;

// Superseded values that must not survive anywhere in the output.
const OLD = {
  not_before: '2026-09-11T13:14:51Z',
  expires_at: '2026-09-12T13:14:51Z',
  owner_approval_commit: '4498102661f626c8e0c489c7d27551acbc8436ea',
  dir: 'next-window-20260911',
};

const [baselinePath, outDirArg] = process.argv.slice(2);
assert.ok(baselinePath, 'USAGE: node reissue-continuation-subject.mjs <baseline.json> [outDir]');
const b = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
assert.match(b.not_before ?? '', ISO, 'baseline.not_before');
assert.match(b.expires_at ?? '', ISO, 'baseline.expires_at');
assert.equal(Date.parse(b.expires_at) - Date.parse(b.not_before), 86400000,
  'OWNER_WINDOW_MUST_BE_EXACTLY_86400_SECONDS');
assert.match(b.owner_approval_commit ?? '', /^[a-f0-9]{40}$/, 'baseline.owner_approval_commit');
assert.notEqual(b.owner_approval_commit, OLD.owner_approval_commit, 'STILL_THE_PREVIOUS_APPROVAL_COMMIT');
assert.ok(Date.parse(b.not_before) <= Date.now() && Date.now() < Date.parse(b.expires_at),
  'SUBJECT_MUST_BE_ISSUED_INSIDE_THE_WINDOW_IT_DECLARES');
for (const k of ['sequence', 'charged_seconds', 'charged_evidence_bytes']) {
  assert.ok(Number.isSafeInteger(b.execution?.[k]), 'baseline.execution.' + k);
}
assert.ok(Number.isSafeInteger(b.root?.sequence) && Number.isSafeInteger(b.root?.generation_ordinal), 'baseline.root');
assert.match(b.root?.generation_id ?? '', /^ctrgen_[a-f0-9]{32}$/, 'baseline.root.generation_id');
assert.match(b.root?.signed_object_sha256 ?? '', /^[a-f0-9]{64}$/, 'baseline.root.signed_object_sha256');
assert.equal(typeof b.accepted_binding_currently_expired, 'boolean', 'baseline.accepted_binding_currently_expired');

const OUT_DIR = outDirArg ? path.resolve(outDirArg) : path.join(REPO, NEXT);
fs.mkdirSync(OUT_DIR, {recursive: true});
const readPrevRaw = n => fs.readFileSync(path.join(REPO, PREV, n));
const readPrev = n => JSON.parse(readPrevRaw(n).toString('utf8'));

// Prove each serialiser reproduces the predecessor byte for byte before emitting anything.
// The subject's expected digest is the value currently live in accepted_binding.subject_sha256.
{
  const s = readPrevRaw('ContinuationRegistrationSubject.canonical.json');
  const rebuilt = asCanonical(JSON.parse(s.toString('utf8')));
  assert.ok(rebuilt.equals(s), 'CANONICAL_SERIALISER_DOES_NOT_REPRODUCE_PREDECESSOR_SUBJECT');
  assert.equal(sha(s), '46867dca9fcdda12580fafe429e07f2e1c71d5ae9d8338a03c1f57221debe1b8',
    'PREDECESSOR_SUBJECT_IS_NOT_THE_ONE_LIVE_IN_ACCEPTED_BINDING');
  for (const n of ['ContinuationRegistrationSubjectAcceptance.json', 'ContinuationControlStoreAcceptance.json']) {
    const r = readPrevRaw(n);
    assert.ok(asIndented(JSON.parse(r.toString('utf8'))).equals(r), 'INDENT_SERIALISER_DOES_NOT_REPRODUCE:' + n);
  }
}
const fileRef = (relDir, name, absDir) => {
  const raw = fs.readFileSync(path.join(absDir, name));
  return {path: `${relDir}/${name}`, sha256: sha(raw), bytes: raw.length};
};

// Stage 0 must already have produced these three in the new directory.
for (const n of ['OwnerApprovalProposal.md', 'ExplicitOwnerApproval.candidate.json', 'OwnerApprovalVerification.json']) {
  assert.ok(fs.existsSync(path.join(REPO, NEXT, n)),
    'STAGE_0_INCOMPLETE — missing ' + NEXT + '/' + n + '. The Owner must merge the approval and its ' +
    'verification must be captured from the GitHub API before the subject can be re-issued.');
}
const verification = JSON.parse(fs.readFileSync(path.join(REPO, NEXT, 'OwnerApprovalVerification.json'), 'utf8'));
assert.equal(verification.merge?.sha, b.owner_approval_commit,
  'VERIFICATION_RECORDS_A_DIFFERENT_MERGE_THAN_THE_BASELINE');
assert.equal(verification.fixed_window?.not_before, b.not_before, 'VERIFICATION_WINDOW_DISAGREES');
assert.equal(verification.fixed_window?.expires_at, b.expires_at, 'VERIFICATION_WINDOW_DISAGREES');
assert.equal(verification.merge?.verification?.verified, true, 'MERGE_NOT_VERIFIED');
assert.equal(verification.merge?.verification?.reason, 'valid', 'MERGE_VERIFICATION_NOT_VALID');
assert.equal(verification.merge?.committer_login, 'web-flow', 'MERGE_COMMITTER_NOT_WEB_FLOW');
assert.equal(verification.pr?.merged_by, 'tdoljyj', 'MERGE_NOT_BY_OWNER');

const approvalRef = fileRef(NEXT, 'ExplicitOwnerApproval.candidate.json', path.join(REPO, NEXT));
const proposalRef = fileRef(NEXT, 'OwnerApprovalProposal.md', path.join(REPO, NEXT));
const verificationRef = fileRef(NEXT, 'OwnerApprovalVerification.json', path.join(REPO, NEXT));

// ---- 1. the subject -------------------------------------------------------
const subject = readPrev('ContinuationRegistrationSubject.canonical.json');
subject.not_before = b.not_before;
subject.expires_at = b.expires_at;
subject.approval = {
  ...subject.approval,
  owner_approval_commit: b.owner_approval_commit,
  approval_path: approvalRef.path,
  approval_sha256: approvalRef.sha256,
  proposal_path: proposalRef.path,
  proposal_sha256: proposalRef.sha256,
  verification_ref: {path: verificationRef.path, sha256: verificationRef.sha256},
};
subject.current_control_root = {
  ...subject.current_control_root,
  current_head_sequence: b.root.sequence,
  generation_id: b.root.generation_id,
  generation_ordinal: b.root.generation_ordinal,
  signed_object_sha256: b.root.signed_object_sha256,
};
subject.execution_baseline = {
  ...subject.execution_baseline,
  sequence: b.execution.sequence,
  charged_seconds: b.execution.charged_seconds,
  charged_evidence_bytes: b.execution.charged_evidence_bytes,
  active_ga_id: b.execution.active_ga_id ?? null,
  pending_budget_sequence: b.execution.pending_budget_sequence ?? null,
};
subject.window_maintenance = {
  ...subject.window_maintenance,
  application_ordinal: subject.window_maintenance.application_ordinal + 1,
};

// The maintenance boundary must be byte-identical to the reviewed one: same seven fields, same
// three checks, same trigger. This is the clause the whole mechanism rests on.
const prevSubject = readPrev('ContinuationRegistrationSubject.canonical.json');
for (const k of ['changed_fields', 'changed_checks', 'exception', 'row', 'temporarily_disabled_trigger',
                 'trigger_restored_same_transaction', 'surgical_authority', 'production_authority',
                 'once_only_per_approved_window', 'fresh_preimage_required_before_apply',
                 'fresh_independent_review_required_before_apply']) {
  assert.deepEqual(subject.window_maintenance[k], prevSubject.window_maintenance[k],
    'MAINTENANCE_BOUNDARY_WIDENED:' + k);
}
const subjectRaw = asCanonical(subject);
fs.writeFileSync(path.join(OUT_DIR, 'ContinuationRegistrationSubject.canonical.json'), subjectRaw);
const subjectRef = {path: `${NEXT}/ContinuationRegistrationSubject.canonical.json`, sha256: sha(subjectRaw), bytes: subjectRaw.length};

// ---- 2. the registration acceptance, which pins the subject ---------------
const regAcc = readPrev('ContinuationRegistrationSubjectAcceptance.json');
regAcc.window = {not_before: b.not_before, expires_at: b.expires_at};
regAcc.owner_approval = {
  ...regAcc.owner_approval,
  merge_commit: b.owner_approval_commit,
  verification_ref: {path: verificationRef.path, sha256: verificationRef.sha256},
};
regAcc.registration_subject = {...subjectRef};
regAcc.current_root_generation = b.root.generation_id;
regAcc.current_root_sequence = b.root.sequence;
regAcc.execution_baseline = {
  sequence: b.execution.sequence,
  charged_seconds: b.execution.charged_seconds,
  charged_evidence_bytes: b.execution.charged_evidence_bytes,
  active_ga_id: b.execution.active_ga_id ?? null,
  pending_budget_sequence: b.execution.pending_budget_sequence ?? null,
};
const regAccRaw = asIndented(regAcc);
fs.writeFileSync(path.join(OUT_DIR, 'ContinuationRegistrationSubjectAcceptance.json'), regAccRaw);
const regAccRef = {path: `${NEXT}/ContinuationRegistrationSubjectAcceptance.json`, sha256: sha(regAccRaw), bytes: regAccRaw.length};

// ---- 3. the store acceptance, which pins both ------------------------------
const storeAcc = readPrev('ContinuationControlStoreAcceptance.json');
storeAcc.window = {not_before: b.not_before, expires_at: b.expires_at};
storeAcc.owner_approval_merge = b.owner_approval_commit;
storeAcc.registration_subject = {...subjectRef};
storeAcc.registration_acceptance = {...regAccRef};
storeAcc.live_observation_baseline = {
  ...storeAcc.live_observation_baseline,
  accepted_binding_currently_expired: b.accepted_binding_currently_expired,
  active_ga_id: b.execution.active_ga_id ?? null,
  pending_budget_sequence: b.execution.pending_budget_sequence ?? null,
  charged_seconds: b.execution.charged_seconds,
  charged_evidence_bytes: b.execution.charged_evidence_bytes,
  current_root_generation: b.root.generation_id,
  current_root_sequence: b.root.sequence,
  execution_sequence: b.execution.sequence,
};
storeAcc.allowed_maintenance = {
  ...storeAcc.allowed_maintenance,
  application_ordinal: storeAcc.allowed_maintenance.application_ordinal + 1,
};
const prevStore = readPrev('ContinuationControlStoreAcceptance.json');
for (const k of ['changed_fields', 'changed_checks', 'exception', 'row',
                 'temporarily_disabled_trigger', 'trigger_restored_same_transaction',
                 'surgical_authority', 'production_authority']) {
  assert.deepEqual(storeAcc.allowed_maintenance[k], prevStore.allowed_maintenance[k],
    'STORE_MAINTENANCE_BOUNDARY_WIDENED:' + k);
}
const storeAccRaw = asIndented(storeAcc);
fs.writeFileSync(path.join(OUT_DIR, 'ContinuationControlStoreAcceptance.json'), storeAccRaw);
const storeAccRef = {path: `${NEXT}/ContinuationControlStoreAcceptance.json`, sha256: sha(storeAccRaw), bytes: storeAccRaw.length};

// ---- no superseded value may survive in any of the three -------------------
for (const [name, raw] of [['subject', subjectRaw], ['registration acceptance', regAccRaw], ['store acceptance', storeAccRaw]]) {
  const text = raw.toString('utf8');
  for (const [k, v] of Object.entries(OLD)) {
    assert.equal(text.split(v).length, 1, 'SUPERSEDED_VALUE_SURVIVED_IN_' + name.replaceAll(' ', '_') + ':' + k + '=' + v);
  }
  JSON.parse(text);
}

console.log(JSON.stringify({
  state: 'CONTINUATION_SUBJECT_REISSUED_NOT_MERGED_NO_AUTHORITY',
  output_dir: OUT_DIR === path.join(REPO, NEXT) ? NEXT : OUT_DIR,
  window: {not_before: b.not_before, expires_at: b.expires_at, duration_seconds: 86400},
  owner_approval_commit: b.owner_approval_commit,
  application_ordinal: subject.window_maintenance.application_ordinal,
  emitted: {subject: subjectRef, registration_acceptance: regAccRef, store_acceptance: storeAccRef},
  maintenance_boundary: 'byte-identical to the reviewed NW-01 clause (7 fields, 3 checks, 1 trigger)',
  next: [
    'Owner merges these three. That merge is what makes them authoritative.',
    'Then capture it into ContinuationSubjectSignatureEvidence.json (stage 2).',
    'Only then can NW-01 be prepared, and only after NW-01 can the root6 registration be built.',
  ],
  authority_effect: 'NONE_UNTIL_VERIFIED_OWNER_MERGE',
}, null, 2));
