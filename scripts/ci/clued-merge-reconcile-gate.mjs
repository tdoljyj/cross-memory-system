// Source-bound cutover routing only, never a Grant or Host qualification.
// The candidate stays off. An accepted on successor may be installed only
// after the old automatic entry points are guarded, in-flight work drains,
// and unknown old operations have been reconciled through their real ports.
import fs from 'node:fs';

export const ACTIVATION_CONTRACT = 'clued.merge-reconcile-activation/1';
export const ACTIVATION_FILE = new URL('./clued-merge-reconcile-activation.json', import.meta.url);
const durable = new WeakSet();

// This marks a function produced by the qualified route's durable wrapper.
// It proves program structure only. Current credentials, exact Source, Host,
// epoch, FIFO, Owner and Native permission remain separate runtime gates.
export function markDurableFetch(fn) {
  if (typeof fn !== 'function') throw Error('MERGE_RECONCILE_DURABLE_FETCH_REQUIRED');
  durable.add(fn);
  return fn;
}
export function isDurableFetch(fn) { return typeof fn === 'function' && durable.has(fn); }

// Always the module's own accepted source, never caller workspace, event or
// environment input. Missing/corrupt/unknown activation is a closed gate,
// not an implicit return to two independent automatic mutation routes.
export function readReconcileActivation() {
  try {
    const raw = fs.readFileSync(ACTIVATION_FILE);
    if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > 1024) throw Error();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('|') !== 'contract|enabled'
      || value.contract !== ACTIVATION_CONTRACT || typeof value.enabled !== 'boolean') throw Error();
    return Object.freeze({ contract: ACTIVATION_CONTRACT, enabled: value.enabled });
  } catch { throw Error('MERGE_RECONCILE_ACTIVATION_INVALID'); }
}

export function automaticExecutorGate(fetchImpl) {
  if (!readReconcileActivation().enabled || isDurableFetch(fetchImpl)) return null;
  return { state: 'DELEGATED', heads: [], actions: [], errors: [],
    notices: ['Automatic merge execution is delegated to the durable reconciliation controller.'] };
}
