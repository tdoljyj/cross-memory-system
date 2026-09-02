import { createHash } from "node:crypto";

export class RunnerJournalError extends Error {
  constructor(code) {
    super(code);
    this.name = "RunnerJournalError";
    this.code = code;
  }
}
const clone = (value) => structuredClone(value);
const sha = (value) => "sha256:" + createHash("sha256").update(
  typeof value === "string" ? value : JSON.stringify(value),
).digest("hex");
function reject(code) { throw new RunnerJournalError(code); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
const stableHash = (value) => sha(JSON.stringify(stable(value)));

const SENSITIVE_FIELD = /(?:secret|token|password|authorization|cookie|credential|private[_-]?key|secret[_-]?handle)/i;
function variants(secret) {
  const source = String(secret);
  return [...new Set([
    source,
    Buffer.from(source, "utf8").toString("base64"),
    encodeURIComponent(source),
    Buffer.from(source, "utf8").toString("hex"),
  ])].filter((item) => item.length > 0);
}
function replaceAllLiteral(text, needle) {
  return needle.length === 0 ? text : text.split(needle).join("[REDACTED]");
}
function scrubValue(value, patterns) {
  if (typeof value === "string") {
    let result = value;
    for (const pattern of patterns) result = replaceAllLiteral(result, pattern);
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, patterns));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_FIELD.test(key) ? "[REDACTED]" : scrubValue(item, patterns);
    }
    return output;
  }
  return value;
}

export function scrubEvidence(input, policy) {
  const serialized = JSON.stringify(input);
  const inputBytes = Buffer.byteLength(serialized, "utf8");
  if (!Number.isSafeInteger(policy.max_input_bytes) || inputBytes > policy.max_input_bytes ||
      !Number.isSafeInteger(policy.max_secret_patterns) ||
      policy.secret_patterns.length > policy.max_secret_patterns) {
    return Object.freeze({
      evidence_status: "incomplete",
      reason_code: "scrub_budget_exceeded",
      scrubbed_payload: null,
      original_persisted: false,
    });
  }
  const patterns = policy.secret_patterns.flatMap(variants);
  const scrubbed = scrubValue(clone(input), patterns);
  const scrubbedText = JSON.stringify(scrubbed);
  if (patterns.some((pattern) => scrubbedText.includes(pattern))) reject("SCRUB_FAILED");
  return Object.freeze({
    evidence_status: "complete",
    scrubbed_payload: scrubbed,
    payload_hash: sha(scrubbedText),
    original_persisted: false,
  });
}

export function scrubEvidenceChunks(chunks, policy) {
  if (!Array.isArray(chunks)) reject("EVIDENCE_CHUNKS_INVALID");
  const joined = chunks.join("");
  const result = scrubEvidence({ stream: joined }, policy);
  return Object.freeze({
    ...result,
    chunk_count: chunks.length,
    cross_chunk_matching: true,
  });
}

export class InMemoryDurableOutbox {
  #entries = [];
  #byId = new Map();
  #bytes = 0;
  #highWater = -1;

  constructor(profile) {
    if (!Number.isSafeInteger(profile.max_outbox_bytes) || profile.max_outbox_bytes <= 0 ||
        !Number.isSafeInteger(profile.reserved_bytes) || profile.reserved_bytes < 0) {
      reject("JOURNAL_PROFILE_INVALID");
    }
    this.profile = Object.freeze(clone(profile));
  }

  beginAction(intent) {
    const required = ["outbox_event_id","tenant_id","attempt_id","action_id","plan_hash",
      "segment_hash","lease_id","lease_version","fencing_stream_id","fencing_token",
      "ownership_epoch","target_idempotency_key","expected_commit_boundary"];
    if (required.some((field) => intent[field] === undefined || intent[field] === null)) {
      reject("ACTION_INTENT_INCOMPLETE");
    }
    const safeControlFields = new Set(["fencing_token"]);
    const forbiddenSensitiveField = Object.keys(intent).some((key) =>
      SENSITIVE_FIELD.test(key) && !safeControlFields.has(key));
    if (forbiddenSensitiveField ||
        /bearer\s+|refresh[_-]?token|client[_-]?secret/i.test(JSON.stringify(intent))) {
      reject("JOURNAL_SECRET_FORBIDDEN");
    }
    const logicalPayload = { kind: "action_intent", ...clone(intent) };
    delete logicalPayload.session_id;
    delete logicalPayload.channel;
    delete logicalPayload.channel_sequence;
    const payloadHash = stableHash(logicalPayload);
    const existing = this.#byId.get(intent.outbox_event_id);
    if (existing) {
      if (existing.payload_hash !== payloadHash) reject("OUTBOX_ID_HASH_CONFLICT");
      return Object.freeze({ replay: true, entry: clone(existing) });
    }
    const bytes = Buffer.byteLength(JSON.stringify(logicalPayload), "utf8");
    if (this.#bytes + bytes + this.profile.reserved_bytes > this.profile.max_outbox_bytes) {
      reject("OUTBOX_BACKPRESSURE");
    }
    const entry = {
      index: this.#entries.length,
      outbox_event_id: intent.outbox_event_id,
      payload_hash: payloadHash,
      payload: logicalPayload,
      durable_barrier_passed: intent.durable_barrier_passed === true,
      commit_boundary: null,
      acknowledged: false,
      security_event: false,
      erasure_marker: false,
    };
    if (!entry.durable_barrier_passed) reject("ACTION_INTENT_NOT_DURABLE");
    this.#entries.push(entry);
    this.#byId.set(entry.outbox_event_id, entry);
    this.#bytes += bytes;
    return Object.freeze({ replay: false, entry: clone(entry) });
  }

  recordCommitBoundary(outboxEventId, boundary) {
    const entry = this.#byId.get(outboxEventId);
    if (!entry) reject("ACTION_INTENT_MISSING");
    if (entry.commit_boundary) {
      if (stableHash(entry.commit_boundary) !== stableHash(boundary)) reject("COMMIT_BOUNDARY_CONFLICT");
      return clone(entry.commit_boundary);
    }
    entry.commit_boundary = clone(boundary);
    return clone(entry.commit_boundary);
  }

  recoveryDisposition(outboxEventId) {
    const entry = this.#byId.get(outboxEventId);
    if (!entry) reject("ACTION_INTENT_MISSING");
    if (entry.commit_boundary) return Object.freeze({ disposition: "REPORT_BOUNDARY", automatic_redo: false });
    if (entry.payload.pre_side_effect_no_effect_proven === true) {
      return Object.freeze({ disposition: "SAFE_REDO_SAME_ACTION_ID", automatic_redo: true });
    }
    return Object.freeze({ disposition: "RECONCILE", automatic_redo: false });
  }

  transmissionEnvelope(outboxEventId, { session_id, channel, channel_sequence }) {
    const entry = this.#byId.get(outboxEventId);
    if (!entry || !Number.isSafeInteger(channel_sequence) || channel_sequence < 0) reject("TRANSMISSION_INVALID");
    return Object.freeze({
      runner_outbox_event_id: entry.outbox_event_id,
      payload_hash: entry.payload_hash,
      payload: clone(entry.payload),
      session_id,
      channel,
      channel_sequence,
    });
  }

  acknowledge(outboxEventId, payloadHash) {
    const entry = this.#byId.get(outboxEventId);
    if (!entry || entry.payload_hash !== payloadHash) reject("ACK_MISMATCH");
    entry.acknowledged = true;
    while (this.#entries[this.#highWater + 1]?.acknowledged) this.#highWater += 1;
    return Object.freeze({ acknowledged: true, contiguous_high_water: this.#highWater });
  }

  snapshot() {
    return Object.freeze({
      entries: clone(this.#entries),
      bytes: this.#bytes,
      contiguous_high_water: this.#highWater,
    });
  }
}

export class InMemoryKernelOutboxDeduper {
  #logical = new Map();
  #sequence = new Map();

  accept(runnerId, envelope, canonicalResult) {
    const sequenceKey = [runnerId, envelope.session_id, envelope.channel].join("|");
    const previousSequence = this.#sequence.get(sequenceKey) ?? -1;
    if (!Number.isSafeInteger(envelope.channel_sequence) ||
        envelope.channel_sequence <= previousSequence) reject("TRANSPORT_REPLAY");
    this.#sequence.set(sequenceKey, envelope.channel_sequence);

    const logicalKey = runnerId + "|" + envelope.runner_outbox_event_id;
    const existing = this.#logical.get(logicalKey);
    if (existing) {
      if (existing.payload_hash !== envelope.payload_hash) reject("OUTBOX_ID_HASH_CONFLICT");
      return Object.freeze({
        deduplicated: true,
        canonical_result: clone(existing.canonical_result),
        outbox_event_id: envelope.runner_outbox_event_id,
        payload_hash: envelope.payload_hash,
        session_id: envelope.session_id,
        channel: envelope.channel,
        channel_sequence: envelope.channel_sequence,
      });
    }
    const payloadHash = stableHash(envelope.payload);
    if (payloadHash !== envelope.payload_hash) reject("OUTBOX_PAYLOAD_HASH_INVALID");
    this.#logical.set(logicalKey, {
      payload_hash: envelope.payload_hash,
      canonical_result: clone(canonicalResult),
    });
    return Object.freeze({
      deduplicated: false,
      canonical_result: clone(canonicalResult),
      outbox_event_id: envelope.runner_outbox_event_id,
      payload_hash: envelope.payload_hash,
      session_id: envelope.session_id,
      channel: envelope.channel,
      channel_sequence: envelope.channel_sequence,
    });
  }
}
