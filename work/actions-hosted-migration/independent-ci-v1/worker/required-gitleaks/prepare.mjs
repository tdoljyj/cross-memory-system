// Required Gitleaks history input/profile candidate. No transport, credentials,
// admission bypass, signing, Checks publication or Docker execution here.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateJob } from '../../src/queue.mjs';
import { canonical, digest, subjectOf } from '../../src/proof.mjs';

export const IMAGE = 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
export const SCAN_ARGS = Object.freeze(['git', '/repo', '--config', '/repo/.gitleaks.toml', '--gitleaks-ignore-path', '/reviewed.ignore', '--redact', '--exit-code', '1']);
export const SOURCE_PINS = Object.freeze({
  'scripts/ci/reviewed_gitleaks.py': '433b24137a7d3430990b69e61c0b4ebcd9dad47d770c5df62d6e1fef28b7f7a9',
  '.gitleaks.toml': 'cf631812810d997f42496af561f44930b51087737f146c4a7541c5dbc0a994cd',
  '.github/workflows/gitleaks.yml': '168aebaf047a7c1b1e96d874f5b79500854175e809a373f236ab1079cff2d579',
});
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const completedSelfTests = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const relative = value => typeof value === 'string' && !/[\\:\x00-\x20\x7f]/.test(value) && !value.startsWith('/')
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const exists = async file => { try { await fsp.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export async function noLinks(filename, walk = false) {
  check(path.isAbsolute(filename), 'ABSOLUTE_PATH_REQUIRED');
  for (let cursor = path.resolve(filename); ; cursor = path.dirname(cursor)) {
    const s = await fsp.lstat(cursor); check(!s.isSymbolicLink() && (s.isDirectory() || s.isFile() && s.nlink === 1), 'INPUT_LINK_OR_TYPE_REFUSED');
    if (cursor === path.dirname(cursor)) break;
  }
  check(path.resolve(await fsp.realpath(filename)) === path.resolve(filename), 'INPUT_REALPATH_CHANGED');
  if (walk) for (const entry of await fsp.readdir(filename, { withFileTypes: true })) await noLinks(path.join(filename, entry.name), entry.isDirectory());
  return path.resolve(filename);
}
export function validateRemoteSnapshot(value, job, now = Date.now()) {
  check(plain(value) && value.contract === 'clued.independent-ci.remote-heads-tags/1' && value.repository === job.repo
    && value.complete === true && value.observedAt <= new Date(now).toISOString() && now - Date.parse(value.observedAt) >= 0
    && now - Date.parse(value.observedAt) <= 30000 && Array.isArray(value.refs) && value.refs.length > 0 && value.refs.length <= 10000,
  'FRESH_COMPLETE_REMOTE_REFS_REQUIRED');
  const seen = new Set();
  for (const ref of value.refs) {
    check(plain(ref) && Object.keys(ref).sort().join('|') === 'name|objectSha' && SHA.test(ref.objectSha ?? '')
      && /^refs\/(heads|tags)\//.test(ref.name ?? '') && relative(ref.name) && !/[~^?*\[\]@{]/.test(ref.name)
      && !ref.name.endsWith('.') && !ref.name.endsWith('.lock') && !ref.name.includes('..') && !seen.has(ref.name), 'REMOTE_REF_INVALID');
    seen.add(ref.name);
  }
  return [...value.refs].sort((a, b) => a.name.localeCompare(b.name));
}
function environment(alternate = null) {
  return { PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
    ...(alternate ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate } : {}),
    ...(process.platform === 'win32' ? { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' } : {}) };
}
async function processGit(executable, gitDirectory, args, { stdin = null, outputFile = null, alternate = null, timeoutMs = 300000, maxBytes = 1024 * 1024 * 1024 } = {}) {
  const outfile = outputFile ? await fsp.open(outputFile, 'wx', 0o600) : null;
  try {
    return await new Promise((resolve, reject) => {
      const argv = ['--no-optional-locks', `--git-dir=${gitDirectory}`, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/nonexistent-clued-hooks', '-c', 'protocol.allow=never', ...args];
      const child = spawn(executable, argv, { shell: false, windowsHide: true, env: environment(alternate), stdio: ['pipe', 'pipe', 'pipe'] });
      const parts = [], hash = createHashForBytes(); let count = 0, refused = null, pending = Promise.resolve();
      const timer = setTimeout(() => { refused = 'GIT_PREPARATION_TIMEOUT'; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', bytes => { count += bytes.length; if (count > maxBytes) { refused = 'HISTORY_SIZE_BOUND'; child.kill('SIGKILL'); return; }
        hash.update(bytes); if (outfile) { child.stdout.pause(); pending = pending.then(() => outfile.writeFile(bytes)).then(() => child.stdout.resume()).catch(() => { refused = 'PACK_WRITE_FAILED'; child.kill('SIGKILL'); }); }
        else parts.push(bytes); });
      child.stderr.on('data', () => {}); // Repository contents never reach logs.
      child.once('error', () => { refused = 'PINNED_GIT_UNAVAILABLE'; });
      child.once('close', async code => { clearTimeout(timer); await pending;
        if (refused || code !== 0) reject(Object.assign(new Error(refused ?? 'GIT_PREPARATION_FAILED'), { code: refused ?? 'GIT_PREPARATION_FAILED' }));
        else resolve({ text: Buffer.concat(parts).toString('utf8'), bytes: count, sha256: hash.digest('hex') }); });
      child.stdin.on('error', () => {}); if (stdin === null) child.stdin.end(); else if (Buffer.isBuffer(stdin) || typeof stdin === 'string') child.stdin.end(stdin); else stdin.pipe(child.stdin);
    });
  } finally { if (outfile) { await outfile.sync(); await outfile.close(); } }
}
// Keep binary hashing separate from proof.digest's JSON/text interface.
import { createHash } from 'node:crypto';
const createHashForBytes = () => createHash('sha256');
async function fileHash(file) { const h = createHashForBytes(); for await (const bytes of fs.createReadStream(file)) h.update(bytes); return h.digest('hex'); }
async function writeOnce(file, bytes, mode = 0o600) { const h = await fsp.open(file, 'wx', mode); try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); } }
async function seal(directory) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name); if (entry.isDirectory()) await seal(file); else await fsp.chmod(file, 0o444);
  }
  await fsp.chmod(directory, 0o555);
}

export async function prepareRequiredHistory({ job, sourceManifestBytes, expectedSourceManifestSha256,
  trustedSourceDirectory, gitDirectory, remoteSnapshot, outputDirectory, gitExecutable, expectedGitSha256 }) {
  validateJob(job); check(job.repo === 'tdoljyj/cross-memory-system' && job.role === 'gitleaks' && job.attempt === 1, 'FIXED_REQUIRED_ROLE_REQUIRED');
  check(createHashForBytes().update(sourceManifestBytes).digest('hex') === expectedSourceManifestSha256 && job.sourceManifestSha256 === expectedSourceManifestSha256, 'SOURCE_MANIFEST_CHANGED');
  const manifest = JSON.parse(sourceManifestBytes), role = manifest.roles?.gitleaks;
  check(manifest.schema === 'independent-ci.sources.v1' && manifest.repo === job.repo && SHA.test(manifest.sourceSha ?? '')
    && role && Array.isArray(role.sourceFiles) && role.containerCommand?.image === IMAGE && role.containerCommand.scanner === 'gitleaks'
    && role.containerCommand.executable === '/usr/bin/gitleaks' && role.containerCommand.cwd === '/repo'
    && canonical(role.containerCommand.args) === canonical(SCAN_ARGS), 'REQUIRED_HISTORY_SOURCE_NOT_REGISTERED');
  const source = await noLinks(trustedSourceDirectory), cache = await noLinks(gitDirectory), git = await noLinks(gitExecutable);
  check(HASH.test(expectedGitSha256 ?? '') && await fileHash(git) === expectedGitSha256, 'PINNED_GIT_CHANGED');
  check(path.isAbsolute(outputDirectory) && path.dirname(path.resolve(outputDirectory)) !== path.resolve(outputDirectory), 'OUTPUT_SCOPE_REQUIRED');
  await noLinks(path.dirname(outputDirectory));
  check(![source, cache].some(root => path.resolve(outputDirectory) === root || path.resolve(outputDirectory).startsWith(root + path.sep)
    || root.startsWith(path.resolve(outputDirectory) + path.sep)), 'INPUT_OUTPUT_OVERLAP');
  const refs = validateRemoteSnapshot(remoteSnapshot, job);
  check(refs.find(ref => ref.name === 'refs/heads/main')?.objectSha === job.baseSha, 'REMOTE_MAIN_BASE_CHANGED');
  for (const [filename, hash] of Object.entries(SOURCE_PINS)) {
    const declared = role.sourceFiles.filter(pin => pin.path === filename);
    check(declared.length === 1 && declared[0].sha256 === hash, 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED');
    const file = path.join(source, ...filename.split('/')); await noLinks(file);
    check(await fileHash(file) === hash, 'TRUSTED_REVIEW_SOURCE_CHANGED');
  }
  for (const file of ['shallow', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) check(!(await exists(path.join(cache, ...file.split('/')))), 'INCOMPLETE_OR_INDIRECT_OBJECT_STORE');
  await noLinks(path.join(cache, 'objects'), true);
  check(!(await fsp.readdir(path.join(cache, 'objects', 'pack'))).some(name => name.endsWith('.promisor')), 'PARTIAL_OBJECT_STORE_REFUSED');
  await fsp.mkdir(outputDirectory, { mode: 0o700 });
  const repository = path.join(outputDirectory, 'repo'), control = path.join(outputDirectory, 'control');
  await fsp.mkdir(repository, { mode: 0o755 }); await fsp.mkdir(control, { mode: 0o700 });
  const dotgit = path.join(repository, '.git'); await fsp.mkdir(path.join(dotgit, 'objects', 'pack'), { recursive: true, mode: 0o755 });
  await fsp.mkdir(path.join(dotgit, 'refs'), { mode: 0o755 }); await writeOnce(path.join(dotgit, 'HEAD'), job.headSha + '\n');
  const alternate = path.join(cache, 'objects'), tips = [...new Set([...refs.map(ref => ref.objectSha), job.headSha])];
  // A fresh Git directory supplies no source config/hooks/remotes/index/reflogs.
  // The alternate is a Host-only environment value used during packing. It is
  // never written into the prepared repository or mounted in the scanner.
  for (const sha of [job.headSha, job.baseSha]) check((await processGit(git, dotgit, ['cat-file', '-t', sha], { alternate, maxBytes: 4096 })).text.trim() === 'commit', 'HEAD_BASE_COMMIT_MISSING');
  for (const ref of refs) await processGit(git, dotgit, ['check-ref-format', ref.name], { alternate, maxBytes: 4096 });
  const revisions = tips.join('\n') + '\n';
  const objects = (await processGit(git, dotgit, ['rev-list', '--objects', '--no-object-names', '--stdin'], { stdin: revisions, alternate, maxBytes: 128 * 1024 * 1024 })).text.trim().split('\n').filter(Boolean).sort();
  check(objects.length > 0 && objects.every(object => SHA.test(object)), 'COMPLETE_HISTORY_OBJECTS_UNCONFIRMED');
  const pack = path.join(dotgit, 'objects', 'pack', 'history.pack');
  const packed = await processGit(git, dotgit, ['pack-objects', '--stdout', '--revs'], { stdin: revisions, alternate, outputFile: pack });
  const indexHash = (await processGit(git, dotgit, ['index-pack', '--strict', pack], { maxBytes: 4096 })).text.trim();
  check(SHA.test(indexHash), 'PACK_INDEX_UNCONFIRMED');
  await fsp.rename(pack, path.join(path.dirname(pack), `pack-${indexHash}.pack`));
  await fsp.rename(pack.replace(/\.pack$/, '.idx'), path.join(path.dirname(pack), `pack-${indexHash}.idx`));
  for (const ref of refs) { const file = path.join(dotgit, ...ref.name.split('/')); await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o755 }); await writeOnce(file, ref.objectSha + '\n'); }
  const actual = (await processGit(git, dotgit, ['for-each-ref', '--format=%(refname) %(objectname)'], { maxBytes: 4 * 1024 * 1024 })).text.trim().split('\n').filter(Boolean).map(line => { const [name, objectSha] = line.split(' '); return { name, objectSha }; }).sort((a, b) => a.name.localeCompare(b.name));
  check(canonical(actual) === canonical(refs), 'EXACT_REMOTE_REF_SET_CHANGED');
  await processGit(git, dotgit, ['fsck', '--full', '--strict', '--no-reflogs'], { maxBytes: 65536 });
  await writeOnce(path.join(repository, '.gitleaks.toml'), await fsp.readFile(path.join(source, '.gitleaks.toml')));
  const safeGitConfig = path.join(control, 'git-safe.config');
  await writeOnce(safeGitConfig, '[safe]\n\tdirectory = /repo\n\tdirectory = /test\n');
  const prepared = { contract: 'clued.independent-ci.required-gitleaks-input/1', subject: subjectOf(job),
    sourceSha: manifest.sourceSha, sourceManifestSha256: expectedSourceManifestSha256, remoteSnapshotSha256: digest(remoteSnapshot),
    refs, refScope: 'fresh-remote-heads-tags-plus-current-head', headSha: job.headSha, baseSha: job.baseSha,
    reachableObjectCount: objects.length, reachableObjectsSha256: digest(objects), packedHistorySha256: packed.sha256,
    packedHistoryBytes: packed.bytes, repository, control, safeGitConfig, trustedHelper: path.join(source, 'scripts/ci/reviewed_gitleaks.py'),
    reviewedIgnore: path.join(control, 'reviewed.ignore'), helperSha256: SOURCE_PINS['scripts/ci/reviewed_gitleaks.py'],
    configSha256: SOURCE_PINS['.gitleaks.toml'], workflowSha256: SOURCE_PINS['.github/workflows/gitleaks.yml'],
    sourceCandidateOnly: true, requiredSelfTestComplete: false, requiredScanComplete: false, formalEligible: false };
  await writeOnce(path.join(outputDirectory, 'input.json'), canonical(prepared)); await seal(repository);
  return Object.freeze(prepared);
}

export async function requiredScannerPlan(prepared, selfTestReport) {
  check(prepared?.contract === 'clued.independent-ci.required-gitleaks-input/1', 'PREPARED_HISTORY_REQUIRED');
  check(completedSelfTests.get(selfTestReport) === digest(prepared), 'ACTUAL_TRUSTED_SELF_TEST_OBSERVATION_REQUIRED');
  validateSelfTestReport(selfTestReport);
  await noLinks(prepared.repository, true); await noLinks(prepared.reviewedIgnore); await noLinks(prepared.safeGitConfig);
  const packs = (await fsp.readdir(path.join(prepared.repository, '.git', 'objects', 'pack'))).filter(name => name.endsWith('.pack'));
  check(packs.length === 1 && await fileHash(path.join(prepared.repository, '.git', 'objects', 'pack', packs[0])) === prepared.packedHistorySha256
    && await fileHash(prepared.reviewedIgnore) === selfTestReport.ignore_sha256
    && await fileHash(path.join(prepared.repository, '.gitleaks.toml')) === SOURCE_PINS['.gitleaks.toml']
    && await fsp.readFile(prepared.safeGitConfig, 'utf8') === '[safe]\n\tdirectory = /repo\n\tdirectory = /test\n', 'SEALED_SCANNER_INPUT_CHANGED');
  return Object.freeze({ profile: 'required-gitleaks-history/1', image: IMAGE, executable: '/usr/bin/gitleaks', cwd: '/repo',
    args: [...SCAN_ARGS], mounts: [[prepared.repository, '/repo'], [prepared.reviewedIgnore, '/reviewed.ignore'], [prepared.safeGitConfig, '/etc/gitconfig']],
    user: '65532:65532', network: 'none', rootfsReadOnly: true, capDrop: ['ALL'], noNewPrivileges: true, ipc: 'private',
    scratch: { target: '/scratch', bytes: 536870912, noexec: true, uid: 65532 },
    limits: { timeoutMs: 1200000, maxOutputBytes: 16 * 1024 * 1024, memoryBytes: 2147483648, cpus: 2, pids: 128 },
    requiredInputs: { ...prepared, selfTestReportSha256: digest(selfTestReport), reviewedIgnoreSha256: selfTestReport.ignore_sha256 },
    scanResultNotYetObserved: true, formalEligible: false });
}
function validateSelfTestReport(selfTestReport) {
  check(selfTestReport?.exact_historical_fingerprints === 533 && selfTestReport.default_rules_unchanged === true
    && selfTestReport.global_fingerprints === 0 && HASH.test(selfTestReport.ignore_sha256 ?? '')
    && selfTestReport.regression?.baseline_detection === true && selfTestReport.regression.exact_history_only === true
    && selfTestReport.regression.new_commit_detection === true && selfTestReport.regression.different_path_detection === true
    && ['actual_git_artifact_passes', 'forged_digest_rejected', 'valid_nonancestor_rejected', 'wrong_line_rejected', 'wrong_path_rejected']
      .every(key => selfTestReport.regression.handover_acceptance_artifact_proof?.[key] === true), 'UNCHANGED_REVIEW_SELF_TEST_REQUIRED');
}

export function reviewedSelfTestPlan(prepared, { node, python, git, docker, dockerRootDirectory = '/var/lib/docker' }) {
  for (const tool of [node, python, git, docker]) check(tool && path.isAbsolute(tool.path) && HASH.test(tool.sha256 ?? ''), 'FIXED_RUNTIME_PINS_REQUIRED');
  check(docker.path === '/usr/bin/docker', 'NATIVE_DOCKER_ONLY');
  return { contract: 'clued.independent-ci.required-gitleaks-self-test/1', prepared, node, python, git, docker,
    shimFile: fileURLToPath(new URL('./selftest-shim.mjs', import.meta.url)), dockerRootDirectory,
    argv: ['-I', '-S', prepared.trustedHelper, '--config', path.join(prepared.repository, '.gitleaks.toml'), '--output', prepared.reviewedIgnore, '--self-test'],
    sourceCandidateOnly: true, formalEligible: false };
}

// Explicit runtime operation, never called during preparation or offline tests.
// It runs only the pinned trusted Python helper; the PR supplies no executable.
export async function runReviewedSelfTest(plan) {
  check(process.platform === 'linux' && process.getuid?.() === 0 && plan?.contract === 'clued.independent-ci.required-gitleaks-self-test/1', 'PROTECTED_LINUX_SELF_TEST_REQUIRED');
  for (const tool of [plan.node, plan.python, plan.git, plan.docker]) {
    await noLinks(tool.path); check(await fileHash(tool.path) === tool.sha256, 'SELF_TEST_RUNTIME_PIN_CHANGED');
    for (let cursor = tool.path; ; cursor = path.dirname(cursor)) {
      const stat = await fsp.lstat(cursor); check(stat.uid === 0 && !(stat.mode & 0o022), 'SELF_TEST_RUNTIME_BOUNDARY_UNKNOWN');
      if (cursor === path.dirname(cursor)) break;
    }
  }
  check(await fileHash(plan.prepared.trustedHelper) === SOURCE_PINS['scripts/ci/reviewed_gitleaks.py']
    && await fileHash(path.join(plan.prepared.repository, '.gitleaks.toml')) === SOURCE_PINS['.gitleaks.toml'], 'SELF_TEST_TRUSTED_SOURCE_CHANGED');
  const root = path.join(plan.prepared.control, 'self-test'); await fsp.mkdir(root, { mode: 0o700 });
  const bin = path.join(root, 'bin'), temp = path.join(root, 'tmp'), templates = path.join(root, 'templates');
  for (const directory of [bin, temp, templates]) await fsp.mkdir(directory, { mode: 0o700 });
  const configuration = path.join(root, 'shim.json');
  await writeOnce(configuration, canonical({ contract: 'clued.independent-ci.gitleaks-self-test-shim/1', prepared: plan.prepared,
    git: plan.git, docker: plan.docker, root, temp, templates, dockerRootDirectory: plan.dockerRootDirectory,
    deadline: new Date(Date.now() + 1200000).toISOString() }));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const mode of ['git', 'docker']) await writeOnce(path.join(bin, mode), `#!/bin/sh\nexec ${quote(plan.node.path)} ${quote(plan.shimFile)} ${quote(configuration)} ${mode} "$@"\n`, 0o500);
  const env = { ...environment(), PATH: bin + ':/usr/bin:/bin', TMPDIR: temp, TMP: temp, TEMP: temp, DOCKER_CONFIG: '/nonexistent' };
  const report = await new Promise((resolve, reject) => {
    const child = spawn(plan.python.path, plan.argv, { cwd: plan.prepared.repository, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = []; let bytes = 0, refused = false;
    const timer = setTimeout(() => { refused = true; child.kill('SIGKILL'); }, 1200000);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 65536) { refused = true; child.kill('SIGKILL'); } else parts.push(data); });
    child.stderr.on('data', () => {});
    child.once('error', () => { refused = true; });
    child.once('close', code => { clearTimeout(timer); if (refused || code !== 0) return reject(Object.assign(new Error('TRUSTED_REVIEW_SELF_TEST_FAILED'), { code: 'TRUSTED_REVIEW_SELF_TEST_FAILED' }));
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { reject(new Error('SELF_TEST_REPORT_INVALID')); } });
  });
  validateSelfTestReport(report); await noLinks(plan.prepared.reviewedIgnore);
  check(await fileHash(plan.prepared.reviewedIgnore) === report.ignore_sha256, 'EXACT_REVIEWED_IGNORE_CHANGED');
  const ignore = await fsp.readFile(plan.prepared.reviewedIgnore, 'utf8');
  const config = await fsp.readFile(path.join(plan.prepared.repository, '.gitleaks.toml'), 'utf8');
  const expected = config.split(/\r?\n/).filter(line => line.startsWith('# clued-reviewed-finding: ')).map(line => JSON.parse(line.slice('# clued-reviewed-finding: '.length)).fingerprint).join('\n') + '\n';
  check(ignore === expected, 'EXACT_REVIEWED_IGNORE_MISMATCH'); await fsp.chmod(plan.prepared.reviewedIgnore, 0o444);
  await writeOnce(path.join(plan.prepared.control, 'self-test-report.json'), canonical(report));
  completedSelfTests.set(report, digest(plan.prepared)); return Object.freeze(report);
}
