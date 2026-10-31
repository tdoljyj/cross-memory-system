// Registration export CLI (Task c9673047): Linux key files, read-only export, init-keys never replacing a key, and the Windows
// script's public-blob conversion checked against Node's verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exportRegistration, initLinuxKeys, main, parseArgs, readLinuxPublicKeys } from '../export-node-registration.mjs';
import { validateRegistration } from '../registration-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PS = path.resolve(here, '../export-node-registration.ps1');
const BINDING = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clued-node-reg-'));
const listing = dir => fs.readdirSync(dir).sort();
const sink = () => { let text = ''; return { write: chunk => { text += chunk; }, get text() { return text; } }; };

test('argument parsing: subcommands, repeated options, refusals', () => {
  const o = parseArgs(['--binding-id', BINDING, '--slot-count', '2', '--role', 'scan', '--role', 'publish', '--publisher-requested']);
  assert.equal(o.command, 'export');
  assert.deepEqual(o.role, ['scan', 'publish']);
  assert.equal(o['publisher-requested'], true);
  assert.equal(parseArgs(['init-keys', '--confirm-create-keys']).command, 'init-keys');
  assert.throws(() => parseArgs(['--slot-count']), /USAGE/);
  assert.throws(() => parseArgs(['--unknown', 'x']), /USAGE/);
  assert.throws(() => parseArgs(['--name', 'a', '--name', 'b']), /USAGE/);
  assert.throws(() => parseArgs(['delete-keys']), /USAGE/);
});

test('export without keys is KEY_MISSING and creates nothing', () => {
  const dir = scratch();
  const keyDir = path.join(dir, 'keys');
  assert.throws(() => readLinuxPublicKeys(keyDir), /KEY_MISSING/);
  assert.equal(fs.existsSync(keyDir), false, 'export never creates the key directory');
  const err = sink();
  const code = main(['--binding-id', BINDING, '--slot-count', '1', '--key-dir', keyDir, '--source-commit', 'a'.repeat(40),
    '--out', path.join(dir, 'reg.json')], { stdout: sink(), stderr: err });
  if (process.platform === 'win32') assert.match(err.text, /USAGE: on Windows run export-node-registration\.ps1/);
  else assert.match(err.text, /^KEY_MISSING/);
  assert.equal(code, 2);
  assert.deepEqual(listing(dir), []);
});

test('init-keys needs explicit confirmation and never replaces an existing key', () => {
  const dir = scratch();
  const keyDir = path.join(dir, 'keys');
  assert.throws(() => initLinuxKeys(keyDir, {}), /CONFIRMATION_REQUIRED/);
  assert.equal(fs.existsSync(keyDir), false);
  const created = initLinuxKeys(keyDir, { confirm: true });
  assert.deepEqual(listing(keyDir), ['encryption.key.pem', 'encryption.pub.pem', 'identity.key.pem', 'identity.pub.pem']);
  assert.notEqual(created.identity.fingerprint, created.encryption.fingerprint);
  assert.doesNotMatch(JSON.stringify(created), /PRIVATE|"d"/, 'the answer carries public keys only');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(keyDir, 'identity.key.pem')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(keyDir).mode & 0o777, 0o700);
  }
  const before = Object.fromEntries(listing(keyDir).map(f => [f, fs.readFileSync(path.join(keyDir, f), 'utf8')]));
  assert.throws(() => initLinuxKeys(keyDir, { confirm: true }), /KEY_EXISTS/);
  // A single leftover file is enough to refuse, before anything is generated.
  fs.rmSync(path.join(keyDir, 'encryption.key.pem'));
  fs.rmSync(path.join(keyDir, 'encryption.pub.pem'));
  assert.throws(() => initLinuxKeys(keyDir, { confirm: true }), /KEY_EXISTS/);
  assert.deepEqual(listing(keyDir), ['identity.key.pem', 'identity.pub.pem']);
  assert.equal(fs.readFileSync(path.join(keyDir, 'identity.key.pem'), 'utf8'), before['identity.key.pem']);
});

test('export reads only the public files and produces a page-valid document; outputs are never overwritten', () => {
  const dir = scratch();
  const keyDir = path.join(dir, 'keys');
  initLinuxKeys(keyDir, { confirm: true });
  // A public file alone is not a node key.
  const lonely = path.join(dir, 'lonely');
  fs.mkdirSync(lonely);
  for (const f of ['identity.pub.pem', 'encryption.pub.pem']) fs.copyFileSync(path.join(keyDir, f), path.join(lonely, f));
  assert.throws(() => readLinuxPublicKeys(lonely), /KEY_MISSING/);
  // The private files are never opened: replacing their contents does not change the export.
  const privateBefore = fs.readFileSync(path.join(keyDir, 'identity.key.pem'));
  const manifest = path.join(dir, 'source-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'independent-ci.sources.v2', sourceSha: 'd'.repeat(40), roles: {} }));
  const options = { 'binding-id': BINDING, 'slot-count': '3', 'key-dir': keyDir, 'source-manifest': manifest, role: ['scan'], 'site-id': 'office-a' };
  const first = exportRegistration(options, { platform: 'linux', now: '2026-10-31T12:00:00.000Z' });
  fs.writeFileSync(path.join(keyDir, 'identity.key.pem'), 'garbage');
  const second = exportRegistration(options, { platform: 'linux', now: '2026-10-31T12:00:00.000Z' });
  fs.writeFileSync(path.join(keyDir, 'identity.key.pem'), privateBefore);
  assert.deepEqual(second.registration, first.registration);
  validateRegistration(first.registration, [BINDING]);
  assert.equal(first.registration.qualification_source, 'd'.repeat(40));
  assert.equal(first.registration.profile.slot_count, 3);
  assert.deepEqual(first.registration.profile.capabilities.filter(c => c !== 'docker'), ['linux', 'scan']);
  if (process.platform !== 'win32') {
    const out = path.join(dir, 'reg.json');
    assert.equal(main(['--binding-id', BINDING, '--slot-count', '1', '--key-dir', keyDir, '--source-manifest', manifest, '--out', out],
      { stdout: sink(), stderr: sink() }), 0);
    validateRegistration(JSON.parse(fs.readFileSync(out, 'utf8')), [BINDING]);
    assert.ok(fs.existsSync(path.join(dir, 'reg.qualification.json')));
    const err = sink();
    assert.equal(main(['--binding-id', BINDING, '--slot-count', '1', '--key-dir', keyDir, '--source-manifest', manifest, '--out', out],
      { stdout: sink(), stderr: err }), 2);
    assert.match(err.text, /^OUTPUT_EXISTS/);
  }
});

test('the Source is never guessed on Linux and both sources cannot be given together', () => {
  const dir = scratch();
  const keyDir = path.join(dir, 'keys');
  initLinuxKeys(keyDir, { confirm: true });
  assert.throws(() => exportRegistration({ 'binding-id': BINDING, 'slot-count': '1', 'key-dir': keyDir }, { platform: 'linux' }), /SOURCE_UNAVAILABLE/);
  assert.throws(() => exportRegistration({ 'binding-id': BINDING, 'slot-count': '1', 'key-dir': keyDir, 'source-commit': 'a'.repeat(40),
    'source-manifest': 'x' }, { platform: 'linux' }), /USAGE/);
  assert.throws(() => exportRegistration({ 'binding-id': BINDING, 'slot-count': '1', 'key-dir': keyDir, 'source-commit': 'A'.repeat(40) },
    { platform: 'linux' }), /SOURCE_UNAVAILABLE/);
});

test('Windows facts from the PowerShell side are validated before use', () => {
  const dir = scratch();
  const keyDir = path.join(dir, 'keys');
  const keys = initLinuxKeys(keyDir, { confirm: true });
  const facts = { os: 'windows', os_version: 'Microsoft Windows 11 Pro 10.0.26300', hostname: 'DESK-W-591', memory_mb: 65230,
    docker_server_version: null, hyperv_enabled: true, windows_sandbox_enabled: false, tpm_present: true,
    identity_public_jwk: keys.identity.public_jwk, encryption_public_jwk: keys.encryption.public_jwk, identity_key_origin: 'tpm', encryption_key_origin: 'tpm' };
  const file = path.join(dir, 'facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  const result = exportRegistration({ 'binding-id': BINDING, 'slot-count': '1', facts: file, 'source-commit': 'e'.repeat(40) }, { platform: 'win32' });
  assert.deepEqual(result.registration.profile.capabilities, ['windows', 'hyper-v']);
  assert.equal(result.registration.profile.identity_key_origin, 'tpm');
  fs.writeFileSync(file, JSON.stringify({ ...facts, identity_public_jwk: { ...facts.identity_public_jwk, d: 'x'.repeat(43) } }));
  assert.throws(() => exportRegistration({ 'binding-id': BINDING, 'slot-count': '1', facts: file, 'source-commit': 'e'.repeat(40) }, { platform: 'win32' }),
    /FACTS_INVALID|PUBLIC_KEY_INVALID/);
});

test('Windows: the EccPublicBlob conversion yields keys Node verifies (ephemeral CNG keys, no key store touched)',
  { skip: process.platform !== 'win32' && 'needs Windows CNG' }, () => {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PS, '-SelfTest'],
      { encoding: 'utf8', timeout: 60000 });
    const result = JSON.parse(raw.trim());
    for (const key of ['identity_public_jwk', 'encryption_public_jwk']) assert.deepEqual(Object.keys(result[key]).sort(), ['crv', 'kty', 'x', 'y']);
    const publicKey = createPublicKey({ key: result.identity_public_jwk, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(result.message, 'base64'), { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(result.signature_p1363, 'base64')), 'the signature made by CNG verifies under the converted public key');
    createPublicKey({ key: result.encryption_public_jwk, format: 'jwk' });
    assert.notDeepEqual(result.identity_public_jwk, result.encryption_public_jwk);
  });
