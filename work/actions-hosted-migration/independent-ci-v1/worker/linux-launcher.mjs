import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, lstat, readdir, open, chmod } from 'node:fs/promises';
import { createHash, sign, createPublicKey } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, sha256, prepareWorkerJob, prepareContainerWorkerJob } from '../src/worker.mjs';
import { validateJob } from '../src/queue.mjs';
import { canonical, digest, subjectOf } from '../src/proof.mjs';
import { loadQualifiedPolicy, protectedPath, requiredInstallInputs, requireCondition as check } from './qualification.mjs';

function environment() { return { PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' }; }
async function invoke(executable, prefix, args, { timeoutMs = 10000, maxOutputBytes = 65536, digestOnly = false, signal } = {}) {
  return new Promise(resolve => {
    const child = spawn(executable, [...prefix, ...args], { shell: false, windowsHide: true, env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const logs = Object.fromEntries(['stdout', 'stderr'].map(key => [key, { hash: createHash('sha256'), bytes: 0, truncated: false }]));
    const chunks = []; let timedOut = false, overflow = false, error = false, settled = false;
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', interrupt); resolve({ code, timedOut, overflow, error, stdout: digestOnly ? '' : Buffer.concat(chunks).toString('utf8'), logs: Object.fromEntries(Object.entries(logs).map(([key, value]) => [key, { sha256: value.hash.digest('hex'), bytes: value.bytes, truncated: value.truncated }])) }); };
    const interrupt = () => { timedOut = true; child.kill('SIGKILL'); setTimeout(() => finish(null), 250).unref(); };
    const timer = setTimeout(interrupt, timeoutMs);
    signal?.addEventListener('abort', interrupt, { once: true }); if (signal?.aborted) interrupt();
    for (const key of ['stdout', 'stderr']) child[key].on('data', bytes => {
      if (settled) return;
      logs[key].hash.update(bytes); logs[key].bytes += bytes.length;
      if (logs.stdout.bytes + logs.stderr.bytes > maxOutputBytes) { overflow = true; logs[key].truncated = true; child.kill('SIGKILL'); }
      else if (!digestOnly && key === 'stdout') chunks.push(bytes);
    });
    child.once('error', () => { error = true; finish(null); });
    child.once('close', finish);
  });
}
function parse(result) { check(result.code === 0 && !result.timedOut && !result.overflow && !result.error, 'DOCKER_READ_UNKNOWN'); try { return JSON.parse(result.stdout); } catch { throw new Error('DOCKER_JSON_UNKNOWN'); } }
export function dockerCreateArguments(config, request, paths, name) {
  const scanner = config.executionMode === 'scanner';
  const mounts = [[paths.candidate, '/input'], [paths.source, '/source']];
  if (!scanner) mounts.push([paths.request, '/request/job.json'], [config.entryFile, '/control/container-entry.mjs']);
  return ['create', '--name', name, '--pull=never', '--network=none', '--ipc=private', '--user=65532:65532', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', `--pids-limit=${config.pids}`, `--cpus=${config.cpus}`, `--memory=${config.memoryBytes}`, `--memory-swap=${config.memoryBytes}`, '--restart=no', '--log-driver=none', '--ulimit=nofile=1024:1024', '--env=NODE_OPTIONS=', '--env=NODE_PATH=', '--env=HOME=/scratch', '--tmpfs=/scratch:rw,nosuid,nodev,noexec,size=536870912,mode=0700,uid=65532,gid=65532', ...[
    ...mounts
  ].flatMap(([src, dst]) => ['--mount', `type=bind,src=${src},dst=${dst},readonly,bind-propagation=rprivate`]), `--workdir=${scanner ? '/input' : '/scratch'}`, `--entrypoint=${scanner ? request.containerCommand.executable : config.containerNodeExecutable}`, '--label', `clued.independent.job=${request.identity.jobId}`, '--label', `clued.independent.nonce=${request.nonce}`, config.image, ...(scanner ? request.containerCommand.args : ['/control/container-entry.mjs'])];
}
function verifyContainer(c, config, name, imageId, paths, request) {
  const scanner = config.executionMode === 'scanner';
  const h = c.HostConfig, expected = new Map([['/input', paths.candidate], ['/source', paths.source]]);
  if (!scanner) { expected.set('/request/job.json', paths.request); expected.set('/control/container-entry.mjs', config.entryFile); }
  check(c.Name === `/${name}` && c.Image === imageId && c.Config.Image === config.image && c.Config.User === '65532:65532', 'CONTAINER_IDENTITY_DRIFT');
  check(h.NetworkMode === 'none' && h.IpcMode === 'private' && ['', 'private'].includes(h.PidMode) && !h.UTSMode && !h.Privileged
    && h.ReadonlyRootfs && h.CapDrop?.includes('ALL') && !h.CapAdd?.length && !h.Devices?.length && h.SecurityOpt?.includes('no-new-privileges:true'), 'CONTAINER_ISOLATION_DRIFT');
  check(h.PidsLimit === config.pids && h.Memory === config.memoryBytes && h.MemorySwap === config.memoryBytes && h.NanoCpus === Math.round(config.cpus * 1e9) && h.LogConfig?.Type === 'none', 'CONTAINER_LIMIT_DRIFT');
  check(c.Mounts.length === expected.size && new Set(c.Mounts.map(m => m.Destination)).size === expected.size
    && c.Mounts.every(m => m.Type === 'bind' && m.RW === false && expected.get(m.Destination) === m.Source), 'CONTAINER_MOUNT_DRIFT');
  check(c.Config.Entrypoint?.length === 1 && c.Config.Entrypoint[0] === (scanner ? request.containerCommand.executable : config.containerNodeExecutable)
    && canonical(c.Config.Cmd) === canonical(scanner ? request.containerCommand.args : ['/control/container-entry.mjs'])
    && c.Config.WorkingDir === (scanner ? '/input' : '/scratch'), 'CONTAINER_COMMAND_DRIFT');
  check(h.Tmpfs && Object.keys(h.Tmpfs).length === 1 && h.Tmpfs['/scratch']?.includes('noexec') && h.Tmpfs['/scratch'].includes('uid=65532'), 'CONTAINER_SCRATCH_DRIFT');
}
async function inspectEngineAndImage(config, docker) {
  const info = parse(await docker(['info', '--format', '{{json .}}']));
  check(info.OSType === 'linux' && info.DockerRootDir === config.dockerRootDirectory && !/desktop/i.test(info.OperatingSystem ?? '')
    && info.SecurityOptions?.some(v => v.includes('seccomp')), 'NATIVE_ENGINE_UNKNOWN');
  const images = parse(await docker(['image', 'inspect', config.image]));
  check(images.length === 1 && (images[0].Id === config.image || images[0].RepoDigests?.includes(config.image))
    && /^sha256:[a-f0-9]{64}$/.test(images[0].Id) && images[0].Os === 'linux' && !Object.keys(images[0].Config?.Volumes ?? {}).length, 'LOCAL_IMAGE_PIN_UNKNOWN');
  check((images[0].Config?.Env ?? []).every(value => /^(PATH|NODE_VERSION|YARN_VERSION|LANG|LC_ALL|TZ)=/.test(value)), 'IMAGE_ENV_NOT_QUALIFIED');
  return images[0];
}
async function durableWrite(filename, value) {
  const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(canonical(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function sealCopy(source, destination, { sourceFiles = null } = {}) {
  async function safeWalk(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const filename = path.join(root, entry.name), stat = await lstat(filename);
      check(!stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022) && (stat.isDirectory() || stat.isFile() && stat.nlink === 1), 'UNSEALED_WORKSPACE');
      if (stat.isDirectory()) await safeWalk(filename);
    }
  }
  await protectedPath(source, { directory: true }); await safeWalk(source);
  await mkdir(destination, { mode: 0o755 });
  if (sourceFiles) {
    for (const item of sourceFiles) { const target = path.join(destination, item.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o755 }); await cp(path.join(source, item.path), target, { dereference: false }); }
  } else await cp(source, destination, { recursive: true, dereference: false, filter: src => path.basename(src) !== '.git' });
  async function readableSnapshot(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await readableSnapshot(file);
      else await chmod(file, (await lstat(file)).mode & 0o111 ? 0o555 : 0o444);
    }
    await chmod(directory, 0o555);
  }
  await readableSnapshot(destination);
}
async function execute(config, request, docker, { fixture = false, signingKey = null, paths, job, authorityExpiresAt = Infinity, signal }) {
  const name = `clued-ci-${request.nonce}`, startedAt = new Date().toISOString();
  let created = false, containerTouched = false, attached = null, state = null, cleanupConfirmed = false, timedOut = false, containerId = null, imageId = null, cleanupReadbackSha256 = null;
  try {
    check(!signal?.aborted, 'EXECUTION_CANCELLED');
    check(config.executionMode === 'scanner' ? request.schema === 'independent-ci.container-execution-request.v1'
      && request.containerCommand?.image === config.image : request.schema === 'independent-ci.execution-request.v1', 'EXECUTION_MODE_SOURCE_MISMATCH');
    check(authorityExpiresAt > Date.now(), 'CURRENT_AUTHORITY_EXPIRED');
    imageId = (await inspectEngineAndImage(config, docker)).Id;
    check(authorityExpiresAt > Date.now(), 'CURRENT_AUTHORITY_EXPIRED');
    check(!signal?.aborted, 'EXECUTION_CANCELLED');
    containerTouched = true;
    const creation = await docker(dockerCreateArguments(config, request, paths, name));
    check(creation.code === 0 && !creation.timedOut && !creation.error && !creation.overflow && /^[a-f0-9]{64}\s*$/.test(creation.stdout), 'CREATE_UNCONFIRMED'); created = true; containerId = creation.stdout.trim();
    const inspected = parse(await docker(['inspect', name])); check(inspected.length === 1 && inspected[0].Id === containerId, 'CONTAINER_READ_UNKNOWN'); verifyContainer(inspected[0], config, name, imageId, paths, request);
    attached = await docker(['start', '--attach', name], { timeoutMs: Math.min(request.timeoutMs, Math.max(1, authorityExpiresAt - Date.now())), maxOutputBytes: request.maxOutputBytes, digestOnly: true, signal });
    timedOut = attached.timedOut;
    const finished = parse(await docker(['inspect', name])); check(finished.length === 1 && finished[0].Id === containerId, 'CONTAINER_READ_UNKNOWN');
    verifyContainer(finished[0], config, name, imageId, paths, request); state = finished[0].State;
    check(state && state.Running === false && state.Status === 'exited' && Number.isInteger(state.ExitCode) && !state.Error
      && !attached.error && attached.code === state.ExitCode, 'EXECUTION_STATE_UNCONFIRMED');
  } catch (error) {
    if (!/^[A-Z_]+$/.test(error.message)) error = new Error('LAUNCHER_REFUSED');
    state = { ...(state ?? {}), refusal: error.message };
  } finally {
    if (containerTouched) {
      try {
        const removal = await docker(['rm', '--force', containerId ?? name]);
        const remaining = await docker(['container', 'ls', '--all', '--no-trunc', '--filter', `label=clued.independent.nonce=${request.nonce}`, '--format', '{{json .}}']);
        cleanupConfirmed = removal.code === 0 && !removal.timedOut && !removal.error && !removal.overflow
          && remaining.code === 0 && !remaining.timedOut && !remaining.error && !remaining.overflow && remaining.stdout.trim() === '';
        cleanupReadbackSha256 = digest({ containerId, removal: { code: removal.code, logs: removal.logs }, inventory: { code: remaining.code, logs: remaining.logs } });
      } catch { cleanupConfirmed = false; }
    }
  }
  const cleanup = { contract: 'independent-ci.cleanup-observation.v1', domain: fixture ? 'fixture' : 'production', subject: job ? subjectOf(job) : request.identity,
    requestDigest: request.requestDigest, nonce: request.nonce, runtimeId: config.runtimeIdentity, containerId, imageId, cleanupConfirmed,
    scope: 'container-pid-namespace-and-tmpfs', hostInputSnapshotsRetained: true, cleanupReadbackSha256, observedAt: new Date().toISOString() };
  if (!created || !cleanupConfirmed || timedOut || !state || state.refusal || !attached || attached.error || attached.overflow || authorityExpiresAt <= Date.now()) {
    const uncertain = { outcome: containerTouched ? 'uncertain' : 'refused', cleanupConfirmed, fixture, formalEligible: false, reason: timedOut ? 'TIMEOUT_REQUIRES_STOP_CONFIRMATION' : state?.refusal ?? 'EXECUTION_UNCONFIRMED', cleanup };
    if (!fixture && containerTouched) uncertain.cleanupReceipt = { contract: 'independent-ci.signed-cleanup.v1', keyId: config.keyId, payload: cleanup, signature: sign(null, Buffer.from(canonical(cleanup)), signingKey).toString('base64url') };
    return uncertain;
  }
  const payload = { schema: fixture ? 'independent-ci.fixture-observation.v1' : 'independent-ci.runtime-attestation.v1', fixture, nonce: request.nonce, requestDigest: request.requestDigest, identity: request.identity, runtimeIdentity: config.runtimeIdentity, outcome: state.ExitCode === 0 ? 'success' : 'failure', exitCode: state.ExitCode, cleanupConfirmed: true, logs: attached.logs, startedAt, finishedAt: new Date().toISOString() };
  if (fixture) return { ...payload, formalEligible: false, evidenceClass: 'fixture-observation', cleanup };
  const runtimeAttestation = { payload, signature: sign(null, Buffer.from(canonicalJson(payload)), signingKey).toString('base64') };
  const cleanupReceipt = { contract: 'independent-ci.signed-cleanup.v1', keyId: config.keyId, payload: cleanup, signature: sign(null, Buffer.from(canonical(cleanup)), signingKey).toString('base64url') };
  const proofPayload = { contract: 'independent-ci.execution-result.v1', domain: 'production', runtimeId: config.runtimeIdentity, subject: subjectOf(job),
    startedAt, finishedAt: payload.finishedAt, conclusion: payload.outcome, exitCode: payload.exitCode, stdoutSha256: attached.logs.stdout.sha256,
    stderrSha256: attached.logs.stderr.sha256, artifactsSha256: digest([]), requestDigest: request.requestDigest,
    sourceSha: request.sourceSha, sourceTreeSha: request.sourceTreeSha, candidateTreeSha: request.candidateTreeSha, cleanupSha256: digest(cleanupReceipt) };
  const envelope = { contract: 'independent-ci.signed-result.v1', keyId: config.keyId, payload: proofPayload, signature: sign(null, Buffer.from(canonical(proofPayload)), signingKey).toString('base64url') };
  const result = { envelope, runtimeAttestation, cleanupReceipt, cleanupConfirmed: true };
  await durableWrite(path.join(paths.run, 'receipt.json'), result);
  return result;
}
export function createFixtureLinuxLauncher({ config, dockerExecutable, dockerPrefixArgs = [] }) {
  const docker = (args, options) => invoke(dockerExecutable, dockerPrefixArgs, args, options);
  return Object.freeze({ fixture: true,
    readiness() { return inspectEngineAndImage(config, docker).then(image => ({ status: 'FIXTURE_ONLY', imageId: image.Id, formalEligible: false })); },
    execute(request, paths, options = {}) { return execute(config, request, docker, { fixture: true, paths, signal: options.signal }); }
  });
}
export async function executeLinuxRequest(input, configPath, { signal } = {}) {
  const { config, sourceManifestBytes, publicKey, qualification } = await loadQualifiedPolicy(configPath);
  check(input && Object.keys(input).length === 2 && Object.hasOwn(input, 'job') && Object.hasOwn(input, 'request'), 'INVALID_REQUEST_PACKET');
  const { job, request } = structuredClone(input); validateJob(job);
  check(Date.parse(job.createdAt) <= Date.now(), 'JOB_TIME_INVALID');
  check(request.schema === (config.executionMode === 'scanner' ? 'independent-ci.container-execution-request.v1' : 'independent-ci.execution-request.v1')
    && /^[a-f0-9]{64}$/.test(request.nonce) && /^[a-f0-9]{64}$/.test(request.identity?.jobId), 'INVALID_REQUEST');
  const { requestDigest, ...bound } = request; check(sha256(canonicalJson(bound)) === requestDigest, 'REQUEST_DIGEST_MISMATCH');
  check(job.id === request.identity.jobId && ['repo', 'pr', 'headSha', 'baseSha', 'claimId', 'fence', 'epoch', 'role', 'sourceManifestSha256'].every(k => job[k] === request.identity[k]), 'JOB_REQUEST_MISMATCH');
  for (const field of ['claimId', 'fence', 'epoch']) check(request.identity[field] === config.currentClaim[field], 'CURRENT_CLAIM_MISMATCH');
  const expectedWorkspace = path.join(config.workspaceRoot, request.identity.jobId, 'candidate'); check(request.workspace === expectedWorkspace, 'WORKSPACE_SCOPE');
  const prepare = config.executionMode === 'scanner' ? prepareContainerWorkerJob : prepareWorkerJob;
  const prepared = await prepare({ job, workspace: expectedWorkspace, trustedSourceDirectory: config.trustedSourceDirectory, sourceManifestBytes, expectedSourceManifestSha256: config.sourceManifestSha256, gitExecutable: config.gitExecutable });
  for (const field of ['identity', config.executionMode === 'scanner' ? 'containerCommand' : 'command', 'sourceSha', 'sourceTreeSha', 'candidateTreeSha', 'timeoutMs', 'maxOutputBytes']) check(canonicalJson(prepared[field]) === canonicalJson(request[field]), 'REQUEST_SOURCE_DRIFT');
  const run = path.join(config.runsRoot, request.nonce); await mkdir(run, { mode: 0o700 });
  const paths = { run, candidate: path.join(run, 'candidate'), source: path.join(run, 'source'), request: path.join(run, 'job.json') };
  const manifest = JSON.parse(sourceManifestBytes);
  await sealCopy(expectedWorkspace, paths.candidate);
  await sealCopy(config.trustedSourceDirectory, paths.source, { sourceFiles: manifest.roles[request.identity.role].sourceFiles });
  if (config.executionMode === 'node-entry') await writeFile(paths.request, JSON.stringify({ command: request.command, relativeCwd: path.relative(expectedWorkspace, request.command.cwd).split(path.sep).join('/') || '.', containerNodeSha256: config.containerNodeSha256 }), { flag: 'wx', mode: 0o644 });
  // Key remains outside all container mounts and is never forwarded to a child.
  await protectedPath(config.signingKeyFile, { privateFile: true });
  const signingKey = await readFile(config.signingKeyFile);
  const actualKey = createPublicKey(signingKey);
  check(actualKey.asymmetricKeyType === 'ed25519' && actualKey.export({ type: 'spki', format: 'der' }).equals(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })), 'RESULT_SIGNER_KEY_MISMATCH');
  await durableWrite(path.join(run, 'intent.json'), { contract: 'independent-ci.launch-intent.v1', subject: subjectOf(job), requestDigest, nonce: request.nonce, image: config.image });
  const result = await execute(config, request, (args, options) => invoke(config.dockerExecutable, ['--host', config.dockerEndpoint], args, options),
    { paths, signingKey, job, signal, authorityExpiresAt: Math.min(Date.parse(config.currentClaim.expiresAt), Date.parse(qualification.payload.expiresAt)) });
  await durableWrite(path.join(run, 'state.json'), result);
  return result;
}
export function workerTransport(launch) {
  return async request => { const result = await launch(request); if (!result.runtimeAttestation?.signature || result.cleanupConfirmed !== true) throw new Error('RUNTIME_COMPLETION_UNCONFIRMED'); return result.runtimeAttestation; };
}
export async function linuxReadiness(configPath) {
  const { config, sourceManifestBytes } = await loadQualifiedPolicy(configPath);
  await protectedPath(config.signingKeyFile, { privateFile: true });
  const roles = JSON.parse(sourceManifestBytes).roles;
  const supportedRoles = Object.keys(roles).filter(role => config.executionMode === 'scanner' ? roles[role].containerCommand?.image === config.image : roles[role].command);
  check(supportedRoles.length > 0, 'NO_BOUND_SOURCE_ROLES');
  const image = await inspectEngineAndImage(config, (args, options) => invoke(config.dockerExecutable, ['--host', config.dockerEndpoint], args, options));
  return { status: 'READY', runtimeIdentity: config.runtimeIdentity, executionMode: config.executionMode, imageId: image.Id, supportedRoles, sourceManifestSha256: config.sourceManifestSha256, actualContainerExecuted: false };
}
export async function cli(argv = process.argv.slice(2), output = process.stdout) {
  check(argv.length === 1 && ['--readiness', '--execute'].includes(argv[0]), 'FIXED_CLI_MODE_REQUIRED');
  if (argv[0] === '--readiness') { const readiness = await linuxReadiness(); output.write(`${JSON.stringify(readiness)}\n`); return 0; }
  const requestFile = '/var/lib/clued-independent-ci/request.json';
  await protectedPath(requestFile, { privateFile: true });
  const bytes = await readFile(requestFile); check(bytes.length <= 65536, 'REQUEST_SIZE_LIMIT');
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
  try { const result = await executeLinuxRequest(JSON.parse(bytes), undefined, { signal: controller.signal }); output.write(`${JSON.stringify(result)}\n`); return result.envelope?.signature ? 0 : 2; }
  finally { process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().then(code => { process.exitCode = code; }).catch(error => { process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', formalEligible: false, reason: /^[A-Z_]+$/.test(error.message) ? error.message : 'LAUNCHER_REFUSED', requiredInstallInputs })}\n`); process.exitCode = 2; });
