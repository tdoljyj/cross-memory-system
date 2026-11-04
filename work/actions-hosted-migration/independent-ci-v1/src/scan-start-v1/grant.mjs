// Closed public Native grant. This records a burned launch permission, never
// proof that a scanner process actually started. No credential or I/O here.
const CODE = 'SCAN_START_GRANT_REFUSED', windows = new WeakMap();
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const FIELDS = ['status', 'contract', 'launch_allowed', 'execution_id', 'receipt_id', 'repository_id', 'head_sha', 'role', 'provider', 'start_requested_at'];
const fail = () => { throw Object.assign(new Error(CODE), { code: CODE }); };
const check = value => { if (!value) fail(); };
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function validateScanStartGrant(value, { job, executionId, repositoryId = 1334673495 } = {}) {
  try {
    check(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
    const d = Object.getOwnPropertyDescriptors(value);
    check(Reflect.ownKeys(d).length === FIELDS.length && FIELDS.every(k => d[k] && Object.hasOwn(d[k], 'value') && d[k].enumerable));
    const g = Object.fromEntries(FIELDS.map(k => [k, d[k].value]));
    check(job?.repo === 'tdoljyj/cross-memory-system' && typeof executionId === 'string' && UUID.test(executionId)
      && repositoryId === 1334673495 && g.status === 'committed' && g.contract === 'clued.ci-scan-start-grant/1'
      && g.launch_allowed === true && g.execution_id === executionId && typeof g.receipt_id === 'string' && UUID.test(g.receipt_id)
      && g.repository_id === repositoryId && typeof job.headSha === 'string' && /^[a-f0-9]{40}$/.test(job.headSha)
      && g.head_sha === job.headSha && ['gitleaks', 'trivy', 'contract-placement'].includes(job.role) && g.role === job.role
      && g.provider === 'independent-controller' && iso(g.start_requested_at));
    return Object.freeze(g);
  } catch { fail(); }
}
// Window metadata is attached only by the Linux bridge after validateResponse.
// Native UTC is never compared with host time; the response's host issuance and
// deadline govern transport freshness, as for existing admission callbacks.
export function noteScanStartResponseWindow(grant, response) {
  try {
    const d = Object.getOwnPropertyDescriptors(grant);
    const g = validateScanStartGrant(grant, { job: { repo: 'tdoljyj/cross-memory-system', headSha: d.head_sha?.value, role: d.role?.value },
      executionId: d.execution_id?.value });
    check(response && iso(response.issuedAt) && iso(response.expiresAt));
    const start = Date.parse(response.issuedAt), end = Date.parse(response.expiresAt);
    check(end > start && end - start <= 120000);
    windows.set(g, { start, end }); return g;
  } catch { fail(); }
}
export function requireFreshScanStartGrant(job, grant, now = Date.now()) {
  const w = windows.get(grant);
  check(w && Number.isSafeInteger(now) && now >= w.start && now < w.end);
  return validateScanStartGrant(grant, { job, executionId: grant.execution_id });
}

// Whether a resident role must take its one Native scan-start permission
// before it launches (Task 169fd456). Production has no active scan-start
// policy yet: Native execution activation and that policy are a separate,
// gated, irreversible cutover. Until then this Source starts its scanners as
// Sources before 36b8046a did: no Native call, and the bridge issue id is the
// execution id (Native would have granted exactly that id). The Source that
// is installed together with the activation sets this to true; nothing at
// run time can switch it.
export const NATIVE_SCAN_START_REQUIRED = false;
const LOCAL_CONTRACT = 'clued.ci-scan-start-not-required/1';
const LOCAL_FIELDS = ['contract', 'native', 'execution_id', 'head_sha', 'role'];
export function localScanStart(job, executionId) {
  try {
    check(typeof executionId === 'string' && UUID.test(executionId) && typeof job?.headSha === 'string'
      && /^[a-f0-9]{40}$/.test(job.headSha) && ['gitleaks', 'trivy', 'contract-placement'].includes(job.role));
    return Object.freeze({ contract: LOCAL_CONTRACT, native: false, execution_id: executionId, head_sha: job.headSha, role: job.role });
  } catch { fail(); }
}
function validateLocalScanStart(value, job) {
  try {
    check(value !== null && typeof value === 'object' && Object.isFrozen(value));
    const d = Object.getOwnPropertyDescriptors(value);
    check(Reflect.ownKeys(d).length === LOCAL_FIELDS.length && LOCAL_FIELDS.every(k => d[k] && Object.hasOwn(d[k], 'value') && d[k].enumerable));
    check(value.contract === LOCAL_CONTRACT && value.native === false && typeof value.execution_id === 'string' && UUID.test(value.execution_id)
      && value.head_sha === job?.headSha && value.role === job?.role);
    return value;
  } catch { fail(); }
}
// What an adapter checks before (and again right before) its first scanner:
// a fresh Native grant when the Source requires one, otherwise only the local
// start of this exact job. A Native grant is refused in local mode and a local
// start is refused in Native mode, so the two can never be mixed.
export function scanStartPermission(job, value, nativeRequired = NATIVE_SCAN_START_REQUIRED, now = Date.now()) {
  return nativeRequired === true ? requireFreshScanStartGrant(job, value, now) : validateLocalScanStart(value, job);
}
