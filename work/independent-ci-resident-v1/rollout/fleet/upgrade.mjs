// The node side of a universal-package IN-PLACE UPGRADE (ADR 0030): from the same accepted universal package and the same acceptance
// file a reinstall takes (install.mjs prepare), and from nothing but what is installed on this node, the node's /4 upgrade package,
// the installed upgrader's ACCEPT run beforehand (the archive's precheck.mjs), and ONE request file in the installed upgrade inbox,
// written by the INSTALLED request-upgrade.ps1. Everything after that is the installed upgrader's (CluedCIUpgrader): the Grant, the
// drain, both sides' switch, the verify, the rollback. NON-elevated, Owner session; no UAC anywhere; writes only under a new work
// directory and that one inbox file; no Python, no git, no WSL, no network.
//
//   node <unpacked>/tree/work/independent-ci-resident-v1/rollout/fleet/upgrade.mjs
//        --artifact <fleet-node-<v>.tar> --artifact-sha <hex> --acceptance <fleet-node-<v>.acceptance.json> --work <new dir>
//        [--no-request] [--allow-active-upgrade]
//
// The command is the same on every node and safe to run again: it answers FLEET_NODE_UPGRADE_IN_PROGRESS while the upgrader has an
// operation open, FLEET_NODE_ALREADY_AT_THIS_PACKAGE once both sides run this package, and otherwise requests the upgrade.
// A node this package cannot upgrade in place (the frozen channel or a Source-entering fleet reference changed, or the two sides are
// not one package) is answered FLEET_NODE_UPGRADE_NEEDS_REINSTALL before anything is requested: its way is install.mjs prepare with the
// same three files (the node has two ways only, Decision b5d041d2).
//
//   1. the acceptance and the archive (install.mjs readArchive); this file and the modules it imports are the archive's bytes.
//   2. the upgrader's status (an open operation ends here), current.json and the Linux facts (already this package ends here).
//   3. the node (install.mjs readNode); the two sides must be one Source.
//   4. the channel: the archive's upgrader manifest is the receipt's, its Linux upgrade tool the facts', the installed Source-entering
//      references (sourceAcceptanceRef, hostQualificationRef, formalRoles) the acceptance's.
//   5. the record with the INSTALLED references (Decision b1dd8a84: the node identity pins every one of them and the Owner's decision)
//      and this commit's Source: its hash is the acceptance's ciSourceManifestSha256. Policy and companion inputs from the installed
//      ones, ownerAcceptance = the acceptance's decision and receipt; the Linux external pins of the package's units (as a reinstall);
//      the three role hashes the frozen Linux tool will derive (ports.rolesDerived); stateCompat the archive's, else the installed one.
//   6. <work>\package\ (the archive's build-package.mjs, twice: the same sha; the universal values the archive's; identity and profile
//      the installed ones).
//   7. the archive's precheck.mjs (the installed generation's own staged package, where the node still has one, as --installed-package).
//   8. a node that holds ci-admission now is not requested (FLEET_NODE_UPGRADE_HAND_OVER_FIRST: the standby goes first, then the
//      hand-over, rollout/README.md section 4) unless --allow-active-upgrade says the Owner accepted the CI pause of its upgrade.
//   9. the installed resident\<sha>\windows\request-upgrade.ps1; one JSON line.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CLOSURE, PREPARE_RECORD, RESIDENT, universalFilesSha256 } from './facts.mjs';
import { DEFAULT_ROOT, FLEET_REF_KEYS, FORMAL_ROLES, OWN_MODULES, configInputsFor, linuxExternalPins, readArchive, readNode, recordInputsFor,
  validateAcceptance } from './install.mjs';
import { Refused, TOOL_PATH, rolesDerived } from './ports.mjs';
import { pyCanonical, pyDumps } from './pyjson.mjs';
import { extractTar } from './tar.mjs';
import { BUNDLE_NAME, bundleHeads } from './universal.mjs';

export const UPGRADE_CONTRACT = 'clued.independent-ci.fleet-node-upgrade/1';
// upgrade\status.json op states in which the upgrader still owns an operation (rollout/precheck.mjs OP_MOVING)
export const OP_MOVING = Object.freeze(['WAITING_GRANT', 'WAITING_DRAIN', 'DEFERRED', 'RUNNING', 'ROLLING_BACK']);
// precheck refusals no in-place upgrade can mend: the node's way is the reinstall
const PRECHECK_REINSTALL = Object.freeze(['UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL', 'LINUX_LIVE_NOT_THE_CURRENT_GENERATION', 'COMPANION_RELAY_PARENT_ACL_REFUSED',
  'COMPANION_RELAY_PARENT_ACL_MISSING_TARGET_DOES_NOT_ADD_IT', 'COMPANION_ACCOUNT_RECORD_REFUSED']);
const SOURCE_REFS = Object.freeze(['sourceAcceptanceRef', 'hostQualificationRef']);
const HEX64 = /^[0-9a-f]{64}$/;
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const need = (ok, code, detail) => { if (!ok) throw new Refused(code, detail); };
// The node's other way (Decision b5d041d2): the same package and acceptance file, install.mjs prepare.
const needUpgradable = (ok, code, detail) => { if (!ok) throw Object.assign(new Refused(code, detail), { reinstall: true }); };
const jsonOf = b => JSON.parse(Buffer.from(b).toString('utf8').replace(/^\uFEFF/, ''));
const parsed = s => { try { return JSON.parse(s); } catch { return null; } };
async function readOrNull(file) {
  try { return await fs.readFile(file); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}
function run(exe, args, { cwd } = {}) {
  const r = spawnSync(exe, args, { cwd, maxBuffer: 1 << 26, windowsHide: true });
  const stdout = String(r.stdout ?? '');
  return { status: r.status, stdout, last: stdout.split(/\r?\n/).filter(l => l.trim()).at(-1) ?? null, stderr: String(r.stderr ?? r.error ?? '').trim().slice(-600) };
}

// The Source-entering part of the installed record (what an acceptance file's fleetRefs must carry for this package to upgrade in place).
export function installedSourceRefs(node) {
  const formalRoles = Object.fromEntries(FORMAL_ROLES.map(r => [r, Object.fromEntries(Object.entries(node.man.roles[r]).filter(([k]) => k !== 'sourceFiles' && k !== 'controllerRelay'))]));
  return { sourceAcceptanceRef: node.acc.sourceAcceptanceRef, hostQualificationRef: node.acc.hostQualificationRef, formalRoles };
}

// The installed record as recordInputsFor takes an acceptance: every reference, the Owner's decision and its time are the installed
// ones (Decision b1dd8a84), only the commit is new.
export function carriedRecord(node, commit) {
  const { acc } = node;
  return { commit, acceptedAt: acc.acceptedAt, validUntil: acc.validUntil ?? null,
    fleetRefs: { ...Object.fromEntries(FLEET_REF_KEYS.map(k => [k, acc[k]])), ...installedSourceRefs(node) } };
}

// The installed request-upgrade.ps1 (Owner session, not elevated): one create-only file in upgrade\inbox; its JSON answer.
export function defaultRequest({ script, packageDir, packageManifestSha256, decisionRef }) {
  const r = run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PackageRoot', packageDir,
    '-ExpectedPackageManifestSha256', packageManifestSha256, '-AcceptanceDecisionRef', decisionRef]);
  const answer = parsed(r.stdout.trim());
  need(r.status === 0 && answer?.status === 'UPGRADE_REQUESTED', 'UPGRADE_REQUEST_FAILED', { stderr: r.stderr, stdout: r.stdout.trim().slice(-300) });
  return answer;
}

export async function upgradeNode({ artifactPath, artifactSha256, acceptance, root = DEFAULT_ROOT, workDir, now = Date.now(), node: nodeBin = process.execPath,
  request = defaultRequest, noRequest = false, allowActiveUpgrade = false, selfDir = HERE }) {
  validateAcceptance(acceptance, now);
  need(typeof workDir === 'string', 'USAGE');   // the package directory's shape is the installed request tool's to judge (A3)
  const { entries, universal } = readArchive(await fs.readFile(artifactPath), artifactSha256, acceptance);
  const byPath = new Map(entries.map(e => [e.path, e.data]));
  for (const n of ['upgrade.mjs', ...OWN_MODULES]) {
    const want = byPath.get(`tree/${RESIDENT}/rollout/fleet/${n}`);
    need(want && want.equals(await fs.readFile(path.join(selfDir, n))), 'FLEET_UPGRADER_NOT_THE_ARCHIVES', n);
  }
  const at = (...p) => path.join(root, ...p);
  const accepted = acceptance.ciSourceManifestSha256;
  const base = { contract: UPGRADE_CONTRACT, version: universal.version, commit: universal.commit, ciSourceManifestSha256: accepted, statusFile: at('upgrade', 'status.json') };

  // 2. safe to run again: an operation the upgrader still owns, or both sides already this package
  let op = null;
  try { op = jsonOf(await fs.readFile(at('upgrade', 'status.json')))?.op ?? null; } catch { op = null; }
  if (OP_MOVING.includes(op?.state)) {
    return { ...base, status: 'FLEET_NODE_UPGRADE_IN_PROGRESS', op: { opId: op.opId ?? null, state: op.state, phase: op.phase ?? null, code: op.code ?? null, confirmUrl: op.grant?.confirmUrl ?? null } };
  }
  const currentBytes = await readOrNull(at('upgrade', 'current.json'));
  need(currentBytes !== null, 'NODE_HAS_NO_INSTALL_FIRST_INSTALL_PATH', 'no upgrade\\current.json: a first install follows reinstall/README.md section 8c');
  const cur = jsonOf(currentBytes);
  let liveFacts = null;
  try { liveFacts = jsonOf(await fs.readFile(at('upgrade', 'mailbox', 'responses', 'version-facts.json'))); } catch { liveFacts = null; }
  if (cur.ciSourceManifestSha256 === accepted && cur.residentManifestSha256 === universal.facts.residentManifestSha256
    && cur.linux?.ciSourceManifestSha256 === accepted && liveFacts?.ciSourceManifestSha256 === accepted && liveFacts.staged === null) {
    return { ...base, status: 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', generation: cur.generation, packageManifestSha256: cur.packageManifestSha256 };
  }

  // 3. the node, as a reinstall reads it; an upgrade also needs its two sides to be one Source
  const node = await readNode({ root, now });
  need(acceptance.repository === node.inst.repository, 'FLEET_ACCEPTANCE_NOT_THIS_REPOSITORY', { accepted: acceptance.repository, installed: node.inst.repository });
  needUpgradable(node.facts.ciSourceManifestSha256 === node.current.ciSourceManifestSha256 && node.facts.generation === node.current.linux?.generation,
    'NODE_SIDES_NOT_ONE_PACKAGE', { windows: node.current.ciSourceManifestSha256, linux: node.facts.ciSourceManifestSha256 });

  // 4. the channel is the installed one, and the Source-entering references are the acceptance's
  needUpgradable(node.receipt.upgrader?.manifestSha256 === universal.facts.upgraderManifestSha256, 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL',
    { what: 'upgrader', installed: node.receipt.upgrader?.manifestSha256 ?? null, package: universal.facts.upgraderManifestSha256 });
  const toolBytes = byPath.get(`tree/${TOOL_PATH}`);
  need(toolBytes, 'FLEET_ARCHIVE_REFUSED', 'no Linux upgrade tool');
  needUpgradable(sha(toolBytes) === node.facts.upgradeToolSha256, 'UPGRADE_CHANNEL_CHANGE_NEEDS_REINSTALL',
    { what: 'linux-upgrade-tool', installed: node.facts.upgradeToolSha256 ?? null, package: sha(toolBytes) });
  const installedRefs = installedSourceRefs(node);
  const changed = [...SOURCE_REFS.filter(k => installedRefs[k] !== acceptance.fleetRefs[k]),
    ...(pyCanonical(installedRefs.formalRoles) === pyCanonical(acceptance.fleetRefs.formalRoles) ? [] : ['formalRoles'])];
  needUpgradable(changed.length === 0, 'FLEET_SOURCE_REFS_CHANGED_NEEDS_REINSTALL', { changed });

  const work = path.resolve(workDir);
  await fs.mkdir(work, { recursive: false });
  const x = path.join(work, 'x');
  await extractTar(entries, x);
  const tree = path.join(x, 'tree');
  const R = path.join(tree, ...RESIDENT.split('/'));
  const listedTree = new Set(universal.files.filter(e => e.path.startsWith('tree/')).map(e => e.path.slice(5)));
  const readSourceFile = rel => (listedTree.has(rel) ? fsSync.readFileSync(path.join(tree, ...rel.split('/'))) : null);
  const readTreeFile = rel => { const b = readSourceFile(rel); need(b !== null, 'PINNED_FILE_MISSING_IN_NEW_COMMIT', { path: rel }); return b; };
  const inputs = path.join(work, 'inputs');
  await fs.mkdir(inputs);
  const writeNew = (name, data) => fs.writeFile(path.join(inputs, name), data, { flag: 'wx' });

  // 5. the record: the installed references, this commit's Source
  await writeNew('record-inputs.json', pyCanonical(recordInputsFor(node, carriedRecord(node, universal.commit))) + '\n');
  const record = path.join(inputs, 'record');
  const closure = path.join(tree, ...CLOSURE.split('/'));
  const prep = run(nodeBin, [path.join(tree, ...PREPARE_RECORD.split('/')), '--inputs', path.join(inputs, 'record-inputs.json'), '--source-root', tree, '--closure', closure, '--out', record]);
  need(prep.status === 0, 'PREPARE_RECORD_FAILED', prep.stderr);
  const chk = run(nodeBin, [path.join(R, 'reinstall', 'tools', 'check-record.mjs'), tree, record]);
  need(chk.status === 0, 'RECORD_V2_REFUSED_BY_RUNTIME_VALIDATOR', parsed(chk.last)?.code ?? chk.stderr);
  const manifestBytes = await fs.readFile(path.join(record, 'source-manifest.json'));
  const ciSourceManifestSha256 = sha(manifestBytes);
  need(ciSourceManifestSha256 === accepted, 'FLEET_SOURCE_NOT_THE_ACCEPTED_ONE', { node: ciSourceManifestSha256, accepted });
  await writeNew('source-files.txt', JSON.parse((await fs.readFile(closure)).toString('utf8')).paths.join('\n') + '\n');

  const ni = configInputsFor(node, acceptance);
  await writeNew('policy.input.json', ni.policyBytes);
  await writeNew('companion.input.json', ni.companionBytes);
  const pins = linuxExternalPins({ residentTree: R, readTreeFile, toolchainNodeSha256: node.linuxHost.toolchainNodeSha256 });
  await writeNew('linux-external-pins.json', pyDumps(pins, { indent: 2 }) + '\n');
  const bundle = path.join(x, ...BUNDLE_NAME.split('/'));
  const heads = bundleHeads(await fs.readFile(bundle));
  need(heads.length === 1 && heads[0] === `${universal.commit} refs/heads/accepted`, 'BUNDLE_NOT_ONLY_THE_ACCEPTED_COMMIT', heads);
  const roles = rolesDerived({ toolBytes, readSourceFile, manifestBytes, ciSha: ciSourceManifestSha256, factsBytes: node.factsBytes,
    rolesPublic: await readOrNull(at('upgrade', 'mailbox', 'responses', 'roles-public.json')), now });
  await writeNew('source-v2.json', JSON.stringify({ commit: universal.commit, bundle, rolesDerivedSha256: roles.rolesDerivedSha256 }, null, 2));
  await writeNew('state-compat.json', pyDumps(universal.stateCompat ?? node.current.stateCompat, { sortKeys: true }) + '\n');

  // 6. the package, twice, with the archive's build-package.mjs
  const build = out => {
    const r = run(nodeBin, [path.join(R, 'tools', 'build-package.mjs'), '--out', out, '--policy', path.join(inputs, 'policy.input.json'), '--companion', path.join(inputs, 'companion.input.json'),
      '--node', node.nodeExe, '--record', record, '--source-root', tree, '--source-files', path.join(inputs, 'source-files.txt'),
      '--linux-external-pins', path.join(inputs, 'linux-external-pins.json'), '--source-v2', path.join(inputs, 'source-v2.json'), '--state-compat', path.join(inputs, 'state-compat.json')], { cwd: R });
    need(r.status === 0 && HEX64.test(parsed(r.last)?.packageManifestSha256 ?? ''), 'BUILD_PACKAGE_FAILED', r.stderr);
    return parsed(r.last);
  };
  const packageDir = path.join(work, 'package');
  const first = build(packageDir);
  need(first.packageManifestSha256 === build(path.join(x, 'package-rebuild')).packageManifestSha256, 'PACKAGE_NOT_REPRODUCIBLE');
  const pkgRaw = await fs.readFile(path.join(packageDir, 'package-manifest.json'));
  need(sha(pkgRaw) === first.packageManifestSha256, 'PACKAGE_CHANGED');
  const m = JSON.parse(pkgRaw.toString('utf8'));
  const f = universal.facts;
  const got = { residentManifestSha256: m.residentManifestSha256, sourceManifestSha256: m.sourceManifestSha256, upgraderManifestSha256: m.upgrader?.manifestSha256,
    bundleSha256: m.linux?.sourceV2?.bundleSha256, universalFilesSha256: universalFilesSha256(m.files, m.residentManifestSha256, m.ciSourceManifestSha256) };
  const differ = Object.keys(got).filter(k => got[k] !== f[k]);
  const decisionRef = acceptance.fleetRefs.ownerDecisionRef;
  need(differ.length === 0 && m.linux?.sourceV2?.commit === universal.commit && m.ciSourceManifestSha256 === accepted && m.acceptance?.decisionRef === decisionRef,
    'FLEET_PACKAGE_NOT_THE_ACCEPTED_SOURCE', { fields: differ });
  need(m.nodeIdentitySha256 === node.receipt.nodeIdentitySha256, 'UPGRADE_NODE_IDENTITY_WOULD_CHANGE');
  need(m.nodeProfileSha256 === node.profileSha256, 'UPGRADE_NODE_PROFILE_WOULD_CHANGE');

  // 7. the installed upgrader's ACCEPT, beforehand. The installed generation's own package, where the node still has it (every
  //    generation an upgrade made: upgrade\staged\<package sha>), lets the precheck compare the frozen files one by one.
  const staged = at('upgrade', 'staged', node.current.packageManifestSha256);
  const stagedManifest = await readOrNull(path.join(staged, 'package-manifest.json')).catch(() => null);
  const pre = run(nodeBin, [path.join(R, 'rollout', 'precheck.mjs'), '--root', root, '--package', packageDir, '--package-sha', first.packageManifestSha256, '--acceptance', decisionRef,
    ...(stagedManifest && sha(stagedManifest) === node.current.packageManifestSha256 ? ['--installed-package', staged] : [])]);
  const precheck = parsed(pre.last) ?? { status: 'PRECHECK_FAILED', detail: pre.stderr };
  const result = { ...base, node: node.profile.nodeName, workDir: work, packageDir, packageManifestSha256: first.packageManifestSha256,
    grantResource: `ci-resident:${node.profile.nodeName}/${first.packageManifestSha256}`, fromGeneration: node.current.generation, precheck };
  if (!(pre.status === 0 && typeof precheck.status === 'string' && precheck.status.startsWith('PRECHECK_PASS'))) {
    return { ...result, status: PRECHECK_REINSTALL.includes(precheck.code) ? 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL' : 'FLEET_NODE_UPGRADE_PRECHECK_REFUSED', code: precheck.code ?? null };
  }
  // 8. the node on duty: its upgrade pauses CI (the upgrader drains and pauses it), so it is the Owner's choice, never a default
  const onDuty = precheck.warnings?.includes('NODE_HOLDS_CI_ADMISSION_HAND_OVER_FIRST') === true;
  if (onDuty && !allowActiveUpgrade) return { ...result, status: 'FLEET_NODE_UPGRADE_HAND_OVER_FIRST' };
  if (onDuty) result.ciPause = true;
  if (noRequest) return { ...result, status: 'FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED' };

  // 9. the request, by the installed tool
  const script = at('resident', node.current.residentManifestSha256, 'windows', 'request-upgrade.ps1');
  const answer = await request({ script, packageDir, packageManifestSha256: first.packageManifestSha256, decisionRef });
  return { ...result, status: 'FLEET_NODE_UPGRADE_REQUESTED', request: { requestId: answer.requestId ?? null, requestFile: answer.requestFile ?? null },
    ownerNextStep: 'Nothing while the Owner\'s automatic approval is on. Otherwise statusFile shows op.grant.confirmUrl at WAITING_GRANT: approve once there. Run this command again to see where the node is.' };
}

export const OK_STATUSES = Object.freeze(['FLEET_NODE_UPGRADE_REQUESTED', 'FLEET_NODE_UPGRADE_IN_PROGRESS', 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE', 'FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED']);
const REINSTALL_HINT = 'This node cannot take this package in place. Its way is the reinstall: install.mjs prepare with the same --artifact, --artifact-sha and --acceptance (rollout/fleet/README.md).';

// `deps` is for tests only (a fixture root, a stand-in for the installed request tool); the command line cannot reach it.
export async function main(argv, deps = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { artifact: { type: 'string' }, 'artifact-sha': { type: 'string' }, acceptance: { type: 'string' }, work: { type: 'string' },
      'no-request': { type: 'boolean' }, 'allow-active-upgrade': { type: 'boolean' } } });
    need(values.artifact && values['artifact-sha'] && values.acceptance && values.work, 'USAGE');
    const r = await upgradeNode({ ...deps, artifactPath: values.artifact, artifactSha256: values['artifact-sha'], acceptance: jsonOf(await fs.readFile(values.acceptance)),
      workDir: values.work, noRequest: values['no-request'] === true, allowActiveUpgrade: values['allow-active-upgrade'] === true });
    return r.status === 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL' ? { ...r, reinstall: REINSTALL_HINT } : r;
  } catch (e) {
    return { contract: UPGRADE_CONTRACT, status: e?.reinstall ? 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL' : 'FLEET_NODE_UPGRADE_REFUSED', code: e?.code ?? 'FLEET_NODE_UPGRADE_FAILED',
      detail: e?.detail ?? String(e?.message ?? e).slice(0, 300), ...(e?.reinstall ? { reinstall: REINSTALL_HINT } : {}) };
  }
}

if (import.meta.main) {
  // the Windows PowerShell 5.1 children (request-upgrade.ps1, the precheck's Get-Acl) get their own module path (install.mjs)
  process.env.PSModulePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
  main(process.argv.slice(2)).then(r => { console.log(JSON.stringify(r)); process.exitCode = OK_STATUSES.includes(r.status) ? 0 : 1; });
}
