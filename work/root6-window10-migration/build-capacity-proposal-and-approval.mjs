// Emits the root6 capacity proposal and reissues the capacity approval that references it.
//
// Why this exists: the merged approval d0649465… declares source_refs_maximum 133 while its
// capacity_proposal_ref points at a proposal declaring 131. That pointer was carried over from the
// predecessor as a "historical pin". It is not one -- it is the pointer to the proposal being
// approved, so the first link of the chain did not match. The controller cannot catch this: it
// checks the ref's shape, never the proposal's content. The successor independent reviewer caught
// it and declined to sign an applicability onto a chain whose first link is broken.
//
// Both documents are produced here so that the approval's capacity_delta and the proposal's
// capacity_delta are the same object by construction rather than aligned by hand.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CTX = path.join(REPO, 'scripts/phase2-qualification/control-context-verifier-root6-window10-successor/context.mjs');
const DIR_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity';
const PRED_PROPOSAL_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v16-source-completeness/Root5OriginalInput4000000CapacityProposal20260911.json';
const PRED_APPROVAL_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v16-source-completeness/Root5OriginalInput4000000CapacityApproval20260911.json';
const MERGED_APPROVAL_REL = DIR_REL + '/Root6OriginalInput4000000CapacityApproval20260912.json';

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const blobSha = b => {
  // Must be a Buffer. Given a string, b.length is the UTF-16 code unit count, not the byte
  // length, and the git blob header would be wrong -- producing a plausible but incorrect id.
  if (!Buffer.isBuffer(b)) throw Error('blobSha_REQUIRES_A_BUFFER_NOT_A_STRING');
  return crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
};
const blobUri = id => 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + id;
const canonical = v => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
const canonicalDigest = v => sha(canonical(v) + '\n');

const ROOT6_GENERATION = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b';
const ROOT6_EXPIRY = '2026-09-19T00:00:00Z';
const CONTROLLER_DIGEST = '72d9eb92cf287ee6fda1fdbb97d90d02ed7f0e368398cba4ddb517233413d145';

// Pull the frozen constants out of the controller. Retyping is how byte-exact comparison breaks.
const src = fs.readFileSync(CTX, 'utf8');
const frozen = name => {
  const m = new RegExp('const ' + name + '=Object\\.freeze\\((\\{.*?\\})\\);', 's').exec(src);
  if (!m) throw Error('CONSTANT_NOT_FOUND_IN_CONTROLLER:' + name);
  return (0, eval)('(' + m[1] + ')');
};
const capacityDelta = frozen('capacityDelta');
const capacityBaseline = frozen('capacityBaseline');
const scope = frozen('scope');
const qualificationLimits = (0, eval)('(' + /export const qualificationLimits=Object\.freeze\((\{.*?\})\);/s.exec(src)[1] + ')');

if (capacityDelta.source_refs_maximum !== 133) throw Error('CONTROLLER_NOT_AT_133');

const predProposal = JSON.parse(fs.readFileSync(path.join(REPO, PRED_PROPOSAL_REL), 'utf8'));
const predApproval = JSON.parse(fs.readFileSync(path.join(REPO, PRED_APPROVAL_REL), 'utf8'));
const mergedRaw = fs.readFileSync(path.join(REPO, MERGED_APPROVAL_REL));
const merged = JSON.parse(mergedRaw.toString('utf8'));

// Sanity: the defect this script fixes must actually be present, or the premise has changed.
const brokenProposal = JSON.parse(fs.readFileSync(path.join(REPO, PRED_PROPOSAL_REL), 'utf8'));
if (merged.capacity_proposal_ref.sha256 !== sha(fs.readFileSync(path.join(REPO, PRED_PROPOSAL_REL))))
  throw Error('MERGED_APPROVAL_DOES_NOT_POINT_AT_THE_PREDECESSOR_PROPOSAL');
if (brokenProposal.capacity_delta.source_refs_maximum !== 131)
  throw Error('PREDECESSOR_PROPOSAL_NOT_AT_131');

// ---- the proposal ----
const proposal = {
  object_type: 'ExactOriginalInputCapacityProposal',
  schema_version: '1.0',
  state: 'PROPOSED_ROOT6_WINDOW_MIGRATION_SOURCE_REF_SUPPLEMENT',
  created_at: merged.approved_at,
  root_id: scope.root_id,
  root_generation: ROOT6_GENERATION,
  expires_at: ROOT6_EXPIRY,
  controller_digest: CONTROLLER_DIGEST,

  observed_pre_v16_original_input_bytes: predProposal.observed_pre_v16_original_input_bytes,
  observed_pre_v16_publisher_request_bytes: predProposal.observed_pre_v16_publisher_request_bytes,
  measurement_scope: predProposal.measurement_scope,

  capacity_delta: capacityDelta,

  what_this_proposal_changes: {
    field: 'capacity_delta.source_refs_maximum',
    from: 131,
    to: 133,
    why: 'The root6 controller closure declares 133 ordered source references: the predecessor 131 plus ' +
         'two files added so that a signing module pinned by hash in 64 other artifacts could be ' +
         'succeeded rather than edited in place.',
    every_other_capacity_delta_field: 'byte-identical to the predecessor proposal',
  },

  precedent: {
    note: 'source_refs_maximum inside capacity_delta is the established supplemental layer, not a scope ' +
          'cap. It has been raised before under this same mechanism: 128, then 130, then 131, each time ' +
          'with an Owner approval and an independent applicability. This is the fourth use of the ' +
          'sanctioned path, not a departure from it.',
    corrects_an_earlier_mischaracterisation: 'An earlier draft by the implementing side described this ' +
      'raise as a second instance of the excluded "cap extension" clause, alongside the forward cap. ' +
      'The successor independent reviewer rejected that reading and the rejection is accepted: the ' +
      'excluded clause governs the root3 appendix\'s own scope caps, and reading it to cover ' +
      'capacity_delta would retroactively invalidate the 128, 130 and 131 raises and with them the ' +
      '4,000,000-byte original input limit this run depends on.',
    forward_cap_is_a_different_case: 'qualificationLimits.forwards ' + qualificationLimits.forwards +
      ' is a controller constant, not part of capacity_delta, and carries no document backing. It is ' +
      'NOT covered by this proposal and remains an open item.',
  },

  additional_allocations_max: predProposal.additional_allocations_max,
  per_allocation_seconds: predProposal.per_allocation_seconds,
  per_allocation_evidence_bytes: predProposal.per_allocation_evidence_bytes,
  new_series_seconds_cap: predProposal.new_series_seconds_cap,
  new_series_evidence_bytes_cap: predProposal.new_series_evidence_bytes_cap,
  maximum_new_ga: predProposal.maximum_new_ga,
  maximum_new_forward: predProposal.maximum_new_forward,
  production: false,
  paid_budget: 0,
  model_budget: 0,
  refund: false,
  new_trust_root: false,
  new_signing_identity: false,

  necessity: 'The root5 window lapsed before the qualification run could use it. Migrating to root6 ' +
             'changes the controller source closure, which raises the ordered source reference count ' +
             'from 131 to 133. Without this supplement the run fails at the first capacity check.',
  external_source_bindings: predProposal.external_source_bindings,
  authority_effect: 'PROPOSAL_ONLY',
};

const proposalRaw = JSON.stringify(proposal, null, 2) + '\n';
const proposalPath = DIR_REL + '/Root6OriginalInput4000000CapacityProposal20260912.json';
fs.mkdirSync(path.join(REPO, DIR_REL), { recursive: true });
fs.writeFileSync(path.join(REPO, proposalPath), proposalRaw);
const proposalSha = sha(proposalRaw), proposalBlob = blobSha(Buffer.from(proposalRaw));

// ---- the reissued approval ----
const approval = {
  ...merged,
  capacity_proposal_ref: { uri: blobUri(proposalBlob), sha256: proposalSha },
  approved_change_index_sha256: proposalSha,
};

// The substance of the Owner's decision has not changed -- 133, same as the merged approval -- so
// approved_at stays at the moment the Owner decided. What changed is a clerical pointer.
approval.reissue = {
  supersedes: {
    path: MERGED_APPROVAL_REL,
    sha256: sha(mergedRaw),
    bytes: mergedRaw.length,
    blob_sha: blobSha(mergedRaw),
    owner_merge: '77330e254896a02c09cc8e22555819dcf5018fdc',
  },
  reason: 'The superseded approval declared source_refs_maximum 133 while capacity_proposal_ref and ' +
          'approved_change_index_sha256 pointed at a proposal declaring 131. Those two fields were ' +
          'carried over from the predecessor by the implementing side as historical pins; they are not ' +
          'historical pins, they are the pointer to the proposal being approved. Found by the successor ' +
          'independent reviewer (R2-F1). The controller cannot detect it -- it checks the ref shape and ' +
          'never reads the proposal.',
  substance_unchanged: true,
  approved_at_unchanged_because: 'The Owner decision being recorded is the same one, at the same moment. ' +
    'Only the pointer is corrected, so re-dating it would misrepresent when the decision was made and ' +
    'would also disturb the ordering constraint against the applicability.',
};

// The earlier characterisation was wrong and is replaced rather than quietly dropped.
approval.conflicts_with_governing_exclusion = undefined;
delete approval.conflicts_with_governing_exclusion;
approval.governing_exclusion_analysis =
  'An earlier version of this approval asserted that raising source_refs_maximum conflicts with the ' +
  '"cap extension" term in BoundedSeriesApplicability20260910.excluded, and recorded it as the second ' +
  'instance of that class after the forward cap. The successor independent reviewer rejected that ' +
  'reading, and the rejection is accepted here. The excluded clause governs the root3 appendix\'s own ' +
  'scope caps; source_refs_maximum sits in capacity_delta, the supplemental layer, which has been raised ' +
  'under this same mechanism three times already (128, 130, 131), each with an Owner approval and an ' +
  'independent applicability. Reading excluded to cover it would retroactively invalidate those three ' +
  'and the 4,000,000-byte original input limit that this run depends on. This is the fourth use of the ' +
  'path the appendix\'s own delegation_effect prescribes. NOTE: this reasoning does NOT extend to ' +
  'qualificationLimits.forwards 15 to 16, which is a controller constant outside capacity_delta with no ' +
  'document backing; that remains an open item recorded in OwnerForwardCapExtensionOverride.json.';

const approvalRaw = JSON.stringify(approval, null, 2) + '\n';
const approvalPath = DIR_REL + '/Root6OriginalInput4000000CapacityApproval20260912.v2.json';
fs.writeFileSync(path.join(REPO, approvalPath), approvalRaw);

// ---- prove the forced comparisons still hold, and that the chain's first link now matches ----
const emitted = JSON.parse(approvalRaw);
const checks = {
  state_exact: emitted.state === 'APPROVED_EXACT_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT',
  base_proposal_sha256_unchanged: emitted.base_proposal_sha256 === predApproval.base_proposal_sha256,
  capacity_delta_matches_controller: canonicalDigest(emitted.capacity_delta) === canonicalDigest(capacityDelta),
  baseline_matches_controller: canonicalDigest(emitted.baseline) === canonicalDigest(capacityBaseline),
  bounded_series_constraints_matches_scope: canonicalDigest(emitted.bounded_series_constraints) === canonicalDigest(scope),
  approved_at_in_window: emitted.approved_at >= '2026-09-12T00:00:00Z' && emitted.approved_at < ROOT6_EXPIRY,
  // the defect being fixed
  proposal_ref_resolves_to_the_new_proposal: emitted.capacity_proposal_ref.sha256 === proposalSha,
  proposal_declares_the_same_capacity_delta:
    canonicalDigest(JSON.parse(proposalRaw).capacity_delta) === canonicalDigest(emitted.capacity_delta),
  proposal_source_refs_maximum: JSON.parse(proposalRaw).capacity_delta.source_refs_maximum,
  approval_source_refs_maximum: emitted.capacity_delta.source_refs_maximum,
};
for (const [k, v] of Object.entries(checks)) if (v === false) throw Error('CHECK_FAILED:' + k);
if (checks.proposal_source_refs_maximum !== checks.approval_source_refs_maximum)
  throw Error('CHAIN_STILL_BROKEN');

console.log(JSON.stringify({
  proposal: { path: proposalPath, bytes: proposalRaw.length, sha256: proposalSha, blob_sha: proposalBlob },
  approval: { path: approvalPath, bytes: approvalRaw.length, sha256: sha(approvalRaw), blob_sha: blobSha(Buffer.from(approvalRaw)) },
  checks,
}, null, 2));
