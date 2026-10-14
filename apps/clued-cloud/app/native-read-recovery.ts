/** Recovery is deliberately restricted to these idempotent Native reads. */
export type NativeReadOperation = "projects.list" | "imprints.read" | "imprints.source";
export type NativeReadCategory = "transport" | "http" | "payload" | "semantic" | "cancelled" | "stale";
export type NativeReadPhase = "request" | "transport" | "body" | "http" | "payload" | "semantic" | "guard";
export type NativeReadFailureType = "TypeError" | "AbortError" | "HttpError" | "PayloadError" | "SemanticError" | "Unknown";

const OPERATIONS = new Set<string>(["projects.list", "imprints.read", "imprints.source"]);
const CATEGORIES = new Set<string>(["transport", "http", "payload", "semantic", "cancelled", "stale"]);
const PHASES = new Set<string>(["request", "transport", "body", "http", "payload", "semantic", "guard"]);
const TYPES = new Set<string>(["TypeError", "AbortError", "HttpError", "PayloadError", "SemanticError", "Unknown"]);
const RETRY_DELAYS = [250, 750] as const;
let nextReadId = 0;

export type NativeReadLifecycle = "visibilitychange" | "pagehide" | "offline" | "online";
type NativeReadVisibility = "hidden" | "visible" | "unknown";
interface LifecycleObservation {
  lifecycle: NativeReadLifecycle;
  visibility: NativeReadVisibility;
}

/** No raw error, credentials, request, response body or resource identity is retained. */
export class NativeReadFailure extends Error {
  readonly category: NativeReadCategory;
  readonly phase: NativeReadPhase;
  readonly status: number | null;
  readonly type: NativeReadFailureType;

  constructor(failure: {
    category: NativeReadCategory;
    phase: NativeReadPhase;
    status?: number | null;
    type?: NativeReadFailureType;
  }) {
    const category = CATEGORIES.has(failure.category) ? failure.category : "payload";
    const phase = PHASES.has(failure.phase) ? failure.phase : "payload";
    super(`Native read failed: ${category}/${phase}.`);
    this.name = "NativeReadFailure";
    this.category = category;
    this.phase = phase;
    this.status = Number.isInteger(failure.status) && (failure.status as number) >= 0 && (failure.status as number) <= 599
      ? failure.status as number : null;
    this.type = failure.type && TYPES.has(failure.type) ? failure.type : "Unknown";
  }
}

export interface NativeReadDiagnostic {
  /** Correlation only within this module's lifetime; never persisted. */
  readId: number;
  startedAt: number;
  operation: NativeReadOperation | "invalid-operation";
  attempt: number;
  timestamp: number;
  elapsed: number;
  status: number | null;
  type: NativeReadFailureType | "Success" | "Start" | "Lifecycle";
  phase: NativeReadPhase | "complete" | "backoff";
  category: NativeReadCategory | null;
  outcome: "start" | "retry" | "failed" | "success" | "lifecycle";
  callerAbort: boolean;
  stale: boolean;
  lifecycle?: NativeReadLifecycle;
  visibility?: NativeReadVisibility;
}

export interface NativeReadOptions {
  /** Bound to the caller's account/token/selection snapshot, never an identity provider. */
  isCurrent: () => boolean;
  signal?: AbortSignal;
  /** A synchronous collector. Its errors do not change the read or retry budget. */
  diagnostic?: (event: NativeReadDiagnostic) => void;
}

export interface NativeReadAttempt {
  attempt: number;
  /** Also aborts when isCurrent becomes false while the request is pending. */
  signal: AbortSignal;
}

function errorType(error: unknown): NativeReadFailureType {
  if (error && typeof error === "object" && "name" in error) {
    if (error.name === "TypeError") return "TypeError";
    if (error.name === "AbortError") return "AbortError";
  }
  return "Unknown";
}

function normalizedFailure(error: unknown, phase: NativeReadPhase = "request"): NativeReadFailure {
  if (error instanceof NativeReadFailure) return error;
  const type = errorType(error);
  return new NativeReadFailure(type === "TypeError" || type === "AbortError"
    ? { category: "transport", phase, status: 0, type }
    : { category: "payload", phase: "payload", type });
}

function inactivity(options: NativeReadOptions): NativeReadFailure | null {
  if (options.signal?.aborted) {
    return new NativeReadFailure({ category: "cancelled", phase: "guard", type: "AbortError" });
  }
  try {
    if (options.isCurrent()) return null;
  } catch {
    // An unavailable caller guard cannot admit the old response.
  }
  return new NativeReadFailure({ category: "stale", phase: "guard", type: "AbortError" });
}

/** Observe fixed lifecycle enums without reading event payloads or changing policy. */
function observeLifecycle(observe: (event: LifecycleObservation) => void): () => void {
  const removals: (() => void)[] = [];
  const doc = typeof document === "undefined" ? undefined : document;
  const win = typeof window === "undefined" ? undefined : window;
  const visibility = (): NativeReadVisibility => {
    try {
      const state = doc?.visibilityState;
      return state === "hidden" || state === "visible" ? state : "unknown";
    } catch { return "unknown"; }
  };
  function listen(target: EventTarget | undefined, lifecycle: NativeReadLifecycle) {
    if (!target) return;
    const listener = () => observe({ lifecycle, visibility: visibility() });
    try {
      target.addEventListener(lifecycle, listener);
      removals.push(() => target.removeEventListener(lifecycle, listener));
    } catch { /* Diagnostic observation is best effort, never a read precondition. */ }
  }
  listen(doc, "visibilitychange");
  listen(win, "pagehide");
  listen(win, "offline");
  listen(win, "online");
  return () => {
    for (const remove of removals) {
      try { remove(); } catch { /* A failed diagnostic cleanup cannot retry a read. */ }
    }
  };
}

function guarded<T>(read: () => PromiseLike<T>, options: NativeReadOptions, controller: AbortController,
  observe: (event: LifecycleObservation) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let removeLifecycle = () => {};
    function finish(error: unknown, value?: T, failed = true) {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      options.signal?.removeEventListener("abort", check);
      removeLifecycle();
      if (failed) reject(error); else resolve(value as T);
    }
    function check(): NativeReadFailure | null {
      const failure = inactivity(options);
      if (failure) {
        finish(failure);
        controller.abort();
      }
      return failure;
    }
    // A predicate has no change event. Observe it only while this operation is pending.
    const poll = setInterval(check, 50);
    options.signal?.addEventListener("abort", check, { once: true });
    if (check()) return;
    removeLifecycle = observeLifecycle(observe);
    try {
      // Preserve synchronous dispatch for the existing RPC callers. The result
      // still passes the same currentness guard before it can be delivered.
      Promise.resolve(read()).then(value => { if (!check()) finish(null, value, false); }, error => { if (!check()) finish(error); });
    } catch (error) {
      if (!check()) finish(error);
    }
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new NativeReadFailure({ category: "cancelled", phase: "guard", type: "AbortError" }));
    }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Three attempts maximum. The callback must perform only the named read, never a mutation. */
export async function runNativeRead<T>(
  operation: NativeReadOperation,
  read: (attempt: NativeReadAttempt) => PromiseLike<T>,
  options: NativeReadOptions,
): Promise<T> {
  const started = Date.now();
  const readId = ++nextReadId;
  const controller = new AbortController();
  const label = OPERATIONS.has(operation) ? operation : "invalid-operation";
  function emit(attempt: number, failure: NativeReadFailure | null, outcome: NativeReadDiagnostic["outcome"],
    observation?: LifecycleObservation, pendingPhase: "request" | "backoff" = "request") {
    const timestamp = Date.now();
    const event: NativeReadDiagnostic = {
      readId, startedAt: started, operation: label, attempt, timestamp, elapsed: Math.max(0, timestamp - started),
      status: failure?.status ?? null,
      type: failure?.type ?? (outcome === "start" ? "Start" : outcome === "lifecycle" ? "Lifecycle" : "Success"),
      phase: failure?.phase ?? (outcome === "start" || outcome === "lifecycle" ? pendingPhase : "complete"),
      category: failure?.category ?? null, outcome, callerAbort: options.signal?.aborted === true,
      stale: failure?.category === "stale",
      ...(observation ? { lifecycle: observation.lifecycle, visibility: observation.visibility } : {}),
    };
    try {
      if (options.diagnostic) options.diagnostic(event);
      else console.info(JSON.stringify(event));
    } catch {
      // Observability must never trigger a second read or replace its result.
    }
  }
  if (label === "invalid-operation") {
    const failure = new NativeReadFailure({ category: "semantic", phase: "guard", type: "SemanticError" });
    emit(0, failure, "failed");
    throw failure;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const value = await guarded(() => {
        emit(attempt, null, "start");
        return read({ attempt, signal: controller.signal });
      }, options, controller, observation => emit(attempt, null, "lifecycle", observation));
      emit(attempt, null, "success");
      return value;
    } catch (error) {
      const failure = inactivity(options) ?? normalizedFailure(error);
      const retry = failure.category === "transport" && (failure.status === 0 || failure.status === null) && attempt < 3;
      emit(attempt, failure, retry ? "retry" : "failed");
      if (!retry) throw failure;
      try {
        await guarded(() => delay(RETRY_DELAYS[attempt - 1], controller.signal), options, controller,
          observation => emit(attempt, null, "lifecycle", observation, "backoff"));
      } catch (error) {
        const stopped = inactivity(options) ?? normalizedFailure(error);
        emit(attempt, stopped, "failed");
        throw stopped;
      }
    }
  }
  throw new NativeReadFailure({ category: "transport", phase: "transport", status: 0 });
}

/** Preserve the distinction between HTTP denial, interrupted body and malformed JSON. */
export async function readNativeJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new NativeReadFailure({ category: "http", phase: "http", status: response.status, type: "HttpError" });
  }
  if (response.bodyUsed) {
    throw new NativeReadFailure({ category: "payload", phase: "payload", status: response.status, type: "PayloadError" });
  }
  try {
    return await response.json();
  } catch (error) {
    const type = errorType(error);
    if (type === "TypeError" || type === "AbortError") throw normalizedFailure(error, "body");
    throw new NativeReadFailure({ category: "payload", phase: "payload", status: response.status, type: "PayloadError" });
  }
}
