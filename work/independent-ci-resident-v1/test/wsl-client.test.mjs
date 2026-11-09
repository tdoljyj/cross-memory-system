import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../src/canonical.mjs';
import { argv } from '../src/companion.mjs';
import { ROLES_PUBLIC_NAMES } from '../src/roles-public.mjs';
import { LEGACY_WSL_EXE, MACHINE_WSL_EXE, WSL_CLIENT_CONTRACT, machineWslValidationArgv, parseMachineWslClient, resolveCompanionWslClient, trustedWslValidator } from '../src/wsl-client.mjs';
import { tempRoot } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const facts = () => ({ contract: WSL_CLIENT_CONTRACT, path: MACHINE_WSL_EXE, sha256: 'a'.repeat(64), signerThumbprint: 'B'.repeat(40) });
async function fixture(t) {
  const root = await tempRoot(t), bytes = Buffer.from('function Get-CluedMachineWslClient { throw "test only" }\n');
  const manifest = Buffer.from(canonicalJson({ contract: 'clued.independent-ci.resident-installed-manifest/1', root: 'resident', files: [{ path: 'windows/wsl-client.ps1', sha256: sha256(bytes), bytes: bytes.length }] }) + '\n');
  const generation = sha256(manifest), residentDirectory = path.join(root, 'resident', generation);
  for (const dir of ['config', 'install', path.join('resident', generation, 'windows')]) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, 'install', 'install-receipt.json'), JSON.stringify({ residentManifestSha256: generation }));
  await fs.writeFile(path.join(root, 'config', 'resident-installed-manifest.json'), manifest);
  const helper = path.join(residentDirectory, 'windows', 'wsl-client.ps1');
  await fs.writeFile(helper, bytes);
  return { root, residentDirectory, helper };
}

test('machine WSL: existing stub declaration is inert; only the validated machine client is selected', async t => {
  const f = await fixture(t), seen = [];
  for (const declaredWslExe of [LEGACY_WSL_EXE, MACHINE_WSL_EXE]) {
    const result = await resolveCompanionWslClient({ ...f, declaredWslExe, run: async (a, o) => { seen.push(a); assert.equal(o.timeoutMs, 60_000); return { code: 0, stdout: JSON.stringify(facts()) }; } });
    assert.equal(result.path, MACHINE_WSL_EXE); assert.ok(Object.isFrozen(result));
  }
  assert.equal(seen.length, 2);
  for (const a of seen) {
    assert.equal(a[0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(a.slice(1, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    const command = Buffer.from(a[6], 'base64').toString('utf16le');
    assert.ok(command.includes(`. '${f.helper}'`)); assert.ok(command.includes('Get-CluedMachineWslClient'));
    assert.ok(command.includes("$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'"));
    assert.equal(a.some(s => /wsl\.exe$/i.test(s)), false, 'validation never spawns WSL');
  }
  let called = false;
  for (const declaredWslExe of ['D:\\custom\\wsl.exe', 'wsl.exe', MACHINE_WSL_EXE.toLowerCase()]) {
    await assert.rejects(resolveCompanionWslClient({ ...f, declaredWslExe, run: async () => { called = true; } }), { code: 'WSL_CLIENT_DECLARATION_REFUSED' });
  }
  assert.equal(called, false);
});

test('machine WSL: missing, reparse, invalid signature and publisher refuse without a WSL child', async t => {
  const f = await fixture(t);
  for (const code of ['WSL_MACHINE_CLIENT_MISSING', 'WSL_MACHINE_CLIENT_NOT_PLAIN', 'WSL_MACHINE_CLIENT_SIGNATURE_INVALID', 'WSL_MACHINE_CLIENT_PUBLISHER_INVALID', 'WSL_MACHINE_CLIENT_UNREADABLE']) {
    let calls = 0;
    await assert.rejects(resolveCompanionWslClient({ ...f, declaredWslExe: LEGACY_WSL_EXE, run: async a => { calls++; assert.equal(a[0].endsWith('powershell.exe'), true); return { code: 3, stdout: JSON.stringify({ status: 'REFUSED', code }) }; } }), { code });
    assert.equal(calls, 1, 'only the verifier starts; no fallback process');
  }
  for (const result of [{ refused: true }, { timedOut: true }, { code: 0, tree: 'unconfirmed', stdout: JSON.stringify(facts()) }, { code: 0, stdout: 'not JSON' }]) {
    await assert.rejects(resolveCompanionWslClient({ ...f, declaredWslExe: MACHINE_WSL_EXE, run: async () => result }), { code: 'WSL_MACHINE_CLIENT_UNREADABLE' });
  }
});

test('machine WSL: validator code is bound to receipt, running generation and exact manifest bytes', async t => {
  const f = await fixture(t);
  assert.equal(await trustedWslValidator(f.root, f), f.helper);
  let called = false;
  await fs.appendFile(f.helper, '# changed');
  await assert.rejects(resolveCompanionWslClient({ ...f, declaredWslExe: MACHINE_WSL_EXE, run: async () => { called = true; } }), { code: 'WSL_CLIENT_VALIDATOR_UNTRUSTED' });
  assert.equal(called, false);
  const g = await fixture(t);
  await fs.writeFile(path.join(g.root, 'install', 'install-receipt.json'), JSON.stringify({ residentManifestSha256: 'f'.repeat(64) }));
  await assert.rejects(trustedWslValidator(g.root, g), { code: 'WSL_CLIENT_VALIDATOR_UNTRUSTED' });
  const h = await fixture(t);
  await fs.appendFile(path.join(h.root, 'config', 'resident-installed-manifest.json'), '\n');
  await assert.rejects(trustedWslValidator(h.root, h), { code: 'WSL_CLIENT_VALIDATOR_UNTRUSTED' });
  const i = await fixture(t);
  for (const target of [i.helper, path.join(i.residentDirectory, 'windows'), path.dirname(i.root)]) {
    const fsImpl = { ...fs, lstat: async p => p === target ? { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => true, size: 50 } : fs.lstat(p) };
    await assert.rejects(trustedWslValidator(i.root, { ...i, fsImpl }), { code: 'WSL_CLIENT_VALIDATOR_UNTRUSTED' });
  }
});

test('machine WSL: verifier facts reject alternate paths, wrong types and extra fields', () => {
  assert.deepEqual(parseMachineWslClient(facts()), facts());
  for (const value of [null, [], { ...facts(), path: LEGACY_WSL_EXE }, { ...facts(), sha256: ['a'.repeat(64)] }, { ...facts(), signerThumbprint: 'b'.repeat(39) }, { ...facts(), extra: true }]) {
    assert.throws(() => parseMachineWslClient(value), { code: 'WSL_CLIENT_FACTS_REFUSED' });
  }
  assert.throws(() => machineWslValidationArgv("C:\\untrusted'helper.ps1"), { code: 'WSL_CLIENT_VALIDATOR_UNTRUSTED' });
});

test('machine WSL: every Linux runtime builder uses the derived client, including upgrade, memory and keepalive', async () => {
  const cfg = { wslExe: MACHINE_WSL_EXE, distribution: 'Ubuntu-24.04', linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' };
  const a = argv(cfg), id = '1234567890abcdef-1234567890ab', op = '12345678-1234-1234-1234-1234567890ab';
  const calls = [a.startWait('worker', id), a.startNoBlock('worker', id), a.unitFacts('worker', id), a.linuxTool('quiescence', id), a.archiveUsage(), a.archivePrune(), a.linuxOutgoing(), a.linuxIncoming(), a.linuxRelayProcs(), a.memoryFacts(), a.archiveStatus(id + '_gitleaks'), a.keepalive(), a.upgradeTool(['version-facts']), a.upgradeTool(['verify', '--op', op, '--generation', '1']), ...ROLES_PUBLIC_NAMES.map(n => a.rolePublic(n))];
  for (const args of calls) assert.equal(args[0], MACHINE_WSL_EXE);
  const main = await fs.readFile(path.join(HERE, '..', 'src', 'companion-main.mjs'), 'utf8');
  const gate = main.indexOf('const wslClient = await resolveCompanionWslClient(');
  assert.ok(gate > 0 && gate < main.indexOf('const mailbox = await Mailbox.open('));
  assert.ok(main.indexOf('cfg = Object.freeze({ ...cfg, wslExe: wslClient.path })') > gate);
  assert.ok(main.includes('sessionFacts({ wsl: (...l) => [cfg.wslExe,'));
  assert.ok(main.includes('companionArgv(cfg).keepalive()'));
});
