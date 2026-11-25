import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const SOURCES = ['ghcr.io/aquasecurity/trivy-db:2', 'mirror.gcr.io/aquasec/trivy-db:2'];
// Upstream publishes about every 6h, with NextUpdate = UpdatedAt + 24h.
// From 6h until expiry, a failed refresh only warns. The generation's metadata sets the actual expiry.
const REFRESH_AGE_MS = 6 * 60 * 60 * 1000;
// Keep an expired generation around past the longest scan job that could still be using it.
const EXPIRED_RETENTION_MS = 60 * 60 * 1000;
const PREPARE_BUDGET_MS = 570_000;
// Reserve a 60s checks download, two 10s read-backs and up to 5s for container cleanup.
const CHECKS_RESERVE_MS = 85_000;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const run = promisify(execFile);
const secondsLeft = (deadline) => Math.floor((deadline - performance.now()) / 1000);

function timestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : NaN;
}

const dbName = (updated) => `db-${new Date(updated).toISOString().replaceAll(':', '-')}`;
const current = ({ updated, next }, now) => updated <= now && now < next;

function database(directory) {
  try {
    const db = path.join(directory, 'db');
    const meta = path.join(db, 'metadata.json');
    if (!lstatSync(directory).isDirectory() || !lstatSync(db).isDirectory() || !lstatSync(meta).isFile()) return null;
    const { Version, UpdatedAt, NextUpdate } = JSON.parse(readFileSync(meta, 'utf8')) ?? {};
    const updated = timestamp(UpdatedAt);
    const next = timestamp(NextUpdate);
    if (Version !== 2 || !(updated < next)) return null;
    const data = lstatSync(path.join(db, 'trivy.db'), { throwIfNoEntry: false });
    return { directory, updated, next, complete: data?.isFile() && data.size > 0 };
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'ENOENT') return null;
    throw error;
  }
}

function generations(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('db-'))
    .map((entry) => database(path.join(root, entry.name)))
    .filter((db) => db && path.basename(db.directory) === dbName(db.updated))
    .sort((a, b) => b.updated - a.updated);
}

async function stageIn(root, job, action) {
  const stage = mkdtempSync(path.join(root, `.stage-${job}-`));
  try {
    return await action(stage);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function publish(stage, destination) {
  if (existsSync(destination)) return false;
  try {
    renameSync(stage, destination);
    return true;
  } catch (error) {
    // The other process can only publish a nonempty directory. Never copy over it.
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) throw error;
    return false;
  }
}

async function docker(args, seconds, deadline) {
  const timeout = Math.min(seconds * 1000, Math.floor(deadline - performance.now()));
  if (timeout <= 0) throw new Error('Trivy cache preparation deadline exceeded');
  const { stdout } = await run('docker', args, { timeout, killSignal: 'SIGKILL' });
  return stdout;
}

function containers(image, deadline) {
  const uid = process.getuid();
  const gid = process.getgid();
  const confined = ['run', '--rm', '--pull=never', `--user=${uid}:${gid}`, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true'];
  const mount = (source, target, flags) => ['--mount', `type=bind,src=${source},dst=${target},${flags}`];
  return {
    async download(stage, mounts, args, timeout) {
      const cidfile = `${stage}.cid`;
      try {
        await docker([...confined, '--network=host', '--ipc=private', '--cgroupns=private', '--pids-limit=128',
          '--cpus=2', '--memory=2147483648', '--memory-swap=2147483648', '--ulimit=nofile=1024:1024',
          '--env=NODE_OPTIONS=', '--env=NODE_PATH=', '--env=HOME=/scratch', '--env=TMPDIR=/scratch', '--env=GODEBUG=http2client=0',
          `--tmpfs=/scratch:rw,nosuid,nodev,noexec,size=536870912,mode=0700,uid=${uid},gid=${gid}`,
          '--cidfile', cidfile, ...mount(stage, '/cache', 'bind-propagation=rprivate'), ...mounts,
          '--workdir=/scratch', '--entrypoint', '/usr/local/bin/trivy', image, ...args], timeout, deadline);
      } catch (error) {
        // If the Docker client times out, clean up only the container it actually started.
        if (error.killed && existsSync(cidfile)) {
          const id = readFileSync(cidfile, 'utf8').trim();
          if (/^[0-9a-f]{64}$/.test(id)) await docker(['rm', '--force', id], 5, deadline).catch(() => {});
        }
        throw error;
      } finally {
        rmSync(cidfile, { force: true });
      }
    },
    read(directory, entry, args) {
      return docker([...confined, '--network=none', ...mount(directory, '/cache', 'readonly'),
        '--entrypoint', entry, image, ...args], 10, deadline);
    },
  };
}

function downloadDetail(error) {
  if (error.killed) return 'Docker deadline exceeded';
  return error.stderr?.trim().split(/\r?\n/).at(-1) || (typeof error.code === 'number' ? `Docker exited ${error.code}` : error.message);
}

function reclaimStages(root, now) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith('.stage-') || !(entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.cid')))) continue;
    const target = path.join(root, entry.name);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat && now - stat.mtimeMs > EXPIRED_RETENTION_MS) rmSync(target, { recursive: entry.isDirectory(), force: true });
  }
}

async function prepareDatabase(root, job, container, deadline) {
  const now = Date.now();
  reclaimStages(root, now);
  const initial = generations(root);
  const available = initial.find((db) => db.complete && current(db, now));
  for (const db of initial) {
    if (now - db.next >= EXPIRED_RETENTION_MS) rmSync(db.directory, { recursive: true, force: true });
  }
  if (available && now - available.updated <= REFRESH_AGE_MS) return available;

  // Optional refresh tries each source once. Cold downloads visit the mirror before retrying GHCR.
  const sources = available ? SOURCES : [...SOURCES, ...SOURCES];
  for (const source of sources) {
    const refreshedElsewhere = generations(root).find((db) => db.complete && current(db, Date.now()) &&
      (!available || db.updated > available.updated));
    if (refreshedElsewhere) return refreshedElsewhere;
    const remaining = secondsLeft(deadline);
    if (remaining < 60) break;
    const seconds = Math.min(available ? 180 : 240, remaining);
    const trivyTimeout = available && seconds === 180 ? '3m' : `${seconds}s`;
    const dockerTimeout = Math.min(seconds + (available ? 5 : 0), remaining);
    const downloaded = await stageIn(root, job, async (stage) => {
      console.log(`Trivy DB download: ${source} (${trivyTimeout})`);
      try {
        await container.download(stage, [], ['fs', '--download-db-only', '--timeout', trivyTimeout,
          '--cache-dir', '/cache', '--db-repository', source], dockerTimeout);
      } catch (error) {
        console.log(`Trivy DB download failed: ${source}: ${downloadDetail(error)}`);
        return false;
      }
      const fresh = database(stage);
      if (!fresh?.complete || !current(fresh, Date.now()) || (available && fresh.updated <= available.updated)) {
        console.log(`Trivy DB download did not provide a newer current generation: ${source}`);
        return false;
      }
      publish(stage, path.join(root, dbName(fresh.updated)));
      return true;
    });
    const best = generations(root).find((db) => db.complete && current(db, Date.now()));
    if (downloaded && best && (!available || best.updated > available.updated)) return best;
  }

  const best = generations(root).find((db) => db.complete && current(db, Date.now()));
  if (best) {
    if (best.directory === available?.directory) {
      console.log(`::warning title=Trivy cache::DB refresh failed from both sources; using ${path.basename(best.directory)}`);
    }
    return best;
  }
  const previous = available ?? initial.find((db) => db.updated <= now);
  const expiry = previous ? new Date(previous.next).toISOString() : 'unavailable';
  throw new Error(`vulnerability DB expired or missing (NextUpdate ${expiry}); neither source supplied a current DB: ${SOURCES.join(', ')}`);
}

async function prepareChecks(root, job, container, digest) {
  const directory = path.join(root, `checks-${digest.slice('sha256:'.length)}`);
  const policy = path.join(directory, 'policy');
  const validate = async (candidate) => {
    if (!lstatSync(candidate).isDirectory() || !lstatSync(path.join(candidate, 'policy')).isDirectory()) {
      throw new Error('checks bundle must be a directory');
    }
    const meta = JSON.parse(await container.read(candidate, '/bin/cat', ['/cache/policy/metadata.json']));
    if (meta.Digest !== digest || meta.MajorVersion !== 2 || meta.CustomBuild === true) {
      throw new Error('checks bundle read-back failed: expected pinned digest, major version 2 and no custom build');
    }
    if (!(await container.read(candidate, 'find', ['/cache/policy/content', '-type', 'f', '-name', '*.rego', '-print', '-quit'])).trim()) {
      throw new Error('checks bundle read-back found no Rego policy');
    }
  };
  const observed = lstatSync(directory, { throwIfNoEntry: false });
  if (observed) {
    try {
      await validate(directory);
      return policy;
    } catch (error) {
      console.log(`Trivy checks bundle read-back failed; reinstalling: ${downloadDetail(error)}`);
      await stageIn(root, job, (stage) => {
        const entry = lstatSync(directory, { throwIfNoEntry: false });
        if (entry?.ino !== observed.ino || entry.dev !== observed.dev) return;
        try {
          renameSync(directory, path.join(stage, 'invalid-checks'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      });
      if (existsSync(directory)) {
        // Another job published a replacement while this job was validating.
        await validate(directory);
        return policy;
      }
    }
  }
  const installed = await stageIn(root, job, async (stage) => {
    const empty = path.join(stage, 'empty');
    mkdirSync(empty);
    console.log(`Trivy checks bundle download: ${digest}`);
    await container.download(stage, ['--mount', `type=bind,src=${empty},dst=/empty,readonly,bind-propagation=rprivate`],
      ['fs', '--timeout', '55s', '--cache-dir', '/cache', '--checks-bundle-repository', `ghcr.io/aquasecurity/trivy-checks@${digest}`,
        '--scanners', 'misconfig', '--severity', 'HIGH,CRITICAL', '--exit-code', '1', '/empty'], 60);
    rmSync(empty, { recursive: true });
    await validate(stage);
    return publish(stage, directory);
  });
  if (!installed) await validate(directory);
  return policy;
}

async function main() {
  const deadline = performance.now() + PREPARE_BUDGET_MS;
  const { TRIVY_IMAGE: image, CHECKS_DIGEST: digest, GITHUB_ENV: output, GITHUB_RUN_ID: job = 'local' } = process.env;
  if (!output || !image || !/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error('TRIVY_IMAGE, CHECKS_DIGEST and GITHUB_ENV are required');
  const root = path.join(homedir(), '.cache', 'clued-trivy');
  if (/[\r\n,]/.test(root)) throw new Error('invalid Trivy cache path');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory()) throw new Error('Trivy cache root must be a directory');
  try {
    await docker(['image', 'inspect', image], 5, deadline);
  } catch {
    await docker(['pull', '--quiet', image], 240, deadline);
  }
  const container = containers(image, deadline);
  const label = job.replace(/[^A-Za-z0-9_-]/g, '_');
  let db = await prepareDatabase(root, label, container, deadline - CHECKS_RESERVE_MS);
  const policy = await prepareChecks(root, label, container, digest);
  // A DB near NextUpdate can expire while checks are being prepared.
  if (!current(db, Date.now())) db = await prepareDatabase(root, label, container, deadline);
  appendFileSync(output, `CLUED_TRIVY_DB=${path.join(db.directory, 'db')}\nCLUED_TRIVY_POLICY=${policy}\n`);
  console.log(`Trivy DB ready: ${path.basename(db.directory)} (NextUpdate ${new Date(db.next).toISOString()})`);
}

try {
  await main();
} catch (error) {
  const message = downloadDetail(error).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error(`::error title=Trivy cache::${message}`);
  process.exitCode = 1;
}
