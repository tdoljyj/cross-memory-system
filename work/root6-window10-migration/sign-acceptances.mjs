// Signs the two prepared root6 acceptance documents: sets the ACCEPTED_* state and stamps
// accepted_at at the real moment of signing.
//
// This is deliberately a separate step from generation. The documents were produced PREPARED with
// no accepted_at precisely so that nothing timestamped a review before the review happened. The
// review has now happened -- five rounds of it -- so this stamps the moment it concluded, not the
// moment the bytes were generated.
//
// The state strings are EXTRACTED FROM THE CONTROLLER, not typed. The successor reviewer's last
// finding was that deriving them from the PREPARED names would append a _ROOT6 suffix the
// controller never accepts, failing at context.mjs:71, :166 and :208. Extraction makes that class
// of error impossible rather than merely avoided.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const V17_REL = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v17';
const CTX = path.join(REPO, 'scripts/phase2-qualification/control-context-verifier-root6-window10-successor/context.mjs');

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const blobSha = b => crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
const src = fs.readFileSync(CTX, 'utf8');

// Pull each required state string out of the check that enforces it. If the controller ever states
// it differently, or states it in more than one way, this stops rather than guessing.
function requiredState(reasonPattern) {
  const found = [...src.matchAll(new RegExp("state===('([A-Z_]+)')", 'g'))].map(m => m[2]);
  const uniq = [...new Set(found.filter(reasonPattern))];
  if (uniq.length !== 1) throw Error('AMBIGUOUS_OR_ABSENT_REQUIRED_STATE:' + JSON.stringify(uniq));
  return uniq[0];
}
const RUNTIME_STATE = requiredState(s => s.startsWith('ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME'));
const QUALIFICATION_STATE = requiredState(s => s.startsWith('ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION'));

// The signing moment. Must sit inside the root6 window and at or after the independent
// applicability's acceptance, which is the last thing that had to happen before this.
const APPLICABILITY_ACCEPTED_AT = '2026-09-12T01:31:02.664Z';
const WINDOW_START = '2026-09-12T00:00:00Z';
const WINDOW_END = '2026-09-19T00:00:00Z';
const now = new Date();
const ACCEPTED_AT = now.toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
if (!(ACCEPTED_AT >= WINDOW_START && ACCEPTED_AT < WINDOW_END)) throw Error('SIGNING_OUTSIDE_WINDOW:' + ACCEPTED_AT);
if (!(ACCEPTED_AT >= APPLICABILITY_ACCEPTED_AT)) throw Error('SIGNING_BEFORE_INDEPENDENT_ACCEPTANCE:' + ACCEPTED_AT);

const REVIEW = {
  concluded_rounds: 5,
  independent_reviewer_session: 'session_018nf6mQ5CQuMFadoJ9WRZCN',
  succession_decision_merge: 'a573ca93e094bc9a4a8dccc23c1e165b6b368ff4',
  what_the_reviewer_did_not_endorse: [
    'qualificationLimits.forwards 15 to 16, a controller constant outside capacity_delta with no ' +
    'backing document. Recorded in OwnerForwardCapExtensionOverride.json and in this document under ' +
    'forward_cap_not_covered_by_independent_review.',
  ],
  what_the_reviewer_could_not_verify: [
    'The root6 registration body preconditions: not_before no later than 2026-09-12T00:54:15.197Z ' +
    'and expires_at exactly 2026-09-19T00:00:00Z. It has no database access and stated the ' +
    'applicability does not apply if these conflict.',
    'The GitHub API side of verifyOwnerMergeArtifact -- committer, signature and PR merged_by. It ' +
    'confirmed all twelve publication descriptors are two-parent merges from the object store only.',
    'Live control-plane state.',
  ],
};

const out = {};
for (const [file, state] of [
  ['ScopedRoot5FinalControllerQualification.json', QUALIFICATION_STATE],
  ['ExactRoot5FinalPreentryControllerRuntimeAcceptance.json', RUNTIME_STATE],
]) {
  const p = path.join(REPO, V17_REL, file);
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));

  if (!/^PREPARED_/.test(doc.state)) throw Error('NOT_IN_PREPARED_STATE:' + file + ':' + doc.state);
  if (doc.acceptance_issued !== false) throw Error('ALREADY_ISSUED:' + file);
  if (Object.hasOwn(doc, 'accepted_at')) throw Error('ACCEPTED_AT_ALREADY_PRESENT:' + file);
  // The reviewer identity the controller requires here is '/root', not the capacity reviewer.
  // Carried from v16 unchanged; asserted rather than assumed.
  if (doc.independent_reviewer !== '/root') throw Error('UNEXPECTED_REVIEWER:' + file + ':' + doc.independent_reviewer);

  const prepared = doc.state;
  doc.state = state;
  doc.accepted_at = ACCEPTED_AT;
  doc.acceptance_issued = true;
  doc.acceptance_record = {
    prepared_state: prepared,
    signed_at: ACCEPTED_AT,
    state_string_source: 'Extracted from the controller check that enforces it, not transcribed. ' +
      'Deriving it from the prepared name would have produced a _ROOT6 suffix the controller rejects.',
    independent_review: REVIEW,
  };

  const raw = JSON.stringify(doc, null, 2) + '\n';
  fs.writeFileSync(p, raw);
  out[file] = { state: doc.state, accepted_at: ACCEPTED_AT, bytes: raw.length, sha256: sha(raw), blob_sha: blobSha(Buffer.from(raw)) };
}

console.log(JSON.stringify({
  required_states_extracted_from_controller: { qualification: QUALIFICATION_STATE, runtime: RUNTIME_STATE },
  signed_at: ACCEPTED_AT,
  ordering: {
    window_start: WINDOW_START,
    approval_approved_at: '2026-09-12T00:54:15.197Z',
    applicability_accepted_at: APPLICABILITY_ACCEPTED_AT,
    acceptance_signed_at: ACCEPTED_AT,
    window_end: WINDOW_END,
    strictly_increasing: true,
  },
  documents: out,
}, null, 2));
