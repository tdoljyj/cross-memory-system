// The Broker's signed probe is the authority. The companion only supplies Release bytes.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { check, HEX64, sha256, UUID } from './canonical.mjs';
import { writeObservation } from './connection-renewal.mjs';
import { acceptanceBytes, acceptanceOf, REQUEST_CONTRACT, REQUEST_FLEET_REFS } from './fleet-acceptance.mjs';
import { freshDeliveryTime } from './fleet-delivery-evidence.mjs';
import { refuseUnderTest } from './production-root-guard.mjs';
import { readBounded } from './store.mjs';
import { packageGenerationOf } from './selfcheck.mjs';
import { fetchFleetReleaseAsset, previousTransportVersion, restoreTransport, sha256File, TRANSPORT } from '../rollout/fleet/fetch.mjs';
import { deliveryAssetManifestName, deliveryDigests, NODE_ENTRY } from '../rollout/fleet/delivery-assets.mjs';
import { readTar } from '../rollout/fleet/tar.mjs';

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,88}$/;
const REPO = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const OBSERVATION_AGE = 15 * 60_000;
const RETRY = 60_000;
const LIMIT = 30 * 60_000;
const SMALL = 256 * 1024;
const LEGACY_CACHE_SCAN = 64;
const LEGACY_BASE_CANDIDATES = 4;
const MOVING = new Set(['WAITING_GRANT', 'WAITING_DRAIN', 'DEFERRED', 'RUNNING', 'ROLLING_BACK']);
const TARGET_FIELDS = ['repository', 'version', 'grant_id', 'receipt_id', 'accepted_at',
  'request_sha256', 'archive_sha256', 'acceptance_sha256'];
export const targetFingerprint = target => Object.fromEntries(TARGET_FIELDS.map(field => [field, target[field] ?? null]));
export const matchesFleetTarget = (fingerprint, target) => !!target && TARGET_FIELDS.every(field =>
  fingerprint?.[field] === (target[field] ?? null));
const needsSeal = target => packageGenerationOf(target.version) >= 25;
const read = async (filename, limit = SMALL) => {
  try { return JSON.parse(await readBounded(filename, limit, 'FLEET_READ_REFUSED')); }
  catch { return null; }
};

function saneTarget(target, repository) {
  return REPO.test(repository) && target?.repository === repository && VERSION.test(target.version ?? '')
    && HEX64.test(target.archive_sha256 ?? '') && HEX64.test(target.request_sha256 ?? '')
    && (!needsSeal(target) || HEX64.test(target.acceptance_sha256 ?? ''))
    && UUID.test(target.grant_id ?? '') && UUID.test(target.receipt_id ?? '')
    && typeof target.accepted_at === 'string' && Number.isFinite(Date.parse(target.accepted_at));
}

export function observationOf(value, repository, now) {
  const at = Date.parse(value?.at);
  const target = value?.fleetTarget;
  if (!Number.isFinite(at) || at > now || now - at > OBSERVATION_AGE || value.code !== null
    || typeof value.onDuty !== 'boolean' || !saneTarget(target, repository)
    || Date.parse(target.accepted_at) > now || !Array.isArray(target.other_sources) || target.other_sources.length > 2
    || target.other_sources.some(source => source !== null && !HEX64.test(source))) return null;
  return { at: value.at, code: null, onDuty: value.onDuty, fleetTarget: target };
}

export function acceptanceFromTarget(target, bytes) {
  check(sha256(bytes) === target.request_sha256, 'FLEET_REQUEST_SHA_MISMATCH');
  const r = JSON.parse(bytes);
  check(r?.contract === REQUEST_CONTRACT && r.repository === target.repository && r.version === target.version
    && r.archive_sha256 === target.archive_sha256 && /^[0-9a-f]{40}$/.test(r.commit ?? '')
    && HEX64.test(r.ciSourceManifestSha256 ?? '') && HEX64.test(r.firstInstallKitSha256 ?? '')
    && REQUEST_FLEET_REFS.every(key => key === 'formalRoles' ? r.fleetRefs?.[key] && typeof r.fleetRefs[key] === 'object' && !Array.isArray(r.fleetRefs[key])
      : UUID.test(r.fleetRefs?.[key] ?? '')),
  'FLEET_REQUEST_REFUSED');
  // Match seal's seconds precision, including PostgREST's offsets and fractional seconds.
  const at = Date.parse(target.accepted_at);
  const acceptedAt = new Date(Math.floor(at / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const acceptance = acceptanceOf(r, { decision: target.grant_id, receipt: target.receipt_id, acceptedAt });
  check(!needsSeal(target) || sha256(acceptanceBytes(acceptance)) === target.acceptance_sha256, 'FLEET_ACCEPTANCE_SEAL_MISMATCH');
  return acceptance;
}

export const byTarget = (root, target) => path.join(root, 'bundles', 'fleet-pull', target.request_sha256);
export const names = target => {
  const tag = `fleet-node-${target.version}`;
  return { tag, tar: `${tag}.tar`, request: `${tag}.acceptance-request.json`, acceptance: `${tag}.acceptance.json` };
};

const KIT_LIMIT = 16 * 1024 * 1024; // bootstrap 的 JSON 读取上限
const RELEASE_ASSET_LIMIT = 2 ** 31 - 1; // Release 单资产必须小于 2 GiB
const assetLimit = (name, files) => name === files.tar ? TRANSPORT.archiveMax
  : name.startsWith('role-image-') ? RELEASE_ASSET_LIMIT
    : name.endsWith('.first-install-kit.json') ? KIT_LIMIT : SMALL;
const terminalDownload = new Set(['FLEET_REINSTALL_MANIFEST_REQUIRED', 'FLEET_DELIVERY_ASSET_MANIFEST_REFUSED',
  'FLEET_DELIVERY_RELEASE_ASSET_CHANGED', 'FLEET_REINSTALL_ASSET_MISSING', 'FLEET_REINSTALL_ENTRY_CHANGED',
  'FIRST_INSTALL_KIT_IMAGES_REFUSED', 'FETCH_ASSET_TOO_LARGE', 'EACCES', 'EPERM']);

export async function verifyReinstallAssets({ target, requestBytes, dir, supply }) {
  acceptanceFromTarget(target, requestBytes);
  const request = JSON.parse(requestBytes);
  check(HEX64.test(target.acceptance_sha256 ?? '') && HEX64.test(request.deliveryAssetsSha256 ?? ''),
    'FLEET_REINSTALL_MANIFEST_REQUIRED');
  const files = names(target);
  const manifest = await supply(deliveryAssetManifestName(target.version), request.deliveryAssetsSha256, SMALL);
  const kit = await supply(`${files.tag}.first-install-kit.json`, request.firstInstallKitSha256, KIT_LIMIT);
  const digests = deliveryDigests(request, manifest, kit);
  await supply(files.acceptance, target.acceptance_sha256, SMALL);
  for (const [name, hash] of digests) {
    if (name.endsWith('.first-install-kit.json')) continue;
    await supply(name, hash, assetLimit(name, files));
  }
  const tar = await readBounded(path.join(dir, files.tar), TRANSPORT.archiveMax, 'FLEET_ARCHIVE_REFUSED');
  check(sha256(tar) === target.archive_sha256, 'FLEET_ARCHIVE_SHA_MISMATCH');
  const entries = readTar(tar);
  for (const [suffix, entry] of Object.entries(NODE_ENTRY)) {
    const data = entries.find(value => value.path === entry)?.data;
    check(data && sha256(data) === digests.get(`${files.tag}.${suffix}`), 'FLEET_REINSTALL_ENTRY_CHANGED');
  }
  return { request, digests };
}

async function downloadReinstall(root, target, dir, fetch, clock) {
  const state = path.join(dir, 'reinstall.json');
  const saved = await read(state);
  if (matchesFleetTarget(saved?.targetFingerprint, target) && (saved.ready || saved.terminal || clock() < saved.retryAt)) return;
  const projection = { targetFingerprint: targetFingerprint(target) };
  const destination = path.join(dir, 'reinstall');
  const files = names(target);
  try {
    await fs.mkdir(destination, { recursive: true });
    const requestBytes = await readBounded(path.join(dir, files.request), SMALL, 'FLEET_REQUEST_REFUSED');
    await verifyReinstallAssets({ target, requestBytes, dir, async supply(name, hash, limit) {
      const cached = path.join(dir, name);
      const file = [files.tar, files.acceptance, 'SHA256SUMS'].includes(name) ? cached : path.join(destination, name);
      if (await sha256File(file).catch(() => null) !== hash) {
        check(name !== files.tar && name !== files.acceptance && await fetch(name, limit, file), 'FLEET_REINSTALL_ASSET_MISSING');
        check(await sha256File(file) === hash, 'FLEET_DELIVERY_RELEASE_ASSET_CHANGED');
      }
      return name.endsWith('.candidate.SHA256SUMS') || name.endsWith('.first-install-kit.json')
        ? readBounded(file, limit, 'FLEET_DELIVERY_ASSET_MANIFEST_REFUSED') : undefined;
    } });
    const latest = (await read(path.join(root, 'state', 'fleet-target.json')))?.fleetTarget;
    if (matchesFleetTarget(targetFingerprint(target), latest)) await writeObservation(state, { ...projection, ready: true });
  } catch (error) {
    const code = codeOf(error, 'FLEET_REINSTALL_DOWNLOAD_FAILED');
    await writeObservation(state, { ...projection, code, terminal: terminalDownload.has(code), retryAt: clock() + RETRY });
  }
}

async function previousTars({ root, repository, version, pointer }) {
  const previous = previousTransportVersion(version);
  if (!previous) return [];
  const tar = names({ version: previous }).tar;
  const cached = await read(pointer, TRANSPORT.metaMax);
  const exists = file => fs.stat(file).then(stat => stat.isFile(), () => false);
  if (cached?.repository === repository && cached.version === previous && HEX64.test(cached.request_sha256 ?? '')) {
    const file = path.join(byTarget(root, cached), tar);
    if (await exists(file)) return [file];
  }
  // Before the pointer existed, companion used the same request-SHA folders.
  // Probe a bounded number of them. The caller verifies each candidate's hash.
  const candidates = [];
  const parent = path.dirname(pointer);
  try {
    const entries = await fs.opendir(parent);
    let scanned = 0;
    for await (const entry of entries) {
      if (++scanned > LEGACY_CACHE_SCAN || candidates.length === LEGACY_BASE_CANDIDATES) break;
      if (!entry.isDirectory() || !HEX64.test(entry.name)) continue;
      const file = path.join(parent, entry.name, tar);
      if (await exists(file)) candidates.push(file);
    }
  } catch { /* Cache discovery is optional. */ }
  return candidates;
}

// An independent companion lane. The download is credentialless. Only the optional upload uses
// the companion's existing GitHub session, and neither its timing nor its result gates the resident.
export function companionSelfPull({ root, repository, clock = Date.now, download = fetchFleetReleaseAsset, upload = async () => {} }) {
  let done = null;
  let next = 0;
  const basePointer = path.join(root, 'bundles', 'fleet-pull', 'transport-base.json');
  return async () => {
    if (clock() < next) return;
    const observation = observationOf(await read(path.join(root, 'state', 'fleet-target.json')), repository, clock());
    if (!observation) return;
    const target = observation.fleetTarget;
    const dir = byTarget(root, target);
    refuseUnderTest(dir);
    const files = names(target);
    const deadline = clock() + LIMIT;
    const fetch = (name, maxBytes = SMALL, file = path.join(dir, name), stop = deadline) =>
      download({ repository, version: target.version, name, file, maxBytes, deadline: stop });
    try {
      if (matchesFleetTarget(done, target)) {
        const ledger = await read(path.join(root, 'state', 'fleet-pull.json'));
        if (ledger?.phase === 'NEEDS_REINSTALL' && ledger.reinstall && matchesFleetTarget(ledger.targetFingerprint, target))
          await downloadReinstall(root, target, dir, fetch, clock);
        return;
      }
      await fs.mkdir(dir, { recursive: true });
      const requestFile = path.join(dir, files.request);
      if (await sha256File(requestFile).catch(() => null) !== target.request_sha256) {
        check(await fetch(files.request), 'FLEET_REQUEST_MISSING');
      }
      const acceptance = acceptanceFromTarget(target, await readBounded(requestFile, SMALL, 'FLEET_REQUEST_REFUSED'));
      if (needsSeal(target)) {
        const file = path.join(dir, files.acceptance);
        if (await sha256File(file).catch(() => null) !== target.acceptance_sha256) {
          check(await fetch(files.acceptance), 'FLEET_ACCEPTANCE_ASSET_MISSING');
        }
        check(await sha256File(file) === target.acceptance_sha256, 'FLEET_ACCEPTANCE_SEAL_MISMATCH');
      }
      const tar = path.join(dir, files.tar);
      const ready = path.join(dir, 'ready.json');
      if (await sha256File(tar).catch(() => null) !== target.archive_sha256) {
        await fs.rm(ready, { force: true });
        check(await fetch('SHA256SUMS'), 'FLEET_SUMS_MISSING');
        const sums = (await readBounded(path.join(dir, 'SHA256SUMS'), SMALL, 'FLEET_SUMS_REFUSED')).toString('utf8');
        check(sums.split(/\r?\n/).some(line => line === `${target.archive_sha256}  ${files.tar}`), 'FLEET_SUMS_MISMATCH');
        const baseFiles = await previousTars({ root, repository, version: target.version, pointer: basePointer });
        const restored = await restoreTransport({ repository, version: target.version, archiveSha256: target.archive_sha256,
          dir, baseFiles, deadline, now: clock, fetchAsset: (name, file, maxBytes, stop) => fetch(name, maxBytes, file, stop) });
        if (!restored) {
          check(await fetch(files.tar, TRANSPORT.archiveMax), 'FLEET_ARCHIVE_MISSING');
          const valid = await sha256File(tar) === target.archive_sha256;
          if (!valid) await fs.rm(tar, { force: true });
          check(valid, 'FLEET_ARCHIVE_SHA_MISMATCH');
        }
      }
      await writeObservation(ready, { grantId: target.grant_id });
      // The pointer is only a lookup hint; the next delta re-hashes the base.
      if (packageGenerationOf(target.version) !== null) {
        await writeObservation(basePointer, { repository, version: target.version, request_sha256: target.request_sha256 }).catch(() => {});
      }
      done = targetFingerprint(target);
      // Existing acceptance bytes are never the authority and are never overwritten on the Release.
      if (!needsSeal(target) && !(await fetch(files.acceptance))) {
        const file = path.join(dir, files.acceptance);
        await fs.writeFile(file, acceptanceBytes(acceptance));
        await upload({ tag: files.tag, file });
      }
    } catch (error) {
      next = clock() + RETRY;
      try { await writeObservation(path.join(dir, 'download.json'), { code: codeOf(error, 'FLEET_DOWNLOAD_FAILED') }); } catch { /* retry remains bounded */ }
    }
  };
}

const codeOf = (error, fallback) => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : fallback;

export async function dropFleetRequest(root, id, payload) {
  const dir = path.join(root, 'broker', 'requests');
  refuseUnderTest(dir);
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(payload), { flag: 'wx' });
}

const DELIVERY_ROOT = 'C:\\ProgramData\\CluedFleetDelivery';
const REINSTALL_CONTRACT = 'clued.independent-ci.fleet-reinstall/1';
const RESULT_CONTRACT = 'clued.independent-ci.fleet-reinstall-result/1';
const RETRY_BROKER = new Set(['RENEW_BUSY', 'FLEET_BROKER_BUSY', 'BROKER_REQUEST_INTERRUPTED_NOT_REPEATED',
  'BROKER_REQUEST_PREDATES_START', 'FLEET_WAITING_FOR_IDLE', 'FLEET_WAITING_FOR_HANDOVER', 'FLEET_MAINTENANCE_BLOCKED',
  'FLEET_REINSTALL_DISK_FULL']);
const exists = file => fs.lstat(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

function attemptInterrupted(at, pid, clock) {
  if (Date.parse(at) < clock() - os.uptime() * 1000) return true;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
  return false;
}

async function reinstallProjection(root, deliveryRoot, target, clock) {
  if (!deliveryRoot) return null;
  const pointer = await read(path.join(deliveryRoot, 'pending.json'));
  if (pointer?.contract !== REINSTALL_CONTRACT || !UUID.test(pointer.operationId ?? '') ||
      pointer.requestSha256 !== target.request_sha256 || !matchesFleetTarget(pointer.targetFingerprint, target)) return null;
  const operation = pointer.operationId;
  const result = await read(path.join(deliveryRoot, target.request_sha256, operation, 'result.json'));
  const reply = result?.contract === RESULT_CONTRACT && result.operationId === operation &&
    result.requestSha256 === target.request_sha256 && result.grantId === target.grant_id &&
    result.sourceSha256 === pointer.sourceSha256 && result.nodeId === pointer.nodeId &&
    result.bindingGeneration === pointer.bindingGeneration ? result : null;
  if (reply?.phase === 'FAILED') return { phase: 'FAILED', code: codeOf(reply, 'FLEET_REINSTALL_FAILED'), at: reply.at };
  const current = await read(path.join(root, 'upgrade', 'current.json'));
  const installed = current?.ciSourceManifestSha256 === pointer.sourceSha256 &&
    current.installReceiptSha256 !== pointer.installReceiptSha256;
  if (reply?.phase === 'COMPLETE' && UUID.test(reply.returnReceiptId ?? '') && installed &&
      current.installReceiptSha256 === reply.receiptSha256) {
    const broker = (await read(path.join(root, 'broker', 'renew-ci.json')))?.delivery;
    const linux = await read(path.join(root, 'upgrade', 'mailbox', 'responses', 'version-facts.json'));
    if (broker?.nodeId === reply.nodeId && broker.bindingGeneration === reply.bindingGeneration &&
        broker.installReceiptSha256 === current.installReceiptSha256 && broker.installGeneration === current.generation &&
        broker.windowsSourceSha256 === pointer.sourceSha256 && freshDeliveryTime(broker.observedAt, clock()) &&
        linux?.contract === 'clued.independent-ci.linux-version-facts/1' &&
        linux.ciSourceManifestSha256 === pointer.sourceSha256 && linux.generation === current.linux?.generation &&
        linux.staged === null && linux.pinsOk === true && linux.liveMatchesCurrent === true && freshDeliveryTime(linux.observedAt, clock()))
      return { phase: 'COMPLETE', at: reply.at };
  }
  if (installed) return { phase: 'VERIFYING' };
  if (reply?.phase === 'INSTALLING' && !attemptInterrupted(reply.at, reply.pid, clock))
    return { phase: 'INSTALLING', at: reply.at };
  const claim = await read(path.join(deliveryRoot, 'claims', `${operation}.json`), 4096);
  const freshHandoff = Date.parse(pointer.expiresAt) > clock();
  if (claim?.operationId === operation && ['PENDING_UAC', 'INSTALLING', 'FAILED', 'PREFLIGHT', 'RETRY_PREFLIGHT'].includes(claim.phase)) {
    // An ongoing preflight can outlast the delivery lease. Refresh that same
    // protected handoff before asking the Broker to launch.
    if (!freshHandoff && ['PREFLIGHT', 'RETRY_PREFLIGHT'].includes(claim.phase)) return null;
    if (['PENDING_UAC', 'INSTALLING'].includes(claim.phase) && attemptInterrupted(claim.at, claim.pid, clock))
      return { phase: 'FAILED', code: 'FLEET_REINSTALL_ATTEMPT_INTERRUPTED', at: claim.at };
    return { phase: claim.phase, code: codeOf(claim, null), at: claim.at };
  }
  return freshHandoff ? { phase: 'WAITING_FOR_OWNER_SESSION' } : null;
}

export function residentSelfPull({ root, repository, clock = Date.now,
  deliveryRoot = process.platform === 'win32' && !process.env.CLUED_UNDER_TEST && !process.env.NODE_TEST_CONTEXT ? DELIVERY_ROOT : null,
  submit = (id, payload) => dropFleetRequest(root, id, payload) }) {
  const at = (...parts) => path.join(root, ...parts);
  const ledger = at('state', 'fleet-pull.json');
  const reservation = at('state', 'fleet-idle.json');
  const observe = async () => observationOf(await read(at('broker', 'renew-ci.json')), repository, clock());
  const response = id => at('broker', 'responses', `${id}.json`);
  const challenge = id => at('broker', 'responses', `${id}.idle`);
  const confirmation = id => at('broker', 'requests', `${id}.idle`);
  const requestFile = id => at('broker', 'requests', `${id}.json`);
  const taken = id => at('broker', 'responses', `${id}.taken`);
  const launchChallenge = at('broker', 'responses', 'reinstall-idle.json');
  const paused = () => fs.access(at('state', 'PAUSED.json')).then(() => true, error => error.code !== 'ENOENT');
  let next = 0;
  let relayed;
  let active;
  let idle = null;
  let lease;
  let stopped = false;
  const show = async (target, phase, code = null, requestId = null, reinstall = undefined) => {
    const view = { targetVersion: target.version, grantId: target.grant_id, phase, code, requestId,
      targetFingerprint: targetFingerprint(target),
      ...(phase === 'NEEDS_REINSTALL' && needsSeal(target) ? {
        reinstall: { repository: target.repository, archiveSha256: target.archive_sha256,
          requestSha256: target.request_sha256, acceptanceSha256: target.acceptance_sha256, ...reinstall },
      } : {}) };
    if (JSON.stringify(view) !== JSON.stringify(await read(ledger))) await writeObservation(ledger, view);
  };
  async function step() {
    refuseUnderTest(root);
    const view = await observe();
    if (JSON.stringify(view) !== relayed) {
      await writeObservation(at('state', 'fleet-target.json'), view);
      relayed = JSON.stringify(view);
    }
    const last = await read(ledger);
    if (last?.reinstall && !matchesFleetTarget(last.targetFingerprint, view?.fleetTarget)) {
      delete last.reinstall;
      await writeObservation(ledger, last);
      return;
    }
    if (!view) return;
    const { fleetTarget: target, onDuty } = view;
    const maintenance = target.holder_package?.maintenance;
    const projected = await reinstallProjection(root, deliveryRoot, target, clock);
    if (projected?.phase === 'COMPLETE') {
      await show(target, 'CURRENT');
      return;
    }
    if (projected && !last?.reinstall?.refusalId) {
      await show(target, 'NEEDS_REINSTALL', last?.code ?? 'FLEET_NEEDS_REINSTALL', null, projected);
      return;
    }
    if (last?.phase === 'NEEDS_REINSTALL' && matchesFleetTarget(last.targetFingerprint, target) && last.reinstall?.refusalId) {
      const info = last.reinstall;
      const update = (phase, extra = {}) => show(target, 'NEEDS_REINSTALL', last.code, null, { refusalId: info.refusalId, phase, ...extra });
      if (projected && projected.phase !== 'WAITING_FOR_OWNER_SESSION') {
        await update(projected.phase, projected);
        return;
      }
      const ineligible = maintenance === 'reserve' || maintenance === 'repair' || (onDuty && target.has_other_healthy) ||
        target.reinstall_eligible !== true;
      if (ineligible && !info.brokerId) {
        const phase = maintenance === 'repair' ? 'REPAIR' :
          maintenance === 'reserve' || onDuty && target.has_other_healthy ? 'WAITING_FOR_HANDOVER' : 'WAITING_FOR_MAINTENANCE';
        await update(phase);
        return;
      }
      if (projected) {
        await update(projected.phase, projected);
        return;
      }
      const canSubmit = async () => !ineligible && idle && (!onDuty || idle.queueEmpty) && !stopped &&
        !MOVING.has((await read(at('upgrade', 'status.json')))?.op?.state) && !(await paused());
      const deliver = async id => {
        try { await submit(id, { kind: 'fleet-reinstall', grantId: target.grant_id, refusalId: info.refusalId }); }
        catch { next = clock() + RETRY; /* Reconcile the same ID before attempting another write. */ }
      };
      if (UUID.test(info.brokerId ?? '')) {
        const id = info.brokerId;
        const answer = await read(response(id));
        if (answer?.requestId !== id) {
          if (info.phase === 'FAILED') return;
          const requestedAt = Number.isSafeInteger(info.requestedAt) ? info.requestedAt : clock();
          if (clock() - requestedAt >= LIMIT) {
            await update('FAILED', { brokerId: id, requestedAt, code: 'FLEET_REINSTALL_BROKER_UNCONFIRMED' });
            return;
          }
          if (requestedAt !== info.requestedAt) await update('PREPARING', { brokerId: id, requestedAt });
          // Absence of the Broker's write-through claim and of the inbox/answer
          // leaves exactly one safe action: create that same request ID.
          if (await canSubmit() && !(await exists(taken(id))) && !(await exists(requestFile(id))) &&
              !(await exists(response(id)))) await deliver(id);
          return;
        }
        if (answer.status === 'FLEET_REINSTALL_PUBLISHED') {
          if (answer.grantId === target.grant_id && matchesFleetTarget(answer.targetFingerprint, target))
            await update('WAITING_FOR_OWNER_SESSION');
          else await update('FAILED', { code: 'FLEET_REINSTALL_SUBJECT_CHANGED' });
          return;
        }
        const code = codeOf(answer, 'FLEET_REINSTALL_BROKER_UNCONFIRMED');
        if (!RETRY_BROKER.has(code)) {
          await update('FAILED', { code });
          return;
        }
        next = clock() + RETRY;
        await update('DOWNLOADING', { code });
        return;
      }
      if (info.phase === 'FAILED') return;
      const ready = await read(path.join(byTarget(root, target), 'reinstall.json'));
      if (!matchesFleetTarget(ready?.targetFingerprint, target) || !ready.ready) {
        await update(ready?.terminal ? 'FAILED' : 'DOWNLOADING', { code: codeOf(ready, null) });
        return;
      }
      if (!(await canSubmit())) return;
      const id = randomUUID();
      await update('PREPARING', { brokerId: id, requestedAt: clock() });
      await deliver(id);
      return;
    }
    if (maintenance === 'reserve' || maintenance === 'repair') {
      await show(target, maintenance === 'reserve' ? 'RESERVE' : 'REPAIR');
      return;
    }
    const upgrade = await read(at('upgrade', 'status.json'));
    const op = upgrade?.op;
    if (last?.grantId === target.grant_id && last.requestId) {
      const answer = await read(response(last.requestId));
      if (last.phase === 'REQUESTED' && answer?.requestId === last.requestId && answer.delivered === false) {
        if (['FLEET_NODE_ALREADY_AT_THIS_PACKAGE', 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL'].includes(answer.status)) {
          const latest = (await observe())?.fleetTarget;
          if (answer.grantId === last.grantId && matchesFleetTarget(last.targetFingerprint, latest)
            && matchesFleetTarget(answer.targetFingerprint, latest)) {
            if (answer.status === 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE') await show(latest, 'CURRENT');
            else await show(latest, 'NEEDS_REINSTALL', codeOf(answer, 'FLEET_NEEDS_REINSTALL'), null,
              latest.holder_package && needsSeal(latest) ? { refusalId: last.requestId, phase: 'DOWNLOADING' } : undefined);
          } else {
            await show(target, 'PREPARE_FAILED', 'FLEET_TARGET_CHANGED');
            next = clock() + RETRY;
          }
        } else {
          const code = codeOf(answer, 'FLEET_PREPARE_FAILED');
          await show(target, code === 'FLEET_WAITING_FOR_PEERS' ? 'WAITING_FOR_PEERS' : 'PREPARE_FAILED', code);
          next = clock() + RETRY;
        }
        return;
      }
      if (last.phase === 'REQUESTED') {
        const completed = upgrade?.recent?.find(r => r.opId === last.requestId);
        const finished = op?.opId === last.requestId ? op : completed;
        const outcome = finished?.outcome ?? finished?.state;
        if (['SUCCEEDED', 'SUCCEEDED_STILL_PAUSED'].includes(outcome)) await show(target, 'CURRENT', null, last.requestId);
        if (['REFUSED', 'GRANT_REJECTED', 'GRANT_EXPIRED', 'CANCELLED', 'STALE'].includes(outcome))
          await show(target, 'REFUSED', codeOf(finished, 'FLEET_UPGRADE_REFUSED'), last.requestId);
        if (['ROLLED_BACK_PAUSED', 'ROLLBACK_FAILED'].includes(outcome)) await show(target, 'ROLLED_BACK', codeOf(finished, 'FLEET_UPGRADE_ROLLBACK'), last.requestId);
      }
      // The existing rollback notices own both rollback outcomes.
      return;
    }
    if (last?.grantId === target.grant_id && (['CURRENT', 'REFUSED'].includes(last.phase)
      || (last.phase === 'NEEDS_REINSTALL' && matchesFleetTarget(last.targetFingerprint, target)
        && (!needsSeal(target) || last.reinstall)))) return;
    if (!idle || (onDuty && !idle.queueEmpty) || stopped || (op && MOVING.has(op.state))
      || await paused()) return;
    const bundle = byTarget(root, target);
    if ((await read(path.join(bundle, 'ready.json')))?.grantId !== target.grant_id) {
      const failure = await read(path.join(bundle, 'download.json'));
      await show(target, 'DOWNLOADING', failure?.code ?? null);
      return;
    }
    const requestBytes = await readBounded(path.join(bundle, names(target).request), SMALL, 'FLEET_REQUEST_REFUSED');
    const acceptance = acceptanceFromTarget(target, requestBytes);
    const source = acceptance.ciSourceManifestSha256;
    if (Object.hasOwn(target, 'holder_package')) {
      const info = target.holder_package;
      if (!info || !['available', 'delisted'].includes(info.maintenance)) return;
      if (onDuty && target.has_other_healthy && info.maintenance === 'available' && info.classification !== 'current') {
        await show(target, 'WAITING_FOR_HANDOVER');
        return;
      }
    } else if (onDuty && !target.other_sources.every(peer => peer === source)) {
      await show(target, 'WAITING_FOR_PEERS');
      return;
    }
    if (!idle || (onDuty && !idle.queueEmpty) || stopped) return;
    const id = randomUUID();
    // Persist before sending. An interrupted or unknown delivery may already have produced an inbox file.
    await show(target, 'REQUESTED', null, id);
    try {
      await submit(id, { kind: 'fleet-pull', grantId: target.grant_id });
    } catch (error) { await show(target, 'REFUSED', codeOf(error, 'FLEET_BROKER_DELIVERY_UNKNOWN'), id); }
  }
  return {
    async holdingIdle() {
      if (lease === undefined) {
        // 服务重启后仍须遵守上一个进程已经确认的空闲保留。
        const saved = await read(reservation);
        lease = UUID.test(saved?.requestId ?? '') && saved.idle === true && Number.isSafeInteger(saved.expiresAt) ? saved : null;
      }
      if (!lease) return false;
      const { requestId, expiresAt } = lease;
      if ((await read(response(requestId)))?.requestId !== requestId) {
        if (clock() < expiresAt) return true;
        // 到期时 Broker 可能仍持有独占句柄，正在写入升级 inbox。
        try { await (await fs.open(challenge(requestId), 'r')).close(); }
        catch (error) { if (error.code !== 'ENOENT') return true; }
      }
      lease = null;
      return false;
    },
    async confirmIdle(canStart) {
      if (lease || stopped) return;
      refuseUnderTest(root);
      const last = await read(ledger);
      const notice = await read(launchChallenge, 4096);
      const launch = Number.isSafeInteger(notice?.expiresAt) && notice.expiresAt > clock() &&
        UUID.test(notice.operationId ?? '') ? notice : null;
      const id = launch?.requestId ?? (last?.phase === 'REQUESTED' ? last.requestId : last?.reinstall?.brokerId);
      if (!UUID.test(id ?? '')) return;
      const ping = await read(challenge(id));
      if (ping?.requestId !== id || !UUID.test(ping.nonce ?? '') || !Number.isSafeInteger(ping.expiresAt)
        || ping.expiresAt <= clock() || await fs.access(confirmation(id)).then(() => true, () => false)) return;
      const latest = await observe();
      const op = (await read(at('upgrade', 'status.json')))?.op;
      const target = latest?.fleetTarget;
      // For launch the Broker binds the current target/duty with a live probe
      // after this reservation. The resident attests only to its local queue.
      const confirmed = canStart?.queueEmpty === true && !MOVING.has(op?.state) && !(await paused()) && !stopped &&
        (launch !== null || latest?.onDuty === true &&
          matchesFleetTarget(last?.targetFingerprint, target) && matchesFleetTarget(ping.targetFingerprint, target));
      const ack = { requestId: id, nonce: ping.nonce, expiresAt: ping.expiresAt, idle: confirmed };
      // 先保留空闲再发送。确认写入结果未知时仍保留空闲。
      if (confirmed) {
        try { await writeObservation(reservation, ack); }
        catch { return; }
        lease = ack;
      }
      try { await fs.writeFile(confirmation(id), JSON.stringify(ack), { flag: 'wx' }); }
      catch { /* Broker 在确认缺失或不可读时重试。 */ }
    },
    tick(canStart) {
      idle = canStart;
      if (stopped || active || clock() < next) return active;
      active = step().catch(async error => {
        next = clock() + RETRY;
        const view = await observe();
        const last = await read(ledger);
        if (view && !(last?.grantId === view.fleetTarget.grant_id && (last.requestId || last.reinstall?.brokerId)))
          await show(view.fleetTarget, 'PREPARE_FAILED', codeOf(error, 'FLEET_PREPARE_FAILED')).catch(() => {});
      }).finally(() => { active = null; });
      return active;
    },
    stop() { stopped = true; },
  };
}
