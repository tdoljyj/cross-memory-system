import crypto from 'node:crypto';

function invariant(condition, code) {
  if (!condition) { const error = new Error(code); error.code = code; throw error; }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }

export class InMemoryOperationCommitStore {
  #aggregates = new Map();
  #events = [];
  #receipts = new Map();
  #outbox = new Map();
  #operations = new Map();

  commit(command) {
    invariant(command && typeof command === 'object', 'OPERATION_COMMAND_REQUIRED');
    const { operation_id: operationId, aggregate_id: aggregateId, expected_version: expectedVersion } = command;
    invariant(typeof operationId === 'string' && operationId.length > 0, 'OPERATION_ID_INVALID');
    invariant(typeof aggregateId === 'string' && aggregateId.length > 0, 'AGGREGATE_ID_INVALID');
    invariant(Number.isSafeInteger(expectedVersion) && expectedVersion >= 0, 'EXPECTED_VERSION_INVALID');
    invariant(command.next_state && typeof command.next_state === 'object' && !Array.isArray(command.next_state), 'NEXT_STATE_INVALID');
    invariant(command.event && typeof command.event.type === 'string', 'EVENT_INVALID');
    invariant(command.receipt_stub && typeof command.receipt_stub.receipt_id === 'string', 'RECEIPT_STUB_INVALID');
    invariant(Array.isArray(command.outbox) && command.outbox.every((item) => item && typeof item.message_id === 'string' && typeof item.topic === 'string'), 'OUTBOX_INVALID');
    invariant(new Set(command.outbox.map((item) => item.message_id)).size === command.outbox.length, 'OUTBOX_DUPLICATE_MESSAGE');

    const commandDigest = digest(command);
    const previous = this.#operations.get(operationId);
    if (previous) {
      invariant(previous.command_digest === commandDigest, 'OPERATION_IDEMPOTENCY_DRIFT');
      return { ...clone(previous.result), idempotent_replay: true };
    }
    invariant(!this.#receipts.has(command.receipt_stub.receipt_id), 'RECEIPT_ID_DUPLICATE');
    for (const item of command.outbox) invariant(!this.#outbox.has(item.message_id), 'OUTBOX_MESSAGE_ID_DUPLICATE');
    const current = this.#aggregates.get(aggregateId) ?? { version: 0, state: null };
    invariant(current.version === expectedVersion, 'CANONICAL_VERSION_CONFLICT');

    const nextVersion = current.version + 1;
    const eventSequence = this.#events.length + 1;
    const aggregate = { aggregate_id: aggregateId, version: nextVersion, state: clone(command.next_state) };
    const event = { sequence: eventSequence, operation_id: operationId, aggregate_id: aggregateId, aggregate_version: nextVersion, type: command.event.type, payload: clone(command.event.payload ?? null) };
    const receipt = { ...clone(command.receipt_stub), operation_id: operationId, aggregate_id: aggregateId, aggregate_version: nextVersion, event_sequence: eventSequence };
    const outbox = command.outbox.map((item, index) => ({ ...clone(item), operation_id: operationId, event_sequence: eventSequence, order: index + 1, status: 'PENDING' }));
    const result = { operation_id: operationId, aggregate, event, receipt_stub: receipt, outbox };

    this.#aggregates.set(aggregateId, aggregate);
    this.#events.push(event);
    this.#receipts.set(receipt.receipt_id, receipt);
    for (const item of outbox) this.#outbox.set(item.message_id, item);
    this.#operations.set(operationId, { command_digest: commandDigest, result: clone(result) });
    return clone(result);
  }

  snapshot() {
    return clone({
      aggregates: [...this.#aggregates.values()].sort((a, b) => a.aggregate_id.localeCompare(b.aggregate_id)),
      events: this.#events,
      receipt_stubs: [...this.#receipts.values()].sort((a, b) => a.receipt_id.localeCompare(b.receipt_id)),
      outbox: [...this.#outbox.values()].sort((a, b) => a.event_sequence - b.event_sequence || a.order - b.order)
    });
  }
}
