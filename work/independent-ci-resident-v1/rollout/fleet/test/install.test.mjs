// install.mjs prepare (BATCH1-INTERFACES.md sections 3, 6, 7): one universal archive (built twice: the same bytes, the reinstall subset)
// and ONE acceptance file give two different node sites (other node values, other installed references and role material; one a
// companion-account node with a heartbeat token) the SAME ciSourceManifestSha256 and two different fresh-install packages, which the
// frozen upgrader's readPackageOnce reads; the synthesized reinstall configuration is one rconfig.py loads; rehearse.py, prep.py and
// generate.py get the right arguments in the right order and the plan has every field. The package's prep.py runs for real on both
// nodes (A.sh, B.sh, B-resume.sh); generate.py runs for real up to the live host (the third test). Refusals: archive sha, acceptance,
// tampered entry, climbing path, an installer not the archive's, stale facts, no install, the receipt's tokens, a failed rehearsal. The
// prepare command line is the same on both nodes (section 8). A node an earlier package's launch left half installed (Linux that
// package's, Windows the install before it, its W1 pause in force: desk-w-591, 2026-11-13) is prepared as it is (DESIGN section 73).
// Differential: the upgrader configuration against upgrader-config.py, the reinstall role derivation against the frozen tool's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { FLEET_REF_KEYS, FORMAL_ROLES, LINUX_SCRIPTS, OWN_MODULES, PLAN_CONTRACT, installedSecretsOf, main, prepareInstall, sourceHashOf, readNode, reasonsOf, recordInputsFor,
  rolesDerivedReinstall, upgraderConfigFor, validateAcceptance } from '../install.mjs';
import { rolesDerived } from '../ports.mjs';
import { readTar, writeTar } from '../tar.mjs';
import { buildUniversal } from '../universal.mjs';
import { readPackageOnce } from '../../../upgrader/src/package.mjs';
import { assembleRecord } from '../../../../actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-record.mjs';
import { roles } from '../../../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { CHECKOUT, RES, fixtureRepo, fleetFacts, nodeSite, sha, tempDir } from './fleet-fixtures.mjs';

const R = 'work/independent-ci-resident-v1';
const VERSION = '2026.11.12-1';
const PY = ['python', 'python3'].find(c => spawnSync(c, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3') ?? null;
const cleanups = [];
const keep = { after: f => cleanups.push(f) };
after(async () => { for (const f of cleanups.reverse()) await f(); });
const readJson = f => JSON.parse(fsSync.readFileSync(f, 'utf8'));

export function acceptanceOf(release, over = {}) {
  const decision = randomUUID(), receipt = randomUUID();
  const fleetRefs = { sourceAcceptanceRef: decision, hostQualificationRef: randomUUID(), ownerAuthorizationRef: decision, publisherQualificationRef: decision,
    ownerPackageAcceptanceRef: decision, installationReceiptRef: receipt, ownerDecisionRef: decision, ownerReceiptRef: receipt, formalRoles: roles() };
  return { contract: 'clued.independent-ci.fleet-node-acceptance/1', version: release.source.version, archive_sha256: release.source.archive_sha256,
    commit: release.source.commit, repository: 'tdoljyj/cross-memory-system', cluedDecision: decision.slice(0, 8), acceptedAt: '2026-11-12T00:00:00Z', fleetRefs, ...over };
}

// The package's Python tools: rehearse.py always a stub (it reads the real C:\ProgramData root and runs the installed tools; a fixture
// site has neither), writing the PASS report prep.py checks (this package, commit and configuration bytes); prep.py and generate.py
// stubs unless named in `real`. Every call is recorded, with the plan as generate.py saw it.
// liveRoot: generate.py's LIVE_ROOT (a constant: the real C:\ProgramData root) replaced by the fixture site's, in a copy next to it.
function pythonTools({ real = [], rehearsal = 'REHEARSAL_PASS', liveRoot = null, pause = 'confirm', check = 0 } = {}) {
  const calls = [], pauses = [];
  const fn = (script, args) => {
    const opt = n => args[args.indexOf(n) + 1];
    const name = path.basename(script) + (path.basename(script) === 'generate.py' && args.includes('--check') ? ' --check' : '');
    calls.push({ name, script, args, plan: name.startsWith('generate.py') ? readJson(opt('--fleet-plan')) : null });
    if (real.includes(path.basename(script))) {
      if (path.basename(script) === 'generate.py' && liveRoot) {
        const live = "LIVE_ROOT = BS.join(['C:', 'ProgramData', 'CluedIndependentCI', 'resident'])";
        const text = fsSync.readFileSync(script, 'utf8');
        assert.equal(text.split(live).length, 2, 'generate.py names its live root once');
        script = path.join(path.dirname(script), 'generate.fixture-root.py');
        fsSync.writeFileSync(script, text.replace(live, `LIVE_ROOT = ${JSON.stringify(liveRoot)}`));
      }
      const r = spawnSync(PY, ['-I', script, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, last: r.stdout.trim().split(/\r?\n/).at(-1) };
    }
    if (name === 'rehearse.py') {
      const cfg = readJson(args[0]);
      const report = { contract: 'clued.independent-ci.reinstall-rehearsal/1', status: rehearsal, findings: rehearsal === 'REHEARSAL_PASS' ? [] : [{ code: 'FIXTURE_FINDING' }],
        node: cfg.node, commit: opt('--commit'), packageManifestSha256: sha(fsSync.readFileSync(path.join(opt('--package'), 'package-manifest.json'))),
        configSha256: sha(fsSync.readFileSync(args[0])), observedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
      const file = path.join(cfg.workDir, 'rehearsal', 'rehearsal.stub.json');
      fsSync.writeFileSync(file, JSON.stringify(report), { flag: 'wx' });
      return { status: rehearsal === 'REHEARSAL_PASS' ? 0 : 1, stdout: JSON.stringify({ status: rehearsal, report: file, findings: report.findings }, null, 1), stderr: '' };
    }
    if (name === 'pause-old-resident.py') {
      // W1 (the real one requests a pause of the live C:\ProgramData resident: never here): the reason the configuration names; its own
      // pause again is confirmed at once (reusedExistingRequest), another one is refused as the real tool refuses it
      const cfg = readJson(args[0]), root = path.dirname(path.dirname(cfg.nodeExe)), reason = cfg.launcher.w1PauseReason;
      const file = path.join(root, 'state', 'PAUSED.json');
      const want = sha(Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.resident-pause/1', reason })));
      let reused = true;
      if (!fsSync.existsSync(file)) { fsSync.mkdirSync(path.dirname(file), { recursive: true }); fsSync.writeFileSync(file, JSON.stringify({ source: { reason, requestSha256: want } })); reused = false; }
      const raw = fsSync.readFileSync(file), paused = JSON.parse(raw);
      const out = pause !== 'confirm' ? { status: pause } : paused.source.requestSha256 !== want
        ? { status: 'OLD_RESIDENT_PAUSED_BY_OTHER_REQUEST_RESUME_REQUIRED', pausedSha256: sha(raw) }
        : { status: 'OLD_RESIDENT_PAUSED_NO_OPEN_BATCH', pausedSha256: sha(raw), pausedRequestSha256: want, reusedExistingRequest: reused };
      pauses.push(out);
      return { status: out.status === 'OLD_RESIDENT_PAUSED_NO_OPEN_BATCH' ? 0 : 2, stdout: `{"request":"x"}\n${JSON.stringify(out)}\n`, stderr: '' };
    }
    if (name === 'prep.py') {
      const w = readJson(args[0]).workDir;
      fsSync.mkdirSync(path.join(w, 'linux'), { recursive: true });
      const out = { scripts: {}, paths: {} };
      for (const n of Object.values(LINUX_SCRIPTS)) {
        const p = path.join(w, 'linux', n), b = Buffer.from(`#!/usr/bin/bash\n# ${n}\n`);
        fsSync.writeFileSync(p, b, { flag: 'wx' });
        out.scripts[n] = sha(b); out.paths[n] = p;
      }
      return { status: 0, stdout: JSON.stringify(out, null, 1), stderr: '' };
    }
    if (name === 'generate.py --check') return { status: check, stdout: check ? '' : '{"status":"FLEET_LAUNCHER_CHECK_PASS"}', stderr: check ? 'FIXTURE_CHECK_REFUSED' : '' };
    const plan = readJson(opt('--fleet-plan'));
    fsSync.writeFileSync(opt('--out'), `# launcher for ${plan.node} ${plan.packageManifestSha256}\n`, { flag: 'wx' });
    return { status: 0, stdout: '{"status":"OK"}', stderr: '' };
  };
  return { calls, pauses, fn };
}
const SCM = () => ({ sddl: 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)' });

let world = null;
async function getWorld() {
  if (world) return world;
  const { repo, commit } = await fixtureRepo(keep);
  const a = await nodeSite(keep, 'a', fleetFacts());
  // other refs, other role material, its own companion account and a heartbeat token
  const b = await nodeSite(keep, 'b', fleetFacts(), { companionAccount: true, heartbeat: true });
  const d = await tempDir(keep, 'fleetinst');
  const r1 = await buildUniversal({ repo, commit, version: VERSION, out: path.join(d, 'out1') });
  const r2 = await buildUniversal({ repo, commit, version: VERSION, out: path.join(d, 'out2') });
  const release = JSON.parse(await fs.readFile(r1.release, 'utf8'));
  // the acceptance file as the coordinator writes it: the draft, then source-hash's ciSourceManifestSha256 (from the package and fleetRefs alone)
  const draft = acceptanceOf(release);
  const sh = await sourceHashOf({ artifactPath: r1.tar, artifactSha256: release.source.archive_sha256, acceptance: draft });
  world = { repo, commit, a, b, d, r1, r2, release, tar: r1.tar, sourceHash: sh, acceptance: { ...draft, ciSourceManifestSha256: sh.ciSourceManifestSha256 } };
  return world;
}
const prepare = (w, n, work, over = {}) => prepareInstall({ artifactPath: w.tar, artifactSha256: w.release.source.archive_sha256, acceptance: w.acceptance, root: n.root,
  workDir: work, scm: SCM, ...over });

test('universal: two builds of one commit, the same tar; the reinstall subset, no node configuration, no test', { timeout: 600_000 }, async () => {
  const w = await getWorld();
  assert.equal(sha(await fs.readFile(w.r1.tar)), sha(await fs.readFile(w.r2.tar)));
  const names = new Set(readTar(await fs.readFile(w.tar)).map(e => e.path));
  for (const p of ['rollout/fleet/install.mjs', 'rollout/fleet/upgrade.mjs', 'rollout/precheck.mjs', 'windows/install-resident.ps1', 'windows/verify-resident.ps1',
    'windows/uninstall-resident.ps1', 'windows/CompanionTaskRegistrar.cs', 'reinstall/launcher/generate.py', 'reinstall/launcher/template.ps1', 'reinstall/linux/prep.py',
    'reinstall/launcher/expected-plan.ps1', 'reinstall/launcher/continue.py', 'reinstall/launcher/continue-install.ps1', 'reinstall/tools/file-locks.ps1',
    'reinstall/tools/ledger-evidence.py',
    'reinstall/linux/assemble.py', 'reinstall/linux/tools/derive-roles.py', 'reinstall/tools/check-record.mjs', 'reinstall/tools/rconfig.py', 'reinstall/rehearse.py',
    'upgrader/src/package.mjs', 'linux/bin/clued-ci-upgrade-linux', 'config/policy.example.json', 'tools/build-package.mjs', 'src/canonical.mjs']) {
    assert.ok(names.has(`tree/${R}/${p}`), p);
  }
  assert.ok(names.has('tree/work/actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-record.mjs'));
  for (const n of names) assert.ok(!/\/reinstall\/(test|config)\/|\/rollout\/fleet\/test\/|README\.fixture|__pycache__/.test(n), n);
});

test('install: one archive and one acceptance, two nodes: one Source, two packages the frozen upgrader reads; the configuration, the plan, the tools in order',
  { timeout: 600_000 }, async () => {
    const w = await getWorld();
    const results = [];
    for (const n of [w.a, w.b]) {
      const py = pythonTools();
      const work = path.join(n.dir, 'install');
      const r = await prepare(w, n, work, { python: py.fn });
      // the result line
      assert.deepEqual(Object.keys(r).sort(), ['installPlan', 'launcher', 'node', 'runCommand', 'status', 'version', 'workDir']);
      assert.equal(r.status, 'FLEET_NODE_INSTALL_PREPARED');
      assert.equal(r.node, n.profile.nodeName);
      assert.equal(r.launcher.sha256, sha(await fs.readFile(path.join(work, 'launcher.ps1'))));
      assert.ok(r.runCommand.includes(`'${r.launcher.sha256}'`) && r.runCommand.includes(path.join(work, 'launcher.ps1')) && r.runCommand.endsWith('-RunApprovedInstall'));
      // the plan: every field of sections 3 and 7
      const plan = readJson(r.installPlan);
      assert.deepEqual(Object.keys(plan).sort(), ['archive_sha256', 'ciSourceManifestSha256', 'commit', 'companionAccount', 'contract', 'expectedInstalledLinux', 'expectedLinux', 'launcher', 'linux',
        'linuxManifestSha256', 'node', 'packageDir', 'packageManifestSha256', 'reasons', 'secrets', 'version', 'w1Paused'].sort());
      // W1: the last step before the launcher, with the plan's reason; the PAUSED.json it confirmed is pinned for generate.py
      const pausedRaw = await fs.readFile(path.join(n.root, 'state', 'PAUSED.json'));
      assert.deepEqual(plan.w1Paused, { sha256: sha(pausedRaw), reason: plan.reasons.w1Pause });
      assert.equal(JSON.parse(pausedRaw).source.reason, plan.reasons.w1Pause);
      assert.equal(plan.ciSourceManifestSha256, w.acceptance.ciSourceManifestSha256, 'the Source the acceptance names (source-hash)');
      assert.deepEqual(Object.keys(plan.linux).sort(), ['distribution', 'inDir', 'outDir', 'scripts', 'timeoutSeconds', 'wslInDir']);
      assert.deepEqual(Object.keys(plan.linux.scripts).sort(), ['A', 'B', 'BResume']);
      assert.deepEqual(Object.keys(plan.expectedLinux).sort(), ['ciSourceManifestSha256', 'generation', 'manifestSha256', 'packageManifestSha256']);
      assert.equal(plan.contract, PLAN_CONTRACT);
      assert.deepEqual([plan.version, plan.commit, plan.archive_sha256, plan.companionAccount], [VERSION, w.commit, w.release.source.archive_sha256, n.letter === 'b']);
      assert.equal(plan.linux.distribution, n.profile.wslDistribution);
      // the out directory: a new one under the CI root that only the elevated launcher makes (prepare made nothing there)
      assert.equal(plan.linux.inDir, path.join(work, 'linux-in'));
      assert.match(plan.linux.outDir, /^C:\\ProgramData\\CluedIndependentCI\\reinstall-linux-out-[0-9a-f]{32}$/);
      assert.equal(fsSync.existsSync(plan.linux.outDir), false);
      assert.equal(plan.linux.wslInDir, `/mnt/${work[0].toLowerCase()}/${work.slice(3).replace(/\\/g, '/')}/linux-in`);
      for (const [k, file] of Object.entries(LINUX_SCRIPTS)) assert.deepEqual(plan.linux.scripts[k], { path: path.join(work, 'linux', file), sha256: sha(await fs.readFile(path.join(work, 'linux', file))) });
      assert.deepEqual(plan.linux.timeoutSeconds, { A: 1800, B: 7200 });
      assert.deepEqual(plan.expectedLinux, { generation: 1, ciSourceManifestSha256: plan.ciSourceManifestSha256, manifestSha256: plan.linuxManifestSha256, packageManifestSha256: plan.packageManifestSha256 });
      // section 8: the installed tokens from the receipt (targets, fingerprints, binding id), the installed Linux generation A must find
      const receipt = readJson(path.join(n.root, 'install', 'install-receipt.json')), hb = receipt.heartbeatToken;
      assert.deepEqual(plan.secrets, { source: 'installed', upgradeToken: { target: receipt.upgradeToken.target, fingerprint: receipt.upgradeToken.fingerprint },
        heartbeatToken: hb ? { target: hb.target, fingerprint: hb.fingerprint, bindingId: hb.bindingId } : null });
      assert.equal(!!hb, n.letter === 'b');
      const current = readJson(path.join(n.root, 'upgrade', 'current.json'));
      assert.deepEqual(plan.expectedInstalledLinux, { generation: 1, manifestSha256: n.pkg.linuxSha, ciSourceManifestSha256: n.pkg.ciSource });
      assert.deepEqual(plan.expectedInstalledLinux, current.linux);
      assert.deepEqual(plan.reasons, reasonsOf(VERSION));
      assert.deepEqual(plan.reasons, { pause: 'fleet-node-reinstall-2026-11-12-1-hold-after-install', rearm: 'fleet-node-reinstall-2026-11-12-1-rearm-after-verify',
        w1Pause: 'fleet-node-reinstall-2026-11-12-1-w1-before-linux-switch' });
      assert.deepEqual(plan.launcher, r.launcher);
      // rehearse.py, prep.py (block 2's form), generate.py, in that order, from the archive's tree
      const tree = path.join(work, `tree-${w.commit.slice(0, 8)}`, ...R.split('/'));
      const config = path.join(work, 'inputs', 'reinstall-config.json');
      assert.deepEqual(py.calls.map(c => c.name), ['rehearse.py', 'prep.py', 'generate.py --check', 'pause-old-resident.py', 'generate.py']);
      assert.equal(py.calls[0].script, path.join(tree, 'reinstall', 'rehearse.py'));
      assert.deepEqual(py.calls[0].args, [config, '--commit', w.commit, '--package', plan.packageDir, '--file-locks-in-launcher', '--fleet']);
      assert.equal(py.calls[1].script, path.join(tree, 'reinstall', 'linux', 'prep.py'));
      const pa = py.calls[1].args;
      assert.deepEqual(pa.slice(0, 5), [config, w.commit, plan.ciSourceManifestSha256, w.acceptance.fleetRefs.sourceAcceptanceRef, plan.packageDir]);
      assert.match(pa[5], /^f\d{8}t\d{6}$/);
      assert.deepEqual(pa.slice(6), ['--in-dir', plan.linux.inDir, '--out-dir', plan.linux.outDir, path.join(work, 'inputs', 'installed', 'version-facts.json'),
        path.join(work, 'inputs', 'installed', 'generation.json'), path.join(work, 'rehearsal', 'rehearsal.stub.json')]);
      // generate.py --check before W1 (a launcher that cannot be generated never leaves the old resident paused), then W1, then generate.py
      assert.equal(py.calls[2].script, path.join(tree, 'reinstall', 'launcher', 'generate.py'));
      assert.deepEqual(py.calls[2].args, ['--fleet-plan', r.installPlan, '--check']);
      assert.deepEqual(py.calls[2].plan, { ...plan, w1Paused: null, launcher: null }, 'the check reads the whole plan before the pause');
      assert.equal(py.calls[3].script, path.join(tree, 'reinstall', 'tools', 'pause-old-resident.py'));
      assert.deepEqual(py.calls[3].args, [config]);
      assert.equal(py.calls[4].script, path.join(tree, 'reinstall', 'launcher', 'generate.py'));
      assert.deepEqual(py.calls[4].args, ['--fleet-plan', r.installPlan, '--out', path.join(work, 'launcher.ps1')]);
      assert.deepEqual(py.calls[4].plan, { ...plan, launcher: null }, 'generate.py reads the whole plan, launcher not yet set');
      // the synthesized configuration: rconfig.py loads it; the node's values; the copies it names are the installed bytes
      const cfg = readJson(config);
      assert.deepEqual([cfg.workDir, cfg.basePackage, cfg.nodeExe, cfg.upgradeTokenFile], [work, plan.packageDir, path.join(n.root, 'runtime', 'node.exe'), receipt.upgradeToken.target]);
      assert.deepEqual(cfg.linux.host, { toolchainNodeSha256: n.toolchainSha, resultPublicKeySha256: n.resultPublicKeySha256 });
      assert.deepEqual(cfg.launcher, { pauseReason: plan.reasons.pause, rearmReason: plan.reasons.rearm, w1PauseReason: plan.reasons.w1Pause });
      await assert.rejects(fs.access(cfg.linux.installedManifest), 'the installed Linux manifest is not on the Windows side (section 8.2)');
      assert.equal(sha(await fs.readFile(path.join(cfg.linux.installedRoles, 'formal-source-manifest-v2.json'))), n.pkg.ciSource);
      assert.deepEqual(cfg.heartbeat ?? null, hb ? { tokenFile: hb.target, bindingId: hb.bindingId } : null);
      assert.deepEqual([cfg.operatorSid ?? null, cfg.companionAccount ?? null], n.letter === 'b'
        ? [readJson(path.join(n.root, 'install', 'companion-account.json')).operatorSid, { wslVhdxDirectory: `D:\\fixture-resident\\wsl\\${n.profile.wslDistribution}` }] : [null, null]);
      if (PY) {
        const load = spawnSync(PY, ['-I', '-c', 'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("c",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); c=m.load(sys.argv[2]); m.need_installed_linux(c); print(c["_sha256"])',
          path.join(tree, 'reinstall', 'tools', 'rconfig.py'), config], { encoding: 'utf8' });
        assert.equal(load.status, 0, load.stderr);
        assert.equal(load.stdout.trim(), sha(await fs.readFile(config)));
      }
      // the bare repository the rehearsal derives roles from: the commit, from the bundle
      assert.equal(spawnSync('git', ['-C', cfg.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), w.commit);
      // the companion account: RX on the inputs, Modify on the scripts' output directory; none on an Owner-run node
      // linux-in: assemble.py's layout, the package's bytes, src.git at the commit
      for (const f of ['record/source-manifest.json', 'tools/clued-ci-install-source-v2', 'linux-pkg/upgrade-v1/bin/clued-ci-upgrade-linux', 'linux-pkg/upgrade-v1/manifest.json',
        'linux-pkg/source-v2/source.bundle', 'linux-res-pkg/manifest.json', 'linux-res-pkg/systemd/clued-ci-worker@.service', 'tools/install-resident-linux.sh',
        'tools/check-host-r4.py', 'tools/verify-signed-r4.mjs', 'tools/derive-roles-r7.py']) await fs.access(path.join(work, 'linux-in', ...f.split('/')));
      assert.equal(sha(await fs.readFile(path.join(work, 'linux-in', 'linux-res-pkg', 'manifest.json'))), plan.linuxManifestSha256);
      assert.equal(spawnSync('git', ['-C', path.join(work, 'linux-in', 'src.git'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), w.commit);
      // the package: the frozen upgrader's reader; a fresh install of this node, the accepted Source
      const pkg = await readPackageOnce(plan.packageDir, plan.packageManifestSha256);
      const m = pkg.manifest;
      assert.equal(m.ciSourceManifestSha256, plan.ciSourceManifestSha256);
      assert.equal(m.linux.manifestSha256, plan.linuxManifestSha256);
      assert.equal(m.nodeProfileSha256, n.pkg.manifest.nodeProfileSha256);
      assert.equal(m.acceptance.decisionRef, w.acceptance.fleetRefs.ownerDecisionRef);
      assert.equal(m.residentManifestSha256, w.release.source.resident_manifest_sha256);
      assert.equal(m.linux.sourceV2.commit, w.commit);
      assert.ok(m.files.some(f => f.target === 'upgrader\\config\\upgrader.json'), 'a fresh install places the upgrader');
      const policy = JSON.parse(pkg.bytesByPath.get(m.files.find(f => f.target === 'config\\policy.json').path).toString('utf8'));
      assert.deepEqual(policy.ownerAcceptance, { decisionRef: w.acceptance.fleetRefs.ownerDecisionRef, installReceiptRef: w.acceptance.fleetRefs.installationReceiptRef });
      // the Linux resident manifest's external pins: the package's units' entry points (section 8.2), source-v2 files of this commit, the node's toolchain
      const readTree = rel => fsSync.readFileSync(path.join(work, `tree-${w.commit.slice(0, 8)}`, ...rel.split('/')));
      const SV2 = '/opt/clued-independent-ci/source-v2/';
      assert.deepEqual(readJson(path.join(plan.packageDir, 'linux', 'manifest.json')).files.slice(4), [
        { installedPath: '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node', sha256: n.toolchainSha },
        ...['work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4/linux-worker.mjs', 'work/actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-workspaces.py']
          .map(rel => ({ installedPath: SV2 + rel, sha256: sha(readTree(rel)) }))]);
      // the record: the node's own values, the fleet's references
      const acc = JSON.parse(pkg.bytesByPath.get('record/acceptance.json').toString('utf8'));
      const installed = readJson(path.join(n.root, 'record', 'acceptance.json'));
      for (const k of FLEET_REF_KEYS.filter(k => k !== 'ownerReceiptRef' && k !== 'ownerDecisionRef')) assert.equal(acc[k], w.acceptance.fleetRefs[k], k);
      assert.deepEqual([acc.ownerDecisionRef, acc.ownerReceiptRef, acc.acceptedAt], [w.acceptance.fleetRefs.ownerDecisionRef, w.acceptance.fleetRefs.ownerReceiptRef, w.acceptance.acceptedAt]);
      for (const k of ['node', 'ciPrincipalQualificationRef', 'ciPrincipalBindingId', 'ciTokenPinSha256', 'appPublicKeySha256Base64']) assert.deepEqual(acc[k], installed[k], k);
      const signers = JSON.parse(pkg.bytesByPath.get('record/signers.json').toString('utf8')).signers;
      assert.deepEqual(signers.map(s => [s.publicKeyPem, s.sourceAcceptanceRef, s.qualificationRef]),
        [[n.signer.publicKeyPem, w.acceptance.fleetRefs.sourceAcceptanceRef, w.acceptance.fleetRefs.hostQualificationRef]]);
      // the source-v2 roles: the installed policies re-derived for the new manifest and references
      const derived = rolesDerivedReinstall({ node: await readNode({ root: n.root }), newManifestBytes: pkg.bytesByPath.get('record/source-manifest.json'), readTreeFile: readTree });
      assert.deepEqual(m.linux.sourceV2.rolesDerivedSha256, derived);
      results.push({ plan, m });
    }
    assert.equal(results[0].plan.ciSourceManifestSha256, results[1].plan.ciSourceManifestSha256, 'one acceptance, one Source on every node');
    assert.notEqual(results[0].plan.packageManifestSha256, results[1].plan.packageManifestSha256, 'each node its own identity');
    assert.notEqual(results[0].m.nodeIdentitySha256, results[1].m.nodeIdentitySha256);
  });

// The package's prep.py and generate.py, not stubs. rehearse.py stays a stub: it reads the real C:\ProgramData root and runs the node's
// installed uninstall/verify tools, which a fixture site does not have (on DESK it runs for real, see the report). generate.py runs with
// LIVE_ROOT = the fixture site: it accepts the plan, the package, the three scripts, the companion account records, secrets and reasons,
// and its --check stops where it first reads the live host: the runner service (a fixture node's does not exist, 1060), so W1 never runs.
test('install, no stubs for prep.py and generate.py: A.sh, B.sh, B-resume.sh for both nodes; generate.py accepts the plan up to the live host',
  { timeout: 600_000, skip: PY ? false : 'no Python 3 here' }, async () => {
    const w = await getWorld();
    for (const n of [w.a, w.b]) {
      const py = pythonTools({ real: ['prep.py', 'generate.py'], liveRoot: n.root });
      const work = path.join(n.dir, 'install-real');
      // the real generate.py --check reads the live host as the launcher's generation does: it stops at the runner service, BEFORE W1
      const hasCheck = fsSync.readFileSync(path.join(RES, 'reinstall', 'launcher', 'generate.py'), 'utf8').includes("'--check'");
      await assert.rejects(prepare(w, n, work, { python: py.fn }),
        e => {
          if (e.code === 'LAUNCHER_CHECK_FAILED' && (!hasCheck || /RUNNER_SERVICE_FACTS_UNREADABLE', \[.*RunnerService\.exe.*\], 1060\)/.test(e.detail))) return true;
          throw new Error(`generate.py --check must stop at the live runner service only: ${e.code} ${String(e.detail ?? e.message).slice(-1200)}`);
        });
      assert.deepEqual(py.calls.map(c => c.name), ['rehearse.py', 'prep.py', 'generate.py --check'], 'W1 never runs after a refused check');
      assert.equal(py.pauses.length, 0);
      const plan = readJson(path.join(work, 'install-plan.json'));
      assert.equal(plan.launcher, null);
      const texts = {};
      for (const [k, file] of Object.entries(LINUX_SCRIPTS)) {
        const b = await fs.readFile(path.join(work, 'linux', file));
        assert.equal(sha(b), plan.linux.scripts[k].sha256);
        assert.ok(!b.includes(0x0d), file);
        texts[file] = b.toString('utf8');
      }
      const wsl = p => `/mnt/${p[0].toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}`;
      for (const [file, t] of Object.entries(texts)) {
        assert.ok(t.includes(`\nW=${wsl(plan.linux.inDir)}\nO=${wsl(plan.linux.outDir)}\n`), file);
        assert.ok(t.includes(w.commit) && t.includes(plan.ciSourceManifestSha256), file);
        assert.ok(t.includes(n.toolchainSha), `${file}: the node's toolchain node pin`);
      }
      // the one signing path (Source v1 is retired): B signs from the installed roles-v3; the derived roles are the package's
      assert.ok(texts['B.sh'].includes('sign-qualification.mjs'));
      for (const h of Object.values(readJson(path.join(plan.packageDir, 'package-manifest.json')).linux.sourceV2.rolesDerivedSha256)) assert.ok(texts['A.sh'].includes(`= ${h} ] || refuse SOURCE_V2_DERIVED_ROLE_MISMATCH`), h);
    }
  });

// DESIGN section 73, the field timeline of 2026-11-13 (desk-w-591). The launch of an earlier package ran Linux A and B and then stopped at
// its Windows preflight (RUNNER_SERVICE_NOT_AS_REVIEWED): the Linux side is that package's generation 1, the Windows side the install
// before it (current.json still names the old Linux generation), and the launch's W1 pause is still in force. The node's files after it:
// the Linux version facts and role copies of that package (its Source, its acceptance references), the Windows record unchanged.
async function leaveHalfInstalled(root, { ciSourceManifestSha256, w1Reason = null }) {
  const responses = path.join(root, 'upgrade', 'mailbox', 'responses');
  const facts = readJson(path.join(responses, 'version-facts.json')), copy = readJson(path.join(responses, 'roles-public.json'));
  const installedCi = readJson(path.join(root, 'upgrade', 'current.json')).ciSourceManifestSha256;
  const refs = new Map();
  for (const role of FORMAL_ROLES) {
    const policy = JSON.parse(Buffer.from(copy.files[`${role}.json`].base64, 'base64').toString('utf8'));
    for (const k of ['sourceAcceptanceRef', 'hostAcceptanceRef']) if (!refs.has(policy[k])) refs.set(policy[k], randomUUID());
    for (const [name, key] of [[`${role}.json`, 'policySha256'], [`${role}.qualification.json`, 'qualificationSha256']]) {
      let text = Buffer.from(copy.files[name].base64, 'base64').toString('utf8').replaceAll(installedCi, ciSourceManifestSha256);
      for (const [from, to] of refs) text = text.replaceAll(from, to);
      const b = Buffer.from(text, 'utf8');
      copy.files[name] = { sha256: sha(b), base64: b.toString('base64') };
      facts.roles[role][key] = sha(b);
    }
  }
  Object.assign(facts, { ciSourceManifestSha256, sourceCommit: 'd'.repeat(40), manifestSha256: sha(Buffer.from(`linux manifest of ${ciSourceManifestSha256}`)) });
  await fs.writeFile(path.join(responses, 'version-facts.json'), JSON.stringify(facts));
  await fs.writeFile(path.join(responses, 'roles-public.json'), JSON.stringify(copy));
  let pausedSha256 = null;
  if (w1Reason) {
    const paused = Buffer.from(JSON.stringify({ at: '2026-11-13T09:09:58.000Z', source: { reason: w1Reason, requestSha256: sha(Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.resident-pause/1', reason: w1Reason }))) } }));
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    await fs.writeFile(path.join(root, 'state', 'PAUSED.json'), paused);
    pausedSha256 = sha(paused);
  }
  return { facts, pausedSha256, installedCi };
}

test('install: a node an earlier package\'s launch left half installed (Linux new, Windows old, its W1 pause in force) is prepared as it is; this package\'s own half install is sent to its continuation',
  { timeout: 600_000, skip: PY ? false : 'no Python 3 here' }, async t => {
    const w = await getWorld();
    const d = await tempDir(t, 'fleethalf');
    const root = path.join(d, 'root');
    await fs.cp(w.b.root, root, { recursive: true });
    const earlier = reasonsOf('2026.11.13-8238bbf2').w1Pause;
    const half = await leaveHalfInstalled(root, { ciSourceManifestSha256: '1c'.repeat(32), w1Reason: earlier });
    assert.notEqual(half.facts.ciSourceManifestSha256, half.installedCi, 'the two sides name different packages');
    // each side from its own record: the Linux side is what its facts say, its Source manifest is not on the Windows side, the pause is a reinstall's W1
    const node = await readNode({ root });
    assert.deepEqual(node.expectedInstalledLinux, { generation: 1, manifestSha256: half.facts.manifestSha256, ciSourceManifestSha256: half.facts.ciSourceManifestSha256 });
    assert.equal(node.linuxMan, null);
    assert.equal(node.installedW1Reason, earlier);
    assert.equal(node.current.linux.ciSourceManifestSha256, half.installedCi, 'the Windows record is untouched');

    const py = pythonTools({ real: ['prep.py'] });
    const work = path.join(d, 'work');
    const out = await prepare(w, w.b, work, { root, python: py.fn });
    assert.equal(out.status, 'FLEET_NODE_INSTALL_PREPARED');
    const plan = readJson(out.installPlan);
    // Linux A and B run from what Linux is now to this package; the Windows side from what it is now
    assert.deepEqual(plan.expectedInstalledLinux, node.expectedInstalledLinux);
    assert.equal(plan.expectedLinux.ciSourceManifestSha256, w.acceptance.ciSourceManifestSha256);
    const a = fsSync.readFileSync(path.join(work, 'linux', LINUX_SCRIPTS.A), 'utf8');
    assert.match(a, new RegExp(`^OLD_MANIFEST=${half.facts.ciSourceManifestSha256}$`, 'm'));
    assert.match(a, new RegExp(`^OLD_LINUX_RES_MANIFEST=${half.facts.manifestSha256}$`, 'm'));
    assert.match(a, /^OLD_GENERATION=1$/m);
    assert.ok(a.includes('refuse INSTALLED_MANIFEST_NOT_SOURCE34') && a.includes('--old-manifest-file /etc/clued-independent-ci/formal-source-manifest-v2.json'), 'A reads the Linux side\'s own Source manifest, as root');
    const m = readJson(path.join(plan.packageDir, 'package-manifest.json'));
    assert.deepEqual(m.linux.sourceV2.rolesDerivedSha256, rolesDerivedReinstall({ node, newManifestBytes: fsSync.readFileSync(path.join(plan.packageDir, 'record', 'source-manifest.json')),
      readTreeFile: rel => fsSync.readFileSync(path.join(work, `tree-${w.commit.slice(0, 8)}`, ...rel.split('/'))) }));
    for (const h of Object.values(m.linux.sourceV2.rolesDerivedSha256)) assert.ok(a.includes(`= ${h} ] || refuse SOURCE_V2_DERIVED_ROLE_MISMATCH`), h);
    const installed = path.join(work, 'inputs', 'installed');
    assert.ok(!fsSync.existsSync(path.join(installed, 'roles-v3', 'formal-source-manifest-v2.json')), 'no copy that is not the Linux side\'s');
    assert.deepEqual(readJson(path.join(installed, 'version-facts.json')), half.facts);
    assert.ok(py.calls.find(c => c.name === 'rehearse.py').args.includes('--fleet'));
    // the earlier launch's W1 pause is this launch's: one pause, never a second request, never a person lifting it first
    assert.equal(plan.reasons.w1Pause, earlier);
    assert.notEqual(reasonsOf(VERSION).w1Pause, earlier);
    assert.deepEqual(plan.w1Paused, { sha256: half.pausedSha256, reason: earlier });
    assert.equal(readJson(path.join(work, 'inputs', 'reinstall-config.json')).launcher.w1PauseReason, earlier);
    assert.deepEqual(py.pauses.map(x => [x.status, x.reusedExistingRequest, x.pausedSha256]), [['OLD_RESIDENT_PAUSED_NO_OPEN_BATCH', true, half.pausedSha256]]);
    assert.equal(sha(fsSync.readFileSync(path.join(root, 'state', 'PAUSED.json'))), half.pausedSha256, 'the pause was not replaced');

    // a pause that is not a reinstall's W1 is somebody else's: not adopted, and W1 refuses it as before
    const foreign = path.join(d, 'foreign');
    await fs.cp(w.b.root, foreign, { recursive: true });
    await leaveHalfInstalled(foreign, { ciSourceManifestSha256: '1c'.repeat(32), w1Reason: 'owner-maintenance' });
    assert.equal((await readNode({ root: foreign })).installedW1Reason, null);
    await assert.rejects(prepare(w, w.b, path.join(d, 'work-foreign'), { root: foreign, python: pythonTools().fn }), { code: 'W1_PAUSE_NOT_CONFIRMED' });

    // this package's own launch stopped after Linux B: Linux is already this package's. Its Linux phases cannot run over themselves:
    // refused before anything is written, with the way on (the continuation of that launch)
    const same = path.join(d, 'same');
    await fs.cp(w.b.root, same, { recursive: true });
    await leaveHalfInstalled(same, { ciSourceManifestSha256: w.acceptance.ciSourceManifestSha256, w1Reason: reasonsOf(VERSION).w1Pause });
    const sameWork = path.join(d, 'work-same');
    await assert.rejects(prepare(w, w.b, sameWork, { root: same, python: () => { throw new Error('not reached'); } }),
      e => e.code === 'LINUX_SIDE_ALREADY_THIS_PACKAGE_CONTINUE_THE_STOPPED_LAUNCH' && /--fleet-continue/.test(e.detail.continueWith));
    await assert.rejects(fs.access(sameWork));
  });

// Section 8: the command has no node-specific argument. The same argv (the same work path, moved aside between the two runs) prepares both
// nodes; only the test's stand-ins (the fixture root, the Python tools, the SCM) differ, and the command line cannot name them.
test('install: the prepare command line is byte for byte the same on both nodes', { timeout: 600_000 }, async t => {
  const w = await getWorld();
  const d = await tempDir(t, 'fleetcmd');
  const accFile = path.join(d, 'fleet-node-2026.11.12-1.acceptance.json');
  await fs.writeFile(accFile, JSON.stringify(w.acceptance));
  const work = path.join(d, 'work');
  const argvOf = () => ['prepare', '--artifact', w.tar, '--artifact-sha', w.release.source.archive_sha256, '--acceptance', accFile, '--work', work];
  const lines = [], results = [];
  for (const n of [w.a, w.b]) {
    const argv = argvOf();
    lines.push(JSON.stringify(argv));
    results.push(await main(argv, { root: n.root, python: pythonTools().fn, scm: SCM }));
    await fs.rename(work, path.join(d, `done-${n.letter}`));
  }
  assert.equal(lines[0], lines[1]);
  // prepare again on node a, the same command: W1 finds its own pause and confirms it at once (idempotent)
  const again = pythonTools();
  const r3 = await main(argvOf(), { root: w.a.root, python: again.fn, scm: SCM });
  assert.equal(r3.status, 'FLEET_NODE_INSTALL_PREPARED');
  assert.equal(again.pauses.at(-1).reusedExistingRequest, true);
  // source-hash: the same value from the command line, without any node
  const sh = await main(['source-hash', '--artifact', w.tar, '--artifact-sha', w.release.source.archive_sha256, '--acceptance', accFile]);
  assert.deepEqual(sh, w.sourceHash);
  assert.equal(sh.ciSourceManifestSha256, w.acceptance.ciSourceManifestSha256);
  assert.deepEqual(results.map(r => [r.status, r.node]), [['FLEET_NODE_INSTALL_PREPARED', w.a.profile.nodeName], ['FLEET_NODE_INSTALL_PREPARED', w.b.profile.nodeName]]);
  await assert.rejects(main([...argvOf(), '--root', w.a.root]), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
  for (const gone of ['--installed-package', '--upgrade-token-file', '--heartbeat-token-file']) await assert.rejects(main([...argvOf(), gone, 'C:\\x']), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' }, gone);
});

test('install refuses: archive sha, acceptance, tampered entry, climbing path, an installer not the archive\'s, stale facts, rehearsal, token files',
  { timeout: 600_000 }, async t => {
    const w = await getWorld();
    const d = await tempDir(t, 'fleetinstbad');
    let k = 0;
    const run = (over = {}) => prepare(w, w.a, path.join(d, `w${k++}`), { python: () => { throw new Error('not reached'); }, ...over });
    const changed = Buffer.from(await fs.readFile(w.tar)); changed[changed.length - 2000] ^= 1;
    await fs.writeFile(path.join(d, 'changed.tar'), changed);
    await assert.rejects(run({ artifactPath: path.join(d, 'changed.tar') }), { code: 'FLEET_ARTIFACT_SHA_MISMATCH' });
    await assert.rejects(run({ artifactSha256: 'f'.repeat(64) }), { code: 'FLEET_ARTIFACT_SHA_NOT_THE_ACCEPTED' });
    await assert.rejects(run({ acceptance: { ...w.acceptance, commit: 'e'.repeat(40) } }), { code: 'FLEET_ARCHIVE_NOT_THE_ACCEPTED' });
    for (const bad of [{ cluedDecision: 'abcdef12' }, { contract: 'x' }, { acceptedAt: '2099-01-01T00:00:00Z' }, { extra: 1 },
      { fleetRefs: { ...w.acceptance.fleetRefs, installationReceiptRef: randomUUID() } }, { fleetRefs: { ...w.acceptance.fleetRefs, ciPrincipalQualificationRef: randomUUID() } }]) {
      assert.throws(() => validateAcceptance({ ...w.acceptance, ...bad }), { code: 'FLEET_ACCEPTANCE_REFUSED' }, JSON.stringify(bad).slice(0, 80));
    }
    const entries = readTar(await fs.readFile(w.tar)).map(e => ({ path: e.path, data: e.path.endsWith('/reinstall/linux/prep.py') ? Buffer.concat([e.data, Buffer.from('\n')]) : e.data }));
    const forged = writeTar(entries);
    await fs.writeFile(path.join(d, 'forged.tar'), forged);
    await assert.rejects(run({ artifactPath: path.join(d, 'forged.tar'), artifactSha256: sha(forged), acceptance: { ...w.acceptance, archive_sha256: sha(forged) } }),
      { code: 'FLEET_ARCHIVE_NOT_ITS_MANIFEST' });
    // a climbing path: refused before anything is written
    const climbing = Buffer.from(writeTar([{ path: 'xx/evil.txt', data: Buffer.from('x') }]));
    climbing.write('../', 0, 'ascii');
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : climbing[i];
    climbing.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    await fs.writeFile(path.join(d, 'climb.tar'), climbing);
    const cw = path.join(d, 'climb-work');
    await assert.rejects(prepare(w, w.a, cw, { artifactPath: path.join(d, 'climb.tar'), artifactSha256: sha(climbing), acceptance: { ...w.acceptance, archive_sha256: sha(climbing) } }),
      { code: 'TAR_PATH_REFUSED' });
    await assert.rejects(fs.access(cw));
    // the running installer is not the archive's
    const other = path.join(d, 'other');
    await fs.mkdir(other);
    for (const n of OWN_MODULES) await fs.copyFile(path.join(RES, 'rollout', 'fleet', n), path.join(other, n));
    await fs.appendFile(path.join(other, 'install.mjs'), '\n// changed\n');
    await assert.rejects(run({ selfDir: other }), { code: 'FLEET_INSTALLER_NOT_THE_ARCHIVES' });
    // nothing is written before the node checks out: stale facts, no installed package, a missing token file
    const sw = path.join(d, `early${k++}`);
    await assert.rejects(prepare(w, w.a, sw, { now: Date.now() + 2 * 3_600_000 }), { code: 'LINUX_VERSION_FACTS_NOT_FRESH' });
    await assert.rejects(fs.access(sw));
    // a node with no install (a first install, README section 8c)
    const empty = path.join(d, 'empty-root');
    await fs.mkdir(empty);
    await assert.rejects(prepare(w, w.a, path.join(d, 'first'), { root: empty }), { code: 'NODE_HAS_NO_INSTALL_FIRST_INSTALL_PATH' });
    // the receipt's installed tokens: missing, unplaced or ambiguous entries are refused with what is missing
    const up = { target: 'C:\\ProgramData\\CluedIndependentCI\\resident\\secrets\\resident-upgrade.token', placed: true, fingerprint: 'a'.repeat(64) };
    const hbt = { target: 'C:\\ProgramData\\CluedIndependentCI\\resident\\secrets\\heartbeat\\ci-node-heartbeat.token', placed: true, fingerprint: 'b'.repeat(64), bindingId: randomUUID() };
    assert.deepEqual(installedSecretsOf({ upgradeToken: up }), { source: 'installed', upgradeToken: { target: up.target, fingerprint: up.fingerprint }, heartbeatToken: null });
    assert.equal(installedSecretsOf({ upgradeToken: up, heartbeatToken: { ...hbt, placed: false } }).heartbeatToken, null);
    assert.deepEqual(installedSecretsOf({ upgradeToken: up, heartbeatToken: { ...hbt, bindingId: null } }).heartbeatToken, { target: hbt.target, fingerprint: hbt.fingerprint, bindingId: null });
    for (const [receipt, code, what] of [[{}, 'INSTALLED_UPGRADE_TOKEN_UNKNOWN', ['upgradeToken.placed', 'upgradeToken.target', 'upgradeToken.fingerprint']],
      [{ upgradeToken: { ...up, placed: false } }, 'INSTALLED_UPGRADE_TOKEN_UNKNOWN', ['upgradeToken.placed']],
      [{ upgradeToken: { ...up, fingerprint: null } }, 'INSTALLED_UPGRADE_TOKEN_UNKNOWN', ['upgradeToken.fingerprint']],
      [{ upgradeToken: up, heartbeatToken: { ...hbt, target: undefined } }, 'INSTALLED_HEARTBEAT_TOKEN_UNKNOWN', ['heartbeatToken.target']],
      [{ upgradeToken: up, heartbeatToken: { ...hbt, placed: 'yes' } }, 'INSTALLED_HEARTBEAT_TOKEN_UNKNOWN', ['heartbeatToken.placed']],
      [{ upgradeToken: up, heartbeatToken: { ...hbt, bindingId: 'x' } }, 'INSTALLED_HEARTBEAT_TOKEN_UNKNOWN', ['heartbeatToken.bindingId']]]) {
      assert.throws(() => installedSecretsOf(receipt), e => e.code === code && JSON.stringify(e.detail.missing) === JSON.stringify(what), JSON.stringify(receipt).slice(0, 80));
    }
    assert.throws(() => installedSecretsOf({ upgradeToken: up, heartbeatToken: { ...hbt, target: up.target } }), { code: 'INSTALLED_HEARTBEAT_TOKEN_UNKNOWN' });
    // the acceptance names another Source or repository than this node's: refused (the Source before any script, the repository before anything)
    await assert.rejects(prepare(w, w.a, path.join(d, 'src'), { python: pythonTools().fn, acceptance: { ...w.acceptance, ciSourceManifestSha256: 'c'.repeat(64) } }),
      { code: 'FLEET_SOURCE_NOT_THE_ACCEPTED_ONE' });
    const rw = path.join(d, 'repo');
    await assert.rejects(prepare(w, w.a, rw, { acceptance: { ...w.acceptance, repository: 'other/repo' } }), { code: 'FLEET_ACCEPTANCE_NOT_THIS_REPOSITORY' });
    await assert.rejects(fs.access(rw));
    // work paths the root shell or Windows would read otherwise: a part ending in '.' or a blank, a blank inside
    for (const bad of [path.join(d, 'ends.'), path.join(d, 'ends '), path.join(d, 'has blank')]) {
      await assert.rejects(prepare(w, w.a, bad), { code: 'WORK_DIR_PATH_REFUSED' }, bad);
    }
    // W1 not confirmed (another pause, a batch still open): no plan, no launcher
    for (const status of ['OLD_RESIDENT_PAUSED_BY_OTHER_REQUEST_RESUME_REQUIRED', 'PAUSE_NOT_CONFIRMED_OR_BATCH_STILL_OPEN_DO_NOT_START_LINUX']) {
      const pw = path.join(d, `w1-${k++}`), py1 = pythonTools({ pause: status });
      await assert.rejects(prepare(w, w.a, pw, { python: py1.fn }), e => e.code === 'W1_PAUSE_NOT_CONFIRMED' && e.detail.status === status, status);
      assert.deepEqual(py1.calls.map(c => c.name), ['rehearse.py', 'prep.py', 'generate.py --check', 'pause-old-resident.py']);
      assert.deepEqual([readJson(path.join(pw, 'install-plan.json')).w1Paused, readJson(path.join(pw, 'install-plan.json')).launcher], [null, null]);
      await assert.rejects(fs.access(path.join(pw, 'launcher.ps1')));
    }
    // generate.py --check refuses: W1 never runs (the old resident is not paused), no launcher
    {
      const cw2 = path.join(d, 'check-refused'), pyc = pythonTools({ check: 1 });
      await assert.rejects(prepare(w, w.a, cw2, { python: pyc.fn }), e => e.code === 'LAUNCHER_CHECK_FAILED' && /FIXTURE_CHECK_REFUSED/.test(e.detail));
      assert.deepEqual(pyc.calls.map(c => c.name), ['rehearse.py', 'prep.py', 'generate.py --check']);
      assert.equal(pyc.pauses.length, 0);
      await assert.rejects(fs.access(path.join(cw2, 'launcher.ps1')));
    }
    // a failed rehearsal: no Linux scripts, no launcher; its findings in the refusal
    const py = pythonTools({ rehearsal: 'REHEARSAL_FAILED' });
    const fw = path.join(d, 'failed');
    await assert.rejects(prepare(w, w.a, fw, { python: py.fn }), e => e.code === 'REHEARSAL_FAILED' && e.detail.findings[0].code === 'FIXTURE_FINDING');
    assert.deepEqual(py.calls.map(c => c.name), ['rehearse.py']);
    await assert.rejects(fs.access(path.join(fw, 'install-plan.json')));
  });

test('ports: the upgrader configuration is upgrader-config.py\'s bytes; the reinstall derivation is the frozen tool\'s while the host reference stays', { timeout: 600_000 }, async t => {
  const w = await getWorld();
  const d = await tempDir(t, 'fleetinstport');
  const node = await readNode({ root: w.a.root });
  // the frozen derive_role allows only the Source references to change: keep the installed host reference
  const acceptance = acceptanceOf(w.release);
  acceptance.fleetRefs.hostQualificationRef = node.acc.hostQualificationRef;
  acceptance.fleetRefs.formalRoles = JSON.parse(JSON.stringify(Object.fromEntries(['gitleaks', 'trivy', 'contract-placement']
    .map(r => [r, Object.fromEntries(Object.entries(node.man.roles[r]).filter(([k]) => k !== 'sourceFiles' && k !== 'controllerRelay'))]))));
  const inputs = recordInputsFor(node, acceptance);
  const closure = readJson(path.join(CHECKOUT, 'work/actions-hosted-migration/independent-ci-v1/src/resident-v2/source-closure.json')).paths;
  const { files } = assembleRecord(inputs, closure.sort().map(p => ({ path: p, sha256: sha(fsSync.readFileSync(path.join(CHECKOUT, ...p.split('/')))) })));
  const manifestBytes = Buffer.from(files['source-manifest.json']);
  const readTreeFile = rel => fsSync.readFileSync(path.join(CHECKOUT, ...rel.split('/')));
  const mine = rolesDerivedReinstall({ node, newManifestBytes: manifestBytes, readTreeFile });
  const frozen = rolesDerived({ toolBytes: await fs.readFile(path.join(RES, 'linux', 'bin', 'clued-ci-upgrade-linux')), readSourceFile: readTreeFile, manifestBytes,
    ciSha: sha(manifestBytes), factsBytes: await fs.readFile(path.join(w.a.root, 'upgrade', 'mailbox', 'responses', 'version-facts.json')),
    rolesPublic: await fs.readFile(path.join(w.a.root, 'upgrade', 'mailbox', 'responses', 'roles-public.json')) });
  assert.deepEqual(mine, frozen.rolesDerivedSha256);
  if (!PY) return t.skip('no Python 3 here');
  const out = path.join(d, 'upgrader.json');
  const r = spawnSync(PY, ['-I', '-B', path.join(RES, 'reinstall', 'tools', 'upgrader-config.py'), path.join(w.a.root, 'record'), out, CHECKOUT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok((await upgraderConfigFor({ recordDir: path.join(w.a.root, 'record'), residentTree: RES })).equals(await fs.readFile(out)));
});
