// Mailbox between the CluedCIResident service (writes requests, reads responses) and the companion
// in the Owner's non-elevated logon session (reads requests, writes responses). Both directions are
// create-only files with exact shapes. Neither side treats the other's records as authority:
// the companion only transports and starts fixed, installed units; every Linux unit re-checks its own
// preconditions as root, and every Windows stage re-checks its own facts as clued-control.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODE, HEX64, UUID, check, exactKeys, isoNow, parseBoundedJson } from './canonical.mjs';
import { ensureDir, exists, readBounded, writeNew } from './store.mjs';

export const REQUEST_CONTRACT = 'clued.independent-ci.resident-companion-request/1';
export const RESPONSE_CONTRACT = 'clued.independent-ci.resident-companion-response/1';
export const HEARTBEAT_CONTRACT = 'clued.independent-ci.resident-companion-heartbeat/1';
export const BATCH_ID = /^[0-9a-f]{16}-[0-9a-f]{12}$/;
const REASON = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ARCHIVE_DIR = /^(failed|archive)-[0-9a-z-]{1,120}$/;
export const KINDS = Object.freeze(['build-bundle', 'prepare-workspaces', 'relay-stage', 'archive-linux', 'linux-quiescence']);

// Exact request shapes per kind; nothing else (no path, argv, env or script) can be carried.
const REQUEST_FIELDS = {
  'build-bundle': ['batchId'],
  'prepare-workspaces': ['batchId'],
  'relay-stage': ['batchId', 'stage', 'jobId'],
  'archive-linux': ['batchId', 'reason'],
  'linux-quiescence': ['batchId'],
};

export function validateRequest(v) {
  check(v && KINDS.includes(v.kind), 'MAILBOX_REQUEST_KIND_REFUSED');
  exactKeys(v, ['contract', 'requestId', 'kind', 'createdAt', 'deadline', ...REQUEST_FIELDS[v.kind]], 'MAILBOX_REQUEST_KEYS_REFUSED');
  check(v.contract === REQUEST_CONTRACT && UUID.test(v.requestId), 'MAILBOX_REQUEST_IDENTITY_REFUSED');
  check(BATCH_ID.test(v.batchId), 'MAILBOX_BATCH_ID_REFUSED');
  check(!Number.isNaN(Date.parse(v.createdAt)) && !Number.isNaN(Date.parse(v.deadline)) && Date.parse(v.deadline) > Date.parse(v.createdAt), 'MAILBOX_REQUEST_TIME_REFUSED');
  if (v.kind === 'relay-stage') check([2, 4, 6].includes(v.stage) && HEX64.test(v.jobId), 'MAILBOX_RELAY_FIELDS_REFUSED');
  if (v.kind === 'archive-linux') check(REASON.test(v.reason), 'MAILBOX_ARCHIVE_REASON_REFUSED');
  return v;
}

const PROOF_KEYS = ['linuxUnitsInactive', 'containersZero'];
export function validateResponse(v, request) {
  exactKeys(v, ['contract', 'requestId', 'kind', 'ok', 'code', 'proof', 'directory', 'verified', 'observedAt'], 'MAILBOX_RESPONSE_KEYS_REFUSED');
  check(v.contract === RESPONSE_CONTRACT && v.requestId === request.requestId && v.kind === request.kind, 'MAILBOX_RESPONSE_IDENTITY_REFUSED');
  check(typeof v.ok === 'boolean' && (v.code === null || (typeof v.code === 'string' && CODE.test(v.code))), 'MAILBOX_RESPONSE_STATUS_REFUSED');
  check(v.proof === null || (exactKeys(v.proof, PROOF_KEYS, 'MAILBOX_RESPONSE_PROOF_REFUSED'), PROOF_KEYS.every(k => typeof v.proof[k] === 'boolean')), 'MAILBOX_RESPONSE_PROOF_REFUSED');
  check(v.directory === null || (typeof v.directory === 'string' && ARCHIVE_DIR.test(v.directory)), 'MAILBOX_RESPONSE_DIRECTORY_REFUSED');
  check(v.verified === null || typeof v.verified === 'boolean', 'MAILBOX_RESPONSE_VERIFIED_REFUSED');
  return v;
}

export class Mailbox {
  constructor(root, clock) {
    this.requests = path.join(root, 'requests');
    this.responses = path.join(root, 'responses');
    // The heartbeat lives in responses/ because that is the one mailbox directory the companion can write.
    this.heartbeatFile = path.join(this.responses, 'heartbeat.json');
    this.clock = clock;
  }

  static async open(root, clock = Date.now) {
    const m = new Mailbox(root, clock);
    await ensureDir(m.requests);
    await ensureDir(m.responses);
    return m;
  }

  // Service side.
  async send(kind, fields, timeoutMs) {
    const now = this.clock();
    const request = validateRequest({ contract: REQUEST_CONTRACT, requestId: randomUUID(), kind, createdAt: new Date(now).toISOString(), deadline: new Date(now + timeoutMs).toISOString(), ...fields });
    await writeNew(path.join(this.requests, `${request.requestId}.json`), request);
    return request;
  }

  async poll(request) {
    const file = path.join(this.responses, `${request.requestId}.json`);
    if (!(await exists(file))) return null;
    return validateResponse(parseBoundedJson(await readBounded(file, 4096, 'MAILBOX_RESPONSE_REFUSED'), 4096, 'MAILBOX_RESPONSE_REFUSED'), request);
  }

  async await(request, sleep, pollMs = 500) {
    while (this.clock() < Date.parse(request.deadline)) {
      const r = await this.poll(request);
      if (r) return r;
      await sleep(pollMs);
    }
    return null; // No answer is never success.
  }

  async heartbeat() {
    if (!(await exists(this.heartbeatFile))) return null;
    try {
      const v = parseBoundedJson(await readBounded(this.heartbeatFile, 512, 'HEARTBEAT_REFUSED'), 512, 'HEARTBEAT_REFUSED');
      exactKeys(v, ['contract', 'at'], 'HEARTBEAT_REFUSED');
      return v.contract === HEARTBEAT_CONTRACT && Number.isSafeInteger(v.at) ? { at: v.at } : null;
    } catch { return null; }
  }

  // Companion side.
  async pending() {
    const out = [];
    for (const name of (await fs.readdir(this.requests)).sort()) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const id = name.slice(0, 36);
      if (await exists(path.join(this.responses, name))) continue;
      try {
        out.push(validateRequest(parseBoundedJson(await readBounded(path.join(this.requests, name), 2048, 'MAILBOX_REQUEST_REFUSED'), 2048, 'MAILBOX_REQUEST_REFUSED')));
      } catch { out.push({ requestId: id, refused: true }); }
    }
    // Oldest first by the service's own createdAt, not by the random request id.
    return out.sort((a, b) => (a.refused || b.refused) ? 0 : Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async respond(request, fields) {
    const response = validateResponse({ contract: RESPONSE_CONTRACT, requestId: request.requestId, kind: request.kind, ok: false, code: null, proof: null, directory: null, verified: null, observedAt: isoNow(this.clock), ...fields }, request);
    await writeNew(path.join(this.responses, `${request.requestId}.json`), response);
    return response;
  }

  async beat() {
    const tmp = `${this.heartbeatFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ contract: HEARTBEAT_CONTRACT, at: this.clock() }));
    await fs.rename(tmp, this.heartbeatFile); // The heartbeat is a liveness hint, not evidence.
  }
}
