#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const nested = path.join(HERE, 'payload', 'work', 'recovery-root9', 'stage2c');
const OUT = fs.existsSync(path.join(HERE, 'RESULT.json')) ? HERE : nested;
const possibleRepoRoot = OUT === HERE ? path.resolve(HERE, '../../..') : null;
const publishedRepoPresent = possibleRepoRoot && fs.existsSync(path.join(possibleRepoRoot, 'work', 'recovery-root9', 'stage2b'));
const scratchRoot = OUT === HERE
  ? path.join(path.resolve(HERE, '../../../../../..'), 'repair-root9')
  : path.resolve(HERE, '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const blobSha = (bytes) => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const canonical = (v) => Array.isArray(v)
  ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v);
const digest = (v) => sha256(Buffer.from(`${canonical(v)}\n`));
const read = (name) => fs.readFileSync(path.join(OUT, name));
const parse = (name) => JSON.parse(read(name));
const gitRef = (bytes) => ({
  uri: `https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/${blobSha(bytes)}`,
  sha256: sha256(bytes)
});
const exact = (name, expected) => assert.equal(sha256(read(name)), expected, `SHA256:${name}`);

exact('Stage2BPublicationEvidence.verified.json', '7bf41dbb104586cddd67933a90cc1676f09c156e8b1689ba314af541e48fffc3');
exact('Status26SignatureEvidence.json', '64f4f97a9b1bfd8f2d668dcd3dad77cec86ab96e1855b5c09c465e028bb77e1b');
exact('Status26Generation.json', '8e02293caa447a5c2fe1749d89c082fe2e1e937180c937d746512d9b7e32b6a3');
exact('SuccessorBinding.root9.json', 'd3c597a2425343bb6fb897e4a6eaddd76cb73adf282a8cd07187e23a527cd76e');

const publication = parse('Stage2BPublicationEvidence.verified.json');
const signature = parse('Status26SignatureEvidence.json');
const status = parse('Status26Generation.json');
const successor = parse('SuccessorBinding.root9.json');
const pins = parse('M3ArtifactPins.json');
const graph = parse('dependency-graph.json');
const contract = parse('final-contract.json');
const result = parse('RESULT.json');

assert.equal(publication.state, 'VERIFIED_STAGE2B_OWNER_MERGE');
assert.equal(publication.merge.sha, '9398c6cb8db84b802facebf683c134fb1ba4ad5d');
assert.equal(publication.merge.tree, 'd553a78484d8f9c452dc6551a8b8cb88bf65869d');
assert.deepEqual(publication.merge.parents, [
  '0ae9f5f29cc97982ef30f36fd8efbd67c521e5fd',
  '8c87fc1213d8cc2c8f60508fb303af7460e44d2f'
]);
assert.equal(publication.merge.author_login, 'tdoljyj');
assert.equal(publication.merge.merged_by, 'tdoljyj');
assert.equal(publication.merge.committer_login, 'web-flow');
assert.equal(publication.merge.base_ref, 'main');
assert.equal(publication.merge.pull_request_count, 1);
assert.equal(publication.merge.verification.verified, true);
assert.equal(publication.merge.verification.reason, 'valid');

assert.equal(signature.merge.sha, publication.merge.sha);
assert.equal(signature.payload.blob_sha, '82ae28e4dde3947bb7ef087c304dadedb3e5c15a');
assert.equal(signature.payload.file_sha256, '101d72576f405b859582fdac34c735edf2cc46a11b306955cdbdb2f9718f28db');
assert.equal(signature.payload.signed_object_sha256, 'd0c0126ae12d710e531e6ceea07c9ff4636d1f69ca85b6a91a49cd75021bccd8');
assert.deepEqual(status.signature_binding.signature_evidence_ref, gitRef(read('Status26SignatureEvidence.json')));
assert.equal(status.signature_binding.owner_merge_commit, publication.merge.sha);
const unsignedStatus = structuredClone(status);
delete unsignedStatus.signature_binding;
assert.equal(digest(unsignedStatus), 'd0c0126ae12d710e531e6ceea07c9ff4636d1f69ca85b6a91a49cd75021bccd8');
assert.equal(status.signature_binding.signed_object_sha256, digest(unsignedStatus));
assert.equal(status.generation, 26);
assert.equal(status.control_trust_root_generation, 'ctrgen_308a1dfc185cff633892638581e0a34c');
assert.equal(status.expires_at, '2026-09-15T03:00:00Z');

assert.equal(Object.keys(successor).length, 15);
assert.equal(successor.root_id, 'ctr_414bd3c724264a83894b0c55cf2ab878');
assert.equal(successor.predecessor_generation_id, 'ctrgen_b060bc520329398936e461af6a477f94');
assert.equal(successor.generation_id, 'ctrgen_308a1dfc185cff633892638581e0a34c');
assert.equal(successor.budget_sequence_floor, 98);
assert.equal(successor.controller_sha256, 'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b');
assert.equal(successor.qualification_sha256, '171828b556756186ed30b88928855fb8e6607f799911bf63214e9505fa984c71');
assert.equal(successor.status_schema_sha256, '6f9a6799109cbad00b4e615b58f535f91fe0ec4a53790fa744000caa2bf3282e');
assert.equal(successor.expires_at, '2026-09-15T03:00:00Z');

assert.equal(pins.owner_merge.commit, publication.merge.sha);
assert.equal(pins.artifacts.root9_generation.sha256, '956975e5131aaf858dc06bc7923e0186416740d82db64363af6103e7f69f94e1');
assert.equal(pins.artifacts.runtime_acceptance.sha256, '107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9');
assert.equal(pins.artifacts.build_ga.sha256, 'df4171ad2d71c2ed975fe65a7f63b3dbb1acf3918e25fb6882a96399853d8953');
assert.equal(pins.invariants.controller_entry_count, 22);
assert.equal(pins.invariants.status_generation, 26);
assert.equal(pins.invariants.runtime_acceptance_repair_refs, 8);
assert.equal(pins.invariants.future_m4_sha_embedded, false);

const locatePublished = (published, local) => {
  if (publishedRepoPresent) {
    const candidate = path.join(possibleRepoRoot, published);
    if (fs.existsSync(candidate)) return candidate;
  }
  const fallback = path.join(scratchRoot, local);
  assert.equal(fs.existsSync(fallback), true, `MISSING_PUBLISHED_SOURCE:${published}`);
  return fallback;
};
const root9Path = locatePublished('work/recovery-root9/stage2b/Root9Generation.json', 'stage2b-pr/payload/work/recovery-root9/stage2b/Root9Generation.json');
const acceptancePath = locatePublished('work/recovery-root9/stage2b/RuntimeAcceptance.root9.json', 'stage2b-pr/payload/work/recovery-root9/stage2b/RuntimeAcceptance.root9.json');
const buildGaPath = locatePublished('work/ga-readiness/build-ga.mjs', 'stage2b-pr/payload/work/ga-readiness/build-ga.mjs');
const qualificationPath = locatePublished('work/recovery-root9/stage2a/ControllerQualification.root9.candidate.json', 'stage2a-pr/payload/work/recovery-root9/stage2a/ControllerQualification.root9.candidate.json');
for (const [file, want, wantBlob] of [
  [root9Path, pins.artifacts.root9_generation.sha256, pins.artifacts.root9_generation.blob_sha],
  [acceptancePath, pins.artifacts.runtime_acceptance.sha256, pins.artifacts.runtime_acceptance.blob_sha],
  [buildGaPath, pins.artifacts.build_ga.sha256, pins.artifacts.build_ga.blob_sha],
  [qualificationPath, pins.artifacts.controller_qualification.sha256, pins.artifacts.controller_qualification.blob_sha]
]) {
  const bytes = fs.readFileSync(file);
  assert.equal(sha256(bytes), want);
  assert.equal(blobSha(bytes), wantBlob);
}
const acceptance = JSON.parse(fs.readFileSync(acceptancePath));
assert.equal(acceptance.acceptance_issued, false);
assert.equal(acceptance.signature_verified, false);
assert.equal(acceptance.accepted_subject.bounded_series_materials.repairs.length, 8);
assert.equal(Object.hasOwn(acceptance.accepted_subject.expected_ga, 'repair_refs'), false);
assert.equal(acceptance.root9_binding.root_authority_ref.sha256, pins.artifacts.root9_generation.canonical_sha256);

assert.equal(graph.object_type, 'Stage2COperationalDependencyGraph');
assert.equal(graph.future_m4.commit, null);
assert.equal(graph.cycle_check.m4_evidence_is_external_and_post_merge, true);
assert.equal(contract.state, 'PREPUBLICATION_ONLY_NOT_APPLY_AUTHORITY');
assert.equal(contract.live_preimage.root_sequence, 8);
assert.equal(contract.live_preimage.execution_sequence, 97);
assert.equal(contract.fixed.root9_sequence, 9);
assert.equal(contract.fixed.post_execution_sequence, 101);
assert.equal(contract.forbidden.sequence_102_creation, true);
assert.equal(contract.future_m4.commit, null);
assert.equal(contract.future_m4.tree, null);
assert.equal(result.authority_effect, 'NONE');
assert.equal(result.database_writes, 0);
assert.equal(result.budget_reservations, 0);
assert.equal(result.capacity_value_change, false);
assert.equal(result.refund, false);
assert.equal(result.ga_dispatches, 0);

const allText = fs.readdirSync(OUT, { recursive: true })
  .filter((name) => fs.statSync(path.join(OUT, name)).isFile() && name !== 'verify-stage2c-payload.mjs')
  .map((name) => fs.readFileSync(path.join(OUT, name), 'utf8'))
  .join('\n');
assert.equal(allText.includes('__PENDING_'), false);
assert.equal(/\b[0-9a-f]{40}\b/.test(JSON.stringify({commit:contract.future_m4.commit,tree:contract.future_m4.tree,source_parent:contract.future_m4.source_parent})), false);

if (fs.existsSync(path.join(OUT, 'CORE_SHA256SUMS.txt'))) {
  const lines = read('CORE_SHA256SUMS.txt').toString().trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const [want, repoPath] = line.split(/\s{2}/);
    const rel = repoPath.replace(/^work\/recovery-root9\/stage2c\//, '');
    assert.equal(sha256(read(rel)), want, `CORE_SHA256:${repoPath}`);
  }
}
if (fs.existsSync(path.join(OUT, 'PACKAGE_SHA256SUMS.txt'))) {
  const lines = read('PACKAGE_SHA256SUMS.txt').toString().trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const [want, repoPath] = line.split(/\s{2}/);
    const rel = repoPath.replace(/^work\/recovery-root9\/stage2c\//, '');
    assert.equal(sha256(read(rel)), want, `PACKAGE_SHA256:${repoPath}`);
  }
}

console.log(JSON.stringify({
  state: 'STAGE2C_PREPUBLICATION_VERIFY_PASS',
  m3: publication.merge.sha,
  status_generation: status.generation,
  status_S: digest(unsignedStatus),
  successor_binding_sha256: sha256(read('SuccessorBinding.root9.json')),
  controller_entry_count: 22,
  repair_refs: 8,
  m4_sha_late_bound: true,
  database_writes: 0,
  budget_reservations: 0,
  capacity_value_change: false,
  refund: false,
  ga_dispatches: 0,
  authority_effect: 'NONE'
}, null, 2));
