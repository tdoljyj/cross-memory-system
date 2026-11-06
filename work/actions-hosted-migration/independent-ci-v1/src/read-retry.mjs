// Bounded exponential retry of READ-ONLY GitHub requests on a passing server fault (5xx) or a network failure.
//
// Why (11-04, PR #992, head df85e68d, attempt 2, stage 1): GitHub answered 502 to one read inside the work-admission
// publisher's after-write boundary. The check was already on the head, so the publisher withdrew it (REVOKED,
// github_http_502) and the head burned, for a fault that said nothing about the authorization. github.mjs retries only a
// network failure (never an HTTP status), and the evaluator's own GitHub reads (githubJson) not at all.
//
// This wraps the controller's fetch. It repeats a request only when ALL of these hold:
//   - the method is GET (or omitted): a read; or a POST the caller names a read (readPost, generation 11: the Native verify RPC as an
//     ordinary observation, its list actions and the merge-slot holders RPC). Every other write (POST/PATCH) and every other Native
//     RPC passes through untouched, so no write is ever repeated here and no Native receipt is ever written twice;
//   - the answer is a 500, 502, 503 or 504, or the request failed on the network (fetch rejected with a TypeError whose
//     cause is a network code). A 501, a 4xx (including 403 and 429), a redirect and every other refusal is returned as it
//     is: those are not passing faults. A rejection that is not a network fault (abort, timeout, a refusal raised by the
//     caller's own fetch such as the context or stage deadline) is thrown at once.
// Backoff is exponential (delaysMs), the sleeps of all retries together stay inside budgetMs (one wrapper = one stage
// process), and live() is called before every repeat, so a stage past its deadline or stop request never waits here.
// Time limits (review of gen8, finding 4): every attempt has min(attemptTimeoutMs, what is left of the stage's own deadline) as its
// timeout (a repeat used to get a flat 30 s even with 5 s of the lease left), and a wait that would run past that deadline is not started.
// The budget counts the waits (sleeps) only, per wrapper = per stage process, and has two phases: a request that matches resetOn (the
// controller passes: any non-GET on /check-runs, i.e. the check write or its withdrawal) starts a new one. So the reads before the first
// check write (the boundary, the write-ahead probe) cannot use up the retries of the verification after it: each phase has the full budget.
// When the budget or the delays are used up the LAST answer (or error) is returned unchanged: the caller sees the same
// github_http_5xx / transport failure it saw before, and classifies it as it always did.
export const READ_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000]);
export const READ_RETRY_BUDGET_MS = 20_000;
export const RETRYABLE_STATUSES = Object.freeze([500, 502, 503, 504]);
const NETWORK_CODES = Object.freeze(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
export const networkFault = error => error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message) && NETWORK_CODES.includes(error.cause?.code);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// readPost (generation 11, resident DESIGN 55): a POST that is a read by its exact URL and body (the caller decides; the controller
// names the Native verify RPC without an action or with a listed read-only action), repeated like a GET. Every other POST/PATCH passes
// through untouched, as before.
export const READ_REQUEST_DEADLINE = Symbol.for('clued-read-request-deadline');
export const READ_REQUEST_GUARD = Symbol.for('clued-read-request-guard');
export function withReadRetry(fetchImpl, { delaysMs = READ_RETRY_DELAYS_MS, budgetMs = READ_RETRY_BUDGET_MS, attemptTimeoutMs = 30_000, sleep = wait, live = () => {}, onRetry = () => {}, deadlineAt = () => null, resetOn = () => false, readPost = () => false, now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== 'function' || !Array.isArray(delaysMs) || !delaysMs.every(ms => Number.isSafeInteger(ms) && ms > 0)
    || !Number.isSafeInteger(budgetMs) || budgetMs < 0 || typeof sleep !== 'function' || typeof live !== 'function' || typeof deadlineAt !== 'function' || typeof resetOn !== 'function' || typeof readPost !== 'function' || typeof now !== 'function') throw new Error('read_retry_configuration_invalid');
  let spent = 0;
  return async function retryingFetch(url, opts = {}) {
    const method = String(opts?.method ?? 'GET').toUpperCase();
    let read = method === 'GET';
    if (method === 'POST') { try { read = readPost(String(url), opts) === true; } catch { read = false; } }
    if (!read) {
      try { return await fetchImpl(url, opts); } finally { if (resetOn(url, opts)) spent = 0; }
    }
    let lastResponse = null, lastFailure = null;
    for (let attempt = 0; ; attempt++) {
      let response = null, failure = null;
      // What is left of the stage's own deadline (null: not known). An attempt never runs longer than that.
      const stageDeadline = deadlineAt(), requestDeadline = opts[READ_REQUEST_DEADLINE];
      const deadline = Number.isFinite(requestDeadline) ? Math.min(requestDeadline, Number.isFinite(stageDeadline) ? stageDeadline : Infinity) : stageDeadline;
      const left = Number.isFinite(deadline) ? Math.max(1, deadline - now()) : null;
      const timeoutMs = left === null ? attemptTimeoutMs : Math.min(attemptTimeoutMs, left);
      // A repeat gets a fresh timeout in place of the first attempt's (which has been running while this waited); the
      // caller's fetch (the controller's) still joins its stage stop signal to every attempt. The first attempt keeps the caller's own
      // signal and is only cut short when the deadline is nearer than that signal's.
      const attemptOpts = attempt === 0 ? (left !== null && left < attemptTimeoutMs ? { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) } : opts)
        : { ...opts, signal: AbortSignal.timeout(timeoutMs) };
      // A delayed wake-up must not issue even a 1ms attempt after this request's
      // own deadline. Leave the pre-existing no-request-deadline route unchanged.
      if (Number.isFinite(requestDeadline) && now() >= requestDeadline) {
        if (lastFailure) throw lastFailure;
        if (lastResponse) return lastResponse;
        throw Object.assign(new Error('read_request_deadline_expired'), { code: 'read_request_deadline_expired' });
      }
      if (typeof opts[READ_REQUEST_GUARD] === 'function') opts[READ_REQUEST_GUARD]();
      try { response = await fetchImpl(url, attemptOpts); } catch (error) { if (!networkFault(error)) throw error; failure = error; }
      lastResponse = response; lastFailure = failure;
      if (response && !RETRYABLE_STATUSES.includes(response.status)) return response;
      const delay = delaysMs[attempt];
      const late = Number.isFinite(deadline) && now() + delay >= deadline;
      if (delay === undefined || spent + delay > budgetMs || late) { if (failure) throw failure; return response; }
      // The stage's own deadline or stop request ends the wait; what it throws is the caller's ordinary refusal.
      live();
      try { await response?.body?.cancel?.(); } catch { /* the failed answer is discarded */ }
      spent += delay;
      onRetry({ attempt: attempt + 1, delayMs: delay, status: response?.status ?? null, network: failure ? failure.cause?.code ?? 'network' : null, ...(method === 'POST' ? { post: true } : {}) });
      await sleep(delay);
      live();
    }
  };
}
