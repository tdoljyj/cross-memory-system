// Offline tests of the exact accepted workflow pin sets (PR-A x PR-B 7d0468e0). The local formal roles of
// Source v2 (gitleaks v4, trivy v4 + required-trivy-v3, placement v2, policy v3, bridge v4) and of the H5
// one-shot fallback (gitleaks v3, trivy v3 + required-trivy-v2, placement v1, policy v2, bridge v3) accept
// exactly the reviewed bytes of the three hosted workflows on main before PR-B and as frozen in PR-B, never
// a pattern, so one installed Source keeps working whichever side of PR-B its trusted checkout is from.
// The bytes come from test/fixtures/trusted-workflows.json, never from the working tree.
// No network, Docker, Host path or credential. Fixtures live under os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical } from '../src/proof.mjs';
import { JOB_CONTRACT, jobId } from '../src/queue.mjs';
import { makeJobV2 } from '../src/job-v2.mjs';
import * as gitleaksV3 from '../worker/formal-gitleaks-v3/required-history/prepare.mjs';
import * as gitleaksV4 from '../worker/formal-gitleaks-v4/required-history/prepare.mjs';
import * as trivyPlansV2 from '../worker/required-trivy-v2/plans.mjs';
import * as trivyPlansV3 from '../worker/required-trivy-v3/plans.mjs';
import * as placementV1 from '../worker/formal-contract-placement-v1/adapter.mjs';
import * as placementV2 from '../worker/formal-contract-placement-v2/adapter.mjs';
import * as entryV1 from '../worker/formal-contract-placement-v1/container-entry.mjs';
import * as entryV2 from '../worker/formal-contract-placement-v2/container-entry.mjs';
import { PLACEMENT_WORKFLOW_SHA256S as POLICY_V2_PLACEMENT } from '../worker/formal-fixed-role-policy-v2/policy.mjs';
import { PLACEMENT_WORKFLOW_SHA256S as POLICY_V3_PLACEMENT } from '../worker/formal-fixed-role-policy-v3/policy.mjs';
import * as bridgeV3 from '../worker/protected-job-bridge-v3/signed-result.mjs';
import * as bridgeV4 from '../worker/protected-job-bridge-v4/signed-result.mjs';
import { WORKFLOWS, VERSIONS, GITLEAKS, TRIVY, PLACEMENT, workflowBytes, sha256, gitBlob, acceptedSha256s } from './fixtures/trusted-workflows.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const REPO = 'tdoljyj/cross-memory-system';
const h = n => String(n).repeat(64).slice(0, 64);

// Independent of the fixture: the blobs the coordinator froze for both sides of PR-B.
const EXPECTED = {
  main: { commit: '8710e92ca5c8bb2b7330e45dc6d4f724c0b68b93', [GITLEAKS]: '74043d68d20dbee9f9404a66f0a02d3285fea0aa',
    [TRIVY]: 'f7f8d075d1a0f314a7c5eb295e459599288d538c', [PLACEMENT]: '54ee2f11cc0f52d7cd9c0f6a63b75da8ef3e2b3a' },
  'pr-b': { commit: '7d0468e07125fa25cfa23846f66c505248d6396a', [GITLEAKS]: '1764fbcd3dd1457ae93423e0c100fe5deb1449ac',
    [TRIVY]: 'a7f2653a8add1d2486d27e1dd388ea4a9ef54025', [PLACEMENT]: '3640f0895cc72caffb8b2bc0c1df21b76b4b5340' },
};

test('the fixture holds the exact reviewed bytes of all three workflows on both sides of PR-B', () => {
  assert.equal(WORKFLOWS.contract, 'clued.independent-ci.test.trusted-workflows/1');
  assert.deepEqual(Object.keys(WORKFLOWS.versions), [...VERSIONS]);
  for (const version of VERSIONS) {
    assert.equal(WORKFLOWS.versions[version].commit, EXPECTED[version].commit);
    assert.deepEqual(Object.keys(WORKFLOWS.versions[version].files).sort(), [GITLEAKS, PLACEMENT, TRIVY].sort());
    for (const file of [GITLEAKS, TRIVY, PLACEMENT]) {
      const entry = WORKFLOWS.versions[version].files[file], bytes = workflowBytes(version, file);
      assert.equal(gitBlob(bytes), EXPECTED[version][file], `${version} ${file} blob`);
      assert.equal(entry.blob, EXPECTED[version][file]);
      assert.equal(sha256(bytes), entry.sha256, `${version} ${file} sha256`);
    }
  }
  for (const file of [GITLEAKS, TRIVY, PLACEMENT]) assert.notEqual(sha256(workflowBytes('main', file)), sha256(workflowBytes('pr-b', file)));
  // The coordinator's sha256 values for PR-B.
  assert.equal(sha256(workflowBytes('pr-b', GITLEAKS)), '17ec69ed57368773ed9dbb5c7ab0808172ac12173131d4fe81b57cd3fbfd8384');
  assert.equal(sha256(workflowBytes('main', GITLEAKS)), '168aebaf047a7c1b1e96d874f5b79500854175e809a373f236ab1079cff2d579');
});

test('every role, policy and signed-result check carries exactly both reviewed versions, frozen, and no single pin is left', () => {
  const sets = [
    ['gitleaks v3', gitleaksV3.WORKFLOW_SHA256S, GITLEAKS], ['gitleaks v4', gitleaksV4.WORKFLOW_SHA256S, GITLEAKS],
    ['required-trivy v2', trivyPlansV2.WORKFLOW_SHA256S, TRIVY], ['required-trivy v3', trivyPlansV3.WORKFLOW_SHA256S, TRIVY],
    ['placement v1', placementV1.WORKFLOW_SHA256S, PLACEMENT], ['placement v2', placementV2.WORKFLOW_SHA256S, PLACEMENT],
    ['policy v2', POLICY_V2_PLACEMENT, PLACEMENT], ['policy v3', POLICY_V3_PLACEMENT, PLACEMENT],
  ];
  for (const [name, set, file] of sets) {
    assert.ok(Object.isFrozen(set), name);
    assert.deepEqual([...set], acceptedSha256s(file), name);
    assert.ok(set.every(value => /^[a-f0-9]{64}$/.test(value)), name);
  }
  assert.equal(gitleaksV3.WORKFLOW_PATH, GITLEAKS); assert.equal(gitleaksV4.WORKFLOW_PATH, GITLEAKS);
  for (const module of [gitleaksV3, gitleaksV4]) {
    assert.deepEqual(Object.keys(module.SOURCE_PINS).sort(), ['.gitleaks.toml', 'scripts/ci/reviewed_gitleaks.py']);
  }
  for (const [name, module] of [['placement v1', placementV1], ['placement v2', placementV2], ['required-trivy v3', trivyPlansV3]]) {
    assert.equal(Object.hasOwn(module, 'WORKFLOW_SHA256'), false, name);
  }
  // Kept only for the superseded H4 formal-trivy-v2 adapter; it is the pre-PR-B value.
  assert.equal(trivyPlansV2.WORKFLOW_SHA256, acceptedSha256s(TRIVY)[0]);
  // The signed-result checks import the placement adapters' sets; linking them proves no stale single-pin import.
  assert.equal(typeof bridgeV3.verifySignedBridgeResult, 'function');
  assert.equal(typeof bridgeV4.observationFacts, 'function');
});

test('gitleaks acceptedWorkflowSha256 (v3, v4): one declared accepted pin, nothing else', () => {
  const [main, prB] = acceptedSha256s(GITLEAKS), other = h(9);
  const role = pins => ({ sourceFiles: pins.map(sha => ({ path: GITLEAKS, sha256: sha })).concat([{ path: '.gitleaks.toml', sha256: h(1) }]) });
  for (const module of [gitleaksV3, gitleaksV4]) {
    assert.equal(module.acceptedWorkflowSha256(role([main])), main);
    assert.equal(module.acceptedWorkflowSha256(role([prB])), prB);
    for (const bad of [role([]), role([other]), role([main, prB]), role([main, main]), { sourceFiles: null }, null,
      { sourceFiles: [{ path: GITLEAKS.toUpperCase(), sha256: main }] }, { sourceFiles: [{ path: GITLEAKS, sha256: main.toUpperCase() }] }]) {
      assert.throws(() => module.acceptedWorkflowSha256(bad), { code: 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED' });
    }
  }
});

test('required trivy plans (v2, v3): the source check accepts both reviewed trivy.yml versions and nothing else', () => {
  const manifest = h(4);
  const v1 = { contract: JOB_CONTRACT, id: '', repo: REPO, pr: 884, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    claimId: '11111111-1111-1111-1111-111111111111', fence: 1, epoch: 1, role: 'trivy', sourceManifestSha256: manifest,
    createdAt: new Date().toISOString(), attempt: 1 };
  v1.id = jobId(v1);
  const v2 = makeJobV2({ repo: REPO, pr: 884, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), role: 'trivy', sourceManifestSha256: manifest,
    createdAt: new Date().toISOString(), attempt: 2 });
  for (const [plans, job] of [[trivyPlansV2.requiredTrivyPlans, v1], [trivyPlansV3.requiredTrivyPlans, v2]]) {
    // An accepted pin passes the source check and stops at the next (missing mounts) check.
    for (const sha of acceptedSha256s(TRIVY)) {
      assert.throws(() => plans({ job, workflowSha256: sha, sourceManifestSha256: manifest }), { code: 'PR_CACHE_MOUNT_OVERLAP' });
    }
    for (const sha of [h(9), undefined, acceptedSha256s(GITLEAKS)[0], acceptedSha256s(TRIVY)[0].toUpperCase()]) {
      assert.throws(() => plans({ job, workflowSha256: sha, sourceManifestSha256: manifest }), { code: 'FIXED_TRIVY_SOURCE_REQUIRED' });
    }
  }
});

test('placement role profile (v1, v2): both reviewed contract-placement.yml versions are accepted, anything else refused', () => {
  for (const [adapter, entry] of [[placementV1, entryV1], [placementV2, entryV2]]) {
    const tools = { node: { path: '/usr/local/bin/node', sha256: h(1) }, python: { path: '/usr/bin/python3', sha256: h(2) }, git: { path: '/usr/bin/git', sha256: h(3) },
      esbuildJs: { path: '/opt/esbuild/lib/main.js', sha256: h(5) }, esbuildBinary: { path: '/opt/esbuild/bin/esbuild', sha256: h(6) } };
    const config = { executionMode: 'node-entry', image: 'sha256:' + h(7), containerNodeExecutable: tools.node.path, containerNodeSha256: tools.node.sha256,
      containerUser: '65532:65532', memoryBytes: entry.LIMITS.memoryBytes, cpus: entry.LIMITS.cpus, pids: entry.LIMITS.pids, dockerRootDirectory: '/var/lib/docker',
      nodeExecutable: '/opt/clued/node/bin/node', nodeExecutableSha256: h(8) };
    const role = workflowSha256 => ({ timeoutMs: entry.LIMITS.timeoutMs, maxOutputBytes: entry.LIMITS.maxOutputBytes,
      command: { executable: config.nodeExecutable, executableSha256: config.nodeExecutableSha256, args: ['/control/contract-placement-entry.mjs'], cwd: '.' },
      formalContractPlacement: { profile: entry.PROFILE, workflowSha256, esbuildVersion: '0.28.1', tools } });
    for (const sha of acceptedSha256s(PLACEMENT)) assert.equal(adapter.validateRole(config, role(sha)).workflowSha256, sha);
    for (const sha of [h(9), acceptedSha256s(TRIVY)[1], undefined]) {
      assert.throws(() => adapter.validateRole(config, role(sha)), { code: 'ORIGINAL_PLACEMENT_PROFILE_REQUIRED' });
    }
    assert.equal(canonical(role(acceptedSha256s(PLACEMENT)[1]).command.args), canonical(['/control/contract-placement-entry.mjs']));
  }
});

// prepare.mjs refuses a hard-linked Git executable; Git for Windows hard-links
// cmd/ and mingw64/bin/git.exe, so the test uses its single-link libexec copy.
const GIT = ['C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\git.exe', '/usr/bin/git']
  .find(file => { try { const s = fs.lstatSync(file); return s.isFile() && s.nlink === 1; } catch { return false; } }) ?? null;
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Clued CI test', GIT_AUTHOR_EMAIL: 'ci-test@example.invalid', GIT_COMMITTER_NAME: 'Clued CI test',
  GIT_COMMITTER_EMAIL: 'ci-test@example.invalid', GIT_AUTHOR_DATE: '2026-10-20T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T00:00:00Z' };
const git = (args, input) => { const r = spawnSync(GIT, args, { input, env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr).slice(0, 300)}`); return r.stdout.toString('utf8').trim(); };

test('gitleaks v4 (Source v2) prepare: either reviewed gitleaks.yml passes, a swapped or tampered one is refused before any output', { skip: !GIT && 'no single-link git executable' }, async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'clued-workflow-pins-'));
  t.after(async () => {
    const open = async p => { const s = await fsp.lstat(p); await fsp.chmod(p, s.isDirectory() ? 0o700 : 0o600);
      if (s.isDirectory()) for (const name of await fsp.readdir(p)) await open(path.join(p, name)); };
    await open(directory).catch(() => {}); await fsp.rm(directory, { recursive: true, force: true });
  });
  const store = path.join(directory, 'store.git'); git(['init', '--bare', '--quiet', '--template=', store]);
  const tree = git(['--git-dir=' + store, 'mktree'], '');
  const base = git(['--git-dir=' + store, 'commit-tree', tree, '-m', 'synthetic base']);
  const head = git(['--git-dir=' + store, 'commit-tree', tree, '-p', base, '-m', 'synthetic head']);
  const gitSha = sha256(fs.readFileSync(GIT));
  async function attempt(label, workflow, pins) {
    const run = await fsp.mkdtemp(path.join(directory, `${label}-`)), source = path.join(run, 'source');
    // Helper and config are single exact pins: the working tree must equal them.
    for (const relative of Object.keys(gitleaksV4.SOURCE_PINS)) {
      const target = path.join(source, ...relative.split('/')); await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(path.join(ROOT, ...relative.split('/')), target);
    }
    const target = path.join(source, ...GITLEAKS.split('/')); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, workflow);
    const bytes = Buffer.from(JSON.stringify({ schema: 'independent-ci.sources.v2', repo: REPO, sourceSha: 'c'.repeat(40),
      roles: { gitleaks: { containerCommand: { image: gitleaksV4.IMAGE, scanner: 'gitleaks', executable: '/usr/bin/gitleaks', cwd: '/input', args: [...gitleaksV4.SCAN_ARGS] },
        sourceFiles: [...Object.entries(gitleaksV4.SOURCE_PINS).map(([file, sha]) => ({ path: file, sha256: sha })), ...pins.map(sha => ({ path: GITLEAKS, sha256: sha }))] } } }));
    const job = makeJobV2({ repo: REPO, pr: 884, headSha: head, baseSha: base, role: 'gitleaks', sourceManifestSha256: sha256(bytes), createdAt: new Date().toISOString(), attempt: 1 });
    const snapshot = { contract: 'clued.independent-ci.remote-heads-tags/1', repository: REPO, complete: true, observedAt: new Date().toISOString(), refs: [{ name: 'refs/heads/main', objectSha: base }] };
    try {
      await gitleaksV4.prepareRequiredHistory({ job, sourceManifestBytes: bytes, expectedSourceManifestSha256: sha256(bytes), trustedSourceDirectory: source,
        gitDirectory: store, remoteSnapshot: snapshot, outputDirectory: path.join(run, 'history'), gitExecutable: GIT, expectedGitSha256: gitSha });
      return { code: null, outputs: fs.readdirSync(run) };
    } catch (error) { return { code: error.code, outputs: fs.readdirSync(run) }; }
  }
  const main = workflowBytes('main', GITLEAKS), prB = workflowBytes('pr-b', GITLEAKS), tampered = Buffer.concat([main, Buffer.from('# tampered\n')]);
  for (const [label, bytes] of [['main', main], ['pr-b', prB]]) {
    // Every pinned-source check passes; the synthetic store then lacks the reviewed commits.
    assert.deepEqual(await attempt(label, bytes, [sha256(bytes)]), { code: 'REVIEWED_COMMIT_NOT_IN_STORE', outputs: ['history', 'source'] }, label);
  }
  assert.deepEqual(await attempt('swapped', main, [sha256(prB)]), { code: 'TRUSTED_REVIEW_SOURCE_CHANGED', outputs: ['source'] });
  assert.deepEqual(await attempt('tampered', tampered, [sha256(tampered)]), { code: 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED', outputs: ['source'] });
  assert.deepEqual(await attempt('undeclared', main, []), { code: 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED', outputs: ['source'] });
});
