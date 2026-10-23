// Source v2 copy of worker.mjs (DESIGN S6): job contract v2 identity and the v2 Source manifest schema.
// Job contract /3 (quota phase 2 step 3b): the candidate is checked out at the tested commit S (job.testSha, S = H
// outside the train); the head H and the base T must be in its store. The identity keeps its fields: jobId binds S.
import { createHash, randomBytes, verify } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { validateJobV2 } from './job-v2.mjs';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const fixtureRuntimes = new WeakSet();
const protectedRuntimes = new WeakSet();
const preparedRequests = new WeakSet();
// Source v2 job identity (claim-free, attempt-scoped; DESIGN S6; jobId binds S since contract /3). Everything else is worker.mjs unchanged.
const identityKeys = ['jobId', 'repo', 'pr', 'headSha', 'baseSha', 'role', 'sourceManifestSha256', 'attempt'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_JSON');
  return JSON.stringify(value);
}
function insist(ok, code) { if (!ok) throw new Error(code); }
function text(value, max = 200) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value); }
function identityOf(job) {
  insist(job && typeof job === 'object' && !Array.isArray(job), 'INVALID_JOB');
  try { validateJobV2(job); } catch { throw new Error('INVALID_JOB'); }
  for (const key of ['argv', 'args', 'command', 'executable', 'env', 'shell', 'runtime', 'sourceManifest', 'containerCommand', 'executionMode', 'image', 'scanner', 'claimId', 'fence', 'epoch']) insist(!(key in job), 'JOB_EXECUTION_OVERRIDE');
  const identity = Object.fromEntries(identityKeys.map(k => [k, k === 'jobId' ? job.id : job[k]]));
  insist(/^[a-z][a-z0-9_.-]{0,79}$/.test(identity.role ?? '') && DIGEST.test(identity.sourceManifestSha256 ?? ''), 'INVALID_ROLE');
  insist(Number.isSafeInteger(identity.attempt) && identity.attempt >= 1 && identity.attempt <= 2, 'ATTEMPT_NOT_ADMITTED');
  return identity;
}
function safeRelative(value, allowDot = false) {
  insist(text(value, 2000) && !value.includes('\\') && !path.posix.isAbsolute(value) && !value.includes(':') && !value.includes('\0'), 'PATH_ESCAPE');
  if (value === '.' && allowDot) return value;
  insist(value.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p)), 'PATH_ESCAPE');
  return value;
}
async function noLinks(absolutePath, { walk = false, skipGit = false } = {}) {
  insist(path.isAbsolute(absolutePath), 'ABSOLUTE_PATH_REQUIRED');
  const absolute = path.resolve(absolutePath);
  let cursor = path.parse(absolute).root;
  for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    insist(!info.isSymbolicLink() && (info.isDirectory() || info.nlink === 1), 'LINK_REFUSED');
  }
  insist(path.resolve(await realpath(absolute)) === absolute, 'REALPATH_MISMATCH');
  if (walk) {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (skipGit && entry.name === '.git') continue;
      const child = path.join(absolute, entry.name);
      const info = await lstat(child);
      insist(!info.isSymbolicLink() && (info.isDirectory() || info.nlink === 1), 'LINK_REFUSED');
      if (info.isDirectory()) await noLinks(child, { walk: true });
    }
  }
  return absolute;
}
function cleanEnv() {
  // No inherited PATH, HOME, proxy, GitHub, admission, cloud or signing credentials.
  const env = { LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
    env.WINDIR = env.SystemRoot;
  }
  return env;
}
async function smallProcess(executable, args, cwd, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const buffers = []; let bytes = 0; let done = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('GIT_TIMEOUT')); }, 10000);
    function finish(error, result) { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); }
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > limit) { child.kill('SIGKILL'); finish(new Error('GIT_OUTPUT_LIMIT')); } else buffers.push(chunk); });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error('GIT_UNAVAILABLE')));
    child.once('close', code => code === 0 ? finish(null, Buffer.concat(buffers)) : finish(new Error('GIT_REFUSED')));
  });
}
async function git(root, gitExecutable, ...args) {
  insist(path.isAbsolute(gitExecutable), 'PINNED_GIT_PATH_REQUIRED');
  return smallProcess(gitExecutable, ['--no-optional-locks', `--git-dir=${path.join(root, '.git')}`, `--work-tree=${root}`, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/nonexistent-independent-ci-hooks', ...args], root);
}
async function validateCheckout(root, commit, gitExecutable, { complete = true, files = [] } = {}) {
  root = await noLinks(root);
  const metadata = path.join(root, '.git');
  insist((await lstat(metadata)).isDirectory(), 'INDEPENDENT_GIT_DIRECTORY_REQUIRED');
  await noLinks(metadata, { walk: true });
  for (const prohibited of ['commondir', 'shallow', 'objects/info/alternates']) {
    try { await lstat(path.join(metadata, prohibited)); throw new Error('SHARED_OR_PARTIAL_GIT_REFUSED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const config = await readFile(path.join(metadata, 'config'), 'utf8');
  insist(!/^\s*\[(include|includeIf|filter|extensions)\b/im.test(config), 'UNSAFE_GIT_CONFIG');
  insist((await git(root, gitExecutable, 'rev-parse', '--verify', 'HEAD^{commit}')).toString().trim() === commit, 'HEAD_MISMATCH');
  const tree = (await git(root, gitExecutable, 'ls-tree', '-r', '-z', '--full-tree', commit)).toString('utf8').split('\0').filter(Boolean);
  const entries = new Map();
  for (const entry of tree) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    insist(match, 'NONREGULAR_GIT_ENTRY');
    const relative = safeRelative(match[3]);
    insist(!entries.has(relative), 'DUPLICATE_TREE_PATH');
    entries.set(relative, match[2]);
  }
  const selected = complete ? [...entries.keys()] : files.map(file => file.path);
  for (const relative of selected) {
    safeRelative(relative); insist(entries.has(relative), 'SOURCE_NOT_IN_TREE');
    const absolute = await noLinks(path.join(root, ...relative.split('/')));
    const info = await lstat(absolute);
    insist(info.isFile(), 'SOURCE_NOT_REGULAR');
    insist(info.size <= 64 * 1024 * 1024, 'SOURCE_FILE_SIZE_LIMIT');
    const bytes = await readFile(absolute);
    const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    insist(oid === entries.get(relative), 'TREE_BYTES_MISMATCH');
    const pin = files.find(file => file.path === relative);
    if (pin) insist(DIGEST.test(pin.sha256) && sha256(bytes) === pin.sha256, 'SOURCE_HASH_MISMATCH');
  }
  if (complete) {
    await noLinks(root, { walk: true, skipGit: true });
    async function checkExtras(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!prefix && entry.name === '.git') continue;
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await checkExtras(path.join(directory, entry.name), `${relative}/`);
        else insist(entries.has(relative), 'UNTRACKED_WORKSPACE_FILE');
      }
    }
    await checkExtras(root);
  }
  return { path: root, treeSha: (await git(root, gitExecutable, 'rev-parse', `${commit}^{tree}`)).toString().trim() };
}
async function headAndBasePresent(candidate, gitExecutable, identity) {
  insist((await git(candidate, gitExecutable, 'cat-file', '-t', identity.baseSha)).toString().trim() === 'commit', 'BASE_NOT_PRESENT');
  insist((await git(candidate, gitExecutable, 'cat-file', '-t', identity.headSha)).toString().trim() === 'commit', 'HEAD_NOT_PRESENT');
}
export async function prepareWorkerJob({ job, workspace, trustedSourceDirectory, sourceManifestBytes, expectedSourceManifestSha256, gitExecutable }) {
  const identity = identityOf(job);
  insist(Buffer.isBuffer(sourceManifestBytes) || typeof sourceManifestBytes === 'string', 'SOURCE_BYTES_REQUIRED');
  insist(DIGEST.test(expectedSourceManifestSha256 ?? '') && sha256(sourceManifestBytes) === expectedSourceManifestSha256 && identity.sourceManifestSha256 === expectedSourceManifestSha256, 'MANIFEST_HASH_MISMATCH');
  let manifest; try { manifest = JSON.parse(sourceManifestBytes); } catch { throw new Error('INVALID_MANIFEST'); }
  insist(manifest.schema === 'independent-ci.sources.v2' && manifest.repo === identity.repo && SHA.test(manifest.sourceSha), 'INVALID_MANIFEST');
  insist(Object.hasOwn(manifest.roles ?? {}, identity.role), 'ROLE_NOT_REGISTERED');
  const role = manifest.roles[identity.role];
  insist(role && Array.isArray(role.sourceFiles) && role.sourceFiles.length > 0 && role.sourceFiles.length <= 1000, 'SOURCE_CLOSURE_REQUIRED');
  insist(new Set(role.sourceFiles.map(f => f.path)).size === role.sourceFiles.length, 'DUPLICATE_SOURCE');
  role.sourceFiles.forEach(file => { safeRelative(file.path); insist(DIGEST.test(file.sha256), 'INVALID_SOURCE_PIN'); });
  const command = role.command;
  insist(command && path.isAbsolute(command.executable ?? '') && DIGEST.test(command.executableSha256 ?? '') && Array.isArray(command.args) && command.args.every(arg => typeof arg === 'string' && !arg.includes('\0') && arg.length < 8192), 'INVALID_TRUSTED_COMMAND');
  insist(command.args.length <= 256 && Object.keys(command).every(k => ['executable', 'executableSha256', 'args', 'cwd'].includes(k)), 'INVALID_TRUSTED_COMMAND');
  safeRelative(command.cwd ?? '.', true);
  insist(Number.isSafeInteger(role.timeoutMs) && role.timeoutMs >= 10 && role.timeoutMs <= 3600000, 'INVALID_TIMEOUT');
  insist(Number.isSafeInteger(role.maxOutputBytes) && role.maxOutputBytes >= 128 && role.maxOutputBytes <= 16 * 1024 * 1024, 'INVALID_OUTPUT_BOUND');
  await noLinks(command.executable);
  insist(sha256(await readFile(command.executable)) === command.executableSha256, 'EXECUTABLE_HASH_MISMATCH');
  const source = await validateCheckout(trustedSourceDirectory, manifest.sourceSha, gitExecutable, { complete: false, files: role.sourceFiles });
  const candidate = await validateCheckout(workspace, job.testSha, gitExecutable);
  insist(source.path !== candidate.path && !source.path.startsWith(candidate.path + path.sep) && !candidate.path.startsWith(source.path + path.sep), 'SOURCE_CANDIDATE_OVERLAP');
  await headAndBasePresent(candidate.path, gitExecutable, identity);
  const cwd = await noLinks(path.join(candidate.path, ...(command.cwd ?? '.').split('/')));
  const prepared = { schema: 'independent-ci.execution-request.v1', nonce: randomBytes(32).toString('hex'), identity, sourceSha: manifest.sourceSha, sourceTreeSha: source.treeSha, candidateTreeSha: candidate.treeSha, workspace: candidate.path, command: { ...command, cwd }, timeoutMs: role.timeoutMs, maxOutputBytes: role.maxOutputBytes };
  prepared.requestDigest = sha256(canonicalJson(prepared));
  preparedRequests.add(prepared);
  return deepFreeze(prepared);
}
// A separate entry for image-native scanners: no image path is ever executed,
// looked up or represented as a Host executable. Only protected Source literals
// can select the fixed scanner/image/argv; the PR/job cannot supply them.
export async function prepareContainerWorkerJob({ job, workspace, trustedSourceDirectory, sourceManifestBytes, expectedSourceManifestSha256, gitExecutable }) {
  const identity = identityOf(job);
  insist((Buffer.isBuffer(sourceManifestBytes) || typeof sourceManifestBytes === 'string') && DIGEST.test(expectedSourceManifestSha256 ?? '')
    && sha256(sourceManifestBytes) === expectedSourceManifestSha256 && identity.sourceManifestSha256 === expectedSourceManifestSha256, 'MANIFEST_HASH_MISMATCH');
  let manifest; try { manifest = JSON.parse(sourceManifestBytes); } catch { throw new Error('INVALID_MANIFEST'); }
  insist(manifest.schema === 'independent-ci.sources.v2' && manifest.repo === identity.repo && SHA.test(manifest.sourceSha), 'INVALID_MANIFEST');
  insist(Object.hasOwn(manifest.roles ?? {}, identity.role), 'ROLE_NOT_REGISTERED');
  const role = manifest.roles[identity.role], command = role.containerCommand;
  insist(!role.command && command && Object.keys(command).every(k => ['image', 'scanner', 'executable', 'args', 'cwd'].includes(k)), 'INVALID_CONTAINER_COMMAND');
  const entrypoints = { gitleaks: '/usr/bin/gitleaks', trivy: '/usr/local/bin/trivy' };
  insist(Object.hasOwn(entrypoints, command.scanner) && command.executable === entrypoints[command.scanner]
    && /^(?:sha256:[a-f0-9]{64}|[^\s,@]+@sha256:[a-f0-9]{64})$/.test(command.image ?? '') && command.cwd === '/input', 'SCANNER_IMAGE_PIN_REQUIRED');
  insist(Array.isArray(command.args) && command.args.length > 0 && command.args.length <= 128
    && command.args.every(arg => typeof arg === 'string' && arg.length <= 8192 && !/[\x00-\x1f]/.test(arg)), 'INVALID_SCANNER_ARGV');
  insist(Array.isArray(role.sourceFiles) && role.sourceFiles.length > 0 && role.sourceFiles.length <= 1000
    && new Set(role.sourceFiles.map(f => f.path)).size === role.sourceFiles.length, 'SOURCE_CLOSURE_REQUIRED');
  role.sourceFiles.forEach(file => { safeRelative(file.path); insist(DIGEST.test(file.sha256), 'INVALID_SOURCE_PIN'); });
  insist(Number.isSafeInteger(role.timeoutMs) && role.timeoutMs >= 10 && role.timeoutMs <= 3600000, 'INVALID_TIMEOUT');
  insist(Number.isSafeInteger(role.maxOutputBytes) && role.maxOutputBytes >= 128 && role.maxOutputBytes <= 16 * 1024 * 1024, 'INVALID_OUTPUT_BOUND');
  const source = await validateCheckout(trustedSourceDirectory, manifest.sourceSha, gitExecutable, { complete: false, files: role.sourceFiles });
  const candidate = await validateCheckout(workspace, job.testSha, gitExecutable);
  insist(source.path !== candidate.path && !source.path.startsWith(candidate.path + path.sep) && !candidate.path.startsWith(source.path + path.sep), 'SOURCE_CANDIDATE_OVERLAP');
  await headAndBasePresent(candidate.path, gitExecutable, identity);
  const prepared = { schema: 'independent-ci.container-execution-request.v1', nonce: randomBytes(32).toString('hex'), identity,
    sourceSha: manifest.sourceSha, sourceTreeSha: source.treeSha, candidateTreeSha: candidate.treeSha, workspace: candidate.path,
    containerCommand: command, timeoutMs: role.timeoutMs, maxOutputBytes: role.maxOutputBytes };
  prepared.requestDigest = sha256(canonicalJson(prepared)); preparedRequests.add(prepared);
  return deepFreeze(prepared);
}
function signedPayload(envelope, publicKey) {
  insist(envelope && Object.keys(envelope).length === 2 && typeof envelope.signature === 'string' && envelope.signature.length < 2048 && envelope.payload && verify(null, Buffer.from(canonicalJson(envelope.payload)), publicKey, Buffer.from(envelope.signature, 'base64')), 'ATTESTATION_SIGNATURE_REFUSED');
  return envelope.payload;
}
function validLogs(logs) {
  return logs && Object.keys(logs).length === 2 && ['stdout', 'stderr'].every(k => logs[k] && Object.keys(logs[k]).length === 3 && DIGEST.test(logs[k].sha256) && Number.isSafeInteger(logs[k].bytes) && logs[k].bytes >= 0 && typeof logs[k].truncated === 'boolean');
}
function deepFreeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
function validateAttestedPayload(payload, request, runtimeIdentity) {
  insist(payload.schema === 'independent-ci.runtime-attestation.v1' && payload.fixture === false && payload.nonce === request.nonce && payload.requestDigest === request.requestDigest, 'ATTESTATION_BINDING_REFUSED');
  insist(canonicalJson(payload.identity) === canonicalJson(request.identity) && payload.runtimeIdentity === runtimeIdentity, 'ATTESTATION_IDENTITY_REFUSED');
  insist(['success', 'failure', 'timeout', 'cancelled'].includes(payload.outcome) && payload.cleanupConfirmed === true && validLogs(payload.logs), 'ATTESTATION_RESULT_REFUSED');
  insist(payload.outcome !== 'success' || payload.exitCode === 0, 'ATTESTATION_FALSE_SUCCESS');
  insist(payload.exitCode === null || Number.isSafeInteger(payload.exitCode), 'INVALID_EXIT_CODE');
  insist(Number.isFinite(Date.parse(payload.startedAt)) && Number.isFinite(Date.parse(payload.finishedAt)) && Date.parse(payload.finishedAt) >= Date.parse(payload.startedAt), 'INVALID_EXECUTION_TIME');
  // The signed receipt must carry only bounded metadata, never raw process logs or secrets.
  insist(Object.keys(payload).every(k => ['schema', 'fixture', 'nonce', 'requestDigest', 'identity', 'runtimeIdentity', 'outcome', 'exitCode', 'cleanupConfirmed', 'logs', 'startedAt', 'finishedAt'].includes(k)), 'UNEXPECTED_RECEIPT_FIELD');
}
export function createAttestedRuntime({ transport, publicKey, qualification, runtimeIdentity, clock = () => Date.now() }) {
  insist(typeof transport === 'function' && text(runtimeIdentity), 'PROTECTED_RUNTIME_REQUIRED');
  const runtime = {
    async execute(request) {
      insist(preparedRequests.has(request), 'UNVALIDATED_EXECUTION_REQUEST');
      const qualified = signedPayload(qualification, publicKey);
      insist(qualified.schema === 'independent-ci.runtime-qualification.v1' && qualified.runtimeIdentity === runtimeIdentity && qualified.sourceManifestSha256 === request.identity.sourceManifestSha256, 'RUNTIME_UNQUALIFIED');
      insist(['root-managed-single-job-container', 'single-use-vm'].includes(qualified.isolation) && qualified.prCannotReadSignerKey === true && qualified.noControllerMounts === true && qualified.noCredentials === true && qualified.networkDisabled === true && qualified.cleanupQualified === true, 'RUNTIME_ISOLATION_UNQUALIFIED');
      insist(Number.isFinite(Date.parse(qualified.expiresAt)) && Date.parse(qualified.expiresAt) > clock() && Date.parse(qualified.qualifiedAt) <= clock(), 'RUNTIME_QUALIFICATION_EXPIRED');
      let timer;
      const envelope = await Promise.race([
        Promise.resolve().then(() => transport(deepFreeze(request))),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('RUNTIME_COMPLETION_UNCONFIRMED')), request.timeoutMs + 5000); })
      ]).finally(() => clearTimeout(timer));
      const payload = signedPayload(envelope, publicKey);
      validateAttestedPayload(payload, request, runtimeIdentity);
      return { ...payload.identity, ...payload, evidenceClass: 'protected-runtime-attestation', attestation: envelope };
    }
  };
  protectedRuntimes.add(runtime);
  return Object.freeze(runtime);
}
export function verifyFormalWorkerResult(result, { publicKey, expectedIdentity, expectedRequestDigest, expectedRuntimeIdentity }) {
  try {
    insist(result.evidenceClass === 'protected-runtime-attestation' && result.fixture === false, 'FIXTURE_NOT_FORMAL');
    const payload = signedPayload(result.attestation, publicKey);
    const request = { nonce: result.nonce, requestDigest: expectedRequestDigest, identity: expectedIdentity };
    validateAttestedPayload(payload, request, expectedRuntimeIdentity);
    for (const [key, value] of Object.entries(payload)) insist(canonicalJson(value) === canonicalJson(result[key]), 'RESULT_ENVELOPE_MISMATCH');
    for (const key of identityKeys) insist(canonicalJson(payload.identity[key]) === canonicalJson(result[key]), 'RESULT_IDENTITY_MISMATCH');
    insist(Object.keys(result).every(key => [...Object.keys(payload), ...identityKeys, 'evidenceClass', 'attestation'].includes(key)), 'UNEXPECTED_RESULT_FIELD');
    return true;
  } catch { return false; }
}
async function killFixtureTree(child) {
  if (!child.pid) return false;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return new Promise(resolve => {
      const killer = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env: cleanEnv(), stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { killer.kill(); resolve(false); }, 2000);
      killer.once('error', () => { clearTimeout(timer); resolve(false); });
      killer.once('close', code => { clearTimeout(timer); resolve(code === 0); });
    });
  }
  try { process.kill(-child.pid, 'SIGKILL'); return true; } catch (error) { return error.code === 'ESRCH'; }
}
export function createFixtureExecutor() {
  const runtime = {
    async execute(request) {
      insist(preparedRequests.has(request), 'UNVALIDATED_EXECUTION_REQUEST');
      const startedAt = new Date().toISOString();
      const logs = Object.fromEntries(['stdout', 'stderr'].map(k => [k, { hash: createHash('sha256'), bytes: 0, truncated: false }]));
      let timedOut = false, overflow = false, cleanupConfirmed = true, spawnFailed = false, killing;
      const child = spawn(request.command.executable, request.command.args, { cwd: request.command.cwd, env: cleanEnv(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const terminate = () => killing ??= killFixtureTree(child).then(ok => { cleanupConfirmed = ok; if (!ok) child.kill('SIGKILL'); });
      const timer = setTimeout(() => { timedOut = true; void terminate(); }, request.timeoutMs);
      for (const key of ['stdout', 'stderr']) child[key].on('data', chunk => {
        logs[key].bytes += chunk.length;
        logs[key].hash.update(chunk); // Streaming digest; raw bytes are never retained or returned.
        if (logs.stdout.bytes + logs.stderr.bytes > request.maxOutputBytes) { logs[key].truncated = true; overflow = true; void terminate(); }
      });
      const exitCode = await new Promise(resolve => { child.once('error', () => { spawnFailed = true; resolve(null); }); child.once('close', code => resolve(code)); });
      clearTimeout(timer); if (killing) await killing;
      return { ...request.identity, schema: 'independent-ci.fixture-observation.v1', fixture: true, nonce: request.nonce, requestDigest: request.requestDigest, identity: request.identity, runtimeIdentity: `fixture:${process.platform}:${process.arch}`, outcome: timedOut ? 'timeout' : overflow || spawnFailed || exitCode !== 0 || !cleanupConfirmed ? 'failure' : 'success', exitCode, cleanupConfirmed, logs: Object.fromEntries(Object.entries(logs).map(([key, item]) => [key, { sha256: item.hash.digest('hex'), bytes: item.bytes, truncated: item.truncated }])), startedAt, finishedAt: new Date().toISOString(), evidenceClass: 'fixture-observation', formalEligible: false, summary: timedOut ? 'FIXTURE_TIMEOUT' : overflow ? 'FIXTURE_OUTPUT_LIMIT' : spawnFailed ? 'FIXTURE_SPAWN_FAILED' : exitCode === 0 ? 'FIXTURE_EXIT_ZERO' : 'FIXTURE_EXIT_NONZERO' };
    }
  };
  fixtureRuntimes.add(runtime);
  return Object.freeze(runtime);
}
export async function runWorkerJob(options) {
  let identity;
  try {
    identity = identityOf(options.job);
    const runtime = options.runtime;
    const fixture = fixtureRuntimes.has(runtime);
    insist(protectedRuntimes.has(runtime) || fixture && options.allowTestFixture === true, 'RUNTIME_UNQUALIFIED');
    insist(options.executionMode === undefined || options.executionMode === 'container-scanner', 'INVALID_EXECUTION_MODE');
    const request = options.executionMode === 'container-scanner' ? await prepareContainerWorkerJob(options) : await prepareWorkerJob(options);
    return await runtime.execute(request);
  } catch (error) {
    // Never echo child stderr, attacker paths, argv, exception text or lease tokens.
    const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(error.message) ? error.message : 'WORKER_VALIDATION_REFUSED';
    return { schema: 'independent-ci.worker-refusal.v1', ...(identity ?? {}), identity: identity ?? null, runtimeIdentity: null, outcome: code === 'RUNTIME_COMPLETION_UNCONFIRMED' ? 'uncertain' : 'refused', cleanupConfirmed: false, exitCode: null, evidenceClass: 'none', formalEligible: false, reason: code };
  }
}
