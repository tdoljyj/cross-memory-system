// Request-local, opt-in diagnostics for the Native project-list read. These
// stages describe application progress, never delivery to or cancellation by
// the browser. Incoming Request.signal requires enable_request_signal, which
// this deployment does not enable; do not infer disconnects from that API.
export const NATIVE_READ_TRACE_HEADER = "x-kooyumi-read-trace";

type NativeReadTraceStage =
  | "entry"
  | "auth_started"
  | "auth_completed"
  | "auth_failed"
  | "rpc_started"
  | "rpc_completed"
  | "rpc_failed"
  | "response_built";

export interface NativeReadTrace {
  stage(stage: NativeReadTraceStage, status?: number): void;
  complete(response: Response): void;
}

export function createNativeReadTrace(request: Request): NativeReadTrace | null {
  try {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/v1/projects") return null;
    const traceId = request.headers.get(NATIVE_READ_TRACE_HEADER);
    // Header duplication becomes a comma-joined value and fails this exact,
    // bounded UUID check. Accept RFC UUID versions without logging raw input.
    if (!traceId || traceId.length !== 36 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(traceId)) return null;
    const started = performance.now();
    const stage = (stage: NativeReadTraceStage, status?: number) => {
      try {
        const elapsed = performance.now() - started;
        console.info(JSON.stringify({
          schema: "kooyumi.native-read-trace/v1",
          traceId,
          stage,
          elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(86400000, Math.round(elapsed))) : 0,
          ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
        }));
      } catch { /* Diagnostics never change the read or its error response. */ }
    };
    const trace: NativeReadTrace = {
      stage,
      complete(response) {
        stage("response_built", response.status);
        try { response.headers.set(NATIVE_READ_TRACE_HEADER, traceId); }
        catch { /* Preserve the original response if its headers are immutable. */ }
      },
    };
    stage("entry");
    return trace;
  } catch {
    return null;
  }
}
