// The first install (prepare on a node WITHOUT an install receipt; PLAN-first-install-20261116 PR1, tests 1 and 2): the same command
// as a reinstall, the node's values from this machine's facts (<CI root>\first-install\facts.json, the host preparation's) and the
// version's first-install kit (install.mjs first-install-kit, read-only on any installed node; accepted with the version). Before this
// change the command refused every such node (NODE_HAS_NO_INSTALL_FIRST_INSTALL_PATH) and a new node needed a hand-written
// configuration, a template node's export and README section 8c by hand.
//   1. a fresh node: FLEET_NODE_FIRST_INSTALL_PREPARED; the record's node profile is exactly the facts' (derived from the machine name),
//      its only signer the node's own; the package, the Linux inputs (template, role image archives), the scripts of the package's
//      first-install.py (--in-dir form; for real when Python is here), the plan (firstInstall, no W1, the host preparation's tokens).
//   2. residue (a resident service or root, no receipt) is refused by name before anything is written; and the kit, the facts and the
//      controller runtime are held to what was accepted and derived.
// Nothing here touches a real host directory, a service, the network or a secret.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { CI_ROOT, FIRST_INSTALL_VHDX_DIRECTORY, RESIDENT_SERVICE_SID, firstInstallCheck, LINUX_SCRIPTS, PLAN_CONTRACT, firstInstallKitOf, imageAssetOf, main, prepareInstall, readKit, sourceHashOf } from '../install.mjs';
import { buildUniversal } from '../universal.mjs';
import { readPackageOnce } from '../../../upgrader/src/package.mjs';
import { roles } from '../../../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { fixtureRepo, fleetFacts, nodeSite, sha, tempDir } from './fleet-fixtures.mjs';

const VERSION = '2026.11.16-1';
const PY = ['python', 'python3'].find(c => spawnSync(c, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3') ?? null;
const cleanups = [];
const keep = { after: f => cleanups.push(f) };
after(async () => { for (const f of cleanups.reverse()) await f(); });
const readJson = f => JSON.parse(fsSync.readFileSync(f, 'utf8'));
const SCM = () => ({ sddl: 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)' });
const HOST = 'FIXTURE-F';
const CI_CRED = 'C:\\ProgramData\\CluedIndependentCI\\first-install\\credentials';

// The fresh machine's facts as the host preparation writes them (first-install-host.ps1): every name derived from the machine name.
function freshFacts({ toolchainNodeSha256, host = HOST }) {
  const nodeName = host.toLowerCase(), controllerRid = 1015;
  const pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  return { contract: 'clued.independent-ci.first-install-facts/1', observedAt: '2026-11-16T00:00:00Z',
    node: { contract: 'clued.independent-ci.node-profile/1', nodeName, hostname: host, ownerSid: 'S-1-5-21-7-8-9-1016', ownerProfileDirectory: 'C:\\Users\\clued-companion',
      controllerSid: `S-1-5-21-7-8-9-${controllerRid}`, runnerService: `actions.runner.tdoljyj-cross-memory-system.clued-ci-${nodeName}`,
      mutationMutex: `Global\\CluedControlControllerMutationV1-${host}-${controllerRid}`, wslDistribution: 'CluedResident-Linux' },
    operatorSid: 'S-1-5-21-7-8-9-1001', companionWsl: { distribution: 'CluedResident-Linux', vhdxDirectory: FIRST_INSTALL_VHDX_DIRECTORY },
    nodeRecord: { appKeyId: 7654321, appPublicKeySha256Base64: Buffer.alloc(32, 7).toString('base64'), ciPrincipalBindingId: randomUUID(), ciPrincipalRoleRef: randomUUID(),
      ciPrincipalQualificationRef: randomUUID(), ciTokenPinSha256: 'c'.repeat(64) },
    credentials: { upgradeToken: { fingerprint: 'a'.repeat(64) }, heartbeatToken: { fingerprint: 'b'.repeat(64), bindingId: randomUUID() } },
    signer: { keyId: `${nodeName}-first-run-20261116`, runtimeId: `${host}-cluedresident-independent-ci-v1`, publicKeyPem: pem },
    linuxHost: { toolchainNodeSha256, resultPublicKeySha256: sha(Buffer.from(pem, 'ascii')) } };
}

// first-install.py stub (its real run is the second test) and generate.py stubs; every call recorded with the plan generate.py read
function pythonTools({ real = [] } = {}) {
  const calls = [];
  const fn = (script, args) => {
    const name = path.basename(script) + (path.basename(script) === 'generate.py' && args.includes('--check') ? ' --check' : '');
    calls.push({ name, script, args, plan: name.startsWith('generate.py') ? readJson(args[args.indexOf('--fleet-plan') + 1]) : null });
    if (real.includes(path.basename(script))) {
      const r = spawnSync(PY, ['-I', script, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, last: r.stdout.trim().split(/\r?\n/).at(-1) };
    }
    if (name === 'first-install.py') {
      const w = readJson(args[0]).workDir, out = { scripts: {}, paths: {} };
      fsSync.mkdirSync(path.join(w, 'linux'), { recursive: true });
      for (const n of Object.values(LINUX_SCRIPTS)) {
        const p = path.join(w, 'linux', n), b = Buffer.from(`#!/usr/bin/bash\n# ${n === 'B-resume.sh' ? 'B.sh' : n}\n`);
        fsSync.writeFileSync(p, b, { flag: 'wx' }); out.scripts[n] = sha(b); out.paths[n] = p;
      }
      return { status: 0, stdout: JSON.stringify(out), stderr: '' };
    }
    if (name === 'generate.py --check') return { status: 0, stdout: '{"status":"FLEET_PLAN_CHECK_PASSED"}', stderr: '' };
    if (name === 'generate.py') { fsSync.writeFileSync(args[args.indexOf('--out') + 1], '# first-install launcher\n', { flag: 'wx' }); return { status: 0, stdout: '{}', stderr: '' }; }
    throw new Error(`no ${name} in a first install`);
  };
  return { calls, fn };
}

let world = null;
async function getWorld() {
  if (world) return world;
  const { repo, commit } = await fixtureRepo(keep);
  const template = await nodeSite(keep, 'a', fleetFacts());   // the installed node the kit is taken from
  const d = await tempDir(keep, 'fleetfirst');
  const built = await buildUniversal({ repo, commit, version: VERSION, out: path.join(d, 'out') });
  const release = JSON.parse(await fs.readFile(built.release, 'utf8'));
  // the version's assets (bootstrap.ps1 -From): the kit (first-install-kit on the template node) and its role image archives
  const from = path.join(d, 'from');
  await fs.mkdir(from);
  const kit = await main(['first-install-kit'], { root: template.root });
  const kitBytes = Buffer.from(JSON.stringify(kit));
  await fs.writeFile(path.join(from, `fleet-node-${VERSION}.first-install-kit.json`), kitBytes);
  for (const l of kit.images.local) await fs.writeFile(path.join(from, l.asset), `docker save of ${l.id}\n`);
  const decision = randomUUID(), receipt = randomUUID();
  const draft = { contract: 'clued.independent-ci.fleet-node-acceptance/1', version: VERSION, archive_sha256: release.source.archive_sha256, commit,
    repository: 'tdoljyj/cross-memory-system', cluedDecision: decision.slice(0, 8), acceptedAt: '2026-11-12T00:00:00Z',
    fleetRefs: { sourceAcceptanceRef: decision, hostQualificationRef: randomUUID(), ownerAuthorizationRef: decision, publisherQualificationRef: decision,
      ownerPackageAcceptanceRef: decision, installationReceiptRef: receipt, ownerDecisionRef: decision, ownerReceiptRef: receipt, formalRoles: roles() },
    firstInstallKitSha256: sha(kitBytes) };
  const sh = await sourceHashOf({ artifactPath: built.tar, artifactSha256: release.source.archive_sha256, acceptance: draft });
  world = { commit, template, d, tar: built.tar, release, from, kit, kitBytes, acceptance: { ...draft, ciSourceManifestSha256: sh.ciSourceManifestSha256 } };
  return world;
}

// A fresh machine: no resident root, the CI root holding only the host preparation's facts.
async function freshSite(t, w, over = {}) {
  const d = await tempDir(t, 'fleetfresh');
  const base = freshFacts({ toolchainNodeSha256: w.kit.template.toolchainNodeSha256 });
  const ciRoot = path.join(d, 'ci'), facts = { ...base, ...(typeof over === 'function' ? over(base) : over) };
  await fs.mkdir(path.join(ciRoot, 'first-install'), { recursive: true });
  await fs.writeFile(path.join(ciRoot, 'first-install', 'facts.json'), JSON.stringify(facts));
  return { d, ciRoot, facts, root: path.join(ciRoot, 'resident') };
}
const prepareFresh = (w, site, work, over = {}) => prepareInstall({ artifactPath: w.tar, artifactSha256: w.release.source.archive_sha256, acceptance: w.acceptance,
  root: site.root, ciRoot: site.ciRoot, from: w.from, workDir: work, scm: SCM, serviceState: () => 'absent', hostname: () => HOST, ciRootSddl: () => '',
  controllerNode: path.join(w.template.root, 'runtime', 'node.exe'), ...over });

test('first install: no receipt, the same command: the node from this machine\'s facts and the accepted kit, one package, the first-install scripts, no W1',
  { timeout: 600_000 }, async t => {
    const w = await getWorld();
    // the kit: the template's files, held to its own version facts; the images its roles name
    const kit = readKit(w.kitBytes);
    assert.deepEqual(kit.images.local.map(l => l.asset), kit.images.local.map(l => imageAssetOf(l.id)));
    const site = await freshSite(t, w);
    const work = path.join(site.d, 'work'), py = pythonTools();
    const r = await prepareFresh(w, site, work, { python: py.fn });
    assert.equal(r.status, 'FLEET_NODE_FIRST_INSTALL_PREPARED');
    assert.equal(r.node, site.facts.node.nodeName);
    assert.ok(r.runCommand.includes(`'${r.launcher.sha256}'`) && r.runCommand.endsWith('-RunApprovedInstall'));
    assert.deepEqual(py.calls.map(c => c.name), ['first-install.py', 'generate.py --check', 'generate.py'], 'no rehearsal, no prep.py, no W1: nothing is installed');
    // the plan
    const plan = readJson(r.installPlan);
    assert.equal(plan.contract, PLAN_CONTRACT);
    assert.deepEqual(plan.firstInstall, { factsSha256: sha(await fs.readFile(path.join(site.ciRoot, 'first-install', 'facts.json'))), operatorSid: site.facts.operatorSid,
      wslVhdxDirectory: FIRST_INSTALL_VHDX_DIRECTORY, kitSha256: w.acceptance.firstInstallKitSha256 });
    assert.deepEqual([plan.w1Paused, plan.expectedInstalledLinux, plan.companionAccount], [null, null, false]);
    assert.deepEqual(Object.keys(plan.reasons).sort(), ['pause', 'rearm']);
    // the host preparation's directory under the CI root (on a node CI_CRED, which generate.py holds the plan to)
    const cred = path.join(site.ciRoot, 'first-install', 'credentials');
    assert.equal(path.join(CI_ROOT, 'first-install', 'credentials'), CI_CRED);
    assert.deepEqual(plan.secrets, { source: 'first-install', upgradeToken: { target: path.join(cred, 'resident-upgrade.token'), fingerprint: 'a'.repeat(64) },
      heartbeatToken: { target: path.join(cred, 'ci-node-heartbeat.token'), fingerprint: 'b'.repeat(64), bindingId: site.facts.credentials.heartbeatToken.bindingId } });
    assert.equal(plan.ciSourceManifestSha256, w.acceptance.ciSourceManifestSha256, 'the accepted Source, as on every node');
    assert.deepEqual(py.calls[1].plan, { ...plan, launcher: null });
    // the package: a fresh install whose record is this machine's profile, values and signer (the node's own only)
    const pkg = await readPackageOnce(plan.packageDir, plan.packageManifestSha256);
    const acc = JSON.parse(pkg.bytesByPath.get('record/acceptance.json').toString('utf8'));
    const inst = JSON.parse(pkg.bytesByPath.get('record/installation.json').toString('utf8'));
    assert.deepEqual(acc.node, site.facts.node);
    assert.equal(acc.ciPrincipalQualificationRef, site.facts.nodeRecord.ciPrincipalQualificationRef);
    for (const k of ['appKeyId', 'appPublicKeySha256Base64', 'ciPrincipalBindingId', 'ciPrincipalRoleRef', 'ciTokenPinSha256']) assert.deepEqual(inst[k], site.facts.nodeRecord[k], k);
    for (const k of ['appId', 'installationId', 'repositoryId', 'supabaseUrl', 'publishableKey', 'controllerNodeSha256']) assert.deepEqual(inst[k], w.kit.record[k], k);
    const signers = JSON.parse(pkg.bytesByPath.get('record/signers.json').toString('utf8')).signers;
    assert.deepEqual(signers.map(s => [s.keyId, s.runtimeId, s.publicKeyPem, s.sourceAcceptanceRef, s.qualificationRef]),
      [[site.facts.signer.keyId, site.facts.signer.runtimeId, site.facts.signer.publicKeyPem, w.acceptance.fleetRefs.sourceAcceptanceRef, w.acceptance.fleetRefs.hostQualificationRef]]);
    const policy = JSON.parse(pkg.bytesByPath.get(pkg.manifest.files.find(f => f.target === 'config\\policy.json').path).toString('utf8'));
    assert.deepEqual([policy.node, policy.companion.userSid, policy.linux.distribution], [site.facts.node, site.facts.node.ownerSid, 'CluedResident-Linux']);
    assert.ok(pkg.manifest.files.some(f => f.target === 'upgrader\\config\\upgrader.json'));
    // the Linux inputs: the kit's template and every local role image's archive, as the version shipped them
    const linuxIn = plan.linux.inDir;
    for (const l of w.kit.images.local) assert.equal(sha(await fs.readFile(path.join(linuxIn, 'images', `${l.id}.tar.gz`))), sha(await fs.readFile(path.join(w.from, l.asset))));
    const fiArgs = py.calls[0].args;
    assert.deepEqual(fiArgs.slice(4, 8), ['--in-dir', linuxIn, '--out-dir', plan.linux.outDir]);
    assert.equal(sha(await fs.readFile(fiArgs[fiArgs.indexOf('--template-facts') + 1])), sha(Buffer.from(w.kit.template.versionFacts, 'base64')));
    const cfg = readJson(fiArgs[0]);
    assert.deepEqual([cfg.linux.installedRoles, cfg.linux.host, cfg.signer, cfg.operatorSid], [null, site.facts.linuxHost, site.facts.signer, site.facts.operatorSid]);
    if (PY) {   // first-install.py takes it (rconfig.load + need_first_install_linux)
      const load = spawnSync(PY, ['-I', '-c', 'import importlib.util,sys; s=importlib.util.spec_from_file_location("c",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.need_first_install_linux(m.load(sys.argv[2]))',
        path.join(work, `tree-${w.commit.slice(0, 8)}`, 'work', 'independent-ci-resident-v1', 'reinstall', 'tools', 'rconfig.py'), fiArgs[0]], { encoding: 'utf8' });
      assert.equal(load.status, 0, load.stderr);
    }
  });

test('first install, the package\'s first-install.py for real: A.sh, B.sh, B-resume.sh in the launcher\'s form, every pinned byte of the version',
  { timeout: 600_000, skip: PY ? false : 'no Python 3 here' }, async t => {
    const w = await getWorld();
    const site = await freshSite(t, w);
    const work = path.join(site.d, 'work'), py = pythonTools({ real: ['first-install.py'] });
    const r = await prepareFresh(w, site, work, { python: py.fn });
    assert.equal(r.status, 'FLEET_NODE_FIRST_INSTALL_PREPARED');
    const plan = readJson(r.installPlan);
    const wsl = p => `/mnt/${p[0].toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}`;
    const text = {};
    for (const [k, file] of Object.entries(LINUX_SCRIPTS)) {
      const b = await fs.readFile(path.join(work, 'linux', file));
      assert.equal(sha(b), plan.linux.scripts[k].sha256); assert.ok(!b.includes(0x0d), file);
      text[file] = b.toString('utf8');
      // what generate.py --fleet-plan requires of a package run script
      assert.ok(text[file].includes(`\nW=${wsl(plan.linux.inDir)}\nO=${wsl(plan.linux.outDir)}\n`) && text[file].includes('\nDRAFT=0\n'), file);
      assert.ok(!text[file].includes('R4_CLEAN_ENV') && !text[file].includes('${1'), file);
      assert.ok(text[file].includes(site.facts.linuxHost.toolchainNodeSha256) && text[file].includes(site.facts.linuxHost.resultPublicKeySha256), file);
    }
    assert.equal(text['B-resume.sh'], text['B.sh'], 'B continues where it stopped: the resume is B');
    assert.ok(text['A.sh'].includes('refuse "NOT_A_FIRST_INSTALL:$p"'));
    assert.ok(text['B.sh'].includes('LINUX_FIRST_INSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1') && text['B.sh'].includes('"$O/linux-version-facts.') && text['B.sh'].includes('"$O/linux-live-manifest.'));
    assert.ok(text['B.sh'].includes(`KEY_ID=${site.facts.signer.keyId}`) && text['B.sh'].includes(`RUNTIME_ID=${site.facts.signer.runtimeId}`));
    for (const l of w.kit.images.local) {   // every local image from the version's archive, pinned; none waits for a person
      assert.match(text['B.sh'], new RegExp(`^${l.id} ${l.id}\\.tar\\.gz ${sha(await fs.readFile(path.join(w.from, l.asset)))}$`, 'm'));
    }
    assert.ok(!/^[0-9a-f]{64} - -$/m.test(text['B.sh']));

    // A stopped first install continues: a prepare again finds this commit's staging (one per commit, never per prepare) and A, when
    // the staging is this package's and unchanged and the new in-directory carries exactly the staged inputs, stages nothing; B goes
    // on from where it stopped. Run the continuation of the real A.sh in Git's own bash (never WSL), in a sandbox.
    assert.match(text['A.sh'], new RegExp(`^BASE=/root/clued-ci-first-install-${w.commit.slice(0, 8)}$`, 'm'));
    assert.ok(text['A.sh'].includes('mv -n -T "$BASE" "$BASE.cut-'), 'an A cut off before it completed is kept aside, not refused for ever');
    const gitBash = path.resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim(), '..', '..', '..', 'bin', 'bash.exe');
    if (!fsSync.existsSync(gitBash)) return t.diagnostic('no Git bash: the continuation is checked as text only');
    const after = text['A.sh'].split('# ---- continue a stopped first install')[1];
    const snippet = after?.slice(after.indexOf(String.fromCharCode(10)) + 1).split('# ---- end continue')[0];
    assert.ok(snippet, 'A.sh continues a stopped first install');
    const listed = [...snippet.split("<<'STAGED_EOF'")[1].split('STAGED_EOF')[0].matchAll(/^([0-9a-f]{64})  (.+)$/gm)].map(x => x[2]);
    assert.ok(listed.length > 20);
    const pkgSha = /^PKG_SHA=([0-9a-f]{64})$/m.exec(text['A.sh'])[1];
    const box = path.join(site.d, 'box'), fwd = p => p.replace(/\\/g, '/');
    const stage = async (dir) => { for (const f of listed) { await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true }); await fs.copyFile(path.join(plan.linux.inDir, ...f.split('/')), path.join(dir, f)); } };
    const runContinue = (w2, base) => {
      const script = `refuse() { echo "{\\"status\\":\\"REFUSED\\",\\"code\\":\\"$1\\"}"; exit 1; }\nset -euo pipefail\nW='${fwd(w2)}'\nBASE='${fwd(base)}'\nSTG="$BASE/stg"\nPKG_SHA=${pkgSha}\n${snippet}\necho '{"status":"NOT_CONTINUED"}'\n`;
      const r = spawnSync(gitBash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8' });
      assert.ok(r.stdout.trim(), `the continuation printed nothing: ${r.stderr}`);
      return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)).code ?? JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)).status;
    };
    const fresh = async (name) => {
      const base = path.join(box, name), stg = path.join(base, 'stg'), w2 = path.join(box, `${name}-in`);
      await stage(stg); await stage(w2);
      await fs.writeFile(path.join(stg, 'phaseA.sha256'), listed.map(f => `${sha(fsSync.readFileSync(path.join(stg, f)))}  ${f}\n`).join(''));
      await fs.writeFile(path.join(base, 'package.sha256'), `${pkgSha}\n`);
      return { base, stg, w2 };
    };
    let s = await fresh('ok');
    assert.equal(runContinue(s.w2, s.base), 'PHASE_A_DONE_NOTHING_SIGNED_NOTHING_INSTALLED', 'the same package, unchanged: A done, B continues');
    s = await fresh('other'); await fs.writeFile(path.join(s.base, 'package.sha256'), `${'0'.repeat(64)}\n`);
    assert.equal(runContinue(s.w2, s.base), 'STAGED_FIRST_INSTALL_OF_ANOTHER_PACKAGE');
    s = await fresh('changed'); await fs.appendFile(path.join(s.stg, listed[0]), 'x');
    assert.equal(runContinue(s.w2, s.base), 'STAGED_BYTES_CHANGED_SINCE_PHASE_A');
    s = await fresh('in'); await fs.appendFile(path.join(s.w2, listed.at(-1)), 'x');
    assert.equal(runContinue(s.w2, s.base), 'IN_DIR_NOT_THE_STAGED_INPUTS');
    s = await fresh('cut'); await fs.rm(path.join(s.stg, 'phaseA.sha256'));
    assert.equal(runContinue(s.w2, s.base), 'NOT_CONTINUED', 'no completed A: the first install starts again (its cut-off staging kept aside)');
  });

test('first install refuses: residue by name, a kit not accepted, facts not this machine\'s or not derived, another controller runtime, a missing image archive',
  { timeout: 600_000 }, async t => {
    const w = await getWorld();
    const notReached = () => { throw new Error('not reached'); };
    let k = 0;
    const attempt = async (site, over, check) => {
      const work = path.join(site.d, `w${k++}`);
      await assert.rejects(prepareFresh(w, site, work, { python: notReached, ...over }), check);
      await assert.rejects(fs.access(work), 'nothing written');
    };
    const site = await freshSite(t, w);
    // residue: a resident service, or the root, without a receipt; and a service whose state is not known
    await attempt(site, { serviceState: n => (n === 'CluedCISwapBroker' ? 'present' : 'absent') },
      e => e.code === 'FIRST_INSTALL_RESIDUE_PRESENT' && e.detail.residue.join() === 'service:CluedCISwapBroker:present');
    await attempt(site, { serviceState: () => 'unknown' }, e => e.code === 'FIRST_INSTALL_RESIDUE_PRESENT' && e.detail.residue.length === 3);
    await fs.mkdir(site.root);
    await attempt(site, {}, e => e.code === 'FIRST_INSTALL_RESIDUE_PRESENT' && e.detail.residue.join() === `directory:${site.root}`);
    await fs.rm(site.root, { recursive: true });
    // what an uninstall leaves is residue too, named: a kept root, the installer's read ACE for the resident's service SID on the CI
    // root (sc.exe showsid CluedCIResident gives this SID), and a CI root whose ACL cannot be read is not taken for a clean one
    assert.equal(RESIDENT_SERVICE_SID, 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629');
    const kept = path.join(site.ciRoot, 'resident-uninstalled-20261101T000000Z-abcdef012345');
    await fs.mkdir(kept);
    await attempt(site, {}, e => e.code === 'FIRST_INSTALL_RESIDUE_PRESENT' && e.detail.residue.join() === `kept-root:${kept}` && /clean machine/.test(e.detail.next));
    await fs.rm(kept, { recursive: true });
    await attempt(site, { ciRootSddl: () => `O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x120080;;;${RESIDENT_SERVICE_SID})` },
      e => e.code === 'FIRST_INSTALL_RESIDUE_PRESENT' && e.detail.residue.join() === `ci-root-ace:${RESIDENT_SERVICE_SID}`);
    await attempt(site, { ciRootSddl: () => null }, e => e.code === 'FIRST_INSTALL_RESIDUE_PRESENT' && e.detail.residue[0].startsWith('ci-root-acl:unreadable:'));
    // the kit: the accepted one only; an acceptance without one is no first install
    const { firstInstallKitSha256, ...noKit } = w.acceptance;
    await attempt(site, { acceptance: noKit }, { code: 'FLEET_ACCEPTANCE_HAS_NO_FIRST_INSTALL_KIT' });
    await attempt(site, { acceptance: { ...w.acceptance, firstInstallKitSha256: 'e'.repeat(64) } }, { code: 'FIRST_INSTALL_KIT_NOT_THE_ACCEPTED' });
    await attempt(site, { from: null }, { code: 'FIRST_INSTALL_NEEDS_THE_RELEASE_DIRECTORY' });
    // the facts: this machine, the derivation rules, the signer
    await attempt(site, { hostname: () => 'OTHER-HOST' }, { code: 'FIRST_INSTALL_FACTS_NOT_THIS_MACHINE' });
    const nodeOver = n => ({ node: { ...site.facts.node, ...n } });
    for (const [over, code] of [[nodeOver({ runnerService: 'actions.runner.tdoljyj-cross-memory-system.clued-ci-company-win-02' }), 'FIRST_INSTALL_PROFILE_NOT_DERIVED'],
      [nodeOver({ wslDistribution: 'Ubuntu-24.04' }), 'FIRST_INSTALL_PROFILE_NOT_DERIVED'], [nodeOver({ nodeName: 'another' }), 'FIRST_INSTALL_PROFILE_NOT_DERIVED'],
      [{ signer: { ...site.facts.signer, keyId: 'template-key-20261116' } }, 'FIRST_INSTALL_SIGNER_NOT_DERIVED'],
      [{ linuxHost: { ...site.facts.linuxHost, resultPublicKeySha256: 'f'.repeat(64) } }, 'FIRST_INSTALL_SIGNER_NOT_THE_RESULT_KEY'],
      [{ operatorSid: site.facts.node.ownerSid }, 'FIRST_INSTALL_FACTS_REFUSED'], [{ extra: 1 }, 'FIRST_INSTALL_FACTS_REFUSED'],
      // one token for two connections (the ci-admission pin is the upgrade token's fingerprint)
      [{ nodeRecord: { ...site.facts.nodeRecord, ciTokenPinSha256: site.facts.credentials.upgradeToken.fingerprint } }, 'FIRST_INSTALL_FACTS_REFUSED'],
      // the toolchain node in place is not the one the template's roles run
      [f => ({ linuxHost: { ...f.linuxHost, toolchainNodeSha256: 'd'.repeat(64) } }), 'FIRST_INSTALL_TOOLCHAIN_NODE_NOT_THE_KITS']]) {
      const bad = await freshSite(t, w, over);
      await attempt(bad, {}, { code });
    }
    await fs.rm(path.join(site.ciRoot, 'first-install', 'facts.json'));
    await attempt(site, {}, { code: 'FIRST_INSTALL_FACTS_MISSING' });
    // the controller runtime is the fleet's (the bootstrap's, by hash); every image archive the kit names is there
    const site2 = await freshSite(t, w);
    await attempt(site2, { controllerNode: process.execPath }, { code: 'FIRST_INSTALL_CONTROLLER_NODE_NOT_THE_FLEETS' });
    const from2 = path.join(site2.d, 'from');
    await fs.cp(w.from, from2, { recursive: true });
    await fs.rm(path.join(from2, w.kit.images.local[0].asset));
    await attempt(site2, { from: from2 }, { code: 'FIRST_INSTALL_ROLE_IMAGE_ASSET_MISSING' });
    // the read-only checks the bootstrap runs before any UAC (the host preparation takes its pins from them, never computes them)
    const accFile = path.join(site2.d, 'acceptance.json'); await fs.writeFile(accFile, JSON.stringify(w.acceptance));
    const chk = await main(['first-install-check', '--artifact', w.tar, '--artifact-sha', w.release.source.archive_sha256, '--acceptance', accFile, '--from', w.from]);
    assert.deepEqual([chk.status, chk.kitSha256, chk.toolchainNodeSha256, chk.controllerNodeSha256, chk.archiveSha256],
      ['FIRST_INSTALL_INPUTS_ACCEPTED', w.acceptance.firstInstallKitSha256, w.kit.template.toolchainNodeSha256, w.kit.record.controllerNodeSha256, w.release.source.archive_sha256]);
    assert.match(chk.registrarSha256, /^[0-9a-f]{64}$/);
    await assert.rejects(firstInstallCheck({ artifactPath: w.tar, artifactSha256: w.release.source.archive_sha256, acceptance: { ...w.acceptance, firstInstallKitSha256: 'e'.repeat(64) }, from: w.from }),
      { code: 'FIRST_INSTALL_KIT_NOT_THE_ACCEPTED' });
    await assert.rejects(firstInstallCheck({ artifactPath: w.tar, artifactSha256: 'e'.repeat(64), acceptance: w.acceptance, from: w.from }), { code: 'FLEET_ARTIFACT_SHA_NOT_THE_ACCEPTED' });
    const factsFile = path.join(site2.ciRoot, 'first-install', 'facts.json');
    assert.equal((await main(['first-install-facts-check', '--facts', factsFile], { hostname: () => HOST })).status, 'FIRST_INSTALL_FACTS_VALID');
    await assert.rejects(main(['first-install-facts-check', '--facts', factsFile], { hostname: () => 'ANOTHER' }), { code: 'FIRST_INSTALL_FACTS_NOT_THIS_MACHINE' });
    // a kit that names an image its roles do not: refused whole
    const forged = { ...w.kit, images: { ...w.kit.images, pull: [...w.kit.images.pull, `ghcr.io/x/y@sha256:${'1'.repeat(64)}`] } };
    assert.throws(() => readKit(Buffer.from(JSON.stringify(forged))), { code: 'FIRST_INSTALL_KIT_IMAGES_NOT_THE_POLICIES' });
  });
