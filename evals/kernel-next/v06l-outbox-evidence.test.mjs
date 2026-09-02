import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryDurableOutbox,
  InMemoryKernelOutboxDeduper,
  scrubEvidence,
  scrubEvidenceChunks,
} from "../../kernel/runtime/durable-outbox-evidence.mjs";

const digest = (char) => "sha256:" + char.repeat(64);
const intent = (overrides = {}) => ({
  outbox_event_id: "outbox-1",
  tenant_id: "tenant-a",
  attempt_id: "attempt-1",
  action_id: "action-1",
  plan_hash: digest("a"),
  segment_hash: digest("b"),
  lease_id: "lease-1",
  lease_version: 1,
  fencing_stream_id: "fence-stream-1",
  fencing_token: 8,
  ownership_epoch: 3,
  target_idempotency_key: "target-idem-1",
  expected_commit_boundary: "external_request_accepted",
  durable_barrier_passed: true,
  ...overrides,
});

test("V06-OUTBOX-01 stable logical ID/hash deduplicates across sessions without duplicate canonical work", () => {
  const outbox = new InMemoryDurableOutbox({
    max_outbox_bytes: 10000,
    reserved_bytes: 100,
  });
  const first = outbox.beginAction(intent());
  assert.equal(first.replay, false);
  assert.equal(outbox.beginAction(intent()).replay, true);
  outbox.recordCommitBoundary("outbox-1", {
    execution_outcome: "succeeded",
    side_effect_status: "completed",
    correlation: "target-123",
  });

  const deduper = new InMemoryKernelOutboxDeduper();
  const envelope1 = outbox.transmissionEnvelope("outbox-1", {
    session_id: "session-a",
    channel: "results",
    channel_sequence: 1,
  });
  const accepted = deduper.accept("runner-a", envelope1, { canonical_result_id: "result-1" });
  assert.equal(accepted.deduplicated, false);

  const envelope2 = outbox.transmissionEnvelope("outbox-1", {
    session_id: "session-b",
    channel: "results",
    channel_sequence: 1,
  });
  const replayed = deduper.accept("runner-a", envelope2, { canonical_result_id: "must-not-be-used" });
  assert.equal(replayed.deduplicated, true);
  assert.equal(replayed.canonical_result.canonical_result_id, "result-1");
  assert.equal(outbox.acknowledge("outbox-1", envelope2.payload_hash).contiguous_high_water, 0);

  assert.throws(() => outbox.beginAction(intent({ action_id: "action-mutated" })), {
    code: "OUTBOX_ID_HASH_CONFLICT",
  });
});

test("V06-OUTBOX-02 crash recovery reconciles unknown effects; redo requires explicit no-effect proof", () => {
  const outbox = new InMemoryDurableOutbox({
    max_outbox_bytes: 10000,
    reserved_bytes: 100,
  });
  outbox.beginAction(intent());
  assert.deepEqual(outbox.recoveryDisposition("outbox-1"), {
    disposition: "RECONCILE",
    automatic_redo: false,
  });

  outbox.beginAction(intent({
    outbox_event_id: "outbox-safe",
    action_id: "action-safe",
    pre_side_effect_no_effect_proven: true,
  }));
  assert.deepEqual(outbox.recoveryDisposition("outbox-safe"), {
    disposition: "SAFE_REDO_SAME_ACTION_ID",
    automatic_redo: true,
  });
  assert.throws(() => new InMemoryDurableOutbox({
    max_outbox_bytes: 50,
    reserved_bytes: 49,
  }).beginAction(intent()), { code: "OUTBOX_BACKPRESSURE" });
});

test("V06-EVIDENCE-01 fields, raw values and encoded derivatives scrub before persistence", () => {
  const secret = "topsecret";
  const encoded = Buffer.from(secret).toString("base64");
  const result = scrubEvidence({
    access_token: secret,
    message: "raw=" + secret + " encoded=" + encoded,
    nested: { authorization: "Bearer " + secret },
  }, {
    max_input_bytes: 10000,
    max_secret_patterns: 10,
    secret_patterns: [secret],
  });
  assert.equal(result.evidence_status, "complete");
  const persisted = JSON.stringify(result.scrubbed_payload);
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes(encoded), false);
  assert.equal(result.original_persisted, false);
});

test("V06-EVIDENCE-02 cross-chunk secrets scrub; budget or unreliable processing yields incomplete evidence", () => {
  const result = scrubEvidenceChunks(["before-top", "secret-after"], {
    max_input_bytes: 10000,
    max_secret_patterns: 4,
    secret_patterns: ["topsecret"],
  });
  assert.equal(result.evidence_status, "complete");
  assert.equal(JSON.stringify(result.scrubbed_payload).includes("topsecret"), false);

  const incomplete = scrubEvidence({ message: "x".repeat(100) }, {
    max_input_bytes: 10,
    max_secret_patterns: 4,
    secret_patterns: ["secret"],
  });
  assert.equal(incomplete.evidence_status, "incomplete");
  assert.equal(incomplete.scrubbed_payload, null);
  assert.equal(incomplete.original_persisted, false);
});
