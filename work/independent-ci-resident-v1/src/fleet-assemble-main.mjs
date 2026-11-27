// The Broker supplies the probe in a directory inherited from broker's SYSTEM-write ACL.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { check, HEX64, sha256, UUID } from './canonical.mjs';
import { acceptanceBytes } from './fleet-acceptance.mjs';
import { acceptanceFromTarget, byTarget, names, observationOf } from './fleet-self-pull.mjs';
import { refuseUnderTest } from './production-root-guard.mjs';
import { readBounded } from './store.mjs';
import { extractTar, readTar } from '../rollout/fleet/tar.mjs';

const SMALL = 256 * 1024;
const ARCHIVE_MAX = 512 * 1024 * 1024;
const RUN_NAME = /^[0-9a-f]{16}$/;
const PREPARED = 'FLEET_NODE_UPGRADE_PREPARED_NOT_REQUESTED';
const TERMINAL = new Set(['SUCCEEDED', 'SUCCEEDED_STILL_PAUSED', 'REFUSED', 'GRANT_REJECTED', 'GRANT_EXPIRED',
  'CANCELLED', 'STALE', 'ROLLED_BACK_PAUSED', 'ROLLBACK_FAILED']);
const read = async file => JSON.parse(await readBounded(file, SMALL, 'FLEET_READ_REFUSED'));

async function pruneRuns(root, parent, run) {
  // The upgrader journals an operation before removing its inbox file, then publishes status.
  const inbox = await fs.readdir(path.join(root, 'upgrade', 'inbox'));
  if (inbox.length) return;
  const status = await read(path.join(root, 'upgrade', 'status.json')).catch(() => null);
  if (status?.op !== null && !TERMINAL.has(status?.op?.state)) return;
  const ops = path.join(root, 'upgrade', 'ops');
  for (const id of await fs.readdir(ops)) {
    if (UUID.test(id) && !(await fs.access(path.join(ops, id, '900-terminal.json')).then(() => true, () => false))) return;
  }
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    const dir = path.join(parent, entry.name);
    if (dir !== run && RUN_NAME.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) {
      check(await fs.realpath(dir) === dir, 'FLEET_BROKER_PATH_REFUSED');
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

async function assemble(root, run, deadline) {
  const parent = path.join(root, 'broker', 'fleet-pull');
  check(path.isAbsolute(root) && path.dirname(run) === parent && RUN_NAME.test(path.basename(run))
    && await fs.realpath(run) === run, 'FLEET_BROKER_PATH_REFUSED');
  refuseUnderTest(run);
  check(Number.isSafeInteger(deadline) && deadline > Date.now(), 'FLEET_ACCEPTANCE_DEADLINE');
  const input = await read(path.join(run, 'target.json'));
  const now = Date.parse(input.at);
  const view = observationOf(input, input.fleetTarget?.repository, now);
  check(view, 'FLEET_TARGET_CHANGED');
  const { fleetTarget: target, onDuty } = view;
  const bundle = byTarget(root, target);
  const files = names(target);
  check(await fs.realpath(bundle) === bundle, 'FLEET_BROKER_PATH_REFUSED');
  const requestBytes = await readBounded(path.join(bundle, files.request), SMALL, 'FLEET_REQUEST_REFUSED');
  const acceptance = acceptanceFromTarget(target, requestBytes);
  check(Object.hasOwn(target, 'holder_package') || !onDuty || target.other_sources.every(peer => peer === acceptance.ciSourceManifestSha256), 'FLEET_WAITING_FOR_PEERS');
  const source = path.join(bundle, files.tar);
  const stat = await fs.lstat(source);
  check(stat.isFile() && stat.size > 0 && stat.size <= ARCHIVE_MAX, 'FLEET_ARCHIVE_REFUSED');
  const bytes = await readBounded(source, stat.size, 'FLEET_ARCHIVE_REFUSED');
  check(sha256(bytes) === target.archive_sha256, 'FLEET_ARCHIVE_SHA_MISMATCH');
  await pruneRuns(root, parent, run);

  const tar = path.join(run, files.tar);
  const acceptanceFile = path.join(run, files.acceptance);
  const tree = path.join(run, 'unpacked');
  const entries = readTar(bytes);
  try {
    await fs.writeFile(tar, bytes, { flag: 'wx' });
    await fs.writeFile(acceptanceFile, acceptanceBytes(acceptance), { flag: 'wx' });
    await extractTar(entries, tree);
    const script = path.join(tree, 'tree', 'work', 'independent-ci-resident-v1', 'rollout', 'fleet', 'upgrade.mjs');
    check(Date.now() < deadline, 'FLEET_ACCEPTANCE_DEADLINE');
    const { main } = await import(pathToFileURL(script).href);
    const args = ['--artifact', tar, '--artifact-sha', target.archive_sha256, '--acceptance', acceptanceFile,
      '--work', run, '--no-request', ...(onDuty ? ['--allow-active-upgrade'] : [])];
    const answer = await main(args, { root, now, deadline, wslConfigPath: null });
    const { status, code } = answer;
    if (status !== PREPARED) return { status, code };
    const { workDir, packageDir, packageManifestSha256, fromGeneration } = answer;
    check(typeof workDir === 'string' && path.dirname(workDir) === run && /^run-[a-zA-Z0-9]{6}$/.test(path.basename(workDir))
      && packageDir === path.join(workDir, 'package') && HEX64.test(packageManifestSha256 ?? '')
      && Number.isSafeInteger(fromGeneration) && fromGeneration > 0, 'FLEET_PREPARED_PACKAGE_REFUSED');
    for (const name of ['x', 'inputs']) await fs.rm(path.join(workDir, name), { recursive: true, force: true });
    return { status, packageDir, packageManifestSha256, fromGeneration };
  } finally {
    await fs.rm(tree, { recursive: true, force: true });
    await fs.rm(tar, { force: true });
    await fs.rm(acceptanceFile, { force: true });
  }
}

if (import.meta.main) {
  // Wait for the Broker to put this process in its kill-on-close job before starting any work.
  // .NET Framework can prefix redirected stdin with a UTF-8 BOM under console code page 65001.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const ready = new TextDecoder().decode(Buffer.concat(chunks));
  if (ready === 'assemble\n') {
    process.env.PSModulePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
    try {
      const { values: { root, run } } = parseArgs({ options: { root: { type: 'string' }, run: { type: 'string' } } });
      console.log(JSON.stringify(await assemble(root, run, Number(process.env.FLEET_UPGRADE_DEADLINE_MS))));
    } catch (error) {
      const code = typeof error?.code === 'string' && /^FLEET_[A-Z0-9_]+$/.test(error.code) ? error.code : 'FLEET_PREPARE_FAILED';
      console.log(JSON.stringify({ code }));
    }
  }
}
