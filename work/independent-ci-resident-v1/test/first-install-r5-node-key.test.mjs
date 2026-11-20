// Fable ruling 11-21 "r5 node key" (D:/w/tmp/FABLE-r5-node-key-20261121.md) section 3.4: only the identity key is required in the TPM;
// the encryption key is made in the software provider (the TPM provider refuses an ECDH key with key-agreement usage, NTE_NOT_SUPPORTED
// 0x80090029, on Intel PTT and Hyper-V vTPM alike). Each part held by a test that failed before it:
//   T1  the real registration script's -SelfTest -KeyProvider tpm, against the real providers of this machine (not elevated; keys of the
//       current user under names only that run uses, deleted again; the node's keys Clued-CI-Node-* and the machine store are never
//       touched): exit 0, the identity key from the TPM, the encryption key from software, both public blobs valid, nothing left behind.
//       Not executed (skipped, never passed) where the TPM provider cannot make even a signing key, the control.
//   T4  the script creates a key in one place only (New-NodeKey), the one T1 runs: no creation path the real test does not cover.
// T2 (the host preparation's rule) is in first-install-r5-host-prep.test.mjs, T3 (the launcher's) in first-install-r5-launcher.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REG = path.join(RES, 'registration', 'export-node-registration.ps1');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'the CNG providers are Windows only';

function powershell(args) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.PSExecutionPolicyPreference;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  assert.ifError(r.error);
  return r;
}
const encoded = command => ['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];

// The key stores a CNG key can land in: the current user's and the machine's, the platform (TPM) provider's and the software provider's.
// Every file under each, or 'unreadable'.
function keyStores() {
  const dirs = [path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Crypto', 'PCPKSP'), path.join(process.env.APPDATA ?? '', 'Microsoft', 'Crypto', 'Keys'),
    'C:\\ProgramData\\Microsoft\\Crypto\\PCPKSP', 'C:\\ProgramData\\Microsoft\\Crypto\\Keys'];
  const out = {};
  for (const dir of dirs) {
    try { out[dir] = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => path.join(d.parentPath ?? d.path, d.name)).sort(); }
    catch (error) { out[dir] = error.code === 'ENOENT' ? [] : 'unreadable'; }
  }
  return out;
}

// The control: can the TPM provider make a signing key for this user at all (a name only this run uses, deleted at once)?
const TPM_CONTROL = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Core
try {
  $p = New-Object System.Security.Cryptography.CngKeyCreationParameters
  $p.Provider = New-Object System.Security.Cryptography.CngProvider 'Microsoft Platform Crypto Provider'
  $p.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
  $k = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, ('Clued-SelfTest-control-' + [Guid]::NewGuid().ToString('N')), $p)
  $k.Delete(); 'TPM_USABLE'
} catch { 'TPM_NOT_USABLE ' + $_.Exception.Message }`;

test('T1: -SelfTest -KeyProvider tpm on the real providers: identity from the TPM, encryption from software, both valid, nothing left behind', { skip, timeout: 300_000 }, (t) => {
  const control = powershell(encoded(TPM_CONTROL));
  const controlLine = String(control.stdout).trim().split(/\r?\n/).at(-1) ?? '';
  if (!controlLine.startsWith('TPM_USABLE')) { t.skip(`not executed: no usable TPM provider on this machine (control: ${controlLine} ${String(control.stderr).trim()})`); return; }
  const before = keyStores();
  const r = powershell(['-File', REG, '-SelfTest', '-KeyProvider', 'tpm', '-Role', 'scan,publish']);
  const after = keyStores();
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const result = JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1));
  assert.deepEqual({ identity: result.identity_origin, encryption: result.encryption_origin }, { identity: 'tpm', encryption: 'software' }, JSON.stringify(result));
  assert.deepEqual(result.roles, ['scan', 'publish']);
  for (const key of ['identity_public_jwk', 'encryption_public_jwk']) assert.deepEqual(Object.keys(result[key]).sort(), ['crv', 'kty', 'x', 'y']);
  const identity = createPublicKey({ key: result.identity_public_jwk, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(result.message, 'base64'), { key: identity, dsaEncoding: 'ieee-p1363' }, Buffer.from(result.signature_p1363, 'base64')),
    'the TPM key signed and the signature verifies under its converted public key');
  createPublicKey({ key: result.encryption_public_jwk, format: 'jwk' });
  assert.notDeepEqual(result.identity_public_jwk, result.encryption_public_jwk);
  // nothing left behind: the run's own key names exist no more, and no key store gained or lost a file
  assert.ok(Array.isArray(result.self_test_key_names) && result.self_test_key_names.length === 2, JSON.stringify(result.self_test_key_names));
  for (const name of result.self_test_key_names) assert.match(name, /^Clued-SelfTest-(identity|encryption)-[0-9a-f]{32}$/, 'never a node key name');
  const exists = powershell(encoded(`$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Core
$tpm = New-Object System.Security.Cryptography.CngProvider 'Microsoft Platform Crypto Provider'
$out = @(); foreach ($n in @(${result.self_test_key_names.map(n => `'${n}'`).join(', ')})) { foreach ($p in @($tpm, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider)) { if ([System.Security.Cryptography.CngKey]::Exists($n, $p)) { $out += $n } } }
'LEFT=' + ($out -join ',')`));
  assert.equal(String(exists.stdout).trim().split(/\r?\n/).at(-1), 'LEFT=', String(exists.stderr));
  assert.deepEqual(after, before);
});

test('T4: the registration script creates a key in New-NodeKey only (init-keys and -SelfTest both through it)', () => {
  const text = fs.readFileSync(REG, 'utf8');
  const creates = [...text.matchAll(/CngKey\]::Create\(/g)].map(m => m.index);
  assert.equal(creates.length, 1, `CngKey]::Create( at ${JSON.stringify(creates)}`);
  const start = text.indexOf('\nfunction New-NodeKey');
  assert.ok(start >= 0, 'New-NodeKey is there');
  const end = text.indexOf('\n}\n', start);
  assert.ok(start < creates[0] && creates[0] < end, 'the one creation is inside New-NodeKey');
  const calls = [...text.slice(end).matchAll(/\bNew-NodeKey\b/g)].length;
  assert.ok(calls >= 2, 'init-keys and -SelfTest call it');
});
