#!/usr/bin/env node
// Node registration export (Task c9673047). Two subcommands:
//
//   export (default)  read-only. Reads the node's two PUBLIC keys, observes the host, reads the installed CI Source commit and
//                     writes the /ci-nodes registration document and its public qualification report. Creates nothing but those
//                     two output files (never overwriting one); a missing key is KEY_MISSING and nothing is written.
//   init-keys         Linux only, and only with --confirm-create-keys: creates the identity (ECDSA P-256) and encryption
//                     (ECDH P-256) key pairs in --key-dir. Refuses (KEY_EXISTS) when any of the four files is already there, before
//                     creating anything. Run it only in an install wave the Owner approved: it is a key operation.
//
// Linux keys: <key-dir>/identity.key.pem and encryption.key.pem (PKCS#8, mode 0600, the directory 0700) with identity.pub.pem and
// encryption.pub.pem (SPKI, 0644) written beside them at creation. export reads only the two .pub.pem files (it checks that the
// private files exist without opening them); the key origin is "software". Windows keys live in CNG and are read by
// export-node-registration.ps1, which passes the observed public facts here with --facts <file>.
//
// No network access, no private key ever printed, written elsewhere or put in the output. Errors print one CODE: detail line and exit 2.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RegistrationError, buildRegistration, check, jwkFromPublicPem, keyFingerprint, sourceFromManifest, validateFacts }
  from './registration-core.mjs';

export const LINUX_KEY_DIR = '/etc/clued-ci-node/keys';
export const WINDOWS_SOURCE_MANIFEST = 'C:\\ProgramData\\CluedIndependentCI\\resident\\record\\source-manifest.json';
export const KEY_FILES = Object.freeze({ identity: ['identity.key.pem', 'identity.pub.pem'], encryption: ['encryption.key.pem', 'encryption.pub.pem'] });

const USAGE = `usage:
  node export-node-registration.mjs [export] --binding-id <uuid> --slot-count <1..64> [--name <name>] [--site-id <id>]
      [--environment-kind <E1-Linux|E1-Windows|E4-Windows-Sandbox|hardened-Windows>]... [--role <scan|publish|control|relay|f-pr>]...
      [--exclusion <capability>]... [--memory-limit-mb <n>] [--publisher-requested] [--scan-signing-requested]
      [--source-manifest <file> | --source-commit <40-hex>] [--key-dir <dir>] [--facts <file>] [--out <file>] [--report-out <file>]
  node export-node-registration.mjs init-keys --confirm-create-keys [--key-dir <dir>]`;

const FLAGS = new Set(['publisher-requested', 'scan-signing-requested', 'confirm-create-keys', 'help']);
const MULTI = new Set(['environment-kind', 'role', 'exclusion']);
const VALUED = new Set(['binding-id', 'slot-count', 'name', 'site-id', 'memory-limit-mb', 'source-manifest', 'source-commit', 'key-dir',
  'facts', 'out', 'report-out', ...MULTI]);

export function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'export';
  check(command === 'export' || command === 'init-keys', 'USAGE', `unknown subcommand ${command}`);
  const options = { command };
  while (args.length) {
    const raw = args.shift();
    check(raw.startsWith('--'), 'USAGE', `unexpected ${raw}`);
    const key = raw.slice(2);
    if (FLAGS.has(key)) { options[key] = true; continue; }
    check(VALUED.has(key), 'USAGE', `unknown option ${raw}`);
    check(args.length > 0 && !args[0].startsWith('--'), 'USAGE', `${raw} needs a value`);
    const value = args.shift();
    if (MULTI.has(key)) (options[key] ??= []).push(value);
    else { check(!(key in options), 'USAGE', `${raw} given twice`); options[key] = value; }
  }
  return options;
}

const integerOption = (value, name) => {
  check(/^(0|[1-9][0-9]{0,6})$/.test(value ?? ''), 'OPTION_INVALID', `${name} must be a whole number`);
  return Number(value);
};

function readOnlyFile(file, code) {
  try { return fs.readFileSync(file); } catch (error) { throw new RegistrationError(code, `${file}: ${error.code ?? error.message}`); }
}

// Public keys of a Linux node. Only the .pub.pem files are opened; the private files are checked for presence with lstat.
export function readLinuxPublicKeys(keyDir) {
  const out = {};
  for (const [role, [privateName, publicName]] of Object.entries(KEY_FILES)) {
    const privatePath = path.join(keyDir, privateName);
    const publicPath = path.join(keyDir, publicName);
    check(fs.existsSync(publicPath), 'KEY_MISSING', `${publicPath} (run init-keys only in an approved install wave)`);
    let privateStat;
    try { privateStat = fs.lstatSync(privatePath); } catch { throw new RegistrationError('KEY_MISSING', `${privatePath} is missing; the public file alone is not a node key`); }
    check(privateStat.isFile(), 'KEY_MISSING', `${privatePath} is not a regular file`);
    if (process.platform !== 'win32') check((privateStat.mode & 0o077) === 0, 'KEY_PERMISSIONS', `${privatePath} is readable by group or others`);
    out[role] = jwkFromPublicPem(readOnlyFile(publicPath, 'KEY_MISSING').toString('utf8'));
  }
  check(keyFingerprint(out.identity) !== keyFingerprint(out.encryption), 'KEY_INVALID', 'identity and encryption are the same key');
  return out;
}

export function initLinuxKeys(keyDir, { confirm } = {}) {
  check(confirm === true, 'CONFIRMATION_REQUIRED', 'init-keys creates node keys; pass --confirm-create-keys, and only in an install wave the Owner approved');
  const files = Object.values(KEY_FILES).flat().map(name => path.join(keyDir, name));
  const present = files.filter(file => fs.existsSync(file));
  check(present.length === 0, 'KEY_EXISTS', `${present.join(', ')} already exist; init-keys never replaces a key`);
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const stat = fs.lstatSync(keyDir);
    check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'KEY_PERMISSIONS', `${keyDir} must be a 0700 directory`);
  }
  const result = {};
  for (const [role, [privateName, publicName]] of Object.entries(KEY_FILES)) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    // 'wx': never replaces a file that appeared meanwhile.
    fs.writeFileSync(path.join(keyDir, privateName), privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    fs.writeFileSync(path.join(keyDir, publicName), publicPem, { flag: 'wx', mode: 0o644 });
    const jwk = jwkFromPublicPem(publicPem);
    result[role] = { public_jwk: jwk, fingerprint: keyFingerprint(jwk), origin: 'software' };
  }
  return result;
}

function run(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
  catch { return null; }
}

export function observeLinux(keyDir) {
  const keys = readLinuxPublicKeys(keyDir);
  const release = run('uname', ['-sr']) ?? `${os.type()} ${os.release()}`;
  const docker = run('docker', ['version', '--format', '{{.Server.Version}}']);
  return validateFacts({
    os: 'linux', os_version: release.slice(0, 200), hostname: os.hostname().slice(0, 100), memory_mb: Math.floor(os.totalmem() / 1048576),
    docker_server_version: docker && /^[0-9A-Za-z.+_-]{1,64}$/.test(docker) ? docker : null, hyperv_enabled: null, windows_sandbox_enabled: null,
    tpm_present: fs.existsSync('/dev/tpmrm0') || fs.existsSync('/dev/tpm0'),
    identity_public_jwk: keys.identity, encryption_public_jwk: keys.encryption, identity_key_origin: 'software', encryption_key_origin: 'software',
  });
}

export function resolveSource(options, platform) {
  check(!(options['source-manifest'] && options['source-commit']), 'USAGE', 'give --source-manifest or --source-commit, not both');
  if (options['source-commit']) {
    check(/^[0-9a-f]{40}$/.test(options['source-commit']), 'SOURCE_UNAVAILABLE', '--source-commit must be 40 lowercase hex');
    return { commit: options['source-commit'], manifestSha256: null };
  }
  const manifest = options['source-manifest'] ?? (platform === 'win32' ? WINDOWS_SOURCE_MANIFEST : null);
  check(manifest, 'SOURCE_UNAVAILABLE', 'pass --source-manifest <record/source-manifest.json> or --source-commit <40-hex>; nothing is guessed');
  return sourceFromManifest(readOnlyFile(manifest, 'SOURCE_UNAVAILABLE'));
}

export function exportRegistration(options, { platform = process.platform, now } = {}) {
  check(options['binding-id'], 'USAGE', '--binding-id is required');
  check(options['slot-count'] !== undefined, 'USAGE', '--slot-count is required');
  let facts;
  if (options.facts) {
    let parsed;
    try { parsed = JSON.parse(readOnlyFile(options.facts, 'FACTS_INVALID').toString('utf8')); }
    catch (error) { if (error instanceof RegistrationError) throw error; throw new RegistrationError('FACTS_INVALID', 'not JSON'); }
    facts = validateFacts(parsed);
  } else {
    check(platform !== 'win32', 'USAGE', 'on Windows run export-node-registration.ps1 (it reads the CNG keys and calls this script)');
    facts = observeLinux(options['key-dir'] ?? LINUX_KEY_DIR);
  }
  return buildRegistration(facts, {
    bindingId: options['binding-id'], name: options.name, slotCount: integerOption(options['slot-count'], '--slot-count'),
    siteId: options['site-id'], environmentKinds: options['environment-kind'], roles: options.role, exclusions: options.exclusion,
    memoryLimitMb: options['memory-limit-mb'] === undefined ? undefined : integerOption(options['memory-limit-mb'], '--memory-limit-mb'),
    publisherRequested: options['publisher-requested'] === true, scanSigningRequested: options['scan-signing-requested'] === true,
    source: resolveSource(options, platform), generatedAt: now,
  });
}

// Both files are written with 'wx' after both documents are complete, so a refusal leaves nothing behind.
export function writeOutputs(result, out, reportOut) {
  for (const file of [out, reportOut]) check(!fs.existsSync(file), 'OUTPUT_EXISTS', `${file} already exists; choose another --out/--report-out`);
  fs.writeFileSync(reportOut, JSON.stringify(result.report, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(out, JSON.stringify(result.registration, null, 2) + '\n', { flag: 'wx' });
}

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const options = parseArgs(argv);
    if (options.help) { io.stdout.write(USAGE + '\n'); return 0; }
    if (options.command === 'init-keys') {
      check(process.platform !== 'win32', 'USAGE', 'on Windows use export-node-registration.ps1 -Mode init-keys');
      const created = initLinuxKeys(options['key-dir'] ?? LINUX_KEY_DIR, { confirm: options['confirm-create-keys'] === true });
      io.stdout.write(JSON.stringify({ status: 'created', keys: created }, null, 2) + '\n');
      return 0;
    }
    const result = exportRegistration(options);
    const out = options.out ?? 'clued-node-registration.json';
    const reportOut = options['report-out'] ?? out.replace(/\.json$/i, '') + '.qualification.json';
    writeOutputs(result, out, reportOut);
    io.stdout.write(`registration: ${path.resolve(out)}\nqualification report: ${path.resolve(reportOut)}\n`
      + `identity fingerprint: ${result.report.keys.identity_fingerprint}\nencryption fingerprint: ${result.report.keys.encryption_fingerprint}\n`);
    return 0;
  } catch (error) {
    io.stderr.write((error instanceof RegistrationError ? error.message : `INTERNAL: ${error.message}`) + '\n');
    if (!(error instanceof RegistrationError) || error.code === 'USAGE') io.stderr.write(USAGE + '\n');
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
