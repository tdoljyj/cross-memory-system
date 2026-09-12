// Emits a CANDIDATE capacity approval for the Owner to complete and sign.
//
// This is a form, not a signature. The fields the controller forces byte-exactly are taken
// straight from the controller's own frozen constants, so they cannot drift from what will be
// checked. The fields that are the Owner's actual decision are left as explicit placeholders and
// the script refuses to fill them.
//
// Nothing here approves anything. The document becomes an approval only when the Owner completes
// it and merges it through the owner-merge signature chain.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CTX = path.join(REPO, 'scripts/phase2-qualification/control-context-verifier-root6-window10-successor/context.mjs');
const PRED_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v16-source-completeness/Root5OriginalInput4000000CapacityApproval20260911.json';
const OUT_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/CapacityApprovalCandidate.json';

const sha = x => crypto.createHash('sha256').update(x).digest('hex');

// same() in the controller is canonicalDigest-based, which sorts keys recursively, so field order
// does not matter -- only values do.
const canonical = v => {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw Error('unsafe number');
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
const canonicalDigest = v => sha(canonical(v) + '\n');

// Pull the frozen constants out of the controller rather than retyping them. Retyping is exactly
// how a byte-exact comparison gets broken.
const src = fs.readFileSync(CTX, 'utf8');
const frozen = name => {
  const m = new RegExp('const ' + name + '=Object\\.freeze\\((\\{.*?\\})\\);', 's').exec(src);
  if (!m) throw Error('CONSTANT_NOT_FOUND_IN_CONTROLLER:' + name);
  return (0, eval)('(' + m[1] + ')');
};
const capacityDelta = frozen('capacityDelta');
const capacityBaseline = frozen('capacityBaseline');
const scope = frozen('scope');

if (capacityDelta.source_refs_maximum !== 133)
  throw Error('CONTROLLER_DOES_NOT_DECLARE_133:' + capacityDelta.source_refs_maximum);

// Fields the predecessor supplies unchanged. These are pins into history, not new decisions.
const pred = JSON.parse(fs.readFileSync(path.join(REPO, PRED_REL), 'utf8'));
const inherited = {
  base_proposal_sha256: pred.base_proposal_sha256,
  base_approval_ref: pred.base_approval_ref,
  capacity_proposal_ref: pred.capacity_proposal_ref,
  approved_change_index_sha256: pred.approved_change_index_sha256,
};

const OWNER_TODO = '<<OWNER_MUST_COMPLETE>>';

const candidate = {
  state: 'APPROVED_EXACT_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT',
  base_proposal_sha256: inherited.base_proposal_sha256,
  base_approval_ref: inherited.base_approval_ref,
  bounded_series_constraints: scope,
  capacity_delta: capacityDelta,
  baseline: capacityBaseline,
  capacity_proposal_ref: inherited.capacity_proposal_ref,
  approved_change_index_sha256: inherited.approved_change_index_sha256,

  // ---- the Owner's actual decision starts here ----
  approved_at: OWNER_TODO,
  authority: OWNER_TODO,
  approval_text: OWNER_TODO,
  source: OWNER_TODO,
  limitations: pred.limitations,

  candidate_status: 'CANDIDATE_NOT_AN_APPROVAL_UNTIL_OWNER_COMPLETES_AND_MERGES',
  what_changed_from_predecessor: {
    field: 'capacity_delta.source_refs_maximum',
    from: 131,
    to: 133,
    why: 'The root6 controller declares 133 ordered source references: 131 plus the two files added ' +
         'to avoid editing a signing module that 64 other artifacts pin by hash.',
    conflicts_with: 'BoundedSeriesApplicability20260910.excluded, which reads verbatim "... new root or ' +
                    'identity, cap extension, automatic retry, refund." Raising a cap is a cap extension.',
    independently_reviewed: false,
    note: 'Every other field of capacity_delta is identical to the predecessor.',
  },
  authority_effect: 'NONE_UNTIL_OWNER_MERGE',
};

// Prove the three forced structures match what the controller will compare against.
const checks = {
  capacity_delta_matches_controller: canonicalDigest(candidate.capacity_delta) === canonicalDigest(capacityDelta),
  baseline_matches_controller: canonicalDigest(candidate.baseline) === canonicalDigest(capacityBaseline),
  bounded_series_constraints_matches_scope: canonicalDigest(candidate.bounded_series_constraints) === canonicalDigest(scope),
  state_string_exact: candidate.state === 'APPROVED_EXACT_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT',
  source_refs_maximum: candidate.capacity_delta.source_refs_maximum,
  predecessor_source_refs_maximum: pred.capacity_delta.source_refs_maximum,
  fields_differing_from_predecessor_capacity_delta: Object.keys(capacityDelta)
    .filter(k => JSON.stringify(capacityDelta[k]) !== JSON.stringify(pred.capacity_delta[k])),
};
if (!checks.capacity_delta_matches_controller || !checks.baseline_matches_controller ||
    !checks.bounded_series_constraints_matches_scope) throw Error('FORCED_FIELD_MISMATCH');

fs.mkdirSync(path.dirname(path.join(REPO, OUT_REL)), { recursive: true });
const raw = JSON.stringify(candidate, null, 2) + '\n';
fs.writeFileSync(path.join(REPO, OUT_REL), raw);

console.log(JSON.stringify({
  output: OUT_REL,
  bytes: raw.length,
  owner_must_complete: Object.entries(candidate).filter(([, v]) => v === OWNER_TODO).map(([k]) => k),
  checks,
}, null, 2));
