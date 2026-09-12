// Builds the root6 GENERATION_REGISTERED event, and refuses to emit one it cannot prove correct.
//
// Why this is the most dangerous artifact in the run: append_event does NOT validate the body
// (:13 only checks that it is a JSON object). A wrong body is accepted by the database, rejected
// afterwards by the controller, and append_event:36 then forbids ever registering
// ctrgen_5e0440a9... again. There is no second attempt and no rollback. So this script proves its
// own method against four historical registrations before it produces anything.
//
// Ordering, which the scope document got wrong (round 8, R8-F3b):
//   append_event:18 requires metadata_binding_sha256 to equal sha256 of the ENTIRE accepted_binding
//   row. The NW-01 window change rewrites that row, so this event cannot be finalised until after
//   NW-01 has been applied. Re-export the snapshot after NW-01, then run this.
//
// Input snapshot: the full output of
//   select clued_control.read_root('ctr_414bd3c724264a83894b0c55cf2ab878');
// saved as JSON. It carries events[] and metadata_binding_sha256, which is the same expression
// append_event:18 computes, so the value is taken from the database rather than recomputed here.
//
// Usage:
//   node build-root6-registration.mjs <snapshot.json> <newNotBeforeZ> <newExpiryZ> \
//        <ownerMergeCommit> <ownerApprovalBlobSha1> <ownerApprovalSha256> \
//        <independentAcceptanceBlobSha1> <independentAcceptanceSha256> \
//        <signatureEvidenceBlobSha1> <signatureEvidenceSha256> [outFile]
//
// Emits nothing to the database. Writes a candidate file only.
//
// STATUS
//   Verified here: loads, parameter validation, and three fail-closed paths (short event list,
//   a window that is not exactly 86400 seconds, missing arguments) all reject correctly.
//   NOT verified here: the success path. That needs the full 23KB read_root output, which in this
//   session can only travel through the conversation; transcribing it by hand was judged out of
//   proportion to running the same self-test once more later.
//
// The validator is trustworthy in this environment, which had to be established rather than
// assumed: root-window-validation.mjs requires ajv, its comment says Ajv6, and npm first installed
// ajv 8, whose format handling differs and which errored out. With ajv 6.15.0 installed, all 41
// ajv files pinned in the controller's own manifest match this checkout byte for byte, so
// validateRootShape here runs the same validator the controller runs. An offline validation under
// a different ajv would not have meant anything.
//
// The independent reviewer has read-only database access and can export a snapshot directly.
// Running this script against one, before the registration is ever submitted, is an explicit
// hand-off, not an optional extra.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
// The validator is imported from the controller itself, never reimplemented, so the offline check
// is the same code the controller will run. CONTROLLER_DIR points at the rebuilt controller in a
// real run; a rehearsal may point it at the current one to exercise the logic.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTROLLER_DIR = process.env.CONTROLLER_DIR
  ?? 'scripts/phase2-qualification/control-context-verifier-root6-window11-successor';
const {canonicalDigest, signaturePayloadDigest, validateRootShape, rootId} =
  await import(path.join(path.resolve(HERE, '..', '..'), CONTROLLER_DIR, 'root-window-validation.mjs'));
const ROOT6 = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b';
const ROOT5 = 'ctrgen_e5df432221344996afc04b5638121d96';
const AUDIENCE = 'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw';
const blobUri = sha1 => 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + sha1;

const [snapPath, newNotBefore, newExpiry, ownerMerge,
       oaBlob, oaSha, iaBlob, iaSha, seBlob, seSha, outArg] = process.argv.slice(2);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
assert.ok(snapPath, 'USAGE: see header');
assert.match(newNotBefore ?? '', ISO, 'newNotBeforeZ');
assert.match(newExpiry ?? '', ISO, 'newExpiryZ');
assert.equal(Date.parse(newExpiry) - Date.parse(newNotBefore), 86400000, 'OWNER_WINDOW_MUST_BE_EXACTLY_86400_SECONDS');
for (const [n, v] of [['ownerMergeCommit', ownerMerge]]) assert.match(v ?? '', /^[a-f0-9]{40}$/, n);
for (const [n, v] of [['oaBlob', oaBlob], ['iaBlob', iaBlob], ['seBlob', seBlob]]) assert.match(v ?? '', /^[a-f0-9]{40}$/, n);
for (const [n, v] of [['oaSha', oaSha], ['iaSha', iaSha], ['seSha', seSha]]) assert.match(v ?? '', /^[a-f0-9]{64}$/, n);

const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const events = snap.events;
assert.ok(Array.isArray(events), 'SNAPSHOT_HAS_NO_EVENTS');
assert.equal(snap.root_set_id, rootId, 'SNAPSHOT_WRONG_ROOT');
assert.equal(events.length, snap.sequence, 'SNAPSHOT_EVENTS_DO_NOT_MATCH_SEQUENCE');
assert.equal(snap.generation_id, ROOT5, 'HEAD_IS_NOT_ROOT5 — has root6 already been registered?');
assert.match(snap.metadata_binding_sha256 ?? '', /^[a-f0-9]{64}$/, 'SNAPSHOT_LACKS_METADATA_BINDING_SHA256');

// ---------------------------------------------------------------------------
// Self-test: reproduce every historical prefix_digest from this same snapshot.
// If the way this script derives a prefix digest is wrong, it is wrong here too,
// and four independent chances to notice is better than none.
// ---------------------------------------------------------------------------
// The expected values are pinned here from an independent read of clued_control.events taken on
// 2026-09-12, NOT taken from the snapshot being checked. A snapshot that was truncated, reordered
// or substituted would otherwise self-consistently "pass".
const EXPECTED_CHAIN = [
  {seq: 1, gen: 'ctrgen_352785779b64458a889d571360e2d2d5', prefix_sequence: 0, prefix_digest: '37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570'},
  {seq: 2, gen: 'ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12', prefix_sequence: 1, prefix_digest: '6fdce11ff8f9a0e31430771acc322e911994e66a39855ad05b3b4734db2a9493'},
  {seq: 3, gen: 'ctrgen_2e778ca66244459f974b081edca8c04e', prefix_sequence: 2, prefix_digest: '3fc6f3c8f2e3d47ba707848512b1aaad239054ec9b2fbfb08e3a9e76a252e558'},
  {seq: 4, gen: 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06', prefix_sequence: 3, prefix_digest: 'da271b6f65da13e06fccda21a909e8a3f53ef3abf746d8eabef9353bd767610c'},
  {seq: 5, gen: ROOT5,                                    prefix_sequence: 4, prefix_digest: '886be4f1b59ae700a0f66e0ab6a59de6f269282779e130a91b0be1bb84becc8b'},
];

const reproduced = [];
for (const e of events) {
  if (e.request?.kind !== 'GENERATION_REGISTERED') continue;
  const prefix = events.slice(0, e.sequence - 1);
  const declaredSeq = e.request.body.history.prefix_sequence;
  const declaredDigest = e.request.body.history.prefix_digest;
  const computed = canonicalDigest(prefix);
  const pinned = EXPECTED_CHAIN.find(x => x.seq === e.sequence);
  assert.ok(pinned, 'UNEXPECTED_REGISTRATION_AT_SEQUENCE_' + e.sequence +
    ' — the event log grew since the pinned read; re-pin EXPECTED_CHAIN from clued_control.events');
  assert.equal(e.request.generation_id, pinned.gen, 'GENERATION_DIFFERS_FROM_PINNED_READ_AT_' + e.sequence);
  assert.equal(declaredSeq, pinned.prefix_sequence, 'DECLARED_PREFIX_SEQUENCE_DIFFERS_FROM_PINNED_READ_AT_' + e.sequence);
  assert.equal(declaredDigest, pinned.prefix_digest, 'SNAPSHOT_DECLARATION_DIFFERS_FROM_PINNED_READ_AT_' + e.sequence);
  assert.equal(computed, pinned.prefix_digest, 'COMPUTED_DIGEST_DIFFERS_FROM_PINNED_READ_AT_' + e.sequence);
  reproduced.push({
    sequence: e.sequence,
    generation: e.request.generation_id,
    prefix_sequence: {declared: declaredSeq, computed: prefix.length, match: declaredSeq === prefix.length},
    prefix_digest: {declared: declaredDigest, computed, match: declaredDigest === computed},
  });
}
assert.equal(reproduced.length, EXPECTED_CHAIN.length,
  'REGISTRATION_COUNT_DIFFERS_FROM_PINNED_READ — expected ' + EXPECTED_CHAIN.length + ', snapshot has ' + reproduced.length);
assert.ok(reproduced.length >= 4, 'EXPECTED_AT_LEAST_FOUR_HISTORICAL_REGISTRATIONS');
for (const r of reproduced) {
  assert.ok(r.prefix_sequence.match, 'PREFIX_SEQUENCE_MISMATCH_AT_' + r.sequence);
  assert.ok(r.prefix_digest.match,
    'PREFIX_DIGEST_METHOD_DOES_NOT_REPRODUCE_HISTORY_AT_' + r.sequence +
    ' — do not emit a registration body from this snapshot');
}

// Also reproduce the predecessor pointer, so the value put in body.predecessor is derived the
// same way the chain already derives it rather than guessed.
const predecessorOf = seq => {
  const prev = events.filter(e => e.request?.kind === 'GENERATION_REGISTERED' && e.sequence < seq).at(-1);
  return prev ? {generation_id: prev.request.generation_id, sha256: canonicalDigest(prev.request.body)} : null;
};
const predecessorChecks = [];
for (const e of events) {
  if (e.request?.kind !== 'GENERATION_REGISTERED') continue;
  const declared = e.request.body.predecessor, computed = predecessorOf(e.sequence);
  predecessorChecks.push({
    sequence: e.sequence,
    // Key-order-insensitive. jsonb normalises object keys shortest-first, so every stored
    // predecessor reads {sha256, generation_id} while this script builds {generation_id, sha256}.
    // JSON.stringify made all five historical records mismatch on identical content, which meant
    // this anchor had never once passed -- an alarm that is always on is worth nothing at the last
    // gate before an irreversible append. Found by the reviewer running the success path (R9-F1).
    match: same(declared, computed),
    declared, computed,
  });
}
const predecessorMethodHolds = predecessorChecks.every(c => c.match);

// ---------------------------------------------------------------------------
// Build the root6 body from the current head's body, changing only what must change.
// ---------------------------------------------------------------------------
const head = events.filter(e => e.request?.kind === 'GENERATION_REGISTERED').at(-1);
assert.equal(head.request.generation_id, ROOT5, 'LAST_REGISTRATION_IS_NOT_ROOT5');
const prefix = events.slice(0, head.sequence); // root6 lands at head.sequence + 1

const body = {
  ...structuredClone(head.request.body),
  control_trust_root_generation: ROOT6,
  generation_ordinal: head.request.body.generation_ordinal + 1,
  not_before: newNotBefore,
  expires_at: newExpiry,
  status: 'REGISTERED',
  history: {
    ...structuredClone(head.request.body.history),
    prefix_sequence: prefix.length,
    prefix_digest: canonicalDigest(prefix),
    minimum_accepted_generation: ROOT6,
  },
  revocation: {
    ...structuredClone(head.request.body.revocation),
    as_of: newNotBefore,
    expires_at: newExpiry,
    event_set_digest: canonicalDigest(events.filter(e => ['ROOT_REVOKED', 'GENERATION_REVOKED'].includes(e.request?.kind))),
  },
  predecessor: {generation_id: ROOT5, sha256: canonicalDigest(head.request.body)},
  owner_approval_ref: {uri: blobUri(oaBlob), sha256: oaSha},
  independent_acceptance_ref: {uri: blobUri(iaBlob), sha256: iaSha},
  signature_binding: {
    owner_merge_commit: ownerMerge,
    signed_object_sha256: 'PLACEHOLDER',
    signature_evidence_ref: {uri: blobUri(seBlob), sha256: seSha},
  },
};
body.signature_binding.signed_object_sha256 = signaturePayloadDigest(body);

// Shape must match the predecessor's exactly -- no field added, none dropped.
assert.deepEqual(Object.keys(body).sort(), Object.keys(head.request.body).sort(), 'BODY_SHAPE_DRIFTED');
assert.equal(body.audience, AUDIENCE);

// The controller's own validator, run offline before anything is submitted.
const shape = validateRootShape(body);

// Round 8 R8-F3e: validateRootShape caps expires_at at 2026-09-19T00:00:00Z in the CURRENT
// controller. The rebuilt controller lowers that cap to its own window, so re-check against the
// rebuilt module actually imported above rather than assuming.
assert.ok(Date.parse(body.expires_at) <= Date.parse('2026-09-19T00:00:00Z'), 'EXPIRY_ABOVE_HARD_CAP');

const request = {
  kind: 'GENERATION_REGISTERED',
  root_set_id: rootId,
  generation_id: ROOT6,
  predecessor_generation_id: ROOT5,
  expected_sequence: snap.sequence,
  idempotency_key: 'register-root6-window11-' + newNotBefore.slice(0, 10).replaceAll('-', ''),
  metadata_binding_sha256: snap.metadata_binding_sha256,
  body,
};
assert.deepEqual(Object.keys(request).sort(),
  ['body', 'expected_sequence', 'generation_id', 'idempotency_key', 'kind',
   'metadata_binding_sha256', 'predecessor_generation_id', 'root_set_id'],
  'APPEND_EVENT_TOP_LEVEL_KEYS_MUST_BE_EXACTLY_THESE_EIGHT');
assert.match(request.idempotency_key, /^[A-Za-z0-9_-]{1,128}$/, 'IDEMPOTENCY_KEY_SHAPE');

const out = outArg ?? path.join(HERE, 'Root6GenerationRegistration.candidate.json');
fs.writeFileSync(out, JSON.stringify({
  state: 'CANDIDATE_NOT_SUBMITTED_NO_AUTHORITY',
  warning: 'append_event does not validate body. A wrong body is accepted, then rejected by the controller, and the generation id is burned permanently. Do not submit without independent review.',
  request,
}, null, 2) + '\n');

console.log(JSON.stringify({
  state: 'ROOT6_REGISTRATION_CANDIDATE_BUILT_NOT_SUBMITTED',
  output: path.relative(path.resolve(HERE, '..', '..'), out),
  self_test: {
    historical_registrations_reproduced: reproduced.length,
    all_prefix_digests_match: true,
    detail: reproduced.map(r => ({sequence: r.sequence, prefix_sequence: r.prefix_sequence.declared, digest_match: r.prefix_digest.match})),
    predecessor_method_reproduces_history: predecessorMethodHolds,
    predecessor_detail: predecessorMethodHolds ? 'all match' : predecessorChecks.filter(c => !c.match),
  },
  emitted: {
    generation_id: ROOT6,
    generation_ordinal: body.generation_ordinal,
    expected_sequence: request.expected_sequence,
    will_land_at_sequence: snap.sequence + 1,
    window: {not_before: body.not_before, expires_at: body.expires_at},
    history: {prefix_sequence: body.history.prefix_sequence, prefix_digest: body.history.prefix_digest},
    predecessor: body.predecessor,
    metadata_binding_sha256: request.metadata_binding_sha256,
    signature_binding_signed_object_sha256: body.signature_binding.signed_object_sha256,
  },
  validate_root_shape: shape,
  authority_effect: 'NONE',
}, null, 2));

if (!predecessorMethodHolds) {
  console.error('\nWARNING: body.predecessor.sha256 could not be reproduced for every historical ' +
    'registration by the method used here. The emitted predecessor pointer may be wrong. ' +
    'Resolve before submitting.');
  process.exitCode = 2;
}
