// Checks the two reviewer-issued documents against the controller.
//
// It does NOT reimplement the checks and it does not import the generator. It lifts the actual
// need(...) expressions out of context.mjs by their reason strings and evaluates them verbatim,
// with the same helpers the controller defines, against the emitted bytes. A paraphrase of a
// byte-exact comparison is not a check of it.
//
// Every positive assertion is paired with a negative one: perturb the field, the same lifted
// expression must reject it. A guard that has never been seen to fail has not been tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CTRL = 'scripts/phase2-qualification/control-context-verifier-root6-window10-successor';
const OUT = 'artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity';
const V17 = 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v17';

const read = rel => fs.readFileSync(path.join(repo, rel));
const readJson = rel => JSON.parse(read(rel).toString('utf8'));
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const blobSha = b => crypto.createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');

const src = read(CTRL + '/context.mjs').toString('utf8');

// ---- lift a need(...) / check(...) expression out of the controller by its reason string ----
function liftCondition(reason) {
  const marker = "'" + reason + "'";
  const end = src.indexOf(marker);
  assert.ok(end > 0, 'reason string not found in controller: ' + reason);
  // walk back from the marker to the opening paren of the need( / check( call
  let i = end - 1;
  assert.equal(src[i], ',', 'expected the reason to be the last argument of ' + reason);
  let depth = 0;
  for (; i >= 0; i--) {
    const ch = src[i];
    if (ch === ')') depth++;
    else if (ch === '(') { if (depth === 0) break; depth--; }
  }
  return src.slice(i + 1, end - 1);
}

// ---- the controller's own helpers, lifted rather than rewritten ----
const same = isDeepStrictEqual;
const exact = (o, keys) => o && same(Object.keys(o).sort(), [...keys].sort());
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const utc = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s) && Number.isFinite(Date.parse(s));
const ref = x => exact(x, ['uri', 'sha256']) && typeof x.uri === 'string' &&
  /^https:\/\/api\.github\.com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[a-f0-9]{40}$/.test(x.uri) && hex(x.sha256);

// confirm the lifted helpers match the controller's source text, so a drift in either is caught
for (const [name, needle] of [
  ['exact', "const exact=(o,keys)=>o&&same(Object.keys(o).sort(),[...keys].sort());"],
  ['hex', "const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);"],
]) assert.ok(src.includes(needle), 'controller helper ' + name + ' no longer matches the transcribed one');

function frozen(name) {
  const i = src.indexOf('const ' + name + '=Object.freeze(');
  assert.ok(i >= 0, name);
  const start = src.indexOf('(', i) + 1;
  let d = 1, j = start;
  while (d > 0) { j++; if (src[j] === '(') d++; else if (src[j] === ')') d--; }
  return (0, eval)('(' + src.slice(start, j) + ')');
}
const capacityDelta = frozen('capacityDelta');
const capacityBaseline = frozen('capacityBaseline');
const scope = frozen('scope');
const proposalSHA = /const proposalSHA='([a-f0-9]{64})'/.exec(src)[1];
const capacityRepairState = /const capacityRepairState='([A-Z_]+)'/.exec(src)[1];

// ---- the live inputs ----
const applicabilityRaw = read(OUT + '/Root6CurrentController4000000CapacityApplicability20260912.json').toString('utf8');
const repairRaw = read(OUT + '/Root6Current043CapacityRepairAcceptance20260912.json').toString('utf8');
const approvalRaw = read(OUT + '/Root6OriginalInput4000000CapacityApproval20260912.v2.json').toString('utf8');
const appendix = readJson('artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/BoundedSeriesApplicability20260910.json');
const v17 = readJson(V17 + '/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json');

const d0 = JSON.parse(applicabilityRaw);
const r0 = JSON.parse(repairRaw);
const a = JSON.parse(approvalRaw);
const pins = { approval_ref: appendix.approval_ref };

// s is the accepted_subject the reissued runtime acceptance will carry: the v17 subject with the
// capacity fields moved onto the documents under test. That move is exactly what remains to be done.
const s = structuredClone(v17.accepted_subject);
s.capacity_delta = capacityDelta;
s.capacity_materials = {
  approval: { ref: { uri: 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + blobSha(read(OUT + '/Root6OriginalInput4000000CapacityApproval20260912.v2.json')), sha256: sha(read(OUT + '/Root6OriginalInput4000000CapacityApproval20260912.v2.json')) } },
  applicability: { ref: { uri: 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + blobSha(Buffer.from(applicabilityRaw, 'utf8')), sha256: sha(Buffer.from(applicabilityRaw, 'utf8')) } },
};

const now = new Date().toISOString();

// ---- evaluate a lifted controller expression against a given d / r ----
function evalCondition(reason, bind = {}) {
  const expr = liftCondition(reason);
  const scopeVars = { d: d0, r: r0, s, a, pins, scope, capacityDelta, capacityBaseline, proposalSHA, now, same, exact, hex, utc, ref, Object, Array, Date, Set, ...bind };
  const names = Object.keys(scopeVars);
  // eslint-disable-next-line no-new-func
  return Function(...names, 'return (' + expr + ');')(...names.map(n => scopeVars[n]));
}

// =====================  the applicability  =====================

test('the emitted applicability parses under the controller admin-JSON rule', () => {
  const check = raw => {
    const value = JSON.parse(raw);
    let compact = '', quoted = false, escaped = false;
    for (const ch of raw) {
      if (quoted) { compact += ch; if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
      else if (ch === '"') { quoted = true; compact += ch; }
      else if (!' \t\r\n'.includes(ch)) compact += ch;
    }
    return compact === JSON.stringify(value);
  };
  assert.ok(check(applicabilityRaw), 'applicability would fail ADMIN_JSON_UNIQUE_CANONICAL_VALUES');
  assert.ok(check(repairRaw), 'repair would fail ADMIN_JSON_UNIQUE_CANONICAL_VALUES');
});

test('EXACT_INDEPENDENT_CAPACITY_APPLICABILITY passes, and fails on a wrong reviewer identity', () => {
  assert.ok(evalCondition('EXACT_INDEPENDENT_CAPACITY_APPLICABILITY'));
  const bad = structuredClone(d0); bad.independent_reviewer = '/root';
  assert.equal(evalCondition('EXACT_INDEPENDENT_CAPACITY_APPLICABILITY', { d: bad }), false);
});

test('EXACT_INDEPENDENT_CAPACITY_APPLICABILITY rejects the superseded v1 approval pointer', () => {
  const bad = structuredClone(d0);
  bad.capacity_proposal_ref = { uri: 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/05b0724a5c4ba8c553b0c28c64a696894d5f23fe', sha256: '0021a37881a62d61d47da9b5f4125e822b0196ac5f245210fe5bc6823c0049ab' };
  assert.equal(evalCondition('EXACT_INDEPENDENT_CAPACITY_APPLICABILITY', { d: bad }), false,
    'the 131 proposal pointer that blocked round two must still be rejected');
});

test('CAPACITY_ONLY_EXPLICIT_DELTA passes, and fails at 131 or with a scope_unchanged key', () => {
  assert.ok(evalCondition('CAPACITY_ONLY_EXPLICIT_DELTA'));
  const at131 = structuredClone(d0); at131.capacity_delta.source_refs_maximum = 131;
  assert.equal(evalCondition('CAPACITY_ONLY_EXPLICIT_DELTA', { d: at131 }), false);
  const legacy = structuredClone(d0); legacy.scope_unchanged = true;
  assert.equal(evalCondition('CAPACITY_ONLY_EXPLICIT_DELTA', { d: legacy }), false);
});

test('CAPACITY_ACCEPTANCE_TIME passes, and fails if accepted before the approval', () => {
  assert.ok(evalCondition('CAPACITY_ACCEPTANCE_TIME'));
  const early = structuredClone(d0); early.accepted_at = '2026-09-12T00:54:15.196Z';
  assert.equal(evalCondition('CAPACITY_ACCEPTANCE_TIME', { d: early }), false,
    'one millisecond before the Owner approval must be rejected');
});

test('CAPACITY_EXACT_CURRENT_CONTROLLER_SCOPE passes, and fails on the superseded controller digest', () => {
  assert.ok(evalCondition('CAPACITY_EXACT_CURRENT_CONTROLLER_SCOPE'));
  const old = structuredClone(d0); old.controller_digest = 'ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa';
  assert.equal(evalCondition('CAPACITY_EXACT_CURRENT_CONTROLLER_SCOPE', { d: old }), false);
});

test('CAPACITY_EXACT_EVIDENCE_SUCCESSOR passes, and fails if the sink equals its predecessor', () => {
  assert.ok(evalCondition('CAPACITY_EXACT_EVIDENCE_SUCCESSOR'));
  const collapsed = structuredClone(d0); collapsed.evidence_sink_ref = collapsed.previous_evidence_sink_ref;
  assert.equal(evalCondition('CAPACITY_EXACT_EVIDENCE_SUCCESSOR', { d: collapsed }), false);
});

test('CAPACITY_EXACT_CHANGED_SOURCE_REFS passes, and fails on a duplicate URI', () => {
  assert.ok(evalCondition('CAPACITY_EXACT_CHANGED_SOURCE_REFS'));
  const dup = structuredClone(d0); dup.changed_source_refs.push(dup.changed_source_refs[0]);
  assert.equal(evalCondition('CAPACITY_EXACT_CHANGED_SOURCE_REFS', { d: dup }), false);
  const empty = structuredClone(d0); empty.changed_source_refs = [];
  assert.equal(evalCondition('CAPACITY_EXACT_CHANGED_SOURCE_REFS', { d: empty }), false);
});

test('CLOSED_SOURCE_REF_MAXIMUM passes at the 133 the accepted subject declares', () => {
  assert.ok(evalCondition('CLOSED_SOURCE_REF_MAXIMUM'));
  assert.equal(s.expected_ga.source_ref.blobs.length, 133);
});

// =====================  the repair acceptance  =====================

test('isApprovedCapacityRepair accepts the emitted repair, and rejects each moved field', () => {
  const body = /function isApprovedCapacityRepair\(r,a,c\)\{return ([^;]+);\}/.exec(src)[1];
  const attempt = { ga_id: capacityBaseline.failed_ga_id, receipt_sha256: capacityBaseline.failed_receipt_sha256 };
  const c = {
    approval_ref: s.capacity_materials.approval.ref,
    applicability_ref: s.capacity_materials.applicability.ref,
    controller_digest: d0.controller_digest,
    scope_digest: d0.scope_digest,
    changed_source_refs: d0.changed_source_refs,
  };
  const run = r => Function('r', 'a', 'c', 'capacityRepairState', 'capacityBaseline', 'ref', 'same', 'Object',
    'return (' + body + ');')(r, attempt, c, capacityRepairState, capacityBaseline, ref, same, Object);

  assert.ok(run(r0), 'the emitted repair acceptance is not accepted by the controller predicate');

  for (const [label, mutate] of [
    ['stale controller digest', r => { r.controller_digest = 'ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa'; }],
    ['stale approval ref', r => { r.capacity_approval_ref = { uri: 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/1d7fab869ea580f852a0c69a6b9316e9b9b71742', sha256: 'f3afb108e1f5080c0dc47902c90a3291acebd2171a78095fd95ae8cd30a6ff8f' }; }],
    ['stale applicability ref', r => { r.capacity_applicability_ref = { uri: 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/cfaafa310102c61b3f1fed5273a2216c90572f8b', sha256: 'cc3db45bb0931ebe0a539be48e58d25e20e84836809b2995ecb9a0b4fb109537' }; }],
    ['changed_source_refs disagreeing with the applicability', r => { r.changed_source_refs = r.changed_source_refs.slice(1); }],
    ['legacy scope_unchanged key', r => { r.scope_unchanged = true; }],
    ['wrong reviewer identity', r => { r.independent_reviewer = '/root'; }],
  ]) {
    const bad = structuredClone(r0); mutate(bad);
    assert.equal(run(bad), false, 'must reject: ' + label);
  }
});

// =====================  the two documents agree  =====================

test('the repair points at the applicability actually on disk', () => {
  const bytes = Buffer.from(applicabilityRaw, 'utf8');
  assert.equal(r0.capacity_applicability_ref.sha256, sha(bytes));
  assert.equal(r0.capacity_applicability_ref.uri.split('/').at(-1), blobSha(bytes));
});

test('both point at the reissued v2 approval, never the superseded first one', () => {
  const bytes = read(OUT + '/Root6OriginalInput4000000CapacityApproval20260912.v2.json');
  assert.equal(d0.approval_ref.sha256, sha(bytes));
  assert.equal(r0.capacity_approval_ref.sha256, sha(bytes));
  assert.notEqual(d0.approval_ref.sha256, 'd06494658f1c9ee90e83951ab7a4ff33306ac9ff978f2d3a200baf50f2a8b0d7');
});

test('changed_source_refs is exactly the reviewed root6 introduction, every byte real', () => {
  const manifestRel = CTRL + '/ControllerSourceManifest.candidate.json';
  const manifestBytes = read(manifestRel);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const expected = [];
  const seen = new Set();
  const push = b => { const u = 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/' + blobSha(b); if (seen.has(u)) return; seen.add(u); expected.push({ uri: u, sha256: sha(b) }); };
  push(manifestBytes);
  for (const e of manifest.files) {
    if (e.role !== 'REPOSITORY_SOURCE' || !e.path.startsWith(CTRL + '/')) continue;
    const b = read(e.path);
    assert.equal(sha(b), e.sha256, 'manifest disagrees with bytes for ' + e.path);
    push(b);
  }
  push(read('scripts/phase2-qualification/nonproduction-control-store/runtime-successor/commitment-signing-root6-window/signing.mjs'));
  assert.deepEqual(d0.changed_source_refs, expected);
  assert.equal(expected.length, 19);
  assert.equal(sha(manifestBytes), d0.controller_digest, 'the leading blob must be the accepted controller manifest');
});

test('nothing unreviewed is asserted: every changed_source_ref resolves to a file in this repository', () => {
  const byShaSum = new Map();
  const walk = dir => {
    for (const e of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') walk(rel); }
      else byShaSum.set(sha(read(rel)), rel);
    }
  };
  walk('scripts/phase2-qualification/control-context-verifier-root6-window10-successor');
  walk('scripts/phase2-qualification/nonproduction-control-store/runtime-successor/commitment-signing-root6-window');
  for (const r of d0.changed_source_refs)
    assert.ok(byShaSum.has(r.sha256), 'changed_source_ref resolves to no repository file: ' + r.sha256);
});

test('the issued documents carry the identity the Owner decision requires', () => {
  for (const doc of [d0, r0]) {
    assert.equal(doc.issuing_session, 'session_018nf6mQ5CQuMFadoJ9WRZCN');
    assert.equal(doc.succession_basis, 'a573ca93e094bc9a4a8dccc23c1e165b6b368ff4');
    assert.match(doc.historical_conclusions_not_ratified, /does not ratify any historical conclusion/);
    assert.equal(doc.authority_effect, 'NONE');
    assert.equal(doc.publication_status, 'INDEPENDENTLY_REVIEWED_NOT_YET_OWNER_PUBLISHED');
  }
  assert.equal(d0.runtime_admission, false);
  assert.equal(r0.qualification_pass, false);
});

test('provenance is extended, not overwritten', () => {
  assert.ok(d0.supersedes?.sha256 && Array.isArray(d0.supersedes_chain) && d0.supersedes_chain.length >= 1);
  assert.equal(d0.supersedes.sha256, 'cc3db45bb0931ebe0a539be48e58d25e20e84836809b2995ecb9a0b4fb109537');
  assert.equal(r0.supersedes.sha256, '5911567d4e4aeb74b76664614746a856704ab588c9dcc98f0655d7b85eb79153');
  assert.ok(r0.supersedes_chain.length >= 1);
});
