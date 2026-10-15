import fs from "node:fs/promises";
import { lstatSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseDailyLedger } from "./resource-center-daily-job.mjs";

const fail = code => { throw new Error(code); };
const digest = value => createHash("sha256").update(value).digest("hex");
const uuid = value => /^[0-9a-f-]{36}$/.test(value ?? "");
const ttl = 24 * 60 * 60 * 1000;
export function assertResourceCenterNotStopped(directory) {
  try { lstatSync(path.join(directory, "renewal-stop.json"));fail("DAILY_RENEWAL_STOPPED"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
}
/** Synchronous check immediately before network dispatch, including after an
 * asynchronously refreshed Google credential. Already-dispatched I/O is not
 * cancelled or described as rolled back by a later stop. */
export function guardedResourceCenterFetch(directory, fetchImpl = fetch) {
  return (url, options) => { assertResourceCenterNotStopped(directory);return fetchImpl(url, options); };
}

/** Whole Host invocation lock, acquired BEFORE loading any credentials. It is
 * additional to, and never clears, the existing executor/recovery fences. */
export async function withResourceCenterLifecycle(directory, action) {
  const st = await fs.lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) fail("DAILY_LIFECYCLE_UNSAFE");
  const filename = path.join(directory, "lifecycle.lock");
  const lock = await fs.open(filename, "wx");
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));await lock.sync();
    return await action();
  } finally { await lock.close();await fs.unlink(filename); }
}

/** Append-only DPAPI journal, pre-provisioned and identity-pinned by operator.
 * Each row is a COMPLETE sealed state; interrupted rows stop, never truncate.
 * Keeping prior states preserves recovery secrets without exposing them. */
export async function openRenewalStore(filename, identity, { seal, unseal }) {
  const st = await fs.lstat(filename);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.dev !== identity?.dev || st.ino !== identity?.ino ||
    st.size > 16 * 1024 * 1024) fail("DAILY_RENEWAL_STORE_UNSAFE");
  const handle = await fs.open(filename, "r+");
  const opened = await handle.stat();
  if (opened.dev !== st.dev || opened.ino !== st.ino || opened.nlink !== 1) { await handle.close();fail("DAILY_RENEWAL_STORE_UNSAFE"); }
  let current;
  try {
    const text = await handle.readFile("utf8");
    if (!text.endsWith("\n")) fail("DAILY_RENEWAL_STORE_INCOMPLETE");
    for (const line of text.trimEnd().split("\n")) {
      const state = await unseal(line);
      if (state.contract !== "clued.resource-center-renewal-state/1" || state.sequence !== (current?.sequence ?? -1) + 1 ||
        !["active", "pending", "stopped"].includes(state.phase) || (current?.phase === "stopped" && state.phase !== "stopped") ||
        (current && (state.profile_id !== current.profile_id || state.grant_id !== current.grant_id))) fail("DAILY_RENEWAL_STORE_CORRUPT");
      current = state;
    }
  } catch (e) { await handle.close();throw e; }
  return {
    read: () => structuredClone(current),
    append: async state => {
      const next = { ...state, contract: "clued.resource-center-renewal-state/1", sequence: current.sequence + 1 };
      const ciphertext = await seal(next);
      if (!/^[A-Za-z0-9+/=]+$/.test(ciphertext) || !isDeepStrictEqual(await unseal(ciphertext), next)) fail("DAILY_RENEWAL_SEAL_FAILED");
      await handle.writeFile(ciphertext + "\n");await handle.sync();
      // Verify the durable bytes using a separate open before any remote effect.
      const readback = (await fs.readFile(filename, "utf8")).trimEnd().split("\n").at(-1);
      if (readback !== ciphertext || !isDeepStrictEqual(await unseal(readback), next)) fail("DAILY_RENEWAL_READBACK_FAILED");
      current = next;
    },
    close: () => handle.close(),
  };
}

export function activeRenewalCredentials(state, profileId, now = Date.now()) {
  if (state.phase !== "active" || state.profile_id !== profileId || !uuid(state.grant_id) ||
    !Number.isSafeInteger(state.generation) || state.generation < 0 ||
    !/^clued_rcr_[a-f0-9]{64}$/.test(state.renewal ?? "") || !Number.isFinite(Date.parse(state.expires_at)) ||
    Date.parse(state.expires_at) <= now || Date.parse(state.expires_at) - now > ttl + 60000) fail("DAILY_RENEWAL_NOT_ACTIVE");
  return { profile_id: profileId, reader: state.reader, writer: state.writer, expires_at: state.expires_at };
}

export async function callRenewal(token, request, fetchImpl = fetch) {
  const response = await fetchImpl("https://kooyumi.pixelgrav.com/v1/resource-center/renew", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ contract: "clued.resource-center-renewal/1", request }),
  });
  if (!response.ok) fail(response.status === 403 ? "DAILY_RENEWAL_DENIED" : "DAILY_RENEWAL_UNAVAILABLE");
  const result = await response.json();
  if (!result || Object.keys(result).some(k => !["status", "grant_id", "profile_id", "generation", "expires_at", "receipt_id"].includes(k))) fail("DAILY_RENEWAL_RESPONSE_INVALID");
  return result;
}

/** Monotonic emergency stop does not wait on, clear or append to execution or
 * rotation journals. The immutable FIRST sealed record retains only the
 * original attenuating stop credential after later rotations. */
export async function stopResourceCenter({ directory, filename, identity, unseal, request = callRenewal }) {
  const marker = path.join(directory, "renewal-stop.json");
  try {
    const f = await fs.open(marker, "wx");
    try { await f.writeFile(JSON.stringify({ request_id: randomUUID() }));await f.sync(); } finally { await f.close(); }
  } catch (e) { if (e.code !== "EEXIST") throw e; }
  const ms = await fs.lstat(marker);
  if (!ms.isFile() || ms.isSymbolicLink() || ms.nlink !== 1) fail("DAILY_RENEWAL_STOP_UNCONFIRMED");
  const stopped = JSON.parse(await fs.readFile(marker, "utf8"));
  if (!uuid(stopped.request_id)) fail("DAILY_RENEWAL_STOP_UNCONFIRMED");
  const st = await fs.lstat(filename);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.dev !== identity?.dev || st.ino !== identity?.ino || st.size > 16 * 1024 * 1024) fail("DAILY_RENEWAL_STORE_UNSAFE");
  const bytes = await fs.readFile(filename, "utf8"), end = bytes.indexOf("\n");
  if (end < 0) fail("DAILY_RENEWAL_STOP_UNCONFIRMED");
  const first = await unseal(bytes.slice(0, end));
  if (first.sequence !== 0 || !/^clued_rcr_[a-f0-9]{64}$/.test(first.renewal ?? "")) fail("DAILY_RENEWAL_STOP_UNCONFIRMED");
  const result = await request(first.renewal, { action: "stop", request_id: stopped.request_id });
  if (result.status !== "stopped" || !uuid(result.receipt_id)) fail("DAILY_RENEWAL_STOP_UNCONFIRMED");
  return { status: "stopped", receipt_id: result.receipt_id };
}

/** Called under lifecycle + executor locks. Injected clock/transport are test
 * seams in the trusted Host, never consumer arguments. No provider operation. */
export async function renewResourceCenter({ store, profile_id: profileId, jobs, request = callRenewal, now = Date.now,
  stop = false, notify = async () => {}, assert_active: assertActive = () => {} }) {
  let state = store.read();
  if (state.profile_id !== profileId) fail("DAILY_RENEWAL_PROFILE_MISMATCH");
  if (stop) {
    // Persist local shutdown BEFORE contacting server; keep retrying stop only.
    if (state.phase !== "stopped") { state = { ...state, phase: "stopped", stop_request_id: randomUUID() };await store.append(state); }
    const result = await request(state.renewal, { action: "stop", request_id: state.stop_request_id });
    if (result.status !== "stopped" || !uuid(result.receipt_id)) fail("DAILY_RENEWAL_STOP_UNCONFIRMED");
    await store.append({ ...store.read(), stop_receipt_id: result.receipt_id });return result;
  }
  if (state.phase === "stopped") return { status: "stopped" };
  const ledger = parseDailyLedger(jobs);
  if ([...ledger.values()].some(row => row.profile_id !== profileId || !["finished", "reconciled"].includes(row.state))) fail("DAILY_JOB_RECONCILIATION_REQUIRED");
  if (state.phase === "active") {
    activeRenewalCredentials(state, profileId, now());
    if (Date.parse(state.expires_at) - now() > 2 * 3600000) return { status: "not_due", expires_at: state.expires_at };
    const next = { reader: "clued_rcb_" + randomBytes(32).toString("hex"), writer: "clued_rcw_" + randomBytes(32).toString("hex"), renewal: "clued_rcr_" + randomBytes(32).toString("hex") };
    const exact = { action: "rotate", request_id: randomUUID(), generation: state.generation,
      reader_hash: digest(next.reader), writer_hash: digest(next.writer), renewal_hash: digest(next.renewal) };
    state = { ...state, phase: "pending", next, exact, attempts: 0, retry_after: 0, initiated_at: now() };
    await store.append(state); // all next credentials recoverable before HTTP
  }
  if (state.phase !== "pending" || !uuid(state.exact?.request_id) || !Number.isSafeInteger(state.attempts)) fail("DAILY_RENEWAL_STORE_CORRUPT");
  if (state.attempts >= 5 || now() - state.initiated_at > ttl || now() < state.retry_after) return { status: "needs_attention" };
  state = { ...state, attempts: state.attempts + 1, retry_after: now() + Math.min(60, 2 ** state.attempts) * 60000 };
  await store.append(state); // a crash cannot reset the retry budget
  try {
    assertActive();
    const result = await request(state.renewal, state.exact);
    if (result.status !== "rotated" || result.grant_id !== state.grant_id || result.profile_id !== profileId ||
      result.generation !== state.generation + 1 || !uuid(result.receipt_id) ||
      !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) - now() < 10 * 60000 ||
      Date.parse(result.expires_at) - now() > ttl + 60000) fail("DAILY_RENEWAL_NOT_COMMITTED");
    // Revocation wins over a recovered historical receipt before activation.
    assertActive();
    const live = await request(state.next.renewal, { action: "status", request_id: randomUUID() });
    if (live.status !== "active" || live.grant_id !== result.grant_id || live.generation !== result.generation || live.expires_at !== result.expires_at) fail("DAILY_RENEWAL_NOT_CURRENT");
    const active = { contract: state.contract, profile_id: profileId, grant_id: state.grant_id,
      generation: result.generation, phase: "active", ...state.next, expires_at: result.expires_at, receipt_id: result.receipt_id };
    assertActive();await store.append(active);assertActive();
    return { status: "rotated", generation: result.generation, expires_at: result.expires_at, receipt_id: result.receipt_id };
  } catch {
    await notify("DAILY_RENEWAL_NEEDS_ATTENTION");
    return { status: "needs_attention", attempts: state.attempts };
  }
}
