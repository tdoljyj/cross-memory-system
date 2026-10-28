// The three fixes for the first HALT of the freshly reinstalled TURING resident, 2026-10-29 (DESIGN.md section 33). Offline.
//   (a) companion.json names Source scripts that are not in the installed Source: refused at the package build, at validation and at
//       the companion's start (the PowerShell side of the same rule, verify-resident.ps1, runs over the same cases in
//       windows/test-resident-windows.ps1);
//   (b) the CI root's READ_CONTROL entry for the resident service: the PowerShell tests in windows/test-resident-windows.ps1; here the
//       text-level facts that need no PowerShell;
//   (c) the Windows archive's own refusal code reaches the executor's receipts, the terminal record and the HALT facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../tools/build-package.mjs';
import { COMPANION_CONFIG_CONTRACT, COMPANION_PATH_KEYS, NON_SOURCE_PATH_KEYS, RESIDENT_INSTALL_ROOT, SOURCE_SCRIPT_KEYS, assertSourceScripts, sourceDirectory, validateCompanionConfig } from '../src/companion.mjs';
import { WindowsEngine, windowsArchiveCode } from '../src/engine-windows.mjs';
import { CODE, ResidentError } from '../src/canonical.mjs';
import { batchKey } from '../src/ledger.mjs';
import { nodeProfileSha256 } from '../src/node-profile.mjs';
import { BASE, HEAD, SOURCE, TEST_NODE, TEST_NODE_SHA, executorFixture, fakeCompanion, fakeEngine, notAdmitted, tempRoot, triggerBytes, WINDOWS_CLEAN } from './helpers.mjs';
import { rearmRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
// Test-only use of the Source v2 record assembler (the resident never imports it).
import { fixtureRecord } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { writeRecord } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/prepare-record.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = file => fs.readFile(file, 'utf8');
const CASES = JSON.parse(await read(path.join(HERE, 'test', 'fixtures', 'companion-source-cases.json')));

// ---- (a) Source script paths ----------------------------------------------------------------------------------------------------

const expand = (text, root, sha = CASES.sha) => (typeof text === 'string' ? text.replaceAll('{base}', `${root}\\source\\${sha}`).replaceAll('{root}', root).replaceAll('{sha}', sha).replaceAll('{other}', CASES.other) : text);
const caseScripts = (c, root) => ({
  relayScript: expand(Object.hasOwn(c, 'relayScript') ? c.relayScript : CASES.good.relayScript, root),
  bundleScript: expand(Object.hasOwn(c, 'bundleScript') ? c.bundleScript : CASES.good.bundleScript, root),
});

test('the shared cases: accepted Source script paths pass, every other path is refused with the key it is refused for', () => {
  assert.equal(CASES.contract, 'clued.independent-ci.companion-source-cases/1');
  assert.ok(CASES.accepted.length >= 4 && CASES.refused.length >= 19);
  for (const c of CASES.accepted) {
    const scripts = caseScripts(c, RESIDENT_INSTALL_ROOT);
    const given = c.upperCase ? Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.toUpperCase()])) : scripts;
    assert.doesNotThrow(() => assertSourceScripts(given, { root: RESIDENT_INSTALL_ROOT + (c.rootSuffix ?? ''), ciSourceManifestSha256: CASES.sha }), c.name);
  }
  for (const c of CASES.refused) {
    const scripts = caseScripts(c, RESIDENT_INSTALL_ROOT);
    assert.throws(() => assertSourceScripts(scripts, { root: RESIDENT_INSTALL_ROOT, ciSourceManifestSha256: CASES.sha }),
      error => error instanceof ResidentError && error.code === 'COMPANION_SCRIPT_NOT_IN_SOURCE' && error.detail === c.key && error.message === 'COMPANION_SCRIPT_NOT_IN_SOURCE', c.name);
  }
});

test('the refusal names a fixed code and a key, never the path; the rule needs a real hash and a drive root', () => {
  const stale = { relayScript: `${RESIDENT_INSTALL_ROOT}\\source\\${CASES.other}\\relay-public.ps1`, bundleScript: caseScripts({}, RESIDENT_INSTALL_ROOT).bundleScript };
  try { assertSourceScripts(stale, { ciSourceManifestSha256: CASES.sha }); assert.fail('refused'); } catch (error) {
    assert.deepEqual([error.code, error.detail], ['COMPANION_SCRIPT_NOT_IN_SOURCE', 'relayScript']);
    assert.equal(JSON.stringify({ code: error.code, detail: error.detail, message: error.message }).includes(CASES.other), false, 'no path or hash in the refusal');
  }
  for (const sha of [undefined, null, '', 'abc', 'G'.repeat(64), CASES.sha.slice(1), CASES.sha + '0']) assert.throws(() => sourceDirectory(RESIDENT_INSTALL_ROOT, sha), { code: 'COMPANION_SOURCE_HASH_INVALID' });
  for (const root of [undefined, '', 'resident', '/opt/resident', 'C:/ProgramData/resident']) assert.throws(() => sourceDirectory(root, CASES.sha), { code: 'COMPANION_SOURCE_ROOT_INVALID' });
  assert.equal(sourceDirectory('C:\\x\\resident\\', CASES.sha), `C:\\x\\resident\\source\\${CASES.sha}\\`);
});

test('a path key of companion.json is a Source script unless it is named as not one', () => {
  assert.deepEqual([...COMPANION_PATH_KEYS], ['wslExe', 'powershellExe', 'relayScript', 'bundleScript', 'windowsSpool']);
  assert.deepEqual([...NON_SOURCE_PATH_KEYS], ['wslExe', 'powershellExe', 'windowsSpool']);
  assert.deepEqual([...SOURCE_SCRIPT_KEYS], ['relayScript', 'bundleScript']);
  assert.ok(COMPANION_PATH_KEYS.every(k => SOURCE_SCRIPT_KEYS.includes(k) !== NON_SOURCE_PATH_KEYS.includes(k)), 'each path key is exactly one of the two');
});

const baseConfig = (o = {}) => ({
  contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA,
  wslExe: 'C:\\Windows\\System32\\wsl.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ...caseScripts({}, RESIDENT_INSTALL_ROOT), windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux', ...o,
});

test('validateCompanionConfig refuses a config whose Source scripts are in another Source, and still accepts every earlier call without the Source', () => {
  const source = { root: RESIDENT_INSTALL_ROOT, ciSourceManifestSha256: CASES.sha };
  assert.equal(validateCompanionConfig(baseConfig(), source).relayScript, baseConfig().relayScript);
  assert.throws(() => validateCompanionConfig(baseConfig({ relayScript: baseConfig().relayScript.replace(CASES.sha, CASES.other) }), source), { code: 'COMPANION_SCRIPT_NOT_IN_SOURCE', detail: 'relayScript' });
  assert.throws(() => validateCompanionConfig(baseConfig({ bundleScript: baseConfig().bundleScript.replace(CASES.sha, CASES.other) }), source), { code: 'COMPANION_SCRIPT_NOT_IN_SOURCE', detail: 'bundleScript' });
  assert.throws(() => validateCompanionConfig(baseConfig(), { ...source, ciSourceManifestSha256: CASES.other }), { code: 'COMPANION_SCRIPT_NOT_IN_SOURCE' }, 'the other direction: the config is right for a Source that is not this one');
  // The checks that existed before keep their codes and order.
  assert.throws(() => validateCompanionConfig(baseConfig({ relayScript: 'relay.ps1' }), source), { code: 'COMPANION_CONFIG_PATH_INVALID', detail: 'relayScript' });
  assert.throws(() => validateCompanionConfig(baseConfig({ linuxTool: '/tmp/x' }), source), { code: 'COMPANION_LINUX_TOOL_FIXED' });
  // Without the Source argument nothing changes (the many fixture configs of the other suites).
  assert.doesNotThrow(() => validateCompanionConfig(baseConfig({ relayScript: 'C:\\x\\relay-public.ps1', bundleScript: 'C:\\x\\build-bundle.ps1' })));
});

test('the companion starts only with Source scripts under the Source the installed record names', async () => {
  const main = await read(path.join(HERE, 'src', 'companion-main.mjs'));
  const start = main.slice(main.indexOf('export async function main'));
  assert.match(start, /const ciSourceManifestSha256 = sha256\(await fs\.readFile\(path\.join\(values\.root, 'record', 'source-manifest\.json'\)\)\);/);
  assert.match(start, /const cfg = validateCompanionConfig\(raw\.companion, \{ root: values\.root, ciSourceManifestSha256 \}\);/);
  assert.ok(start.indexOf('record\', \'source-manifest.json') < start.indexOf('validateCompanionConfig(raw.companion'), 'the record hash is read first');
});

async function packageInputs(t, { relayScript, bundleScript } = {}) {
  const root = await tempRoot(t);
  const node = path.join(root, 'node.exe'); await fs.writeFile(node, 'not really node');
  const fx = fixtureRecord();
  const record = path.join(root, 'record'); writeRecord(record, { files: fx.files, recordManifest: fx.recordManifest });
  const profile = JSON.parse(fx.files['acceptance.json']).node;
  const policyInput = JSON.parse(await read(path.join(HERE, 'config', 'policy.example.json')));
  policyInput.node = profile; policyInput.nodeProfileSha256 = nodeProfileSha256(profile);
  policyInput.companion.userSid = profile.ownerSid; policyInput.linux.distribution = profile.wslDistribution;
  const companionInput = JSON.parse(await read(path.join(HERE, 'config', 'companion.example.json')));
  Object.assign(companionInput.companion, { node: profile, nodeProfileSha256: nodeProfileSha256(profile), distribution: profile.wslDistribution });
  const sha = fx.recordManifest.sourceManifestSha256;
  if (relayScript) companionInput.companion.relayScript = relayScript.replaceAll('{sha}', sha);
  if (bundleScript) companionInput.companion.bundleScript = bundleScript.replaceAll('{sha}', sha);
  const policyFile = path.join(root, 'policy.json'), companionFile = path.join(root, 'companion.json');
  await fs.writeFile(policyFile, JSON.stringify(policyInput)); await fs.writeFile(companionFile, JSON.stringify(companionInput));
  return { root, out: path.join(root, 'pkg'), build: () => buildPackage({ out: path.join(root, 'pkg'), policyFile, companionFile, nodeExe: node, recordDir: record }), sha };
}

test('the package build writes Source script paths under source\\<ciSourceManifestSha256>\\ and refuses a stale hash in either path', async t => {
  const ok = await packageInputs(t);
  const built = await ok.build();
  const companion = JSON.parse(await read(path.join(ok.out, 'config', 'companion.json'))).companion;
  assert.equal(built.ciSourceManifestSha256, ok.sha);
  assert.doesNotThrow(() => assertSourceScripts(companion, { root: RESIDENT_INSTALL_ROOT, ciSourceManifestSha256: ok.sha }));
  for (const key of ['relayScript', 'bundleScript']) assert.ok(companion[key].startsWith(`${RESIDENT_INSTALL_ROOT}\\source\\${ok.sha}\\`), key);
  assert.equal(companion.relayScript.includes('<'), false, 'the placeholder is gone');
  // A literal hash that IS this package's Source is as good as the placeholder.
  const literal = await packageInputs(t, { relayScript: `${RESIDENT_INSTALL_ROOT}\\source\\{sha}\\work\\relay-public.ps1` });
  await literal.build();
  // The 2026-10-29 file: paths into an older Source, written by hand over the placeholder. Nothing is installed from such a build.
  const old = `${RESIDENT_INSTALL_ROOT}\\source\\${CASES.other}\\work\\actions-hosted-migration\\independent-ci-v1`;
  const staleRelay = await packageInputs(t, { relayScript: `${old}\\worker\\protected-job-bridge-v4\\relay-public.ps1` });
  await assert.rejects(staleRelay.build(), { code: 'COMPANION_SCRIPT_NOT_IN_SOURCE', detail: 'relayScript' });
  const staleBundle = await packageInputs(t, { bundleScript: `${old}\\src\\resident-v2\\build-bundle.ps1` });
  await assert.rejects(staleBundle.build(), { code: 'COMPANION_SCRIPT_NOT_IN_SOURCE', detail: 'bundleScript' });
  const elsewhere = await packageInputs(t, { bundleScript: 'C:\\Other\\source\\{sha}\\build-bundle.ps1' });
  await assert.rejects(elsewhere.build(), { code: 'COMPANION_SCRIPT_NOT_IN_SOURCE', detail: 'bundleScript' });
});

// ---- (b) the CI root's entry for the resident service: the facts that need no PowerShell ----------------------------------------------

test('the install plan carries the CI root entry, the verify checks it from the live ACL, and nothing broader is planned', async () => {
  const install = await read(path.join(HERE, 'windows', 'install-resident.ps1'));
  const verify = await read(path.join(HERE, 'windows', 'verify-resident.ps1'));
  const code = text => text.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
  assert.match(install, /^\$CiRoot = 'C:\\ProgramData\\CluedIndependentCI'/m);
  assert.match(install, /^\$Root = 'C:\\ProgramData\\CluedIndependentCI\\resident'/m);
  assert.equal(RESIDENT_INSTALL_ROOT, 'C:\\ProgramData\\CluedIndependentCI\\resident', 'the package build checks against the root the install and verify use');
  assert.match(verify, /^\$Root = 'C:\\ProgramData\\CluedIndependentCI\\resident'/m);
  assert.match(install, /PARENT_ACL_UNREADABLE/);
  assert.match(install, /parentAcl = Get-ParentAclState \$CiRoot \$res/);
  assert.match(install, /function Get-ParentAce\(\[string\]\$res\) \{ '\(A;;0x120080;;;' \+ \$res \+ '\)' \}/, 'this folder only: no inheritance flags, mask 0x120080');
  assert.match(install, /contract = 'clued\.independent-ci\.resident-install-plan\/7'/);
  // the step runs after the directories and before any file is placed
  const at = needle => { const i = install.indexOf(needle); assert.ok(i > 0, needle); return i; };
  assert.ok(at("Step 'directories'") < at("Step 'parent-acl'") && at("Step 'parent-acl'") < at("Step 'package-copy'"));
  assert.match(install, /Step 'parent-acl' \{\s*\$wrote = Add-ParentAce \$plan\.parentAcl/);
  // The one ACE appended to an existing folder: the code only ever calls SetAccessControl for it, and writes no owner/group/SACL section.
  const appendFn = install.slice(install.indexOf('function Add-ParentAce'), install.indexOf('# ---- Carry-forward'));
  assert.match(appendFn, /SetSecurityDescriptorSddlForm\(\$now \+ \$p\.ace, \[Security\.AccessControl\.AccessControlSections\]::Access\)/);
  assert.equal([...install.matchAll(/SetAccessControl\(\$p\.path/g)].length, 1);
  assert.doesNotMatch(code(install), /icacls|takeown|Set-Acl\b/i, 'no other way of changing an ACL was added');
  // verify: live ACL of the CI root for the service SID, and the companion scripts
  assert.match(verify, /Record 'ci-root-resident-read-control' \$\(if \(\[string\]::IsNullOrEmpty\(\$ciRootSddl\)\) \{ 'unreadable' \} else \{ try \{ Test-ParentAclRule \$ciRootSddl \(Get-ServiceSid 'CluedCIResident'\) \} catch \{ \$false \} \}\)/);
  assert.match(verify, /\$ciRootSddl = try \{ \(Get-Acl -LiteralPath 'C:\\ProgramData\\CluedIndependentCI'\)\.Sddl \} catch \{ \$null \}/, 'the live ACL of the CI root, not the receipt');
  assert.match(verify, /Record 'companion-source-scripts' \$companionScripts\.ok \$companionScripts\.detail/);
  assert.match(verify, /\$ciSourceSha = Sha256File \(Join-Path \$Root 'record\\source-manifest\.json'\)/);
});

// ---- (c) the Windows archive's own code ---------------------------------------------------------------------------------------------

test('the archive code is the tool\'s own fixed code, else the runner\'s, else a timeout, else unconfirmed: never text', () => {
  assert.equal(windowsArchiveCode({ code: 2 }, { verified: false, code: 'PROFILE_HANDLE_OPEN_REFUSED' }), 'PROFILE_HANDLE_OPEN_REFUSED');
  assert.equal(windowsArchiveCode({ code: 2 }, { verified: false, code: 'WINDOWS_ARCHIVE_UNCONFIRMED' }), 'WINDOWS_ARCHIVE_UNCONFIRMED');
  for (const code of ['lower case', 'Access to the path C:\\ProgramData\\x is denied.', 'A', '', 'X'.repeat(81), 7, null, undefined, ['A_B'], 'A B', 'A\nB'])
    assert.equal(windowsArchiveCode({ code: 2 }, { verified: false, code }), 'WINDOWS_ARCHIVE_UNCONFIRMED', JSON.stringify(code));
  assert.equal(windowsArchiveCode({ code: null, refused: 'RUNNER_SPAWN_FAILED' }, null), 'RUNNER_SPAWN_FAILED');
  assert.equal(windowsArchiveCode({ code: null, refused: 'lower' }, null), 'WINDOWS_ARCHIVE_UNCONFIRMED');
  assert.equal(windowsArchiveCode({ code: null, timedOut: true }, null), 'WINDOWS_ARCHIVE_TIMED_OUT');
  assert.equal(windowsArchiveCode({ code: 2 }, null), 'WINDOWS_ARCHIVE_UNCONFIRMED');
  assert.equal(windowsArchiveCode(undefined, undefined), 'WINDOWS_ARCHIVE_UNCONFIRMED');
  assert.ok(CODE.test('WINDOWS_ARCHIVE_TIMED_OUT') && CODE.test('WINDOWS_ARCHIVE_UNCONFIRMED'));
});

const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
const KEY = 'a1'.repeat(32);
async function archiveEngine(t, answer) {
  const root = await tempRoot(t);
  const sourceRoot = path.join(root, 'source', 'e'.repeat(64));
  await fs.mkdir(path.join(sourceRoot, ...V2), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, ...V2, 'archive-windows-spool.ps1'), '// fixture');
  const runs = [];
  const linux = { ok: true, verified: true, directory: 'archive-linux-x' };
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run: async argv => { runs.push(argv); return answer(argv); }, busy: () => false,
    companionMailbox: { async send() { return {}; }, async await() { return linux; } }, sleep: async () => {}, clock: () => Date.parse('2026-10-29T08:00:00Z'),
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'C:\\resident\\runtime\\node.exe',
      powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', scExe: 'C:\\Windows\\System32\\sc.exe' } });
  return { engine, runs, batch: { key: KEY, batchId: `${KEY.slice(0, 16)}-${'0'.repeat(12)}` } };
}
const verdict = (o = {}) => JSON.stringify({ verified: false, directory: null, moved: null, code: null, scope: null, contract: 'clued.independent-ci.resident-windows-spool-archive/2', ...o });

test('archiveWindows carries the tool\'s refusal code, also from its exit 2, and closeBatch and archiveFailure pass it on', async t => {
  // The 2026-10-29 case: the tool could not open an ancestor of the node profile and said so on stdout with exit 2.
  const refused = await archiveEngine(t, () => ({ code: 2, stdout: verdict({ code: 'PROFILE_HANDLE_OPEN_REFUSED' }) + '\r\n', stderr: '' }));
  const a = await refused.engine.archiveWindows(refused.batch, 'success-close');
  assert.deepEqual(a, { verified: false, directory: null, moved: null, archiveCode: 'PROFILE_HANDLE_OPEN_REFUSED' });
  assert.deepEqual(refused.runs[0].slice(-4), ['-Reason', 'success-close', '-ExpectedNodeProfileSha256', TEST_NODE_SHA]);
  assert.deepEqual(await refused.engine.closeBatch(refused.batch, { linux: false }), { verified: false, archived: null, archiveCode: 'PROFILE_HANDLE_OPEN_REFUSED' });
  assert.deepEqual(await refused.engine.closeBatch(refused.batch), { verified: false, archived: null, archiveCode: 'PROFILE_HANDLE_OPEN_REFUSED' }, 'with Linux too');
  assert.deepEqual(await refused.engine.archiveFailure(refused.batch, 'rearm-quarantine'), { verified: false, directory: null, moved: null, archiveCode: 'PROFILE_HANDLE_OPEN_REFUSED' });
  // Verified: no code, and the moved count and directory as before.
  const ok = await archiveEngine(t, () => ({ code: 0, stdout: verdict({ verified: true, directory: 'archive-aaaaaaaaaaaa-success-close-bbbbbbbbbbbb', moved: 3 }), stderr: '' }));
  assert.deepEqual(await ok.engine.archiveWindows(ok.batch, 'success-close'), { verified: true, directory: 'archive-aaaaaaaaaaaa-success-close-bbbbbbbbbbbb', moved: 3, archiveCode: null });
  assert.deepEqual(await ok.engine.closeBatch(ok.batch), { verified: true, archived: 3, archiveCode: null });
  // Windows verified, Linux not: the Windows code stays empty (it says nothing about Linux).
  const linuxBad = await archiveEngine(t, () => ({ code: 0, stdout: verdict({ verified: true, directory: 'archive-x', moved: 1 }), stderr: '' }));
  linuxBad.engine.archiveLinux = async () => ({ verified: false, directory: null });
  assert.deepEqual(await linuxBad.engine.closeBatch(linuxBad.batch), { verified: false, archived: 1, archiveCode: null });
});

test('an archive that gave no usable code is still named: garbage, free text, a timeout, a runner refusal', async t => {
  const cases = [
    ['not JSON at all', { code: 2, stdout: 'Add-Type : the type could not be loaded\r\n', stderr: 'x' }, 'WINDOWS_ARCHIVE_UNCONFIRMED'],
    ['empty output', { code: 2, stdout: '', stderr: '' }, 'WINDOWS_ARCHIVE_UNCONFIRMED'],
    ['a code that is text', { code: 2, stdout: verdict({ code: 'Access to the path C:\\ProgramData\\CluedIndependentCI is denied.' }), stderr: '' }, 'WINDOWS_ARCHIVE_UNCONFIRMED'],
    ['a refusal without a code', { code: 2, stdout: verdict({ code: null }), stderr: '' }, 'WINDOWS_ARCHIVE_UNCONFIRMED'],
    ['the tool timed out', { code: null, stdout: '', stderr: '', timedOut: true }, 'WINDOWS_ARCHIVE_TIMED_OUT'],
    ['the runner refused', { code: null, stdout: '', stderr: '', refused: 'RUNNER_BUSY_WITH_UNFINISHED_CHILD' }, 'RUNNER_BUSY_WITH_UNFINISHED_CHILD'],
    ['exit 0 but not verified', { code: 0, stdout: verdict({ verified: false, code: 'SPOOL_PATH_REDIRECTED' }), stderr: '' }, 'SPOOL_PATH_REDIRECTED'],
    ['verified in the text but exit 2: not verified', { code: 2, stdout: verdict({ verified: true, directory: 'archive-x', moved: 1 }), stderr: '' }, 'WINDOWS_ARCHIVE_UNCONFIRMED'],
  ];
  for (const [name, answer, want] of cases) {
    const f = await archiveEngine(t, () => answer);
    const a = await f.engine.archiveWindows(f.batch, 'success-close');
    assert.deepEqual([a.verified, a.archiveCode], [false, want], name);
  }
  // Exit 0 with output that is not a verdict stays what it was: the archive throws, unconfirmed (the caller HALTs on it).
  const garbage = await archiveEngine(t, () => ({ code: 0, stdout: 'hello', stderr: '' }));
  await assert.rejects(garbage.engine.archiveWindows(garbage.batch, 'success-close'), { code: 'WINDOWS_ARCHIVE_UNCONFIRMED' });
});

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const keyFor = o => batchKey(subject(o));
const bodies = async (f, types) => (await f.receipts.latest(types, 20)).map(e => [e.type, e.value.body]);
const ARCHIVE_CODE = 'PROFILE_HANDLE_OPEN_REFUSED';

test('the 2026-10-29 HALT, closing an unexecuted batch: the HALT facts, the terminal record and the receipts name the archive\'s code', async t => {
  const engine = fakeEngine({ stages: { 1: notAdmitted() }, close: { verified: false, archived: null, archiveCode: ARCHIVE_CODE } });
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'UNEXECUTED_CLOSE_UNCONFIRMED']);
  const halt = (await f.ledger.halted()).value;
  assert.deepEqual([halt.code, halt.facts.basis, halt.facts.windowsArchiveCode], ['UNEXECUTED_CLOSE_UNCONFIRMED', 'failure-handling-unconfirmed', ARCHIVE_CODE]);
  const terminal = (await f.ledger.state(keyFor())).terminal;
  assert.equal(terminal.facts.failureCode, 'UNEXECUTED_CLOSE_UNCONFIRMED');
  assert.equal(terminal.facts.windowsArchiveCode, ARCHIVE_CODE);
  const got = await bodies(f, ['halt', 'batch-terminal']);
  assert.ok(got.some(([type, body]) => type === 'halt' && body.failureCode === 'UNEXECUTED_CLOSE_UNCONFIRMED' && body.facts.windowsArchiveCode === ARCHIVE_CODE), 'the halt receipt');
  assert.ok(got.some(([type, body]) => type === 'batch-terminal' && body.outcome === 'FAILED_UNKNOWN' && body.windowsArchiveCode === ARCHIVE_CODE), 'the batch-terminal receipt');
});

test('no archive code, or one that is not a fixed code: the records are exactly what they were', async t => {
  for (const archiveCode of [undefined, null, 'free text: C:\\ProgramData\\x', '']) {
    const engine = fakeEngine({ stages: { 1: notAdmitted() }, close: { verified: false, archived: null, ...(archiveCode === undefined ? {} : { archiveCode }) } });
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).failureCode, 'UNEXECUTED_CLOSE_UNCONFIRMED');
    assert.equal(Object.hasOwn((await f.ledger.halted()).value.facts, 'windowsArchiveCode'), false, JSON.stringify(archiveCode));
    assert.equal(Object.hasOwn((await f.ledger.state(keyFor())).terminal.facts, 'windowsArchiveCode'), false);
    assert.ok((await bodies(f, ['halt', 'batch-terminal'])).every(([, body]) => !JSON.stringify(body).includes('windowsArchiveCode')));
  }
  // A verified archive carries no code even when a fake gives one: it is the refusal's code, not a tag.
  const engine = fakeEngine({ stages: { 1: notAdmitted() }, close: { verified: true, archived: 1, archiveCode: ARCHIVE_CODE } });
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'NOT_ADMITTED');
});

test('the same for a failure archive (FAILURE_ARCHIVE_UNCONFIRMED) and for the success path (SUCCESS_PATH_ARCHIVE_UNCONFIRMED)', async t => {
  const failure = await executorFixture(t, { engine: fakeEngine({ stages: { 3: { ok: false, code: 'FIXED_PUBLIC_CHILD_REFUSED', proof: { ...WINDOWS_CLEAN, linuxUnitsInactive: true, containersZero: true } } },
    archiveWindows: { verified: false, directory: null, moved: null, archiveCode: 'SPOOL_PATH_REDIRECTED' } }) });
  await failure.drop(triggerBytes());
  const a = await failure.exec.tick();
  assert.deepEqual([a.state, a.failureCode], ['HALTED', 'FAILURE_ARCHIVE_UNCONFIRMED']);
  assert.equal((await failure.ledger.halted()).value.facts.windowsArchiveCode, 'SPOOL_PATH_REDIRECTED');
  assert.equal((await failure.ledger.state(keyFor())).terminal.facts.windowsArchiveCode, 'SPOOL_PATH_REDIRECTED');
  const success = await executorFixture(t, { engine: fakeEngine({ close: { verified: false, archived: null, archiveCode: ARCHIVE_CODE } }) });
  await success.drop(triggerBytes());
  const b = await success.exec.tick();
  assert.deepEqual([b.state, b.failureCode], ['HALTED', 'SUCCESS_PATH_ARCHIVE_UNCONFIRMED']);
  assert.equal((await success.ledger.halted()).value.facts.windowsArchiveCode, ARCHIVE_CODE);
  assert.equal((await success.ledger.state(keyFor())).terminal.facts.windowsArchiveCode, ARCHIVE_CODE);
  assert.ok((await bodies(success, ['batch-terminal'])).some(([, body]) => body.windowsArchiveCode === ARCHIVE_CODE));
});

test('a re-arm whose Windows archive is refused says why in its refusal receipt', async t => {
  // First a failure that halts with an unarchived FAILED_UNKNOWN scene (the Windows archive fails), then the Owner's re-arm, whose archive fails the same way.
  const archiveWindows = { verified: false, directory: null, moved: null, archiveCode: 'SPOOL_PARENT_HOLD_REFUSED' };
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 3: { ok: false, code: 'FIXED_PUBLIC_CHILD_REFUSED', proof: { ...WINDOWS_CLEAN, linuxUnitsInactive: true, containersZero: true } } }, archiveWindows }),
    companion: fakeCompanion() });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'HALTED');
  const h = await f.ledger.halted();
  f.advance(1);
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: h.sha256, reason: 'checked', by: 'S-1-5-21-1-2-3-1001' }), f.clock);
  assert.equal((await f.exec.tick()).state, 'HALTED', 'the re-arm is refused');
  const refusals = (await bodies(f, ['owner-request-refused'])).map(([, body]) => body);
  assert.ok(refusals.some(b => b.failureCode === 'REARM_WINDOWS_ARCHIVE_UNCONFIRMED' && b.windowsArchiveCode === 'SPOOL_PARENT_HOLD_REFUSED'), JSON.stringify(refusals));
});
