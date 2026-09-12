// Emits the successor independent reviewer's two documents:
//
//   (2) Root6CurrentController4000000CapacityApplicability20260912.json
//   (4) Root6Current043CapacityRepairAcceptance20260912.json
//
// These are the reviewer's own instruments, not the implementing side's artifacts. Nothing the
// implementing side produced is read for its conclusions; every forced value is taken from the
// controller source, the Owner-merged approval, or the v17 runtime acceptance, and is then
// asserted against the controller's own comparison before anything is written.
//
// Retyping is how a byte-exact comparison dies. Nothing here is retyped: capacityDelta,
// capacityBaseline and scope are extracted from context.mjs; every ref is derived from the actual
// bytes of the file it points at.
//
// Running this issues nothing by itself. Both documents carry acceptance state, but a capacity
// document has authority only once the Owner merges it and the runtime acceptance binds it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity';
const CTRL_REL = 'scripts/phase2-qualification/control-context-verifier-root6-window10-successor';
const SIGN_REL = 'scripts/phase2-qualification/nonproduction-control-store/runtime-successor/commitment-signing-root6-window/signing.mjs';
const V17_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v17';
const PRED_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v16-source-completeness';

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const blobSha = b => crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
const blobUri = id => 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + id;
const read = rel => fs.readFileSync(path.join(REPO, rel));
const readJson = rel => JSON.parse(read(rel).toString('utf8'));
const refOf = rel => { const b = read(rel); return { uri: blobUri(blobSha(b)), sha256: sha(b) }; };
const need = (ok, why) => { if (!ok) throw Error('REFUSING_TO_ISSUE:' + why); };

// ---- identity of the issuing reviewer, per the Owner succession decision ----
const SESSION = 'session_018nf6mQ5CQuMFadoJ9WRZCN';
const SUCCESSION_MERGE = 'a573ca93e094bc9a4a8dccc23c1e165b6b368ff4';
const NOT_RATIFIED = 'This acceptance does not ratify any historical conclusion of the original /root/project_list_auth_fix session.';
const REVIEWER = '/root/project_list_auth_fix';

// ---- the frozen structures, extracted from the controller rather than retyped ----
const ctxSrc = read(CTRL_REL + '/context.mjs').toString('utf8');
const frozen = name => {
  const i = ctxSrc.indexOf('const ' + name + '=Object.freeze(');
  need(i >= 0, 'CONSTANT_NOT_FOUND_IN_CONTROLLER:' + name);
  const start = ctxSrc.indexOf('(', i) + 1;
  let depth = 1, j = start;
  while (depth > 0) { j++; if (ctxSrc[j] === '(') depth++; else if (ctxSrc[j] === ')') depth--; }
  return (0, eval)('(' + ctxSrc.slice(start, j) + ')');
};
const capacityDelta = frozen('capacityDelta');
const capacityBaseline = frozen('capacityBaseline');
const scope = frozen('scope');
need(capacityDelta.source_refs_maximum === 133, 'CONTROLLER_DOES_NOT_DECLARE_133');

// proposalSHA and the hardcoded previous evidence sink are scraped, not retyped, for the same reason.
const proposalSHA = /const proposalSHA='([a-f0-9]{64})'/.exec(ctxSrc)?.[1];
const previousSinkSha = /d\.previous_evidence_sink_ref\.sha256==='([a-f0-9]{64})'/.exec(ctxSrc)?.[1];
need(proposalSHA && previousSinkSha, 'CONTROLLER_SCRAPE_FAILED');

// ---- (1) the Owner-merged approval this acceptance is about ----
const APPROVAL_REL = OUT_REL + '/Root6OriginalInput4000000CapacityApproval20260912.v2.json';
const approval = readJson(APPROVAL_REL);
const approvalRef = refOf(APPROVAL_REL);

// The v2 approval is the one with an aligned proposal pointer. Refuse to bind the superseded v1.
need(approval.reissue?.supersedes?.sha256, 'APPROVAL_IS_NOT_THE_REISSUED_V2');
const proposalRef = refOf(OUT_REL + '/Root6OriginalInput4000000CapacityProposal20260912.json');
const proposal = readJson(OUT_REL + '/Root6OriginalInput4000000CapacityProposal20260912.json');

// ---- the root3 appendix, source of pins.approval_ref ----
const appendixRel = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/BoundedSeriesApplicability20260910.json';
const appendix = readJson(appendixRel);

// ---- the v17 runtime acceptance, source of expected_ga ----
const v17 = readJson(V17_REL + '/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json');
const expectedGa = v17.accepted_subject.expected_ga;

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const deepSame = (x, y) => { const c = v => { if (Array.isArray(v)) return '[' + v.map(c).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + c(v[k])).join(',') + '}'; return JSON.stringify(v); }; return c(x) === c(y); };

// ---------------------------------------------------------------------------
// changed_source_refs -- RULE R6, stated because it could not be inherited.
//
// The predecessor set carries 20 blobs. Ten are the root5 controller directory; the other ten are
// real git objects that resolve to no path in this repository -- sources from an off-repo Windows
// administrative working tree, which the predecessor reviewer could see and this one cannot. Its
// own source_set_semantics field says "current controller and exact candidate external sources",
// and that external half is not reconstructible from here.
//
// This reviewer therefore states its own rule and vouches only for what it actually reviewed:
// the blobs the root6 window migration introduced, all of which were verified byte for byte
// against the manifest in the first review round.
//
//   (a) the root6 ControllerSourceManifest blob, leading the set (its sha256 is the controller
//       digest), matching the predecessor's ordering;
//   (b) every REPOSITORY_SOURCE the manifest declares whose path is inside the root6 controller
//       directory, in manifest order;
//   (c) the new commitment-signing-root6-window/signing.mjs blob.
//
// Deduplicated by blob URI. No off-repo source is asserted, because none was reviewed.
// ---------------------------------------------------------------------------
function buildChangedSourceRefs() {
  const manifestRel = CTRL_REL + '/ControllerSourceManifest.candidate.json';
  const manifestBytes = read(manifestRel);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const refs = [], seen = new Set();
  const push = (bytes, declaredSha256, label) => {
    need(!declaredSha256 || sha(bytes) === declaredSha256, 'SOURCE_BYTES_DISAGREE_WITH_MANIFEST:' + label);
    const uri = blobUri(blobSha(bytes));
    if (seen.has(uri)) return;
    seen.add(uri);
    refs.push({ uri, sha256: sha(bytes) });
  };
  push(manifestBytes, null, manifestRel);
  let inDir = 0;
  for (const e of manifest.files) {
    if (e.role !== 'REPOSITORY_SOURCE') continue;
    if (!e.path.startsWith(CTRL_REL + '/')) continue;
    inDir++;
    push(read(e.path), e.sha256, e.path);
  }
  const signEntry = manifest.files.find(e => e.path === SIGN_REL);
  need(signEntry, 'NEW_SIGNING_MODULE_NOT_DECLARED_BY_MANIFEST');
  push(read(SIGN_REL), signEntry.sha256, SIGN_REL);
  need(sha(manifestBytes) === expectedGa.controller_digest, 'MANIFEST_IS_NOT_THE_ACCEPTED_CONTROLLER');
  return { refs, inDir };
}
const { refs: changedSourceRefs, inDir } = buildChangedSourceRefs();

// ---- timestamps: strictly increasing, per the ordering the controller forces ----
// Pinned, not read from the clock. The acceptance time is a recorded fact about when this reviewer
// accepted, so re-running must reproduce the issued bytes exactly; a clock read would give every
// run a different digest and there would be nothing stable to publish or reference.
const ACCEPTED_AT = '2026-09-12T01:31:02.664Z';
const acceptedAt = ACCEPTED_AT;
need(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(acceptedAt), 'ACCEPTED_AT_SHAPE');
need(Date.parse(acceptedAt) <= Date.now(), 'ACCEPTED_AT_IN_THE_FUTURE');
need(Date.parse(acceptedAt) >= Date.parse(approval.approved_at), 'ACCEPTED_AT_PRECEDES_APPROVAL');
need(Date.parse(acceptedAt) < Date.parse('2026-09-19T00:00:00Z'), 'ACCEPTED_AT_OUTSIDE_WINDOW');

// ---------------------------------------------------------------------------
// (2) the capacity applicability
// ---------------------------------------------------------------------------
const applicability = {
  state: 'ACCEPTED_EXACT_ROOT3_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT',
  independent_reviewer: REVIEWER,
  approval_ref: approvalRef,
  base_approval_ref: appendix.approval_ref,
  base_proposal_sha256: proposalSHA,
  capacity_proposal_ref: proposalRef,
  bounded_series_constraints: scope,
  capacity_delta: capacityDelta,
  baseline: capacityBaseline,
  scope_unchanged_except_original_input_limit: true,
  new_action_authorized: false,
  accepted_at: acceptedAt,
  controller_digest: expectedGa.controller_digest,
  scope_digest: expectedGa.scope_digest,
  previous_evidence_sink_ref: readJson(PRED_REL + '/Root5CurrentController4000000CapacityApplicability20260911.json').previous_evidence_sink_ref,
  evidence_sink_ref: expectedGa.evidence_sink_ref,
  changed_source_refs: changedSourceRefs,
  approved_change_index_ref: proposalRef,

  issuing_session: SESSION,
  succession_basis: SUCCESSION_MERGE,
  historical_conclusions_not_ratified: NOT_RATIFIED,

  source_set_semantics:
    'changed_source_refs carries the blobs the root6 window migration introduced and that this reviewer verified ' +
    'byte for byte against the controller manifest: the manifest itself, the ' + inDir + ' repository sources inside ' +
    CTRL_REL + ', and the new ' + SIGN_REL + '. Historical dependencies remain pinned in the controller manifest. ' +
    'This set is deliberately narrower in kind than the predecessor applicability, whose 20 entries include ten git ' +
    'objects that resolve to no path in this repository -- off-repo administrative sources the predecessor reviewer ' +
    'could see and this one cannot. Nothing unreviewed is asserted here.',
  what_is_accepted:
    'That capacity_delta.source_refs_maximum may be 133 rather than 131 for the root6 controller ' +
    expectedGa.controller_digest + ', on the Owner approval ' + approvalRef.sha256 + ' and the root6 capacity ' +
    'proposal ' + proposalRef.sha256 + ', both of which declare 133 and whose capacity_delta is byte-identical to the ' +
    "controller's own frozen constant. 133 is arithmetically exact: one manifest blob plus 144 declared repository " +
    'sources minus 12 duplicate-content blobs, by the same construction that gives the predecessor 131 from 142.',
  what_is_not_accepted: [
    'No GA, GRR, Entry, gate result, qualification pass or runtime admission.',
    'No extension of qualificationLimits.forwards from 15 to 16. That limit is a controller constant, sits in ' +
      'neither the root3 appendix scope nor capacity_delta, and no document backs it. It is outside this acceptance.',
    'No further cap extension, new trust root, new signing identity, paid or model budget, or production authority.',
    'No ratification of the implementing side\'s conclusions; each forced value here was taken from source and ' +
      'asserted against the controller comparison before issuance.',
  ],
  governing_exclusion_position:
    "The excluded clause of BoundedSeriesApplicability20260910 governs that appendix's own scope caps. " +
    'source_refs_maximum sits in capacity_delta, the supplemental layer, which the same mechanism has already raised ' +
    'three times (128, 130, 131), each under an Owner approval plus an independent applicability. Reading excluded to ' +
    'cover capacity_delta would retroactively void those three and the 4,000,000-byte original input limit this run ' +
    'depends on. That reductio is why this reviewer holds 131 to 133 to be the fourth ordinary use of an established ' +
    'route rather than a violation.',
  preconditions_outside_this_repository: [
    'The root6 GENERATION_REGISTERED body must carry not_before no later than ' + approval.approved_at +
      ', because context.mjs:44 requires registered.not_before <= approved_at and that body is immutable once written.',
    'That body must carry expires_at exactly 2026-09-19T00:00:00Z, clamped jointly by root-window-validation.mjs:31, ' +
      'context.mjs:44, budget-evidence.mjs:18 and context.mjs:179.',
    'Neither could be verified from repository contents: no such body exists here and this reviewer has no database ' +
      'access. If the registered body contradicts either, this acceptance does not apply and must not be consumed.',
  ],
  binding_requirement_for_the_runtime_acceptance:
    'The runtime acceptance must bind capacity_materials.approval to ' + approvalRef.sha256 + ' (the reissued v2), ' +
    'not to the superseded first approval d06494658f1c9ee90e83951ab7a4ff33306ac9ff978f2d3a200baf50f2a8b0d7, which ' +
    'remains on main and points at a proposal declaring 131. Both files exist; only this one is accepted.',
  publication_status: 'INDEPENDENTLY_REVIEWED_NOT_YET_OWNER_PUBLISHED',
  runtime_admission: false,
  authority_effect: 'NONE',
  supersedes: refOf(PRED_REL + '/Root5CurrentController4000000CapacityApplicability20260911.json'),
  supersedes_chain: [readJson(PRED_REL + '/Root5CurrentController4000000CapacityApplicability20260911.json').supersedes],
};

// ---- the controller's own comparisons, run before writing ----
need(applicability.state === 'ACCEPTED_EXACT_ROOT3_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT', 'STATE');
need(applicability.independent_reviewer === REVIEWER, 'REVIEWER_IDENTITY');
need(deepSame(applicability.base_approval_ref, appendix.approval_ref), 'BASE_APPROVAL_REF');
need(applicability.base_proposal_sha256 === proposalSHA, 'BASE_PROPOSAL_SHA');
need(deepSame(applicability.capacity_proposal_ref, approval.capacity_proposal_ref), 'CAPACITY_PROPOSAL_REF_MUST_EQUAL_APPROVALS');
need(deepSame(proposal.capacity_delta, capacityDelta), 'PROPOSAL_DELTA');
need(deepSame(approval.capacity_delta, capacityDelta), 'APPROVAL_DELTA');
need(deepSame(applicability.bounded_series_constraints, scope), 'SCOPE');
need(deepSame(applicability.capacity_delta, capacityDelta), 'DELTA');
need(deepSame(applicability.baseline, capacityBaseline), 'BASELINE');
need(applicability.scope_unchanged_except_original_input_limit === true, 'SCOPE_FLAG');
need(!Object.hasOwn(applicability, 'scope_unchanged'), 'FORBIDDEN_SCOPE_UNCHANGED_KEY');
need(applicability.new_action_authorized === false, 'NEW_ACTION');
need(/^[a-f0-9]{64}$/.test(applicability.controller_digest) && /^[a-f0-9]{64}$/.test(applicability.scope_digest), 'HEX_DIGESTS');
need(applicability.previous_evidence_sink_ref.sha256 === previousSinkSha, 'PREVIOUS_SINK');
need(deepSame(applicability.evidence_sink_ref, expectedGa.evidence_sink_ref), 'EVIDENCE_SINK');
need(expectedGa.artifact_refs.some(r => deepSame(r, applicability.evidence_sink_ref)), 'SINK_NOT_IN_ARTIFACT_REFS');
need(applicability.previous_evidence_sink_ref.sha256 !== applicability.evidence_sink_ref.sha256, 'SINK_NOT_A_SUCCESSOR');
need(expectedGa.source_ref.blobs.length <= 133, 'CLOSED_SOURCE_REF_MAXIMUM');
need(changedSourceRefs.length > 0, 'EMPTY_CHANGED_SOURCE_REFS');
need(new Set(changedSourceRefs.map(r => r.uri)).size === changedSourceRefs.length, 'DUPLICATE_CHANGED_SOURCE_URI');
for (const r of changedSourceRefs)
  need(Object.keys(r).sort().join() === 'sha256,uri' &&
    /^https:\/\/api\.github\.com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[a-f0-9]{40}$/.test(r.uri) &&
    /^[a-f0-9]{64}$/.test(r.sha256), 'CHANGED_SOURCE_REF_SHAPE');

const applicabilityRaw = JSON.stringify(applicability, null, 2) + '\n';
const canonicalOk = raw => {
  const value = JSON.parse(raw);
  let compact = '', quoted = false, escaped = false;
  for (const ch of raw) {
    if (quoted) { compact += ch; if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
    else if (ch === '"') { quoted = true; compact += ch; }
    else if (!' \t\r\n'.includes(ch)) compact += ch;
  }
  return compact === JSON.stringify(value);
};
need(canonicalOk(applicabilityRaw), 'APPLICABILITY_NOT_CANONICAL_ADMIN_JSON');

const APPLICABILITY_REL = OUT_REL + '/Root6CurrentController4000000CapacityApplicability20260912.json';
fs.writeFileSync(path.join(REPO, APPLICABILITY_REL), applicabilityRaw);
const applicabilityBytes = Buffer.from(applicabilityRaw, 'utf8');
const applicabilityRef = { uri: blobUri(blobSha(applicabilityBytes)), sha256: sha(applicabilityBytes) };

// ---------------------------------------------------------------------------
// (4) the 043 capacity repair acceptance, which must reference (2)
// ---------------------------------------------------------------------------
const predRepair = readJson(PRED_REL + '/Current043CapacityRepairApplicability20260911.json');
const capacityRepairState = /const capacityRepairState='([A-Z_]+)'/.exec(ctxSrc)?.[1];
need(capacityRepairState === 'ACCEPTED_EXACT_QUALIFICATION_REPAIR_WITH_APPROVED_CAPACITY_DELTA', 'REPAIR_STATE_SCRAPE');

const repair = {
  state: capacityRepairState,
  independent_reviewer: REVIEWER,
  failed_ga_id: capacityBaseline.failed_ga_id,
  failed_receipt_sha256: capacityBaseline.failed_receipt_sha256,
  identified_error_ref: predRepair.identified_error_ref,
  changed_source_refs: changedSourceRefs,
  scope_unchanged_except_original_input_limit: true,
  new_action_authorized: false,
  capacity_approval_ref: approvalRef,
  capacity_applicability_ref: applicabilityRef,
  controller_digest: expectedGa.controller_digest,
  scope_digest: expectedGa.scope_digest,
  accepted_at: acceptedAt,
  root_id: scope.root_id,
  root_generation: /root6Generation='(ctrgen_[a-f0-9]+)'/.exec(ctxSrc)?.[1],
  qualification_pass: false,

  issuing_session: SESSION,
  succession_basis: SUCCESSION_MERGE,
  historical_conclusions_not_ratified: NOT_RATIFIED,

  identified_error: predRepair.identified_error,
  root6_note:
    'The repair itself is unchanged: the historical ga043 administrative-JSON rejection and evidence capacity ' +
    'shortfall remain repaired by the same authenticated parser and V6 complete-input publisher. This successor ' +
    'exists only because isApprovedCapacityRepair compares controller_digest, capacity_approval_ref, ' +
    'capacity_applicability_ref and changed_source_refs against the live capacity administration, all four of which ' +
    'moved with the root6 migration. No new error is asserted and no previously signed byte is rewritten.',
  evidence_sink_ref: expectedGa.evidence_sink_ref,
  publication_status: 'INDEPENDENTLY_REVIEWED_NOT_YET_OWNER_PUBLISHED',
  authority_effect: 'NONE',
  supersedes: refOf(PRED_REL + '/Current043CapacityRepairApplicability20260911.json'),
  supersedes_chain: [predRepair.supersedes],
};

need(repair.root_generation === 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b', 'ROOT6_GENERATION_SCRAPE');
need(repair.failed_ga_id === predRepair.failed_ga_id && repair.failed_receipt_sha256 === predRepair.failed_receipt_sha256, 'REPAIR_SUBJECT_MOVED');
need(!Object.hasOwn(repair, 'scope_unchanged'), 'FORBIDDEN_SCOPE_UNCHANGED_KEY_ON_REPAIR');
need(deepSame(repair.changed_source_refs, applicability.changed_source_refs), 'REPAIR_AND_APPLICABILITY_DISAGREE');
need(deepSame(repair.capacity_approval_ref, applicability.approval_ref), 'REPAIR_APPROVAL_REF');
need(repair.capacity_applicability_ref.sha256 === applicabilityRef.sha256, 'REPAIR_APPLICABILITY_REF');
need(repair.controller_digest === applicability.controller_digest && repair.scope_digest === applicability.scope_digest, 'REPAIR_DIGESTS');

const repairRaw = JSON.stringify(repair, null, 2) + '\n';
need(canonicalOk(repairRaw), 'REPAIR_NOT_CANONICAL_ADMIN_JSON');
const REPAIR_REL = OUT_REL + '/Root6Current043CapacityRepairAcceptance20260912.json';
fs.writeFileSync(path.join(REPO, REPAIR_REL), repairRaw);
const repairBytes = Buffer.from(repairRaw, 'utf8');

console.log(JSON.stringify({
  issued_by: SESSION,
  succession_basis: SUCCESSION_MERGE,
  accepted_at: acceptedAt,
  approval_bound: { path: APPROVAL_REL, ...approvalRef, approved_at: approval.approved_at },
  proposal_bound: { ...proposalRef, source_refs_maximum: proposal.capacity_delta.source_refs_maximum },
  changed_source_refs: {
    total: changedSourceRefs.length,
    manifest: 1,
    controller_directory_sources: inDir,
    new_signing_module: 1,
  },
  documents: {
    applicability: { path: APPLICABILITY_REL, bytes: applicabilityBytes.length, ...applicabilityRef },
    repair: { path: REPAIR_REL, bytes: repairBytes.length, uri: blobUri(blobSha(repairBytes)), sha256: sha(repairBytes) },
  },
  note: 'Both documents carry acceptance state and were checked against every controller comparison before writing. ' +
        'Neither has authority until the Owner merges it and the reissued runtime acceptance binds it.',
}, null, 2));
