/** Fixed Python release source verification; requires an existing Sigstore 4.1.1. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

export const SOURCE = Object.freeze({
  version: '3.14.8',
  archive: 'python-3.14.8-embed-amd64.zip',
  archive_sha256: 'a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310',
  bundle_sha256: '903afdb58d5e29af9a378ee657a0ad589519aebc28954343b47930c2feaf5dc4',
  identity: 'hugo@python.org',
  issuer: 'https://github.com/login/oauth',
  release_url: 'https://www.python.org/downloads/release/python-3148/',
  identity_policy_url: 'https://www.python.org/downloads/metadata/sigstore/',
});
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
const MODULE = 'C:/Program Files/nodejs/node_modules/npm/node_modules/sigstore/dist/index.js';
const MODULE_ROOT = 'C:/Program Files/nodejs/node_modules/npm/node_modules';

function trustedVerifier() {
  if (process.platform !== 'win32') throw new Error('FIXED_WINDOWS_VERIFIER_REQUIRED');
  const pending = [path.dirname(path.dirname(MODULE))], packages = new Set(), files = new Set();
  const inventory = {};
  while (pending.length) {
    const root = pending.pop();
    if (packages.has(root)) continue;
    if (!path.resolve(root).toLowerCase().startsWith(path.resolve(MODULE_ROOT).toLowerCase() + path.sep)) throw new Error('DEPENDENCY_OUTSIDE_TRUSTED_TREE');
    packages.add(root);
    const pkgFile = path.join(root, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const require = createRequire(pkgFile);
    for (const name of Object.keys(metadata.dependencies || {})) {
      let member = path.dirname(require.resolve(name));
      while (!fs.existsSync(path.join(member, 'package.json'))) {
        const parent = path.dirname(member);
        if (parent === member) throw new Error('DEPENDENCY_PACKAGE_MISSING');
        member = parent;
      }
      pending.push(member);
    }
    const queue = [root];
    while (queue.length) {
      const entry = queue.pop();
      if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('DEPENDENCY_LINK');
      files.add(entry);
      if (fs.statSync(entry).isDirectory()) {
        for (const child of fs.readdirSync(entry)) if (child !== 'node_modules') queue.push(path.join(entry, child));
      } else inventory[path.relative(MODULE_ROOT, entry).replaceAll('\\', '/')] = hash(fs.readFileSync(entry));
    }
  }
  const aclScript = `$ErrorActionPreference='Stop'; $paths=ConvertFrom-Json ([Console]::In.ReadToEnd()); $ba='S-1-5-32-544'; $sy='S-1-5-18'; $ti='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'; $checked=@{}; foreach($initial in $paths){$current=$initial; while($current){if(!$checked.ContainsKey($current)){$checked[$current]=$true; $item=Get-Item -LiteralPath $current -Force; if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'VERIFIER_REPARSE'}; $acl=Get-Acl -LiteralPath $current; $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; $os=($current -ieq 'C:\\' -or $current -ieq 'C:\\Program Files'); if($owner -ne $ba -and $owner -ne $sy -and !($os -and $owner -eq $ti)){throw 'VERIFIER_OWNER'}; foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($ace.AccessControlType -ne 'Allow' -or ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){continue}; if($ace.IdentityReference.Value -in @($ba,$sy) -or ($os -and $ace.IdentityReference.Value -eq $ti)){continue}; $mask=[int64]$ace.FileSystemRights; if($mask -band 0x50000000){throw 'VERIFIER_GENERIC_WRITE'}; $danger=[int64]([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership); if($current -ieq 'C:\\'){$danger=$danger -band (-bnot [int64][Security.AccessControl.FileSystemRights]::CreateDirectories)}; if($mask -band $danger){throw 'VERIFIER_WRITABLE'}}}; $parent=[IO.Path]::GetDirectoryName($current); if(!$parent -or $parent -eq $current){break}; $current=$parent}}; 'VERIFIER_ACL_PASS'`;
  const ps = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const observed = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', aclScript], {input: JSON.stringify([...files]), encoding:'utf8', timeout:60000});
  if (!observed.includes('VERIFIER_ACL_PASS')) throw new Error('VERIFIER_ACL');
  const require = createRequire(import.meta.url);
  const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(MODULE)), 'package.json'), 'utf8'));
  if (metadata.name !== 'sigstore' || metadata.version !== '4.1.1') throw new Error('SIGSTORE_PREREQUISITE');
  const sorted = Object.fromEntries(Object.entries(inventory).sort(([a],[b])=>a.localeCompare(b)));
  return {verifier:require(MODULE), closure_sha256:hash(Buffer.from(JSON.stringify(sorted))), packages:packages.size, files:Object.keys(sorted).length};
}

export async function verifySource({archivePath, bundlePath, cachePath}) {
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error('NODE_PRELOAD_ENVIRONMENT_DENIED');
  // Snapshot bytes once; all digest and signature checks use the same payload.
  const raw = fs.readFileSync(archivePath);
  const bundleRaw = fs.readFileSync(bundlePath);
  if (hash(raw) !== SOURCE.archive_sha256 || hash(bundleRaw) !== SOURCE.bundle_sha256) {
    throw new Error('SOURCE_DIGEST_MISMATCH');
  }
  // A fresh directory forces initialization from the protected installed seed.
  // A pre-existing root/cache, including a link, is never accepted.
  if (fs.existsSync(cachePath)) throw new Error('PREEXISTING_CACHE_DENIED');
  const trusted = trustedVerifier();
  fs.mkdirSync(cachePath, {recursive:false});
  if (fs.lstatSync(cachePath).isSymbolicLink() || fs.readdirSync(cachePath).length) throw new Error('CACHE_NOT_EMPTY');
  // Production TUF root comes from the installed verifier's seed. No caller
  // root/key override, force-cache or disabled transparency verification.
  await trusted.verifier.verify(JSON.parse(bundleRaw.toString('utf8')), raw, {
    certificateIdentityEmail: SOURCE.identity,
    certificateIssuer: SOURCE.issuer,
    tufCachePath: path.resolve(cachePath),
    ctLogThreshold: 1,
    tlogThreshold: 1,
    timeout: 10000,
    retry: {retries: 1},
  });
  return {schema: 'm2-python-runtime-source-verification-v1',
    status: 'SIGSTORE_VERIFIED', source: SOURCE,
    source_bytes: raw.length, sigstore_version: '4.1.1',
    verifier_dependency_closure_sha256: trusted.closure_sha256,
    verifier_dependency_packages: trusted.packages, verifier_dependency_files: trusted.files,
    verifier_sha256: hash(fs.readFileSync(new URL(import.meta.url))),
    verified_at: new Date().toISOString(),
    runtime_executed: false, installed: false, qualification: 'NOT_ISSUED'};
}

export async function main(args) {
  const keys = ['--archive', '--bundle', '--cache', '--output'];
  if (args.length !== 8 || keys.some((key, i) => args[i * 2] !== key || !args[i * 2 + 1])) {
    throw new Error('FIXED_SOURCE_ARGUMENTS');
  }
  const [archivePath, bundlePath, cachePath, outputPath] = keys.map((_, i) => args[i * 2 + 1]);
  // Never overwrite a previous verification receipt; failure writes no PASS.
  if (fs.existsSync(outputPath)) throw new Error('RECEIPT_ALREADY_EXISTS');
  const receipt = await verifySource({archivePath, bundlePath, cachePath});
  fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({status: receipt.status, source_sha256: SOURCE.archive_sha256, qualification: receipt.qualification}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {console.error('FAIL_CLOSED_RUNTIME_SOURCE_VERIFICATION'); process.exitCode = 1;});
}
