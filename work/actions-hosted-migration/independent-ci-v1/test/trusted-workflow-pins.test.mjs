// Offline tests of the exact accepted workflow pin sets (PR-A x PR-B). The local formal roles of Source v2
// (gitleaks v4, trivy v4 + required-trivy-v3, placement v2, policy v3, bridge v4) and of the H5 one-shot
// fallback (gitleaks v3, trivy v3 + required-trivy-v2, placement v1, policy v2, bridge v3) accept exactly the
// reviewed bytes of the three hosted workflows on main and in the frozen PR-B commit, never a pattern, so one
// installed Source keeps working whichever side of PR-B its trusted checkout is from. Every set derives from
// the one table worker/trusted-workflows.mjs; test/fixtures/repin-trusted-workflows.mjs regenerates that table
// and the fixture from two commits. The bytes come from test/fixtures/trusted-workflows.json, never from the
// working tree. No network, Docker, Host path or credential. Fixtures live under os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { REQUIRED_SOURCE_PATHS as BRIDGE_V3_SOURCE } from '../worker/protected-job-bridge-v3/boundary.mjs';
import { REQUIRED_SOURCE_PATHS as BRIDGE_V4_SOURCE } from '../worker/protected-job-bridge-v4/boundary.mjs';
import { requiredSourcePaths as policyV2Paths } from '../worker/formal-fixed-role-policy-v2/policy.mjs';
import { requiredSourcePaths as policyV3Paths } from '../worker/formal-fixed-role-policy-v3/policy.mjs';
import { WORKFLOWS, VERSIONS, GITLEAKS, TRIVY, PLACEMENT, workflowBytes, sha256, gitBlob, acceptedSha256s, GITLEAKS_SUCCESSOR, successorWorkflowBytes } from './fixtures/trusted-workflows.mjs';
import { TRUSTED_WORKFLOWS, TRUSTED_WORKFLOW_PATHS, trustedWorkflowSha256s, GITLEAKS_SUCCESSOR_WORKFLOW, activeGitleaksWorkflowSha256s } from '../worker/trusted-workflows.mjs';
import { TABLE_FILE, FIXTURE_FILE, readVersions, fixtureText, tableText, readGitleaksSuccessor, successorTableText } from './fixtures/repin-trusted-workflows.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const REPO = 'tdoljyj/cross-memory-system';
const h = n => String(n).repeat(64).slice(0, 64);
const FILES = [GITLEAKS, TRIVY, PLACEMENT];

test('the one table and the fixture name the same exact bytes of all three workflows on both sides of PR-B', () => {
  assert.equal(WORKFLOWS.contract, 'clued.independent-ci.test.trusted-workflows/2');
  assert.deepEqual(Object.keys(WORKFLOWS.versions), [...VERSIONS]);
  assert.deepEqual(Object.values(TRUSTED_WORKFLOW_PATHS).sort(), [...FILES].sort());
  assert.ok(Object.isFrozen(TRUSTED_WORKFLOWS) && Object.isFrozen(TRUSTED_WORKFLOW_PATHS));
  assert.equal(Object.keys(TRUSTED_WORKFLOWS).length, FILES.length * VERSIONS.length);
  for (const version of VERSIONS) {
    const { commit, files } = WORKFLOWS.versions[version];
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(Object.keys(files).sort(), [...FILES].sort());
    for (const file of FILES) {
      const entry = files[file], bytes = workflowBytes(version, file);
      assert.equal(gitBlob(bytes), entry.blob, `${version} ${file} blob`);
      assert.equal(sha256(bytes), entry.sha256, `${version} ${file} sha256`);
      // The table row keyed by these bytes' sha256: same path, blob and source commit.
      assert.deepEqual({ ...TRUSTED_WORKFLOWS[entry.sha256] }, { path: file, sha256: entry.sha256, blob: entry.blob, source: `${version} ${commit}` });
    }
  }
  for (const file of FILES) {
    assert.notEqual(sha256(workflowBytes('main', file)), sha256(workflowBytes('pr-b', file)));
    assert.deepEqual([...trustedWorkflowSha256s(file)], acceptedSha256s(file));
  }
  assert.throws(() => trustedWorkflowSha256s('.github/workflows/other.yml'), { code: 'TRUSTED_WORKFLOW_PATH_UNKNOWN' });
  // Regenerating from the fixture's own data reproduces the committed table and fixture byte for byte.
  const versions = structuredClone(WORKFLOWS.versions);
  assert.equal(tableText(fs.readFileSync(TABLE_FILE, 'utf8'), versions), fs.readFileSync(TABLE_FILE, 'utf8'));
  assert.equal(fixtureText(versions, WORKFLOWS.successors), fs.readFileSync(FIXTURE_FILE, 'utf8'));
  assert.equal(successorTableText(fs.readFileSync(TABLE_FILE, 'utf8'), GITLEAKS_SUCCESSOR), fs.readFileSync(TABLE_FILE, 'utf8'));
});

test('the active gitleaks successor is separate from the immutable 726 workflow set', () => {
  const active = GITLEAKS_SUCCESSOR ? [GITLEAKS_SUCCESSOR.files[GITLEAKS].sha256] : [];
  assert.deepEqual([...activeGitleaksWorkflowSha256s()], active);
  assert.deepEqual([...gitleaksV4.WORKFLOW_SHA256S], active);
  assert.deepEqual([...gitleaksV3.WORKFLOW_SHA256S], acceptedSha256s(GITLEAKS));
  assert.ok(active.every(sha => !gitleaksV3.WORKFLOW_SHA256S.includes(sha)));
  if (!GITLEAKS_SUCCESSOR) { assert.equal(GITLEAKS_SUCCESSOR_WORKFLOW, null); return; }
  const bytes = successorWorkflowBytes(), entry = GITLEAKS_SUCCESSOR.files[GITLEAKS];
  assert.equal(sha256(bytes), entry.sha256); assert.equal(gitBlob(bytes), entry.blob);
  assert.deepEqual(GITLEAKS_SUCCESSOR_WORKFLOW, { path: GITLEAKS, sha256: entry.sha256, blob: entry.blob, commit: GITLEAKS_SUCCESSOR.commit });
  assert.deepEqual(readGitleaksSuccessor(ROOT, GITLEAKS_SUCCESSOR.commit), GITLEAKS_SUCCESSOR);
});

const haveCommits = (() => {
  const r = spawnSync('git', ['-C', ROOT, 'cat-file', '--batch-check'], { input: VERSIONS.map(v => WORKFLOWS.versions[v].commit).join('\n') + '\n', windowsHide: true });
  return r.status === 0 && !String(r.stdout).includes('missing');
})();
test('the fixture bytes are the git objects of its two commits (re-pin tool, read-only)', { skip: !haveCommits && 'fixture commits not in the local object store' }, () => {
  const versions = readVersions(ROOT, Object.fromEntries(VERSIONS.map(v => [v, WORKFLOWS.versions[v].commit])));
  assert.deepEqual(versions, WORKFLOWS.versions);
});

test('a malformed table refuses to load: duplicate, non-hex, unknown path, or a workflow without a row', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'clued-trusted-table-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const text = fs.readFileSync(TABLE_FILE, 'utf8'), [mainGitleaks] = acceptedSha256s(GITLEAKS);
  const row = WORKFLOWS.versions.main.files[GITLEAKS];
  const line = `  ['${GITLEAKS}', '${mainGitleaks}', '${row.blob}', 'main ${WORKFLOWS.versions.main.commit}'],\n`;
  assert.ok(text.includes(line));
  const variants = {
    duplicate: text.replace(line, line + line),
    upper: text.replace(line, line.replace(mainGitleaks, mainGitleaks.toUpperCase())),
    pattern: text.replace(line, line.replace(mainGitleaks, '*')),
    unknown: text.replace(line, line.replace(GITLEAKS, '.github/workflows/gitleaks-shadow.yml')),
    source: text.replace(line, line.replace(`'main ${WORKFLOWS.versions.main.commit}'`, "'any'")),
    missing: text.split('\n').filter(l => !l.includes(`['${PLACEMENT}'`)).join('\n'),
  };
  for (const [name, variant] of Object.entries(variants)) {
    const file = path.join(directory, `${name}.mjs`); fs.writeFileSync(file, variant);
    await assert.rejects(import(pathToFileURL(file).href), { code: 'TRUSTED_WORKFLOW_TABLE_INVALID' }, name);
  }
});

test('every role, policy and signed-result check carries exactly both reviewed versions, frozen, and no single pin is left', () => {
  const sets = [
    ['gitleaks v3', gitleaksV3.WORKFLOW_SHA256S, GITLEAKS],
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
  for (const module of [gitleaksV3]) {
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
  // The table is pinned wherever a closure of these modules is verified.
  const TABLE = 'work/actions-hosted-migration/independent-ci-v1/worker/trusted-workflows.mjs';
  for (const role of ['gitleaks', 'trivy', 'contract-placement']) {
    assert.ok(policyV2Paths(role).includes(TABLE), `policy v2 ${role}`); assert.ok(policyV3Paths(role).includes(TABLE), `policy v3 ${role}`);
  }
  assert.ok(BRIDGE_V3_SOURCE.includes(TABLE) && BRIDGE_V4_SOURCE.includes(TABLE));
  for (const adapter of ['formal-gitleaks-v3', 'formal-gitleaks-v4', 'formal-trivy-v2', 'formal-trivy-v3', 'formal-trivy-v4', 'formal-contract-placement-v1', 'formal-contract-placement-v2']) {
    assert.match(fs.readFileSync(new URL(`../worker/${adapter}/adapter.mjs`, import.meta.url), 'utf8'), /(?:P\+)?'worker\/trusted-workflows\.mjs'/, adapter);
  }
});

test('gitleaks acceptedWorkflowSha256 (v3, v4): one declared accepted pin, nothing else', () => {
  const [main, prB] = acceptedSha256s(GITLEAKS), other = h(9);
  const role = pins => ({ sourceFiles: pins.map(sha => ({ path: GITLEAKS, sha256: sha })).concat([{ path: '.gitleaks.toml', sha256: h(1) }]) });
  for (const module of [gitleaksV3]) {
    assert.equal(module.acceptedWorkflowSha256(role([main])), main);
    assert.equal(module.acceptedWorkflowSha256(role([prB])), prB);
    for (const bad of [role([]), role([other]), role([main, prB]), role([main, main]), { sourceFiles: null }, null,
      { sourceFiles: [{ path: GITLEAKS.toUpperCase(), sha256: main }] }, { sourceFiles: [{ path: GITLEAKS, sha256: main.toUpperCase() }] }]) {
      assert.throws(() => module.acceptedWorkflowSha256(bad), { code: 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED' });
    }
  }
  const active = GITLEAKS_SUCCESSOR ? GITLEAKS_SUCCESSOR.files[GITLEAKS].sha256 : null;
  if (active) assert.equal(gitleaksV4.acceptedWorkflowSha256(role([active])), active);
  for (const bad of [role([]), role([main]), role([prB]), role([other]), role(active ? [active, active] : []), { sourceFiles: null }, null])
    assert.throws(() => gitleaksV4.acceptedWorkflowSha256(bad), { code: 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED' });
});

test('required trivy plans (v2, v3): the source check accepts both reviewed trivy.yml versions and nothing else', () => {
  const manifest = h(4);
  const v1 = { contract: JOB_CONTRACT, id: '', repo: REPO, pr: 884, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    claimId: '11111111-1111-1111-1111-111111111111', fence: 1, epoch: 1, role: 'trivy', sourceManifestSha256: manifest,
    createdAt: new Date().toISOString(), attempt: 1 };
  v1.id = jobId(v1);
  const v2 = makeJobV2({ repo: REPO, pr: 884, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), testSha: 'a'.repeat(40), role: 'trivy', sourceManifestSha256: manifest,
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

test('gitleaks v4 prepare: only the 729 successor passes; legacy, swapped or tampered bytes are refused before output', { skip: !GIT ? 'no single-link git executable' : !GITLEAKS_SUCCESSOR && 'successor workflow awaits a real freeze commit' }, async t => {
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
    const job = makeJobV2({ repo: REPO, pr: 884, headSha: head, baseSha: base, testSha: head, role: 'gitleaks', sourceManifestSha256: sha256(bytes), createdAt: new Date().toISOString(), attempt: 1 });
    const snapshot = { contract: 'clued.independent-ci.remote-heads-tags/1', repository: REPO, complete: true, observedAt: new Date().toISOString(), refs: [{ name: 'refs/heads/main', objectSha: base }] };
    try {
      await gitleaksV4.prepareRequiredHistory({ job, sourceManifestBytes: bytes, expectedSourceManifestSha256: sha256(bytes), trustedSourceDirectory: source,
        gitDirectory: store, remoteSnapshot: snapshot, outputDirectory: path.join(run, 'history'), gitExecutable: GIT, expectedGitSha256: gitSha });
      return { code: null, outputs: fs.readdirSync(run) };
    } catch (error) { return { code: error.code, outputs: fs.readdirSync(run) }; }
  }
  const active = successorWorkflowBytes(), main = workflowBytes('main', GITLEAKS), prB = workflowBytes('pr-b', GITLEAKS), tampered = Buffer.concat([active, Buffer.from('# tampered\n')]);
  assert.deepEqual(await attempt('successor', active, [sha256(active)]), { code: 'REVIEWED_COMMIT_NOT_IN_STORE', outputs: ['history', 'source'] });
  for (const [label, bytes] of [['main', main], ['pr-b', prB]]) {
    assert.deepEqual(await attempt(label, bytes, [sha256(bytes)]), { code: 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED', outputs: ['source'] }, label);
  }
  assert.deepEqual(await attempt('swapped', main, [sha256(active)]), { code: 'TRUSTED_REVIEW_SOURCE_CHANGED', outputs: ['source'] });
  assert.deepEqual(await attempt('tampered', tampered, [sha256(tampered)]), { code: 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED', outputs: ['source'] });
  assert.deepEqual(await attempt('undeclared', main, []), { code: 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED', outputs: ['source'] });
});
