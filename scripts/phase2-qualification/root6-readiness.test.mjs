// Verifies the output of work/root6-window10-migration/build-root6-successor.mjs.
//
// Deliberately imports NOTHING from the controller. Every assertion is made against source bytes
// and the manifest, so this runs in environments where ajv is absent and context.mjs cannot be
// loaded at all. That is the point: it is the check on the build for anyone who cannot run the
// build themselves.
//
// Before the build has been run these tests fail because the directory does not exist. That is
// the correct signal, not a broken test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields '/C:/Users/...' with a leading
// slash and path.resolve then computes the wrong repository root.
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const DST_REL = 'scripts/phase2-qualification/control-context-verifier-root6-window10-successor';
const SRC_REL = 'scripts/phase2-qualification/control-context-verifier-root5-window5-forward11-successor';
const SIGN_DST_REL = 'scripts/phase2-qualification/nonproduction-control-store/runtime-successor/commitment-signing-root6-window';

const ROOT6_GENERATION = 'ctrgen_5e0440a95ac8ee257b9e4236cabd275b';
const ROOT5_GENERATION = 'ctrgen_e5df432221344996afc04b5638121d96';
const ROOT4_GENERATION = 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06';
const ROOT6_NOT_BEFORE = '2026-09-12T00:00:00Z';
const ROOT6_EXPIRY = '2026-09-19T00:00:00Z';
const OWNER_WINDOW_LOWER = '2026-09-10T13:18:47Z';
const OLD_CUTOFF = '2026-09-11T10:21:05Z';
const PREDECESSOR_DIGEST = 'ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa';

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const read = rel => fs.readFileSync(path.join(repo, rel), 'utf8');
const count = (haystack, needle) => haystack.split(needle).length - 1;

const ctx = () => read(DST_REL + '/context.mjs');

test('the successor directory exists and carries every predecessor file', () => {
  const src = fs.readdirSync(path.join(repo, SRC_REL)).sort();
  const dst = fs.readdirSync(path.join(repo, DST_REL)).sort();
  for (const f of src) assert.ok(dst.includes(f), 'missing carried file: ' + f);
  // trusted-github.mjs is new in this directory, so the successor has exactly one more file.
  assert.ok(dst.includes('trusted-github.mjs'));
  assert.equal(dst.length, src.length + 1);
});

test('the predecessor directory is untouched, byte for byte', () => {
  assert.equal(sha(fs.readFileSync(path.join(repo, SRC_REL + '/ControllerSourceManifest.candidate.json'))), PREDECESSOR_DIGEST);
});

// ---- the generation chain ----

test('the controller is bound to root6', () => {
  assert.ok(ctx().includes("generation='" + ROOT6_GENERATION + "';"));
});

test('the historical generation arms are preserved, so no past budget is reclassified', () => {
  const c = ctx();
  assert.ok(c.includes("root4Generation='" + ROOT4_GENERATION + "'"), 'root4 arm lost');
  assert.ok(c.includes("root5Generation='" + ROOT5_GENERATION + "'"), 'root5 arm lost');
  assert.ok(c.includes("root4Expiry='" + OLD_CUTOFF + "'"), 'root4 expiry lost');
  assert.ok(c.includes('root5BudgetSequence=64'), 'root5 budget boundary moved');
  // Historical budgets live below sequence 89 and must still resolve to root5/root4.
  assert.ok(c.includes('root6BudgetSequence=89'));
  assert.ok(/sequence>=root6BudgetSequence\?root6Generation:sequence>=root5BudgetSequence\?root5Generation:sequence>=59\?root4Generation/.test(c));
  assert.ok(/sequence>=root6BudgetSequence\?root6Expiry:sequence>=59\?root4Expiry/.test(c));
});

test('the superseded cutoff survives only as the historical root4 constant', () => {
  // Exactly one occurrence: the root4Expiry declaration. Any second occurrence means a live
  // check is still pinned to the expired window.
  assert.equal(count(ctx(), OLD_CUTOFF), 1);
});

test('the live head must be root6, not root5', () => {
  const c = ctx();
  assert.ok(c.includes('x.root.generation_id===root6Generation'));
  assert.ok(!c.includes('x.root.generation_id===root5Generation'),
    'EXACT_REGISTERED_ROOT5_CONTINUATION still pins root5, which contradicts CURRENT_ROOT_GENERATION_REQUIRED');
});

test('both dispatch cutoffs and the capacity expiry use the root6 window', () => {
  const c = ctx();
  assert.ok(c.includes("need(Date.parse(now)<Date.parse(root6Expiry),'FIXED_OWNER_CUTOFF_NO_DISPATCH')"));
  assert.ok(c.includes("need(Date.parse(now)+600000<Date.parse(root6Expiry),'FULL_600_SECOND_WINDOW_REQUIRED')"));
  assert.ok(c.includes("time(runtime.expires_at)<=time(root6Expiry)"));
  assert.ok(c.includes("root6Expiry='" + ROOT6_EXPIRY + "'"));
});

// ---- the forward cap, raised under a recorded Owner override ----

test('the forward cap is 16 and no other declared limit moved', () => {
  const c = ctx();
  assert.ok(c.includes('allocations:9,forwards:16,seconds:10506,evidenceBytes:2335812531,originalInputBytes:4000000,publicationBytes:8388608'),
    'qualificationLimits changed in more than the forward cap, or not at all');
});

test('the reason string no longer asserts a bound it does not enforce', () => {
  const c = ctx();
  assert.ok(!c.includes('FIFTEEN_FORWARDS'), 'reason string still claims FIFTEEN');
  assert.ok(c.includes("'NINE_ALLOCATIONS_AND_GAS_SIXTEEN_FORWARDS_MAXIMUM'"));
});

// ---- the Owner window and the ordered source reference caps ----

// Only the ceiling moves. Pinning the lower bound forward to the window start makes
// CAPACITY_APPROVAL_CURRENT_ROOT5_TIME unsatisfiable, because context.mjs:44 requires the
// registered not_before to be <= the capacity approval's approved_at, which predates the window.
test('the Owner window ceiling moved and the lower bound did not', () => {
  const v = read(DST_REL + '/root-window-validation.mjs');
  assert.ok(v.includes("start>=Date.parse('" + OWNER_WINDOW_LOWER + "')&&start<end&&end<=Date.parse('" + ROOT6_EXPIRY + "')"),
    'Owner window bounds are not the predecessor lower bound plus the root6 ceiling');
  assert.equal(count(v, OLD_CUTOFF), 0, 'superseded cutoff still present');
});

test('all three ordered source reference caps moved together', () => {
  assert.ok(read(DST_REL + '/source-publication.mjs').includes('refs.length<=133'),
    'COMPLETE_BOUNDED_SOURCE_SET still caps at 131');
  const c = ctx();
  assert.ok(c.includes('blobs.length<=133'), 'CLOSED_SOURCE_REF_MAXIMUM still caps at 131');
  assert.ok(c.includes('source_refs_maximum:133'), 'frozen capacityDelta still declares 131');
  assert.equal(count(c, 'source_refs_maximum:131'), 0);
});

// ---- the two schemas that are compiled and executed ----

test('the status manifest schema admits root6 and nothing else', () => {
  const s = read(DST_REL + '/status-manifest.root5.schema.json');
  assert.equal(count(s, ROOT5_GENERATION), 0, 'status schema still consts root5, which contradicts context.mjs:310');
  assert.equal(count(s, ROOT6_GENERATION), 2, 'expected both the payload and observations generation consts');
});

test('the gate result receipt schema admits root6', () => {
  const s = read(DST_REL + '/gate-result-receipt.root5.schema.json');
  assert.equal(count(s, ROOT5_GENERATION), 0, 'GRR schema still consts root5, so the final receipt cannot validate');
  assert.equal(count(s, ROOT6_GENERATION), 1);
});

// ---- the signing allowlist that gates GA and GRR construction ----

test('the signing successor admits root6 without dropping the historical generations', () => {
  const s = read(SIGN_DST_REL + '/signing.mjs');
  assert.ok(s.includes("root6Generation='" + ROOT6_GENERATION + "'"));
  assert.ok(s.includes('[rootGeneration,root5Generation,root6Generation].includes(boundRootGeneration)'),
    'makeCommitment would reject root6 and fail only in the final 600 seconds');
});

test('the predecessor signing module is not modified in place', () => {
  const old = read('scripts/phase2-qualification/nonproduction-control-store/runtime-successor/commitment-signing-next-window/signing.mjs');
  assert.equal(count(old, ROOT6_GENERATION), 0, 'a module pinned by hash in other artifacts was edited in place');
});

test('the controller loads the root6 signing module, not the predecessor', () => {
  const tg = read(DST_REL + '/trusted-github.mjs');
  assert.ok(tg.includes('commitment-signing-root6-window/signing.mjs'));
  assert.ok(!tg.includes('commitment-signing-next-window/signing.mjs'));
  for (const f of ['context.mjs', 'grr.mjs', 'historical-component-observations.mjs',
                   'original-inputs-blob.mjs', 'result-terminal.mjs', 'source-publication.mjs']) {
    const t = read(DST_REL + '/' + f);
    assert.ok(t.includes("'./trusted-github.mjs'"), f + ' does not use the local trusted-github');
    assert.ok(!t.includes("'../control-context-verifier-next-window-successor/trusted-github.mjs'"),
      f + ' still imports the predecessor trusted-github, which loads the root5 signing allowlist');
  }
});

// ---- the two hardcoded paths that would otherwise attest or launch the wrong controller ----

test('source publication verifies this controller manifest, not the predecessor', () => {
  const s = read(DST_REL + '/source-publication.mjs');
  assert.ok(s.includes(DST_REL + '/ControllerSourceManifest.candidate.json'));
  assert.equal(count(s, SRC_REL), 0,
    'verifySourcePublication would attest a source closure that is not the one executing');
});

test('the tool entry launches this controller, not an earlier generation', () => {
  const t = read(DST_REL + '/tool-entry.functions.js');
  assert.equal(count(t, 'control-context-verifier-root5-final-successor'), 0);
  assert.equal(count(t, DST_REL + '/'), 2, 'expected the manifest path and the cli.mjs launch path');
});

// ---- the manifest ----

test('the manifest is in the canonical encoding', () => {
  const raw = read(DST_REL + '/ControllerSourceManifest.candidate.json');
  assert.equal(raw.split('\n').length, 2, 'manifest is not compact single-line');
  assert.ok(raw.startsWith('{"object_type":"ControllerSourceManifest","format":"EXACT_SORTED_SOURCE_BYTES_V1_CANDIDATE"'));
  const m = JSON.parse(raw);
  const sorted = [...m.files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  assert.deepEqual(m.files.map(f => f.path), sorted.map(f => f.path),
    'manifest is not sorted by localeCompare(en), so the digest is not reproducible by the project builder');
  assert.equal(m.qualification_issued, false);
  assert.equal(m.authority_effect, 'NONE');
});

test('the manifest is additive and every declared byte is real', () => {
  const m = JSON.parse(read(DST_REL + '/ControllerSourceManifest.candidate.json'));
  const prev = JSON.parse(read(SRC_REL + '/ControllerSourceManifest.candidate.json'));
  assert.equal(m.files.length, prev.files.length + 2, 'expected exactly the two new source files');

  const paths = new Set(m.files.map(f => f.path));
  assert.ok(paths.has(DST_REL + '/trusted-github.mjs'));
  assert.ok(paths.has(SIGN_DST_REL + '/signing.mjs'));

  // Nothing was dropped: every predecessor entry survives, repointed if it lived in the old dir.
  for (const f of prev.files) {
    const expected = f.path.startsWith(SRC_REL + '/') ? DST_REL + f.path.slice(SRC_REL.length) : f.path;
    assert.ok(paths.has(expected), 'manifest dropped ' + f.path);
  }

  // Every repository source must actually hash to what the manifest declares. Runtime dependencies
  // are Windows-host paths that do not exist here and are carried unverified by construction.
  for (const f of m.files) {
    if (f.role !== 'REPOSITORY_SOURCE') continue;
    const buf = fs.readFileSync(path.join(repo, f.path));
    assert.equal(buf.length, f.bytes, 'declared byte length wrong for ' + f.path);
    assert.equal(sha(buf), f.sha256, 'declared digest wrong for ' + f.path);
  }
});

test('no manifest entry points back into the superseded directory', () => {
  const m = JSON.parse(read(DST_REL + '/ControllerSourceManifest.candidate.json'));
  const stale = m.files.filter(f => f.path.startsWith(SRC_REL + '/'));
  assert.deepEqual(stale, [], 'manifest still declares predecessor-directory sources');
});
