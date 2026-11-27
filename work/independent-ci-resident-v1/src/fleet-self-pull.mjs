// The Broker's signed probe is the authority. The companion only supplies Release bytes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, HEX64, sha256, UUID } from './canonical.mjs';
import { writeObservation } from './connection-renewal.mjs';
import { acceptanceBytes, acceptanceOf, REQUEST_CONTRACT, REQUEST_FLEET_REFS } from './fleet-acceptance.mjs';
import { refuseUnderTest } from './production-root-guard.mjs';
import { readBounded } from './store.mjs';
import { packageGenerationOf } from './selfcheck.mjs';
import { fetchFleetReleaseAsset, previousTransportVersion, restoreTransport, sha256File, TRANSPORT } from '../rollout/fleet/fetch.mjs';

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
const targetFingerprint = target => Object.fromEntries(TARGET_FIELDS.map(field => [field, target[field] ?? null]));
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
    if (done === target.grant_id) return;
    const dir = byTarget(root, target);
    refuseUnderTest(dir);
    const files = names(target);
    const deadline = clock() + LIMIT;
    const fetch = (name, maxBytes = SMALL, file = path.join(dir, name), stop = deadline) =>
      download({ repository, version: target.version, name, file, maxBytes, deadline: stop });
    try {
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
      done = target.grant_id;
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

export function residentSelfPull({ root, repository, clock = Date.now,
  submit = (id, payload) => dropFleetRequest(root, id, payload) }) {
  const at = (...parts) => path.join(root, ...parts);
  const ledger = at('state', 'fleet-pull.json');
  const reservation = at('state', 'fleet-idle.json');
  const observe = async () => observationOf(await read(at('broker', 'renew-ci.json')), repository, clock());
  const response = id => at('broker', 'responses', `${id}.json`);
  const challenge = id => at('broker', 'responses', `${id}.idle`);
  const confirmation = id => at('broker', 'requests', `${id}.idle`);
  const paused = () => fs.access(at('state', 'PAUSED.json')).then(() => true, error => error.code !== 'ENOENT');
  let next = 0;
  let relayed;
  let active;
  let idle = null;
  let lease;
  let stopped = false;
  const show = async (target, phase, code = null, requestId = null) => {
    const view = { targetVersion: target.version, grantId: target.grant_id, phase, code, requestId,
      targetFingerprint: targetFingerprint(target),
      ...(phase === 'NEEDS_REINSTALL' && needsSeal(target) ? {
        reinstall: { repository: target.repository, archiveSha256: target.archive_sha256,
          requestSha256: target.request_sha256, acceptanceSha256: target.acceptance_sha256 },
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
            else await show(latest, 'NEEDS_REINSTALL', codeOf(answer, 'FLEET_NEEDS_REINSTALL'));
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
      const id = last?.phase === 'REQUESTED' && last.requestId;
      if (!UUID.test(id ?? '')) return;
      const ping = await read(challenge(id));
      if (ping?.requestId !== id || !UUID.test(ping.nonce ?? '') || !Number.isSafeInteger(ping.expiresAt)
        || ping.expiresAt <= clock() || await fs.access(confirmation(id)).then(() => true, () => false)) return;
      const latest = await observe();
      const op = (await read(at('upgrade', 'status.json')))?.op;
      const confirmed = canStart?.queueEmpty === true && latest?.onDuty === true && !MOVING.has(op?.state)
        && matchesFleetTarget(last.targetFingerprint, latest.fleetTarget)
        && matchesFleetTarget(ping.targetFingerprint, latest.fleetTarget) && !(await paused()) && !stopped;
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
        if (view && !(last?.grantId === view.fleetTarget.grant_id && last.requestId))
          await show(view.fleetTarget, 'PREPARE_FAILED', codeOf(error, 'FLEET_PREPARE_FAILED')).catch(() => {});
      }).finally(() => { active = null; });
      return active;
    },
    stop() { stopped = true; },
  };
}
