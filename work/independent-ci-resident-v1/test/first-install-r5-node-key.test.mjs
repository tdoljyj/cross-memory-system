// Fable ruling 11-21 "r5 node key" (D:/w/tmp/FABLE-r5-node-key-20261121.md) section 3.4: only the identity key is required in the TPM;
// the encryption key is made in the software provider (the TPM provider refuses an ECDH key with key-agreement usage, NTE_NOT_SUPPORTED
// 0x80090029, on Intel PTT and Hyper-V vTPM alike). Each part held by a test that failed before it:
//   T1  the real registration script's -SelfTest -KeyProvider tpm, against the real providers of this machine (not elevated; keys of the
//       current user under names only that run uses, deleted again; the node's keys Clued-CI-Node-* and the machine store are never
//       touched): exit 0, the identity key from the TPM, the encryption key from software, both public blobs valid, nothing left behind.
//       Not executed (skipped, never passed) where the TPM provider cannot make even a signing key, the control.
//   T4  the script creates a key in one place only (New-NodeKey), the one T1 runs: no creation path the real test does not cover.
//   T5  (ruling 11-21 "r6 ephemeral key" 2.2, D:/w/tmp/FABLE-r6-ephemeral-key-20261121.md) New-NodeKey refuses an empty name
//       (KEY_NAME_REQUIRED): Windows PowerShell passes $null to a [string] as '', which the software provider persists as a key named ''.
//       T1 holds nothing left behind by name: the run's own names, and no key named '' in the software provider.
//   T6  (r6 review, question 1) -KeyProvider is matched case-sensitively where it is used (Get-KeyProviders, -ceq), so its ValidateSet is
//       too: -KeyProvider TPM is refused at parameter binding, before any line of the script runs (no key can be made), not let through
//       to a provider choice that finds nothing and stops with an empty error.
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

// Is there a key named '' in the current user's software provider (what a $null name made)? 'EMPTY=True' or 'EMPTY=False'.
const EMPTY_NAME_CHECK = `try { $empty = [System.Security.Cryptography.CngKey]::Exists('', [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider) } catch { $empty = 'unreadable: ' + $_.Exception.Message }
'EMPTY=' + $empty`;

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
  const r = powershell(['-File', REG, '-SelfTest', '-KeyProvider', 'tpm', '-Role', 'scan,publish']);
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
  // nothing left behind: the run's own key names exist no more, and no key named '' was made
  assert.ok(Array.isArray(result.self_test_key_names) && result.self_test_key_names.length === 2, JSON.stringify(result.self_test_key_names));
  for (const name of result.self_test_key_names) assert.match(name, /^Clued-SelfTest-(identity|encryption)-[0-9a-f]{32}$/, 'never a node key name');
  const exists = powershell(encoded(`$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Core
$tpm = New-Object System.Security.Cryptography.CngProvider 'Microsoft Platform Crypto Provider'
$out = @(); foreach ($n in @(${result.self_test_key_names.map(n => `'${n}'`).join(', ')})) { foreach ($p in @($tpm, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider)) { if ([System.Security.Cryptography.CngKey]::Exists($n, $p)) { $out += $n } } }
'LEFT=' + ($out -join ',')
${EMPTY_NAME_CHECK}`));
  assert.deepEqual(String(exists.stdout).trim().split(/\r?\n/).slice(-2), ['LEFT=', 'EMPTY=False'], String(exists.stderr));
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

// The real New-NodeKey (taken by AST from the script, with Get-Providers and $TpmProviderName), asked for a software key named ''. Before
// the fix it makes a persisted key named '' in the current user's store: the test deletes that one again (Open('') + Delete) before it
// fails, so the machine keeps nothing.
test('T5: New-NodeKey refuses an empty name (KEY_NAME_REQUIRED) and makes no key named \'\'', { skip, timeout: 300_000 }, () => {
  const r = powershell(encoded(`$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2; Add-Type -AssemblyName System.Core
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${REG.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PARSE_ERRORS' }
foreach ($n in @('Get-Providers', 'New-NodeKey')) {
  $f = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -ceq $n }, $false))
  if ($f.Count -ne 1) { throw ('FUNCTION_NOT_ONE:' + $n) }
  . ([scriptblock]::Create($f[0].Extent.Text))
}
$a = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] -and $x.Left.Extent.Text -ceq '$TpmProviderName' }, $false))
. ([scriptblock]::Create($a[0].Extent.Text))
$software = @(Get-Providers | Where-Object { $_[1] -ceq 'software' })[0]
$refused = $null
foreach ($name in @('', $null)) {
  try { $k = New-NodeKey 'encryption' $software $name ([System.Security.Cryptography.CngKeyCreationOptions]::None); $refused += @('created'); try { $k.Dispose() } catch { } }
  catch { $refused += @([string]$_.Exception.Message) }
}
$sw = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
$leftover = [System.Security.Cryptography.CngKey]::Exists('', $sw)
if ($leftover) { $k = [System.Security.Cryptography.CngKey]::Open('', $sw); $k.Delete() }
${EMPTY_NAME_CHECK}
ConvertTo-Json -Compress -InputObject ([ordered]@{ refused = @($refused); leftover = $leftover })`));
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const lines = String(r.stdout).trim().split(/\r?\n/);
  const result = JSON.parse(lines.at(-1));
  assert.equal(lines.at(-2), 'EMPTY=False', 'no key named \'\' is left (deleted again if the code under test made one)');
  assert.equal(result.leftover, false, 'New-NodeKey made a key named \'\'');
  assert.equal(result.refused.length, 2, JSON.stringify(result));
  for (const message of result.refused) assert.match(message, /^KEY_NAME_REQUIRED: /, JSON.stringify(result));
});

// Before the fix the ValidateSet compared without case: TPM got through binding, the self-test found no provider for it (Get-KeyProviders
// compares with -ceq) and stopped with "KEY_CREATE_FAILED: identity: " and nothing after it. Now PowerShell refuses the value at binding:
// exit 1, its own ParameterArgumentValidationError naming KeyProvider (the message itself is in the machine's language), and the script
// body never ran -- no output, none of the script's own CODE: lines, so no key could have been made.
test('T6: -SelfTest -KeyProvider TPM is refused at parameter binding, before the script runs (no key made)', { skip, timeout: 300_000 }, () => {
  const r = powershell(['-File', REG, '-SelfTest', '-KeyProvider', 'TPM']);
  const stderr = String(r.stderr);
  assert.notEqual(r.status, 0, `${r.stdout}\n${stderr}`);
  assert.match(stderr, /ParameterArgumentValidationError,export-node-registration\.ps1/, stderr);
  assert.match(stderr.replace(/\r?\n/g, ''), /KeyProvider/, stderr);   // PowerShell wraps the message at the console width
  assert.doesNotMatch(stderr, /^[A-Z_]+: /m, 'none of the script\'s own CODE: lines: its body never ran');
  assert.equal(String(r.stdout).trim(), '', 'no self-test output: its body never ran');
});
