import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canonical, digest } from '../../src/proof.mjs';
import { IMAGE, LIMITS } from '../required-trivy-v2/plans.mjs';
import { createArguments, observeUnsignedContainer } from '../verify-once/verify-worker.mjs';

const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const actualClients = new WeakSet();
// Docker canonical RepoDigests omit a human-readable tag. Preserve the exact
// original ee940 digest while using its canonical repository@digest form.
export const NATIVE_IMAGE = IMAGE.replace(':0.74.0@', '@');
function createDockerClient(spawnProcess) {
  const client = async (args, { timeoutMs = 10000, maxOutputBytes = 65536, digestOnly = false, signal } = {}) => new Promise(resolve => {
    const p = spawnProcess('/usr/bin/docker', ['--host', 'unix:///run/docker.sock', ...args], { shell: false,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const logs = Object.fromEntries(['stdout', 'stderr'].map(key => [key, { hash: createHash('sha256'), bytes: 0, truncated: false }]));
    const chunks = { stdout: [], stderr: [] }; let timedOut = false, overflow = false, error = false, ended = false, stopping = false, timer, settleTimer;
    const finish = code => {
      if (ended) return; ended = true; clearTimeout(timer); clearTimeout(settleTimer); signal?.removeEventListener('abort', abort);
      resolve({ code, timedOut, overflow, error, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        logs: Object.fromEntries(Object.entries(logs).map(([key, value]) => [key, { sha256: value.hash.digest('hex'), bytes: value.bytes, truncated: value.truncated }])) });
    };
    // Killing the CLI proves no container cleanup. If close never arrives,
    // return an unknown exit after a bounded settle so the caller can remove
    // and inventory the container instead of waiting forever.
    const stop = kind => {
      if (ended) return; if (kind === 'overflow') overflow = true; else timedOut = true;
      if (stopping) return; stopping = true;
      try { p.kill('SIGKILL'); } catch { error = true; }
      if (!ended) settleTimer = setTimeout(() => finish(null), 250);
    };
    const abort = () => stop('timeout');
    for (const key of ['stdout', 'stderr']) p[key].on('data', bytes => { if (ended) return; logs[key].hash.update(bytes); logs[key].bytes += bytes.length;
      if (logs.stdout.bytes + logs.stderr.bytes > maxOutputBytes) { logs[key].truncated = true; stop('overflow'); }
      else if (!digestOnly) chunks[key].push(bytes); });
    p.once('error', () => { error = true; finish(null); }); p.once('close', finish);
    timer = setTimeout(abort, timeoutMs); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
  return client;
}
export function actualDockerClient() { const client = createDockerClient(spawn); actualClients.add(client); return client; }
// The pure process fixture shares bounded transport behavior but never receives
// the private actual-client brand accepted by actualCachePort.
export const fixtureDockerClient = spawnProcess => createDockerClient(spawnProcess);
export const isActualDockerClient = client => actualClients.has(client);
const parsed = result => { check(result.code === 0 && !result.error && !result.timedOut && !result.overflow, 'DOCKER_READ_UNKNOWN'); try { return JSON.parse(result.stdout); } catch { check(false, 'DOCKER_JSON_UNKNOWN'); } };
const good = result => result?.code === 0 && !result.error && !result.timedOut && !result.overflow;
export function executionRequest(deadline) {
  return { nonce: randomBytes(32).toString('hex'), executionId: randomUUID(), deadline: new Date(deadline).toISOString() };
}
export async function imageReadiness(docker, dockerRootDirectory) {
  const info = parsed(await docker(['info', '--format', '{{json .}}']));
  check(info.OSType === 'linux' && info.DockerRootDir === dockerRootDirectory && !/desktop/i.test(info.OperatingSystem ?? '')
    && info.SecurityOptions?.some(value => value.includes('seccomp')), 'NATIVE_ENGINE_UNKNOWN');
  const images = parsed(await docker(['image', 'inspect', NATIVE_IMAGE]));
  check(images.length === 1 && images[0].Os === 'linux' && /^sha256:[a-f0-9]{64}$/.test(images[0].Id)
    && images[0].RepoDigests?.includes(NATIVE_IMAGE) && !Object.keys(images[0].Config?.Volumes ?? {}).length
    && (images[0].Config?.Env ?? []).every(value => /^(PATH|NODE_VERSION|YARN_VERSION|LANG|LC_ALL|TZ)=/.test(value)), 'EXACT_EE940_IMAGE_MISSING');
  return { imageId: images[0].Id, imageObservationSha256: digest(images[0]), engineObservationSha256: digest(info) };
}

// Only cache preparation uses this networked profile. Source literals fix the
// image/argv and the sole writable mount; no job or PR directory is accepted.
export function cacheCreateArguments(spec, request, name) {
  check(spec.image === IMAGE && spec.network === 'host' && spec.user === '65532:65532' && spec.executable === '/usr/local/bin/trivy'
    && spec.mounts.length >= 1 && spec.mounts.length <= 2 && spec.mounts[0].target === '/cache' && spec.mounts[0].readOnly === false
    && spec.mounts.slice(1).every(mount => mount.target === '/empty' && mount.readOnly === true), 'FIXED_CACHE_PROFILE_REQUIRED');
  const plan = { executable: spec.executable, cwd: '/scratch', args: spec.argv ?? spec.args, mounts: spec.mounts.map(mount => [mount.source, mount.target]) };
  return createArguments({ imageDigest: NATIVE_IMAGE, limits: LIMITS }, request, plan, name).map(value => value === '--network=none' ? '--network=host'
    : value.startsWith('type=bind,') && value.includes(',dst=/cache,readonly,') ? value.replace(',readonly,', ',') : value);
}
function inspectCache(container, spec, request, name, imageId) {
  const h = container?.HostConfig, expected = new Map(spec.mounts.map(mount => [mount.target, mount]));
  check(container?.Name === '/' + name && container.Image === imageId && container.Config?.Image === NATIVE_IMAGE && container.Config.User === '65532:65532'
    && h?.NetworkMode === 'host' && h.IpcMode === 'private' && h.CgroupnsMode === 'private' && ['', 'private'].includes(h.PidMode) && !h.UTSMode
    && h.Privileged === false && h.ReadonlyRootfs === true && canonical(h.CapDrop) === canonical(['ALL']) && !h.CapAdd?.length && !h.Devices?.length
    && canonical(h.SecurityOpt) === canonical(['no-new-privileges:true']) && h.Memory === LIMITS.memoryBytes && h.MemorySwap === LIMITS.memoryBytes
    && h.NanoCpus === Math.round(LIMITS.cpus * 1e9) && h.PidsLimit === LIMITS.pids && h.LogConfig?.Type === 'none', 'CACHE_CONTAINER_ISOLATION_DRIFT');
  const binds = (container.Mounts ?? []).filter(mount => mount.Type === 'bind'), scratch = (container.Mounts ?? []).filter(mount => mount.Type === 'tmpfs');
  check(binds.length === expected.size && new Set(binds.map(mount => mount.Destination)).size === expected.size
    && binds.every(mount => expected.get(mount.Destination)?.source === mount.Source && mount.RW === !expected.get(mount.Destination).readOnly)
    && scratch.length <= 1 && scratch.every(mount => mount.Destination === '/scratch' && !mount.Source)
    && container.Mounts.length === binds.length + scratch.length && Object.keys(h.Tmpfs ?? {}).length === 1
    && h.Tmpfs['/scratch']?.includes('uid=65532') && h.Tmpfs['/scratch'].includes('noexec'), 'CACHE_ONLY_MOUNT_DRIFT');
  check(canonical(container.Config.Entrypoint) === canonical(['/usr/local/bin/trivy']) && canonical(container.Config.Cmd) === canonical(spec.argv ?? spec.args)
    && container.Config.WorkingDir === '/scratch' && container.Config.Labels?.['clued.verify.nonce'] === request.nonce
    && container.Config.Labels?.['clued.verify.execution'] === request.executionId
    && (container.Config.Env ?? []).every(value => /^(PATH|NODE_VERSION|YARN_VERSION|LANG|LC_ALL|TZ|NODE_OPTIONS|NODE_PATH|HOME)=/.test(value))
    && ['NODE_OPTIONS=', 'NODE_PATH=', 'HOME=/scratch'].every(wanted => (container.Config.Env ?? []).filter(value => value.split('=')[0] === wanted.split('=')[0]).join('') === wanted), 'CACHE_COMMAND_ENV_DRIFT');
}
export async function runCacheContainer({ spec, docker, dockerRootDirectory, deadline, signal }) {
  const request = executionRequest(deadline), name = 'clued-verify-' + request.nonce;
  let touched = false, id = null, state = null, attached = null, reason = null, cleanupConfirmed = false, image = null;
  try {
    check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED'); image = await imageReadiness(docker, dockerRootDirectory);
    check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED');
    touched = true; const created = await docker(cacheCreateArguments(spec, request, name));
    check(good(created) && /^[a-f0-9]{64}\s*$/.test(created.stdout), 'CACHE_CREATE_UNCONFIRMED'); id = created.stdout.trim();
    let data = parsed(await docker(['inspect', id])); check(data.length === 1 && data[0].Id === id, 'CACHE_IDENTITY_UNKNOWN'); inspectCache(data[0], spec, request, name, image.imageId);
    check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED');
    attached = await docker(['start', '--attach', id], { timeoutMs: Math.max(1, Math.min(310000, deadline - Date.now())), maxOutputBytes: 4 * 1024 * 1024, digestOnly: false, signal });
    data = parsed(await docker(['inspect', id])); check(data.length === 1 && data[0].Id === id, 'CACHE_IDENTITY_UNKNOWN'); inspectCache(data[0], spec, request, name, image.imageId); state = data[0].State;
    check(state?.Running === false && state.Status === 'exited' && Number.isInteger(state.ExitCode) && state.ExitCode >= 0 && state.ExitCode <= 255
      && !state.OOMKilled && !state.Error && attached.code === state.ExitCode && !attached.error && !attached.overflow, 'CACHE_EXIT_UNKNOWN');
    check(!attached.timedOut && !/deadline exceeded|timed out|context cancel/i.test(attached.stderr ?? ''), 'CACHE_TIMEOUT');
  } catch (error) { reason = error.code ?? 'CACHE_EXECUTION_UNKNOWN'; }
  finally {
    if (touched) try {
      const removed = await docker(['rm', '--force', id ?? name]);
      const ids = await docker(['container', 'ls', '--all', '--no-trunc', '--filter', `label=clued.verify.nonce=${request.nonce}`, '--format', '{{.ID}}']);
      const named = await docker(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
      cleanupConfirmed = [removed, ids, named].every(good) && ids.stdout.trim() === '' && named.stdout.trim() === '';
    } catch { cleanupConfirmed = false; }
  }
  return { contract: 'clued.independent-ci.trivy-cache-execution/1', requestSha256: digest(request), nonce: request.nonce,
    touched,
    outcome: reason || !cleanupConfirmed ? 'unknown' : state.ExitCode === 0 ? 'success' : 'failure', reason,
    exitCode: state?.ExitCode ?? null, containerId: id, imageId: image?.imageId ?? null, cleanupConfirmed,
    logs: attached?.logs ?? null, observationSha256: digest({ request, id, image, state, reason, cleanupConfirmed, logs: attached?.logs ?? null }),
    qualificationIssued: false, publicationAuthorized: false };
}
export async function runFixedScanner({ scan, docker, dockerRootDirectory, deadline, signal }) {
  const request = executionRequest(deadline);
  const observation = await observeUnsignedContainer({ imageDigest: NATIVE_IMAGE, dockerRootDirectory, limits: scan.limits }, request, scan, docker, { signal });
  return { scanner: scan.scanner, requestSha256: digest(request), nonce: request.nonce, executionId: request.executionId,
    exitCode: observation.state?.ExitCode ?? null, complete: observation.complete, touched: observation.touched, reason: observation.reason,
    logs: observation.attached?.logs ?? null, containerId: observation.containerId, imageId: observation.imageId,
    startedAt: observation.startedAt, finishedAt: observation.finishedAt, cleanupConfirmed: observation.cleanupConfirmed,
    cleanupObservedAt: observation.cleanupObservedAt, observationSha256: digest(observation) };
}
