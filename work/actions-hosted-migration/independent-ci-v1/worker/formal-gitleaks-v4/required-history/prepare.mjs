// Source v2 copy of formal-gitleaks-v3/required-history/prepare.mjs (DESIGN S6, lesson b28): job contract v2
// (attempt 1..2), Source manifest schema v2, input contract /2, and refsInStore() for the adapter.
// Required Gitleaks history input/profile candidate. No transport, credentials,
// admission bypass, signing, Checks publication or Docker execution here.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateJobV2 as validateJob, subjectOfV2 as subjectOf } from '../../../src/job-v2.mjs';
import { canonical, digest } from '../../../src/proof.mjs';
import { TRUSTED_WORKFLOW_PATHS, activeGitleaksWorkflowSha256s } from '../../trusted-workflows.mjs';

export const IMAGE = 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
export const SCAN_ARGS = Object.freeze(['git', '/repo', '--config', '/repo/.gitleaks.toml', '--gitleaks-ignore-path', '/reviewed.ignore', '--redact', '--exit-code', '1']);
export const SOURCE_PINS = Object.freeze({
  'scripts/ci/reviewed_gitleaks.py': 'ce262ae31a44cfd486e9c8b56e6bc912e7259f18bf5b3b7bebcaf60f26206e4d',
  '.gitleaks.toml': '167600934018e4761d80057321789a1c50486f35c32aa15eebc00ee53cf9aeec',
});
// This active Source pins only its exact 729-finding workflow successor. The legacy
// main/PR-B set remains separate for v3/H5. A pending freeze has an empty active set,
// never a fallback to a legacy 726 workflow. Helper and config stay single exact pins.
export const WORKFLOW_PATH = TRUSTED_WORKFLOW_PATHS.gitleaks;
export const WORKFLOW_SHA256S = activeGitleaksWorkflowSha256s();
// The role's declared workflow pin; refused unless it is declared once and is an accepted value.
export function acceptedWorkflowSha256(role) {
  const declared = Array.isArray(role?.sourceFiles) ? role.sourceFiles.filter(pin => pin?.path === WORKFLOW_PATH) : [];
  check(declared.length === 1 && WORKFLOW_SHA256S.includes(declared[0].sha256), 'TRUSTED_REVIEW_SOURCE_PIN_REQUIRED');
  return declared[0].sha256;
}
// The pinned trusted helper (scripts/ci/reviewed_gitleaks.py parse_records and
// _ensure_reviewed_commits) reads its reviewed records from the pinned
// .gitleaks.toml "# clued-reviewed-finding: {json}" lines and requires the
// commit of every record fingerprint in the scanned repository. The offline
// self-test cannot fetch them, so preparation packs exactly this pinned set.
// The set is the sorted, LF-joined (trailing LF) list of distinct commits.
export const REVIEWED_COMMITS = Object.freeze({ findings: 729, commits: 101,
  sha256: '37fcdae7442b1235f75f2325c13e508a0189443a24e62627bf338fa8285488bf' });
// Recomputed by the pinned helper's actual verify_history, not inferred by adding counts.
export const REVIEWED_HISTORY_PROOF = Object.freeze({ commits: REVIEWED_COMMITS.commits, files_at_commits: 172,
  verified_git_objects: 130, reviewed_commits_sha256: REVIEWED_COMMITS.sha256,
  reviewed_ignore_sha256: 'abbbece0db8ff3e524736006e0bc8ecf078358b48fae91c8d0bc3046728b8f5a' });
export function matchesReviewedHistoryProof(value) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join('|') === Object.keys(REVIEWED_HISTORY_PROOF).sort().join('|')
    && Object.entries(REVIEWED_HISTORY_PROOF).every(([key, expected]) => value[key] === expected);
}
const REVIEWED_FINDING_PREFIX = '# clued-reviewed-finding: ', REVIEWED_COUNT_PREFIX = '# clued-reviewed-count: ';
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
// Deterministic extraction of the reviewed commit set from the pinned config
// bytes; any input the Python and JS line/JSON readings could disagree on fails.
export function reviewedCommitsFromConfig(bytes, pin = REVIEWED_COMMITS) {
  let text = null;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('REVIEWED_RECORDS_AMBIGUOUS'); }
  // Printable ASCII plus LF only: JS split('\n') then equals Python str.splitlines().
  check(text.endsWith('\n') && !/[^\n\x20-\x7e]/.test(text), 'REVIEWED_RECORDS_AMBIGUOUS');
  const lines = text.slice(0, -1).split('\n');
  const counts = lines.filter(line => line.startsWith(REVIEWED_COUNT_PREFIX));
  const fingerprints = lines.filter(line => line.startsWith(REVIEWED_FINDING_PREFIX)).map(line => {
    let record = null;
    try { record = JSON.parse(line.slice(REVIEWED_FINDING_PREFIX.length)); } catch { fail('REVIEWED_RECORDS_AMBIGUOUS'); }
    check(plain(record) && Object.keys(record).sort().join('|') === 'fingerprint|kinds' && typeof record.fingerprint === 'string'
      && record.fingerprint.split(':').length === 4 && SHA.test(record.fingerprint.split(':')[0]), 'REVIEWED_RECORDS_AMBIGUOUS');
    return record.fingerprint;
  });
  check(counts.length === 1 && counts[0] === REVIEWED_COUNT_PREFIX + String(fingerprints.length)
    && new Set(fingerprints).size === fingerprints.length, 'REVIEWED_RECORDS_AMBIGUOUS');
  const commits = [...new Set(fingerprints.map(fingerprint => fingerprint.slice(0, 40)))].sort();
  check(fingerprints.length === pin.findings && commits.length === pin.commits
    && createHashForBytes().update(commits.join('\n') + '\n').digest('hex') === pin.sha256, 'REVIEWED_COMMIT_SET_CHANGED');
  return Object.freeze(commits);
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

// Before the adapter creates its run directory (the point after which a failure is UNCERTAIN and the
// attempt is spent): every fresh remote ref tip, the head and the base must already be objects of the
// workspace store that prepare-workspaces.py built from the batch bundle. A tip that is missing means a
// push happened between the bundle and this scan: a clean, retryable REMOTE_REFS_CHANGED_SINCE_BUNDLE
// (the lesson of b28), never a half-prepared history. Read-only: cat-file on the store itself.
export async function refsInStore({ job, remoteSnapshot, gitDirectory, gitExecutable, expectedGitSha256, now = Date.now() }) {
  validateJob(job); check(job.role === 'gitleaks', 'FIXED_REQUIRED_ROLE_REQUIRED');
  const refs = validateRemoteSnapshot(remoteSnapshot, job, now);
  check(refs.find(ref => ref.name === 'refs/heads/main')?.objectSha === job.baseSha, 'REMOTE_MAIN_BASE_CHANGED');
  const cache = await noLinks(gitDirectory), git = await noLinks(gitExecutable);
  check(HASH.test(expectedGitSha256 ?? '') && await fileHash(git) === expectedGitSha256, 'PINNED_GIT_CHANGED');
  const tips = [...new Set([...refs.map(ref => ref.objectSha), job.headSha, job.baseSha])].sort();
  const out = (await processGit(git, cache, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { stdin: tips.join('\n') + '\n', maxBytes: 4 * 1024 * 1024 })).text;
  const rows = out.trim().split('\n').filter(Boolean);
  check(rows.length === tips.length, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  for (const [i, row] of rows.entries()) {
    const [sha, type] = row.split(' ');
    check(sha === tips[i] && ['commit', 'tag'].includes(type), 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  }
  return Object.freeze({ tips: tips.length, refs: refs.length });
}

export async function prepareRequiredHistory({ job, sourceManifestBytes, expectedSourceManifestSha256,
  trustedSourceDirectory, gitDirectory, remoteSnapshot, outputDirectory, gitExecutable, expectedGitSha256 }) {
  validateJob(job); check(job.repo === 'tdoljyj/cross-memory-system' && job.role === 'gitleaks', 'FIXED_REQUIRED_ROLE_REQUIRED');
  check(createHashForBytes().update(sourceManifestBytes).digest('hex') === expectedSourceManifestSha256 && job.sourceManifestSha256 === expectedSourceManifestSha256, 'SOURCE_MANIFEST_CHANGED');
  const manifest = JSON.parse(sourceManifestBytes), role = manifest.roles?.gitleaks;
  check(manifest.schema === 'independent-ci.sources.v2' && manifest.repo === job.repo && SHA.test(manifest.sourceSha ?? '')
    && role && Array.isArray(role.sourceFiles) && role.containerCommand?.image === IMAGE && role.containerCommand.scanner === 'gitleaks'
    // The registered generic manifest cwd is '/input' (src/worker.mjs); this
    // profile's own scanner plan still runs at '/repo' (requiredScannerPlan).
    && role.containerCommand.executable === '/usr/bin/gitleaks' && role.containerCommand.cwd === '/input'
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
  const workflowSha256 = acceptedWorkflowSha256(role), workflowFile = path.join(source, ...WORKFLOW_PATH.split('/'));
  await noLinks(workflowFile); check(await fileHash(workflowFile) === workflowSha256, 'TRUSTED_REVIEW_SOURCE_CHANGED');
  // One read: these exact pinned bytes are both parsed and copied to the scanner input.
  const configBytes = await fsp.readFile(path.join(source, '.gitleaks.toml'));
  check(createHashForBytes().update(configBytes).digest('hex') === SOURCE_PINS['.gitleaks.toml'], 'TRUSTED_REVIEW_SOURCE_CHANGED');
  const reviewedCommits = reviewedCommitsFromConfig(configBytes), reviewedInput = reviewedCommits.join('\n') + '\n';
  const reviewedTypes = reviewedCommits.map(sha => `${sha} commit`).join('\n');
  for (const file of ['shallow', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) check(!(await exists(path.join(cache, ...file.split('/')))), 'INCOMPLETE_OR_INDIRECT_OBJECT_STORE');
  await noLinks(path.join(cache, 'objects'), true);
  check(!(await fsp.readdir(path.join(cache, 'objects', 'pack'))).some(name => name.endsWith('.promisor')), 'PARTIAL_OBJECT_STORE_REFUSED');
  await fsp.mkdir(outputDirectory, { mode: 0o700 });
  const repository = path.join(outputDirectory, 'repo'), control = path.join(outputDirectory, 'control');
  await fsp.mkdir(repository, { mode: 0o755 }); await fsp.mkdir(control, { mode: 0o700 });
  const dotgit = path.join(repository, '.git'); await fsp.mkdir(path.join(dotgit, 'objects', 'pack'), { recursive: true, mode: 0o755 });
  await fsp.mkdir(path.join(dotgit, 'refs'), { mode: 0o755 }); await writeOnce(path.join(dotgit, 'HEAD'), job.headSha + '\n');
  // Reviewed commits are pack tips only, never refs: the scanned ref set stays
  // exactly the fresh remote heads/tags plus the detached current head.
  const alternate = path.join(cache, 'objects'), tips = [...new Set([...refs.map(ref => ref.objectSha), job.headSha, ...reviewedCommits])];
  // A fresh Git directory supplies no source config/hooks/remotes/index/reflogs.
  // The alternate is a Host-only environment value used during packing. It is
  // never written into the prepared repository or mounted in the scanner.
  for (const sha of [job.headSha, job.baseSha]) check((await processGit(git, dotgit, ['cat-file', '-t', sha], { alternate, maxBytes: 4096 })).text.trim() === 'commit', 'HEAD_BASE_COMMIT_MISSING');
  const reviewedPresent = async withAlternate => (await processGit(git, dotgit, ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    { stdin: reviewedInput, alternate: withAlternate, maxBytes: 65536 })).text.trim() === reviewedTypes;
  check(await reviewedPresent(alternate), 'REVIEWED_COMMIT_NOT_IN_STORE');
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
  // Without the alternate: every reviewed commit and its whole closure is in the prepared pack.
  check(await reviewedPresent(null), 'REVIEWED_COMMIT_NOT_PREPARED');
  const packedObjects = new Set(objects);
  const reviewedClosure = await processGit(git, dotgit, ['rev-list', '--objects', '--no-object-names', '--stdin'], { stdin: reviewedInput, maxBytes: 128 * 1024 * 1024 })
    .catch(error => fail(error?.code === 'GIT_PREPARATION_FAILED' ? 'REVIEWED_COMMIT_NOT_PREPARED' : error?.code ?? 'GIT_PREPARATION_FAILED'));
  check(reviewedClosure.text.trim().split('\n').filter(Boolean).every(object => packedObjects.has(object)), 'REVIEWED_COMMIT_NOT_PREPARED');
  for (const ref of refs) { const file = path.join(dotgit, ...ref.name.split('/')); await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o755 }); await writeOnce(file, ref.objectSha + '\n'); }
  const actual = (await processGit(git, dotgit, ['for-each-ref', '--format=%(refname) %(objectname)'], { maxBytes: 4 * 1024 * 1024 })).text.trim().split('\n').filter(Boolean).map(line => { const [name, objectSha] = line.split(' '); return { name, objectSha }; }).sort((a, b) => a.name.localeCompare(b.name));
  check(canonical(actual) === canonical(refs), 'EXACT_REMOTE_REF_SET_CHANGED');
  await processGit(git, dotgit, ['fsck', '--full', '--strict', '--no-reflogs'], { maxBytes: 65536 });
  await writeOnce(path.join(repository, '.gitleaks.toml'), configBytes);
  const safeGitConfig = path.join(control, 'git-safe.config');
  await writeOnce(safeGitConfig, '[safe]\n\tdirectory = /repo\n\tdirectory = /test\n', 0o444);
  // Explicitly restore the public read bits after creation; umask077 must not
  // make this non-secret bind-mounted scanner config root-only.
  await fsp.chmod(safeGitConfig, 0o444);
  const prepared = { contract: 'clued.independent-ci.required-gitleaks-input/2', subject: subjectOf(job),
    sourceSha: manifest.sourceSha, sourceManifestSha256: expectedSourceManifestSha256, remoteSnapshotSha256: digest(remoteSnapshot),
    refs, refScope: 'fresh-remote-heads-tags-plus-current-head', headSha: job.headSha, baseSha: job.baseSha,
    packTipScope: 'refs-plus-current-head-plus-pinned-reviewed-commits', reviewedCommitCount: reviewedCommits.length,
    reviewedCommitsSha256: REVIEWED_COMMITS.sha256,
    reachableObjectCount: objects.length, reachableObjectsSha256: digest(objects), packedHistorySha256: packed.sha256,
    packedHistoryBytes: packed.bytes, repository, control, safeGitConfig, trustedHelper: path.join(source, 'scripts/ci/reviewed_gitleaks.py'),
    reviewedIgnore: path.join(control, 'reviewed.ignore'), helperSha256: SOURCE_PINS['scripts/ci/reviewed_gitleaks.py'],
    configSha256: SOURCE_PINS['.gitleaks.toml'], workflowSha256,
    sourceCandidateOnly: true, requiredSelfTestComplete: false, requiredScanComplete: false, formalEligible: false };
  await writeOnce(path.join(outputDirectory, 'input.json'), canonical(prepared)); await seal(repository);
  return Object.freeze(prepared);
}

export async function requiredScannerPlan(prepared, selfTestReport) {
  check(prepared?.contract === 'clued.independent-ci.required-gitleaks-input/2', 'PREPARED_HISTORY_REQUIRED');
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
// Pure report check; this never adds the actual self-test completion brand.
export function validateSelfTestReport(selfTestReport) {
  check(plain(selfTestReport) && Object.keys(selfTestReport).sort().join('|') === 'commits|default_rules_unchanged|exact_historical_fingerprints|files_at_commits|global_fingerprints|ignore_sha256|regression|verified_git_objects'
    && selfTestReport.exact_historical_fingerprints === REVIEWED_COMMITS.findings && selfTestReport.default_rules_unchanged === true
    && selfTestReport.commits === REVIEWED_HISTORY_PROOF.commits && selfTestReport.files_at_commits === REVIEWED_HISTORY_PROOF.files_at_commits
    && selfTestReport.verified_git_objects === REVIEWED_HISTORY_PROOF.verified_git_objects
    && selfTestReport.global_fingerprints === 0 && selfTestReport.ignore_sha256 === REVIEWED_HISTORY_PROOF.reviewed_ignore_sha256
    && Object.keys(selfTestReport.regression ?? {}).sort().join('|') === 'baseline_detection|different_path_detection|exact_history_only|handover_acceptance_artifact_proof|new_commit_detection|scheduling_marker_different_path_detection|scheduling_marker_new_commit_detection|valid_private_key_detection'
    && selfTestReport.regression?.baseline_detection === true && selfTestReport.regression.exact_history_only === true
    && selfTestReport.regression.new_commit_detection === true && selfTestReport.regression.different_path_detection === true
    && ['scheduling_marker_new_commit_detection', 'scheduling_marker_different_path_detection', 'valid_private_key_detection']
      .every(key => selfTestReport.regression[key] === true)
    && Object.keys(selfTestReport.regression.handover_acceptance_artifact_proof ?? {}).sort().join('|') === 'actual_git_artifact_passes|forged_digest_rejected|valid_nonancestor_rejected|wrong_line_rejected|wrong_path_rejected'
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

// The execution entry derives both executable arguments and shim Source.
// Mutable caller presentation fields cannot stand in for the trusted helper.
export function trustedSelfTestInvocation(plan) {
  const prepared = plan.prepared;
  return Object.freeze({
    shimFile: fileURLToPath(new URL('./selftest-shim.mjs', import.meta.url)),
    argv: Object.freeze(['-I', '-S', prepared.trustedHelper, '--config',
      path.join(prepared.repository, '.gitleaks.toml'), '--output', prepared.reviewedIgnore, '--self-test'])
  });
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
  const invocation = trustedSelfTestInvocation(plan);
  const root = path.join(plan.prepared.control, 'self-test'); await fsp.mkdir(root, { mode: 0o700 });
  const bin = path.join(root, 'bin'), temp = path.join(root, 'tmp'), templates = path.join(root, 'templates');
  for (const directory of [bin, temp, templates]) await fsp.mkdir(directory, { mode: 0o700 });
  const configuration = path.join(root, 'shim.json');
  await writeOnce(configuration, canonical({ contract: 'clued.independent-ci.gitleaks-self-test-shim/1', prepared: plan.prepared,
    git: plan.git, docker: plan.docker, root, temp, templates, dockerRootDirectory: plan.dockerRootDirectory,
    deadline: new Date(Date.now() + 1200000).toISOString() }));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const mode of ['git', 'docker']) await writeOnce(path.join(bin, mode), `#!/bin/sh\nexec ${quote(plan.node.path)} ${quote(invocation.shimFile)} ${quote(configuration)} ${mode} "$@"\n`, 0o500);
  const env = { ...environment(), PATH: bin + ':/usr/bin:/bin', TMPDIR: temp, TMP: temp, TEMP: temp, DOCKER_CONFIG: '/nonexistent' };
  const report = await new Promise((resolve, reject) => {
    const child = spawn(plan.python.path, invocation.argv, { cwd: plan.prepared.repository, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
