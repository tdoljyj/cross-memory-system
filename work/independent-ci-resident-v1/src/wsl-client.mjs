// The account's MSIX registration is not a WSL execution dependency. Every
// companion lane uses the fixed, machine-installed client, verified once before
// any WSL child or heartbeat. Program Files remains an administrator-controlled
// trust boundary; this observation is not a per-command execution lease.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, exactKeys, HEX64, parseBoundedJson, sha256 } from './canonical.mjs';

export const MACHINE_WSL_EXE = 'C:\\Program Files\\WSL\\wsl.exe';
export const LEGACY_WSL_EXE = 'C:\\Windows\\System32\\wsl.exe';
export const WSL_CLIENT_CONTRACT = 'clued.independent-ci.wsl-client/1';
export const WSL_CLIENT_HELPER = 'windows/wsl-client.ps1';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const INSTALLED_MANIFEST = 'clued.independent-ci.resident-installed-manifest/1';
const RESIDENT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const plainFile = async (file, max, fsImpl) => {
  const st = await fsImpl.lstat(file);
  check(st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= max, 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
  return fsImpl.readFile(file);
};

export function validateWslDeclaration(value) {
  check(value === MACHINE_WSL_EXE || value === LEGACY_WSL_EXE, 'WSL_CLIENT_DECLARATION_REFUSED');
}

export function parseMachineWslClient(value) {
  exactKeys(value, ['contract', 'path', 'sha256', 'signerThumbprint'], 'WSL_CLIENT_FACTS_REFUSED');
  check(value.contract === WSL_CLIENT_CONTRACT && value.path === MACHINE_WSL_EXE && typeof value.sha256 === 'string' && HEX64.test(value.sha256)
    && typeof value.signerThumbprint === 'string' && /^[0-9A-Fa-f]{40}$/.test(value.signerThumbprint), 'WSL_CLIENT_FACTS_REFUSED');
  return Object.freeze({ ...value });
}

// The helper is executable code: bind it to the current receipt, the exact
// content-addressed running generation, and its manifest entry before invoking
// it. Never load it from a configurable path or a different installed generation.
export async function trustedWslValidator(root, { residentDirectory = RESIDENT_DIRECTORY, fsImpl = fs } = {}) {
  try {
    const ancestors = [];
    for (let directory = path.resolve(root); ; directory = path.dirname(directory)) {
      ancestors.push(directory);
      if (path.dirname(directory) === directory) break;
    }
    for (const directory of ancestors) {
      const st = await fsImpl.lstat(directory);
      check(st.isDirectory() && !st.isSymbolicLink(), 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    }
    const receipt = parseBoundedJson(await plainFile(path.join(root, 'install', 'install-receipt.json'), 1024 * 1024, fsImpl), 1024 * 1024, 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    const generation = path.basename(residentDirectory);
    check(HEX64.test(generation) && receipt.residentManifestSha256 === generation, 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    check(path.resolve(residentDirectory) === path.resolve(root, 'resident', generation), 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    for (const directory of [root, path.join(root, 'install'), path.join(root, 'config'), path.join(root, 'resident'), residentDirectory, path.join(residentDirectory, 'windows')]) {
      const st = await fsImpl.lstat(directory);
      check(st.isDirectory() && !st.isSymbolicLink(), 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    }
    const manifestBytes = await plainFile(path.join(root, 'config', 'resident-installed-manifest.json'), 4 * 1024 * 1024, fsImpl);
    check(sha256(manifestBytes) === generation, 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    const manifest = parseBoundedJson(manifestBytes, 4 * 1024 * 1024, 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    exactKeys(manifest, ['contract', 'root', 'files'], 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    check(manifest.contract === INSTALLED_MANIFEST && manifest.root === 'resident' && Array.isArray(manifest.files), 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    const entries = manifest.files.filter(f => f?.path === WSL_CLIENT_HELPER);
    check(entries.length === 1, 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    exactKeys(entries[0], ['path', 'sha256', 'bytes'], 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    check(typeof entries[0].sha256 === 'string' && HEX64.test(entries[0].sha256) && Number.isSafeInteger(entries[0].bytes), 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    const helper = path.join(residentDirectory, 'windows', 'wsl-client.ps1');
    const bytes = await plainFile(helper, 65536, fsImpl);
    check(bytes.length === entries[0].bytes && sha256(bytes) === entries[0].sha256, 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    // These fixed install paths need no PowerShell quoting interpretation.
    check(typeof helper === 'string' && /^[\x20-\x26\x28-\x7e]+$/.test(helper), 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
    return helper;
  } catch (error) {
    if (error?.code === 'WSL_CLIENT_VALIDATOR_UNTRUSTED') throw error;
    check(false, 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
  }
}

export function machineWslValidationArgv(helper) {
  check(typeof helper === 'string' && /^[\x20-\x26\x28-\x7e]+$/.test(helper), 'WSL_CLIENT_VALIDATOR_UNTRUSTED');
  const code = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); "
    + "$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'; "
    + `try { . '${helper}'; Get-CluedMachineWslClient | ConvertTo-Json -Compress } catch { `
    + "$c=[string]$_.Exception.Message; if($c -cnotmatch '^WSL_MACHINE_CLIENT_[A-Z_]{1,60}$'){$c='WSL_MACHINE_CLIENT_UNREADABLE'}; "
    + "[ordered]@{status='REFUSED';code=$c}|ConvertTo-Json -Compress; exit 3 }";
  return [POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')];
}

export async function resolveCompanionWslClient({ root, declaredWslExe, run, residentDirectory = RESIDENT_DIRECTORY, fsImpl = fs }) {
  validateWslDeclaration(declaredWslExe);
  const helper = await trustedWslValidator(root, { residentDirectory, fsImpl });
  const result = await run(machineWslValidationArgv(helper), { timeoutMs: 60_000 });
  check(result && !result.refused && !result.timedOut && !('tree' in result), 'WSL_MACHINE_CLIENT_UNREADABLE');
  let value;
  try { value = parseBoundedJson(Buffer.from(result.stdout ?? '', 'utf8'), 4096, 'WSL_CLIENT_FACTS_REFUSED'); }
  catch { check(false, 'WSL_MACHINE_CLIENT_UNREADABLE'); }
  if (result.code !== 0) {
    check(value && value.status === 'REFUSED' && typeof value.code === 'string' && /^WSL_MACHINE_CLIENT_[A-Z_]{1,60}$/.test(value.code), 'WSL_MACHINE_CLIENT_UNREADABLE');
    check(false, value.code);
  }
  return parseMachineWslClient(value);
}
