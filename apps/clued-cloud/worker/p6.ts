export const P6_CONTRACT = "clued.p6.shadow-canary-publish-rollback.v3";
export const P6_RELEASE_PROFILE = "fast-15m-1000-candidate-reads.v1";
export const P6_LATENCY_MEASUREMENT_CONTRACT = "clued.p6.latency.sequential-mirrored-ab-ba.v1";

export interface P6FeatureEnv {
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  P6_RELEASE_CONTROL_ENABLED?: string;
}

export interface P6VersionAttribution {
  contract: typeof P6_CONTRACT;
  version_id: string;
  version_tag: string;
  version_timestamp: string | null;
  source: "cloudflare_version_metadata" | "local_unversioned";
}

export interface CanaryWindow {
  request_count: number;
  duration_minutes: number;
  baseline_5xx_rate: number;
  candidate_5xx_rate: number;
  baseline_timeout_rate: number;
  candidate_timeout_rate: number;
  p95_ratio: number;
  p99_ratio: number;
  latency_measurement_contract: string;
  hard_violations: string[];
  attribution_complete: boolean;
  receipts_complete: boolean;
  rollback_ready: boolean;
  observability_blind_seconds: number;
}

export interface CanaryState {
  phase_index: number;
  consecutive_severe_windows: number;
}

export const P6_CANARY_PHASES = Object.freeze([
  { traffic_percent: 0, minimum_minutes: 2, minimum_requests: 100, purpose: "targeted_production_shadow" },
  { traffic_percent: 1, minimum_minutes: 2, minimum_requests: 50, purpose: "canary" },
  { traffic_percent: 5, minimum_minutes: 2, minimum_requests: 100, purpose: "canary" },
  { traffic_percent: 25, minimum_minutes: 2, minimum_requests: 150, purpose: "canary" },
  { traffic_percent: 50, minimum_minutes: 2, minimum_requests: 200, purpose: "canary" },
  { traffic_percent: 100, minimum_minutes: 5, minimum_requests: 400, purpose: "stability_observation" },
] as const);

export const P6_CANARY_BUDGET = Object.freeze({
  minimum_total_minutes: P6_CANARY_PHASES.reduce((total, phase) => total + phase.minimum_minutes, 0),
  minimum_total_candidate_requests: P6_CANARY_PHASES.reduce((total, phase) => total + phase.minimum_requests, 0),
});

function finiteRate(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative finite number.`);
  return value;
}

export function versionAttribution(env: P6FeatureEnv): P6VersionAttribution {
  const metadata = env.CF_VERSION_METADATA;
  if (metadata && typeof metadata.id === "string" && metadata.id) {
    return {
      contract: P6_CONTRACT,
      version_id: metadata.id,
      version_tag: typeof metadata.tag === "string" ? metadata.tag : "",
      version_timestamp: typeof metadata.timestamp === "string" ? metadata.timestamp : null,
      source: "cloudflare_version_metadata",
    };
  }
  return {
    contract: P6_CONTRACT,
    version_id: "local-unversioned",
    version_tag: "local",
    version_timestamp: null,
    source: "local_unversioned",
  };
}

export function p6ReleaseControlEnabled(env: P6FeatureEnv) {
  return /^(1|true|on|enabled)$/i.test(env.P6_RELEASE_CONTROL_ENABLED?.trim() ?? "");
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const item of cookies.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(parts.join("=")); } catch { return null; }
    }
  }
  return null;
}

function safeAffinityKey(value: string | null) {
  const key = value?.trim() ?? "";
  return key.length >= 8 && key.length <= 256 && /^[A-Za-z0-9._~:-]+$/.test(key) ? key : null;
}

export function resolveVersionAffinity(request: Request) {
  const platformKey = safeAffinityKey(request.headers.get("Cloudflare-Workers-Version-Key"));
  if (platformKey) return { key: platformKey, source: "platform_header", set_cookie: false } as const;
  const cookieKey = safeAffinityKey(cookieValue(request, "clued_version_key"));
  if (cookieKey) return { key: cookieKey, source: "clued_cookie", set_cookie: false } as const;
  const sessionKey = safeAffinityKey(request.headers.get("x-clued-session-id"));
  if (sessionKey) return { key: sessionKey, source: "session_header", set_cookie: false } as const;
  return { key: crypto.randomUUID(), source: "generated_cookie", set_cookie: true } as const;
}

function appendVary(headers: Headers, value: string) {
  const current = headers.get("vary");
  const values = new Set((current ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  values.add(value);
  headers.set("vary", [...values].join(", "));
}

function applyP6Headers(headers: Headers, attribution: P6VersionAttribution, affinity: ReturnType<typeof resolveVersionAffinity>) {
  headers.set("clued-version-id", attribution.version_id);
  headers.set("clued-version-tag", attribution.version_tag);
  headers.set("clued-version-attribution", attribution.source);
  headers.set("clued-version-affinity-source", affinity.source);
  appendVary(headers, "Cloudflare-Workers-Version-Key");
  if (affinity.set_cookie) {
    headers.append(
      "set-cookie",
      `clued_version_key=${encodeURIComponent(affinity.key)}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`,
    );
  }
}

export function decorateP6Response(request: Request, response: Response, env: P6FeatureEnv) {
  const attribution = versionAttribution(env);
  const affinity = resolveVersionAffinity(request);
  try {
    applyP6Headers(response.headers, attribution, affinity);
    return response;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  const headers = new Headers(response.headers);
  applyP6Headers(headers, attribution, affinity);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function normalizeScriptVersion(value: unknown): P6VersionAttribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return versionAttribution({});
  const scriptVersion = value as { id?: unknown; tag?: unknown; timestamp?: unknown };
  if (typeof scriptVersion.id !== "string" || !scriptVersion.id) return versionAttribution({});
  return {
    contract: P6_CONTRACT,
    version_id: scriptVersion.id,
    version_tag: typeof scriptVersion.tag === "string" ? scriptVersion.tag : "",
    version_timestamp: typeof scriptVersion.timestamp === "string" ? scriptVersion.timestamp : null,
    source: "cloudflare_version_metadata",
  };
}

export function evaluateCanaryWindow(state: CanaryState, window: CanaryWindow) {
  const phase = P6_CANARY_PHASES[state.phase_index];
  if (!phase) throw new Error("Unknown Canary phase.");
  finiteRate(window.baseline_5xx_rate, "baseline_5xx_rate");
  finiteRate(window.candidate_5xx_rate, "candidate_5xx_rate");
  finiteRate(window.baseline_timeout_rate, "baseline_timeout_rate");
  finiteRate(window.candidate_timeout_rate, "candidate_timeout_rate");
  finiteRate(window.p95_ratio, "p95_ratio");
  finiteRate(window.p99_ratio, "p99_ratio");

  const immediateRollback = [...new Set(window.hard_violations)].sort();
  if (window.observability_blind_seconds > 120) immediateRollback.push("OBSERVABILITY_BLIND_OVER_120_SECONDS");
  const latencyMeasurementValid = window.latency_measurement_contract === P6_LATENCY_MEASUREMENT_CONTRACT;
  const severe =
    window.candidate_5xx_rate > Math.max(0.01, window.baseline_5xx_rate + 0.005)
    || window.candidate_timeout_rate > Math.max(0.005, window.baseline_timeout_rate + 0.0025)
    || (latencyMeasurementValid && window.p95_ratio > 1.25);
  const severeCount = severe ? state.consecutive_severe_windows + 1 : 0;
  if (severeCount >= 2) immediateRollback.push("TWO_CONSECUTIVE_SEVERE_WINDOWS");
  if (immediateRollback.length > 0) {
    return {
      action: "AUTO_ROLLBACK",
      reasons: [...new Set(immediateRollback)].sort(),
      next_state: { ...state, consecutive_severe_windows: severeCount },
    } as const;
  }

  const stopReasons: string[] = [];
  if (window.candidate_5xx_rate > 0.01 || window.candidate_5xx_rate > window.baseline_5xx_rate + 0.002) {
    stopReasons.push("STOP_5XX_THRESHOLD");
  }
  if (window.candidate_timeout_rate > 0.005 || window.candidate_timeout_rate > window.baseline_timeout_rate + 0.001) {
    stopReasons.push("STOP_TIMEOUT_THRESHOLD");
  }
  if (!latencyMeasurementValid) stopReasons.push("STOP_LATENCY_MEASUREMENT_INVALID");
  if (latencyMeasurementValid && window.p95_ratio > 1.15) stopReasons.push("STOP_P95_THRESHOLD");
  if (latencyMeasurementValid && window.p99_ratio > 1.25) stopReasons.push("STOP_P99_THRESHOLD");
  if (!window.attribution_complete) stopReasons.push("STOP_VERSION_ATTRIBUTION_INCOMPLETE");
  if (!window.receipts_complete) stopReasons.push("STOP_RECEIPT_OBSERVABILITY_INCOMPLETE");
  if (!window.rollback_ready) stopReasons.push("STOP_ROLLBACK_NOT_READY");
  if (stopReasons.length > 0) {
    return {
      action: "STOP",
      reasons: stopReasons.sort(),
      next_state: { ...state, consecutive_severe_windows: severeCount },
    } as const;
  }

  if (window.duration_minutes < phase.minimum_minutes || window.request_count < phase.minimum_requests) {
    return {
      action: "HOLD",
      reasons: ["MINIMUM_OBSERVATION_NOT_MET"],
      next_state: { ...state, consecutive_severe_windows: severeCount },
    } as const;
  }
  return {
    action: state.phase_index === P6_CANARY_PHASES.length - 1 ? "STAGE_COMPLETE" : "ADVANCE",
    reasons: [],
    next_state: {
      phase_index: Math.min(state.phase_index + 1, P6_CANARY_PHASES.length - 1),
      consecutive_severe_windows: 0,
    },
  } as const;
}
