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
import { fetchFleetReleaseAsset, sha256File } from '../rollout/fleet/fetch.mjs';

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,88}$/;
const REPO = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const OBSERVATION_AGE = 15 * 60_000;
const RETRY = 60_000;
const LIMIT = 30 * 60_000;
const SMALL = 256 * 1024;
const ARCHIVE_MAX = 512 * 1024 * 1024;
const MOVING = new Set(['WAITING_GRANT', 'WAITING_DRAIN', 'DEFERRED', 'RUNNING', 'ROLLING_BACK']);
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

// An independent companion lane. The download is credentialless. Only the optional upload uses
// the companion's existing GitHub session, and neither its timing nor its result gates the resident.
export function companionSelfPull({ root, repository, clock = Date.now, download = fetchFleetReleaseAsset, upload = async () => {} }) {
  let done = null;
  let next = 0;
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
    const fetch = (name, maxBytes = SMALL) => download({ repository, version: target.version, name, file: path.join(dir, name), maxBytes, deadline });
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
      if (await sha256File(tar).catch(() => null) !== target.archive_sha256) {
        check(await fetch('SHA256SUMS'), 'FLEET_SUMS_MISSING');
        const sums = (await readBounded(path.join(dir, 'SHA256SUMS'), SMALL, 'FLEET_SUMS_REFUSED')).toString('utf8');
        check(sums.split(/\r?\n/).some(line => line === `${target.archive_sha256}  ${files.tar}`), 'FLEET_SUMS_MISMATCH');
        check(await fetch(files.tar, ARCHIVE_MAX), 'FLEET_ARCHIVE_MISSING');
        check(await sha256File(tar) === target.archive_sha256, 'FLEET_ARCHIVE_SHA_MISMATCH');
      }
      await writeObservation(path.join(dir, 'ready.json'), { grantId: target.grant_id });
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
  let next = 0;
  let relayed;
  let active;
  let idle = null;
  let stopped = false;
  const show = async (target, phase, code = null, requestId = null) => {
    const view = { targetVersion: target.version, grantId: target.grant_id, phase, code, requestId };
    if (JSON.stringify(view) !== JSON.stringify(await read(ledger))) await writeObservation(ledger, view);
  };
  async function step() {
    refuseUnderTest(root);
    const view = observationOf(await read(at('broker', 'renew-ci.json')), repository, clock());
    if (JSON.stringify(view) !== relayed) {
      await writeObservation(at('state', 'fleet-target.json'), view);
      relayed = JSON.stringify(view);
    }
    if (!view) return;
    const { fleetTarget: target, onDuty } = view;
    const last = await read(ledger);
    const upgrade = await read(at('upgrade', 'status.json'));
    const op = upgrade?.op;
    if (last?.grantId === target.grant_id && last.requestId) {
      const answer = await read(at('broker', 'responses', `${last.requestId}.json`));
      if (last.phase === 'REQUESTED' && answer?.requestId === last.requestId && answer.delivered === false) {
        if (answer.status === 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE') {
          await show(target, 'CURRENT');
        } else if (answer.status === 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL') {
          await show(target, 'NEEDS_REINSTALL', codeOf(answer, 'FLEET_NEEDS_REINSTALL'));
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
    if (last?.grantId === target.grant_id && ['CURRENT', 'NEEDS_REINSTALL', 'REFUSED'].includes(last.phase)) return;
    if (!idle || (onDuty && !idle.queueEmpty) || stopped || (op && MOVING.has(op.state))
      || await fs.access(at('state', 'PAUSED.json')).then(() => true, () => false)) return;
    const bundle = byTarget(root, target);
    if ((await read(path.join(bundle, 'ready.json')))?.grantId !== target.grant_id) {
      const failure = await read(path.join(bundle, 'download.json'));
      await show(target, 'DOWNLOADING', failure?.code ?? null);
      return;
    }
    const requestBytes = await readBounded(path.join(bundle, names(target).request), SMALL, 'FLEET_REQUEST_REFUSED');
    const acceptance = acceptanceFromTarget(target, requestBytes);
    const source = acceptance.ciSourceManifestSha256;
    if (onDuty && !target.other_sources.every(peer => peer === source)) {
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
    tick(canStart) {
      idle = canStart;
      if (stopped || active || clock() < next) return active;
      active = step().catch(async error => {
        next = clock() + RETRY;
        const view = observationOf(await read(at('broker', 'renew-ci.json')), repository, clock());
        const last = await read(ledger);
        if (view && !(last?.grantId === view.fleetTarget.grant_id && last.requestId))
          await show(view.fleetTarget, 'PREPARE_FAILED', codeOf(error, 'FLEET_PREPARE_FAILED')).catch(() => {});
      }).finally(() => { active = null; });
      return active;
    },
    stop() { stopped = true; },
  };
}
