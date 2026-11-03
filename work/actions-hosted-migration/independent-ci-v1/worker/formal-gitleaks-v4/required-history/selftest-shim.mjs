// Source v2 copy of formal-gitleaks-v3/required-history/selftest-shim.mjs; it sits next to the v4 prepare.mjs
// that names it, and reuses the unchanged v3 Docker transport.
// Narrow argv adapters for the *pinned trusted* reviewed_gitleaks.py self-test.
// No command is selected by PR/job data; no actual result can be signed here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { IMAGE, noLinks, SOURCE_PINS } from './prepare.mjs';
import { canonical } from '../../../src/proof.mjs';
import { observeUnsignedContainer } from '../../verify-once/verify-worker.mjs';
import { dockerInvoke } from '../../formal-gitleaks-v3/docker-transport.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const within = (file, root) => file.startsWith(root + '/') && path.posix.resolve(file) === file;
const env = () => ({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '' });

export function selfTestContainerPlan(args, c) {
  const mountValues = args.flatMap((value, index) => value === '--mount' ? [args[index + 1]] : []);
  check(mountValues.length === 3, 'SELF_TEST_MOUNT_COUNT');
  const parsed = mountValues.map(value => /^type=bind,source=([^,]+),target=([^,]+),readonly$/.exec(value ?? ''));
  check(parsed.every(Boolean), 'SELF_TEST_MOUNT_FORMAT');
  const [[, repo, repoTarget], [, config, configTarget], [, ignore, ignoreTarget]] = parsed;
  check(repoTarget === '/test' && configTarget === '/config/gitleaks.toml' && ignoreTarget === '/reviewed.ignore'
    && within(repo, c.temp) && within(ignore, c.temp) && config === path.posix.join(c.prepared.repository, '.gitleaks.toml'), 'SELF_TEST_MOUNT_SCOPE');
  const scan = ['git', '/test', '--config', '/config/gitleaks.toml', '--gitleaks-ignore-path', '/reviewed.ignore', '--redact=100', '--no-banner', '--no-color',
    '--log-level', 'error', '--report-format', 'json', '--report-path', '-', '--exit-code', '1'];
  const expected = ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...mountValues.flatMap(value => ['--mount', value]), '--env', 'GIT_CONFIG_COUNT=1', '--env', 'GIT_CONFIG_KEY_0=safe.directory', '--env', 'GIT_CONFIG_VALUE_0=/test', IMAGE, ...scan];
  check(canonical(args) === canonical(expected), 'TRUSTED_SELF_TEST_ARGV_CHANGED');
  return { executable: '/usr/bin/gitleaks', cwd: '/test', args: scan,
    mounts: [[repo, '/test'], [config, '/config/gitleaks.toml'], [ignore, '/reviewed.ignore'], [c.prepared.safeGitConfig, '/etc/gitconfig']] };
}
export function safeGitArguments(args, c) {
  const rest = [...args];
  while (rest[0] === '-c') {
    check(/^(user\.(name|email)|commit\.gpgsign)=/.test(rest[1] ?? ''), 'SELF_TEST_GIT_OPTION_REFUSED'); rest.splice(0, 2);
  }
  const historicalDiff = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--diff-algorithm=myers', '--unified=0',
    'cc353e29a32b991696df95d5fc3f9b9d107e8d1c^', 'cc353e29a32b991696df95d5fc3f9b9d107e8d1c', '--', 'scripts/ci/clued-gated-proof-profiles.json'];
  const exactHistoricalDiff = canonical(args) === canonical(historicalDiff);
  check(exactHistoricalDiff || ['init', 'add', 'commit', 'rev-parse', 'cat-file', 'merge-base', 'commit-tree'].includes(rest[0]), 'SELF_TEST_GIT_COMMAND_REFUSED');
  return ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/nonexistent-clued-hooks', '-c', 'protocol.allow=never',
    '-c', `init.templateDir=${c.templates}`, ...args];
}
async function run(executable, args, { timeoutMs, maxBytes = 4 * 1024 * 1024, stdin = null } = {}) {
  return new Promise(resolve => {
    const p = spawn(executable, args, { shell: false, env: env(), stdio: [stdin ? 'inherit' : 'ignore', 'pipe', 'pipe'] });
    let timedOut = false, overflow = false, error = false, count = 0;
    const chunks = [], streams = Object.fromEntries(['stdout', 'stderr'].map(key => [key, { hash: createHash('sha256'), bytes: 0, truncated: false }]));
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    for (const key of ['stdout', 'stderr']) p[key].on('data', bytes => {
      count += bytes.length; streams[key].hash.update(bytes); streams[key].bytes += bytes.length;
      if (count > maxBytes) { overflow = true; streams[key].truncated = true; p.kill('SIGKILL'); }
      else if (key === 'stdout') chunks.push(bytes);
    });
    p.once('error', () => { error = true; });
    p.once('close', code => { clearTimeout(timer); resolve({ code, timedOut, overflow, error, stdout: Buffer.concat(chunks).toString('utf8'),
      logs: Object.fromEntries(Object.entries(streams).map(([key, stream]) => [key, { sha256: stream.hash.digest('hex'), bytes: stream.bytes, truncated: stream.truncated }])) }); });
  });
}
async function protectedFile(file, hash = null) {
  await noLinks(file);
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    const stat = await fs.lstat(cursor); check(stat.uid === 0 && !(stat.mode & 0o022), 'SELF_TEST_CONTROL_BOUNDARY_UNKNOWN');
    if (cursor === path.dirname(cursor)) break;
  }
  if (hash) check(createHash('sha256').update(await fs.readFile(file)).digest('hex') === hash, 'SELF_TEST_PIN_CHANGED');
}
// FORMAL_READABLE_SYNTHETIC_BEGIN
// Only the helper's disposable synthetic repo/ignore are made scanner-readable.
// No key, Source tree, controller directory or caller path may enter this scope.
export function readableSyntheticTargets(plan, c) {
  check(plan.mounts?.length === 4 && plan.mounts[0][1] === '/test' && plan.mounts[2][1] === '/reviewed.ignore'
    && within(plan.mounts[0][0], c.temp) && within(plan.mounts[2][0], c.temp), 'SYNTHETIC_READABLE_SCOPE_REFUSED');
  return [plan.mounts[0][0], plan.mounts[2][0]];
}
async function makeSyntheticReadable(plan, c) {
  async function visit(file) {
    await noLinks(file); const stat = await fs.lstat(file);
    check(stat.uid === 0 && !(stat.mode & 0o022) && (stat.isDirectory() || stat.isFile() && stat.nlink === 1), 'SYNTHETIC_OWNER_TYPE_REFUSED');
    if (stat.isDirectory()) { for (const child of await fs.readdir(file)) await visit(path.join(file, child)); await fs.chmod(file, 0o755); }
    else await fs.chmod(file, stat.mode & 0o111 ? 0o755 : 0o644);
  }
  for (const target of readableSyntheticTargets(plan, c)) await visit(target);
}
// FORMAL_READABLE_SYNTHETIC_END
export async function main(argv = process.argv.slice(2)) {
  check(process.platform === 'linux' && process.getuid?.() === 0 && argv.length >= 3 && ['git', 'docker'].includes(argv[1]), 'FIXED_LINUX_SHIM_ONLY');
  const [configFile, mode, ...args] = argv; await protectedFile(configFile);
  const c = JSON.parse(await fs.readFile(configFile, 'utf8'));
  check(c.contract === 'clued.independent-ci.gitleaks-self-test-shim/1' && c.docker.path === '/usr/bin/docker'
    && Date.parse(c.deadline) > Date.now(), 'SELF_TEST_CONFIG_INVALID');
  check(path.resolve(process.cwd()) === c.prepared.repository || within(path.resolve(process.cwd()), c.temp), 'SELF_TEST_CWD_SCOPE');
  await noLinks(process.cwd());
  await protectedFile(c[mode].path, c[mode].sha256);
  if (mode === 'git') {
    const result = await run(c.git.path, safeGitArguments(args, c), { timeoutMs: Math.min(10000, Date.parse(c.deadline) - Date.now()), maxBytes: 32 * 1024 * 1024, stdin: true });
    check(!result.timedOut && !result.overflow && !result.error, 'SELF_TEST_GIT_UNCONFIRMED'); process.stdout.write(result.stdout); return result.code;
  }
  const plan = selfTestContainerPlan(args, c);
  for (const [source] of plan.mounts) await noLinks(source, (await fs.lstat(source)).isDirectory());
  await makeSyntheticReadable(plan, c);
  check(createHash('sha256').update(await fs.readFile(path.join(c.prepared.repository, '.gitleaks.toml'))).digest('hex') === SOURCE_PINS['.gitleaks.toml'], 'SELF_TEST_CONFIG_SOURCE_CHANGED');
  const limits = { timeoutMs: 60000, maxOutputBytes: 4 * 1024 * 1024, memoryBytes: 1073741824, cpus: 2, pids: 128 };
  const config = { imageDigest: IMAGE.slice(0, IMAGE.lastIndexOf(':', IMAGE.indexOf('@'))) + '@' + IMAGE.slice(IMAGE.lastIndexOf('@') + 1), dockerRootDirectory: c.dockerRootDirectory, limits };
  const request = { nonce: randomBytes(32).toString('hex'), executionId: randomUUID(), deadline: new Date(Math.min(Date.parse(c.deadline), Date.now() + limits.timeoutMs)).toISOString() };
  // Reuse the frozen create/inspect/exit/force-remove/two-inventory algorithm.
  // The returned observation is unsigned and cannot enter its signing path.
  const docker = (dockerArgs, options = {}) => dockerInvoke(dockerArgs,
    { timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 10000, Date.parse(c.deadline) - Date.now())), maxOutputBytes: options.maxOutputBytes ?? 65536 });
  const observation = await observeUnsignedContainer(config, request, plan, docker);
  check(observation.complete && observation.cleanupConfirmed && [0, 1].includes(observation.state.ExitCode), 'SELF_TEST_CONTAINER_OR_CLEANUP_UNCONFIRMED');
  // Only the synthetic fixture's redacted detector JSON goes to the trusted
  // Python process. Real history never uses this raw-output adapter.
  process.stdout.write(observation.attached.stdout); return observation.state.ExitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(() => {
  process.stderr.write('Controlled Gitleaks regression refused; raw data withheld\n'); process.exitCode = 2;
});
