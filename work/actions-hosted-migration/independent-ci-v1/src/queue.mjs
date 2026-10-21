// Service-owned state only: never place this directory in a candidate checkout
// or expose these methods to job code. ACL/service qualification is a deployment
// prerequisite. This module uses no network, shell, GitHub writer or credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const JOB_CONTRACT = 'clued.independent-ci.job/1';
const STATE_CONTRACT = 'clued.independent-ci.queue/1';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ROLE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const JOB_FIELDS = ['contract', 'id', 'repo', 'pr', 'headSha', 'baseSha', 'claimId', 'fence', 'epoch', 'role', 'sourceManifestSha256', 'createdAt', 'attempt'];
const OBS_FIELDS = ['repo', 'pr', 'headSha', 'baseSha', 'claimId', 'fence', 'epoch', 'sourceManifestSha256', 'observedAt', 'claimExpiresAt', 'admitted', 'open', 'mergeEligible'];
const IDENTITY = ['repo', 'pr', 'headSha', 'baseSha', 'claimId', 'fence', 'epoch', 'sourceManifestSha256'];
const defaults = Object.freeze({ maxJobs: 1000, maxOutbox: 1000, maxAttempts: 3, maxConcurrent: 1,
  maxJournalBytes: 64 * 1024 * 1024, maxLeaseMs: 60_000, observationMaxAgeMs: 30_000 });
const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const keyOf = ({ repo, pr }) => `${repo}#${pr}`;
const same = (a, b) => IDENTITY.every(key => a?.[key] === b?.[key]);

export function jobId(job) {
  return hash(JSON.stringify([...IDENTITY, 'role'].map(key => job[key])));
}

export function validateJob(job) {
  if (!exact(job, JOB_FIELDS) || job.contract !== JOB_CONTRACT || !DIGEST.test(job.id)
    || !REPO.test(job.repo) || !positive(job.pr) || !SHA.test(job.headSha) || !SHA.test(job.baseSha)
    || !UUID.test(job.claimId) || !positive(job.fence) || !positive(job.epoch) || !ROLE.test(job.role)
    || !DIGEST.test(job.sourceManifestSha256) || !iso(job.createdAt) || !positive(job.attempt)
    || job.id !== jobId(job)) fail('invalid_job');
  return job;
}

export function validateObservation(value) {
  if (!exact(value, OBS_FIELDS) || !REPO.test(value.repo) || !positive(value.pr)
    || !SHA.test(value.headSha) || !SHA.test(value.baseSha) || !UUID.test(value.claimId)
    || !positive(value.fence) || !positive(value.epoch) || !DIGEST.test(value.sourceManifestSha256)
    || !iso(value.observedAt) || !iso(value.claimExpiresAt)
    || ['admitted', 'open', 'mergeEligible'].some(key => typeof value[key] !== 'boolean')) fail('invalid_observation');
  return value;
}

async function ordinaryFile(filename, allowMissing = true) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('unsafe_state_file');
    return stat;
  } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
}

async function exclusiveFile(filename, value) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
}

async function takeLock(directory, recoverDeadOwner) {
  const filename = path.join(directory, 'owner.lock');
  const owner = { contract: 'clued.independent-ci.lock/1', pid: process.pid, host: os.hostname(), token: randomUUID() };
  try { await exclusiveFile(filename, owner); return owner; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!recoverDeadOwner) fail('queue_locked');
  // Recovery itself is exclusive. A crash here deliberately requires operator
  // investigation; timestamps and expired leases are never proof of process death.
  const recovery = path.join(directory, 'recovery.lock');
  try { await exclusiveFile(recovery, owner); }
  catch (error) { if (error.code === 'EEXIST') fail('queue_recovery_locked'); throw error; }
  try {
    await ordinaryFile(filename, false);
    const prior = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (prior.contract !== owner.contract || prior.host !== owner.host || !positive(prior.pid) || !UUID.test(prior.token)) fail('invalid_queue_lock');
    try { process.kill(prior.pid, 0); fail('queue_owner_alive'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    // No other recoverer can replace this lock while recovery.lock is held.
    if (JSON.parse(await fs.readFile(filename, 'utf8')).token !== prior.token) fail('queue_lock_changed');
    await fs.unlink(filename);
    await exclusiveFile(filename, owner);
    return owner;
  } finally { await fs.unlink(recovery); }
}

export class PersistentQueue {
  static async open({ directory, limits = {}, clock = Date.now, recoverDeadOwner = false } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof clock !== 'function') fail('invalid_queue_configuration');
    if (Object.keys(limits).some(key => !Object.hasOwn(defaults, key))) fail('invalid_queue_limits');
    const effective = { ...defaults, ...limits };
    if (Object.values(effective).some(value => !positive(value))) fail('invalid_queue_limits');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_queue_directory');
    const owner = await takeLock(directory, recoverDeadOwner);
    const queue = new PersistentQueue(directory, effective, clock, owner);
    try { await queue._load(); return queue; }
    catch (error) { await queue.close(); throw error; }
  }

  constructor(directory, limits, clock, owner) {
    this.directory = directory; this.limits = limits; this.clock = clock; this.owner = owner;
    this.filename = path.join(directory, 'journal.jsonl'); this.tail = Promise.resolve();
    this.state = { contract: STATE_CONTRACT, seq: 0, lastNow: 0, jobs: {}, observations: {}, outbox: [], mergeSlot: null };
    this.bytes = 0; this.closed = false; this.poisoned = false;
  }

  async _load() {
    await ordinaryFile(this.filename);
    const text = await fs.readFile(this.filename, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (Buffer.byteLength(text) > this.limits.maxJournalBytes) fail('journal_limit');
    let consumed = 0;
    for (const line of text.split('\n').slice(0, -1)) {
      if (!line) fail('corrupt_queue_journal');
      let record;
      try { record = JSON.parse(line); } catch { fail('corrupt_queue_journal'); }
      if (!record.state || record.sha256 !== hash(JSON.stringify(record.state)) || record.state.contract !== STATE_CONTRACT
        || record.state.seq !== this.state.seq + 1) fail('corrupt_queue_journal');
      this.state = record.state; consumed += Buffer.byteLength(line + '\n');
    }
    this.bytes = consumed;
    // Only an incomplete final append may be discarded. An acknowledged record
    // ends in a newline and is fsynced before a caller receives its lease.
    if (consumed !== Buffer.byteLength(text)) await fs.truncate(this.filename, consumed);
    this.handle = await fs.open(this.filename, 'a', 0o600);
    if (Object.keys(this.state.jobs).length > this.limits.maxJobs || this.state.outbox.length > this.limits.maxOutbox) fail('state_limit');
    for (const entry of Object.values(this.state.jobs)) validateJob(entry.job);
    // A coordinator restart cannot prove that a child worker stopped. Keep its
    // reservation until the protected service supplies stop evidence.
    if (Object.values(this.state.jobs).some(entry => entry.status === 'running')) {
      await this._change(state => { for (const entry of Object.values(state.jobs)) if (entry.status === 'running') entry.status = 'uncertain'; });
    }
  }

  _now(state) {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < state.lastNow) fail('queue_clock_regressed');
    state.lastNow = value; return value;
  }

  _current(state, job, now) {
    const observation = state.observations[keyOf(job)];
    return same(job, observation) && observation.admitted && observation.open
      && Date.parse(observation.claimExpiresAt) > now && Date.parse(observation.observedAt) <= now
      && now - Date.parse(observation.observedAt) <= this.limits.observationMaxAgeMs;
  }

  _expire(state, now) {
    for (const entry of Object.values(state.jobs)) {
      if (['queued', 'running', 'succeeded', 'failed'].includes(entry.status) && !this._current(state, entry.job, now)) {
        entry.status = 'invalidated'; entry.invalidReason = 'current_authorization_changed';
      } else if (entry.status === 'running' && entry.lease.expiresAt <= now) entry.status = 'uncertain';
    }
    for (const intent of state.outbox) {
      if (intent.status === 'pending' && !this._current(state, intent.identity, now)) intent.status = 'invalidated';
    }
    if (state.mergeSlot && !this._current(state, state.mergeSlot.identity, now)) state.mergeSlot = null;
  }

  _change(operation) {
    const pending = this.tail.then(async () => {
      if (this.closed || this.poisoned) fail('queue_unavailable');
      const currentOwner = JSON.parse(await fs.readFile(path.join(this.directory, 'owner.lock'), 'utf8'));
      if (currentOwner.token !== this.owner.token) fail('queue_lock_lost');
      const state = copy(this.state); const now = this._now(state); this._expire(state, now);
      const result = operation(state, now);
      if (result?.then) fail('async_queue_transaction');
      state.seq++;
      const encoded = JSON.stringify({ state, sha256: hash(JSON.stringify(state)) }) + '\n';
      if (this.bytes + Buffer.byteLength(encoded) > this.limits.maxJournalBytes) fail('journal_limit');
      try {
        await this.handle.writeFile(encoded); await this.handle.sync();
      } catch (error) { this.poisoned = true; throw error; }
      this.bytes += Buffer.byteLength(encoded); this.state = state;
      return copy(result);
    });
    this.tail = pending.catch(() => {}); return pending;
  }

  observe(observation) {
    validateObservation(observation);
    return this._change((state, now) => {
      if (Date.parse(observation.observedAt) > now || now - Date.parse(observation.observedAt) > this.limits.observationMaxAgeMs) fail('stale_observation');
      const prior = state.observations[keyOf(observation)];
      if (prior && Date.parse(prior.observedAt) > Date.parse(observation.observedAt)) fail('observation_regressed');
      state.observations[keyOf(observation)] = copy(observation); this._expire(state, now);
      return observation;
    });
  }

  enqueue(job) {
    validateJob(job);
    return this._change((state, now) => {
      if (!this._current(state, job, now) || job.attempt !== 1) fail('job_not_current');
      const existing = state.jobs[job.id];
      if (existing) {
        // A lost API observation retires its results. Restored authority may
        // schedule a new bounded attempt only after the prior worker stopped.
        if (existing.status === 'invalidated' && existing.lease === null && existing.job.attempt < this.limits.maxAttempts) {
          existing.job.attempt++; existing.status = 'queued'; existing.result = null; existing.invalidReason = null;
        }
        return existing;
      }
      if (Object.keys(state.jobs).length >= this.limits.maxJobs) fail('job_limit');
      return state.jobs[job.id] = { job: copy(job), status: 'queued', lease: null, result: null, invalidReason: null };
    });
  }

  claim({ workerId, leaseMs = this.limits.maxLeaseMs } = {}) {
    if (typeof workerId !== 'string' || !ROLE.test(workerId) || !positive(leaseMs) || leaseMs > this.limits.maxLeaseMs) fail('invalid_worker_lease');
    return this._change((state, now) => {
      // Uncertain or invalidated-but-not-stopped workers still consume capacity.
      const occupied = Object.values(state.jobs).filter(entry => entry.lease !== null).length;
      if (occupied >= this.limits.maxConcurrent) return null;
      const entry = Object.values(state.jobs).find(value => value.status === 'queued' && value.lease === null && this._current(state, value.job, now));
      if (!entry) return null;
      const observation = state.observations[keyOf(entry.job)];
      entry.status = 'running'; entry.lease = { token: randomUUID(), workerId,
        expiresAt: Math.min(now + leaseMs, Date.parse(observation.claimExpiresAt), Date.parse(observation.observedAt) + this.limits.observationMaxAgeMs) };
      return entry;
    });
  }

  heartbeat({ id, token, leaseMs = this.limits.maxLeaseMs } = {}) {
    if (!positive(leaseMs) || leaseMs > this.limits.maxLeaseMs) fail('invalid_worker_lease');
    return this._change((state, now) => {
      const entry = state.jobs[id];
      if (!entry || entry.status !== 'running' || entry.lease?.token !== token || !this._current(state, entry.job, now)) fail('worker_lease_stale');
      const observation = state.observations[keyOf(entry.job)];
      entry.lease.expiresAt = Math.min(now + leaseMs, Date.parse(observation.claimExpiresAt), Date.parse(observation.observedAt) + this.limits.observationMaxAgeMs);
      return entry;
    });
  }

  complete({ id, token, result } = {}) {
    if (!exact(result, ['conclusion', 'evidenceSha256']) || !['success', 'failure'].includes(result.conclusion) || !DIGEST.test(result.evidenceSha256)) fail('invalid_job_result');
    return this._change((state, now) => {
      const entry = state.jobs[id];
      if (!entry || entry.status !== 'running' || entry.lease?.token !== token || !this._current(state, entry.job, now)) fail('worker_lease_stale');
      entry.result = { ...copy(result), completedAt: new Date(now).toISOString() };
      entry.status = result.conclusion === 'success' ? 'succeeded' : 'failed'; entry.lease = null;
      return entry;
    });
  }

  confirmStopped({ id, token, evidenceSha256 } = {}) {
    if (!DIGEST.test(evidenceSha256)) fail('stop_evidence_required');
    return this._change((state, now) => {
      const entry = state.jobs[id];
      if (!entry || !['uncertain', 'invalidated'].includes(entry.status) || entry.lease?.token !== token) fail('worker_stop_not_pending');
      entry.stopEvidenceSha256 = evidenceSha256; entry.lease = null;
      if (entry.status === 'uncertain' && this._current(state, entry.job, now)) {
        if (entry.job.attempt >= this.limits.maxAttempts) { entry.status = 'failed'; entry.invalidReason = 'attempt_limit'; }
        else { entry.job.attempt++; entry.status = 'queued'; }
      } else entry.status = 'invalidated';
      return entry;
    });
  }

  reconcileExpired() { return this._change(state => Object.values(state.jobs)); }

  invalidatePr({ repo, pr, reason = 'observation_unavailable' } = {}) {
    if (!REPO.test(repo) || !positive(pr) || !ROLE.test(reason)) fail('invalid_invalidation');
    return this._change(state => {
      const observation = state.observations[keyOf({ repo, pr })];
      if (observation) { observation.admitted = false; observation.mergeEligible = false; }
      for (const entry of Object.values(state.jobs)) if (entry.job.repo === repo && entry.job.pr === pr) {
        entry.status = 'invalidated'; entry.invalidReason = reason;
      }
      for (const intent of state.outbox) if (intent.identity.repo === repo && intent.identity.pr === pr) intent.status = 'invalidated';
      if (state.mergeSlot?.identity.repo === repo && state.mergeSlot.identity.pr === pr) state.mergeSlot = null;
      return true;
    });
  }

  acquireMergeSlot({ repo, pr, jobIds } = {}) {
    return this._change((state, now) => {
      if (!Array.isArray(jobIds) || !jobIds.length || new Set(jobIds).size !== jobIds.length) fail('merge_jobs_required');
      const entries = jobIds.map(id => state.jobs[id]);
      const first = entries[0]?.job;
      if (!first || first.repo !== repo || first.pr !== pr || entries.some(entry => !entry || entry.status !== 'succeeded'
        || !same(entry.job, first) || !this._current(state, entry.job, now)) || !state.observations[keyOf(first)].mergeEligible) fail('merge_not_current');
      if (state.mergeSlot && !same(state.mergeSlot.identity, first)) return null;
      if (!state.mergeSlot) state.mergeSlot = { token: randomUUID(), identity: Object.fromEntries(IDENTITY.map(field => [field, first[field]])), jobIds: [...jobIds] };
      return state.mergeSlot;
    });
  }

  appendIntent({ kind, slotToken } = {}) {
    return this._change((state, now) => {
      const slot = state.mergeSlot;
      if (kind !== 'merge' || !slot || slot.token !== slotToken || !this._current(state, slot.identity, now)) fail('merge_slot_stale');
      if (slot.jobIds.some(id => state.jobs[id]?.status !== 'succeeded')) fail('merge_results_stale');
      const id = hash(JSON.stringify([kind, slot.identity, slot.jobIds.map(id => [id,
        state.jobs[id].job.attempt, state.jobs[id].result.evidenceSha256])]));
      const existing = state.outbox.find(intent => intent.id === id);
      if (existing) return existing;
      if (state.outbox.length >= this.limits.maxOutbox) fail('outbox_limit');
      const intent = { contract: 'clued.independent-ci.intent/1', id, kind, identity: copy(slot.identity),
        jobIds: [...slot.jobIds], createdAt: new Date(now).toISOString(), status: 'pending' };
      state.outbox.push(intent); return intent;
    });
  }

  releaseMergeSlot({ token } = {}) {
    return this._change(state => {
      if (!state.mergeSlot || state.mergeSlot.token !== token) fail('merge_slot_stale');
      state.mergeSlot = null; return true;
    });
  }

  async snapshot() { await this.tail; if (this.closed || this.poisoned) fail('queue_unavailable'); return copy(this.state); }

  async close() {
    await this.tail;
    if (this.closed) return;
    this.closed = true;
    if (this.handle) await this.handle.close();
    const filename = path.join(this.directory, 'owner.lock');
    const current = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (current.token !== this.owner.token) fail('queue_lock_lost');
    await fs.unlink(filename);
  }
}
