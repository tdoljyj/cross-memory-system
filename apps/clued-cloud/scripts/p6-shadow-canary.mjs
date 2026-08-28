#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const P6_SHADOW_CONTRACT = "clued.p6.isolated-shadow.v1";
export const P6_DIFFERENCE_CONTRACT = "clued.p6.normalized-difference.v1";
export const P6_EVIDENCE_CONTRACT = "clued.p6.immutable-evidence.v1";

const AUTHORITY_FIELDS = [
  "actor_kind",
  "tenant_id",
  "organization_id",
  "workspace_id",
  "role",
  "scope",
  "purpose",
  "policy_version",
  "revocation_epoch",
];

const VOLATILE_FIELDS = new Set([
  "occurred_at",
  "recorded_at",
  "updated_at",
  "created_at",
  "timestamp",
  "duration_ms",
  "request_id",
  "trace_id",
  "attempt_id",
  "receipt_id",
  "event_id",
  "evidence_id",
]);

const BUSINESS_RESULT_OPERATIONAL_FIELDS = new Set([
  "duration_ms",
  "request_id",
  "trace_id",
  "attempt_id",
  "receipt_id",
  "event_id",
  "evidence_id",
]);

const CLASSIFIED_ENVELOPE_FIELDS = new Set([
  "http_status",
  "business_status",
  "error_code",
  "authority",
  "canonical",
  "business_result",
  "events",
  "receipts",
  "evidence",
  "sources_read",
  "rejection_audit",
  "conflicts",
]);

function normalize(value) {
  if (typeof value === "string") return value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite values are not comparable.");
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("Latency percentile requires samples.");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index];
}

function latencyNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
  return value;
}

export function summarizePairedLatency(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Paired latency rows are required.");
  const grouped = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.endpoint !== "string" || !row.endpoint) {
      throw new Error("Every paired latency row requires an endpoint.");
    }
    const baseline = latencyNumber(row.baseline?.elapsed_ms, "baseline.elapsed_ms");
    const candidate = latencyNumber(row.candidate?.elapsed_ms, "candidate.elapsed_ms");
    const group = grouped.get(row.endpoint) ?? { baseline: [], candidate: [], deltas: [], ratios: [] };
    group.baseline.push(baseline);
    group.candidate.push(candidate);
    group.deltas.push(candidate - baseline);
    group.ratios.push(candidate / baseline);
    grouped.set(row.endpoint, group);
  }

  const perEndpoint = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([endpoint, group]) => {
    const baselineP95 = nearestRank(group.baseline, 0.95);
    const baselineP99 = nearestRank(group.baseline, 0.99);
    return {
      endpoint,
      paired_sample_count: group.deltas.length,
      paired_median_delta_ms: nearestRank(group.deltas, 0.5),
      paired_p80_delta_ms: nearestRank(group.deltas, 0.8),
      paired_median_ratio: nearestRank(group.ratios, 0.5),
      paired_p80_ratio: nearestRank(group.ratios, 0.8),
      p95_ratio: nearestRank(group.candidate, 0.95) / baselineP95,
      p99_ratio: nearestRank(group.candidate, 0.99) / baselineP99,
    };
  });

  const maximum = (field) => Math.max(...perEndpoint.map((item) => item[field]));
  return {
    contract: "clued.p6.paired-latency-summary.v1",
    endpoint_count: perEndpoint.length,
    paired_sample_count: Math.min(...perEndpoint.map((item) => item.paired_sample_count)),
    paired_median_delta_ms: maximum("paired_median_delta_ms"),
    paired_p80_delta_ms: maximum("paired_p80_delta_ms"),
    paired_median_ratio: maximum("paired_median_ratio"),
    paired_p80_ratio: maximum("paired_p80_ratio"),
    p95_ratio: maximum("p95_ratio"),
    p99_ratio: maximum("p99_ratio"),
    percentile_role: "advisory_only",
    per_endpoint: perEndpoint,
  };
}

function semanticShape(value) {
  if (Array.isArray(value)) return value.map(semanticShape);
  if (!value || typeof value !== "object") return normalize(value);
  const shaped = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_FIELDS.has(key)) continue;
    shaped[key] = semanticShape(value[key]);
  }
  return shaped;
}

function businessResultShape(value) {
  if (Array.isArray(value)) return value.map(businessResultShape);
  if (!value || typeof value !== "object") return normalize(value);
  const shaped = {};
  for (const key of Object.keys(value).sort()) {
    if (BUSINESS_RESULT_OPERATIONAL_FIELDS.has(key)) continue;
    shaped[key] = businessResultShape(value[key]);
  }
  return shaped;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string"))].sort();
}

function semanticArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(semanticShape).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function unclassifiedShape(value) {
  const shaped = {};
  for (const key of Object.keys(value).sort()) {
    if (CLASSIFIED_ENVELOPE_FIELDS.has(key) || VOLATILE_FIELDS.has(key)) continue;
    shaped[key] = semanticShape(value[key]);
  }
  return shaped;
}

export function normalizeShadowEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Shadow envelope must be an object.");
  const authority = {};
  for (const field of AUTHORITY_FIELDS) authority[field] = value.authority?.[field] ?? null;
  return normalize({
    contract: P6_SHADOW_CONTRACT,
    http_status: value.http_status ?? null,
    business_status: value.business_status ?? null,
    error_code: value.error_code ?? null,
    authority,
    canonical: {
      id: value.canonical?.id ?? null,
      version: value.canonical?.version ?? null,
      snapshot_version: value.canonical?.snapshot_version ?? null,
    },
    business_result: businessResultShape(value.business_result ?? null),
    events: semanticArray(value.events),
    receipts: semanticArray(value.receipts),
    evidence: semanticArray(value.evidence),
    sources_read: stringArray(value.sources_read),
    rejection_audit: semanticArray(value.rejection_audit),
    conflicts: semanticArray(value.conflicts),
    unclassified: unclassifiedShape(value),
  });
}

function difference(code, pathName, baseline, candidate) {
  return {
    contract: P6_DIFFERENCE_CONTRACT,
    code,
    path: pathName,
    baseline_sha256: sha256(canonicalJson(baseline)),
    candidate_sha256: sha256(canonicalJson(candidate)),
  };
}

function rejected(envelope) {
  return envelope.http_status >= 400 || envelope.business_status === "rejected" || envelope.business_status === "failed";
}

function missingFrom(candidate, baseline) {
  const candidateSet = new Set(candidate.map((item) => canonicalJson(item)));
  return baseline.filter((item) => !candidateSet.has(canonicalJson(item)));
}

export function compareShadowPair({ fixture_id, baseline, candidate }) {
  const left = normalizeShadowEnvelope(baseline);
  const right = normalizeShadowEnvelope(candidate);
  const hardDifferences = [];
  const unclassifiedDifferences = [];
  if (rejected(left) && !rejected(right)) hardDifferences.push(difference("OLD_REJECT_NEW_ACCEPT", "business_status", left.business_status, right.business_status));
  if (left.http_status !== right.http_status) hardDifferences.push(difference("HTTP_STATUS_DIFFERENCE", "http_status", left.http_status, right.http_status));
  if (left.business_status !== right.business_status) hardDifferences.push(difference("BUSINESS_STATUS_DIFFERENCE", "business_status", left.business_status, right.business_status));
  if (left.error_code !== right.error_code) hardDifferences.push(difference("ERROR_CODE_DIFFERENCE", "error_code", left.error_code, right.error_code));
  if (canonicalJson(left.authority) !== canonicalJson(right.authority)) hardDifferences.push(difference("AUTHORITY_OR_SCOPE_DIFFERENCE", "authority", left.authority, right.authority));
  if (left.canonical.id !== right.canonical.id) hardDifferences.push(difference("CANONICAL_ID_DIFFERENCE", "canonical.id", left.canonical.id, right.canonical.id));
  if (left.canonical.version !== right.canonical.version) hardDifferences.push(difference("CANONICAL_VERSION_DIFFERENCE", "canonical.version", left.canonical.version, right.canonical.version));
  if (left.canonical.snapshot_version !== right.canonical.snapshot_version) hardDifferences.push(difference("SNAPSHOT_VERSION_DIFFERENCE", "canonical.snapshot_version", left.canonical.snapshot_version, right.canonical.snapshot_version));
  if (canonicalJson(left.business_result) !== canonicalJson(right.business_result)) hardDifferences.push(difference("BUSINESS_RESULT_DIFFERENCE", "business_result", left.business_result, right.business_result));
  for (const [field, code] of [
    ["events", "EVENT_SEMANTICS_DIFFERENCE"],
    ["receipts", "RECEIPT_SEMANTICS_DIFFERENCE"],
    ["evidence", "EVIDENCE_SEMANTICS_DIFFERENCE"],
    ["conflicts", "CONFLICT_EVIDENCE_DIFFERENCE"],
  ]) {
    if (canonicalJson(left[field]) !== canonicalJson(right[field])) hardDifferences.push(difference(code, field, left[field], right[field]));
  }
  const missingSources = left.sources_read.filter((item) => !right.sources_read.includes(item));
  if (missingSources.length > 0) hardDifferences.push(difference("SOURCES_READ_REDUCED", "sources_read", missingSources, right.sources_read));
  const missingAudit = missingFrom(right.rejection_audit, left.rejection_audit);
  if (missingAudit.length > 0) hardDifferences.push(difference("REJECTION_AUDIT_REDUCED", "rejection_audit", missingAudit, right.rejection_audit));
  if (canonicalJson(left.unclassified) !== canonicalJson(right.unclassified)) {
    unclassifiedDifferences.push(difference("UNCLASSIFIED_SEMANTIC_DIFFERENCE", "unclassified", left.unclassified, right.unclassified));
  }
  const differences = [...hardDifferences, ...unclassifiedDifferences];
  return {
    contract: P6_SHADOW_CONTRACT,
    fixture_id,
    baseline_sha256: sha256(canonicalJson(left)),
    candidate_sha256: sha256(canonicalJson(right)),
    hard_difference_count: hardDifferences.length,
    unclassified_difference_count: unclassifiedDifferences.length,
    result: hardDifferences.length === 0 && unclassifiedDifferences.length === 0 ? "PASS" : "FAIL",
    differences,
  };
}

export async function runIsolatedShadow({ fixtures, baselineHandler, candidateHandler }) {
  const results = [];
  for (const fixture of fixtures) {
    const baseline = await baselineHandler(structuredClone(fixture));
    const candidate = await candidateHandler(structuredClone(fixture));
    results.push(compareShadowPair({ fixture_id: fixture.fixture_id, baseline, candidate }));
  }
  const hardDifferenceCount = results.reduce((total, item) => total + item.hard_difference_count, 0);
  const unclassifiedDifferenceCount = results.reduce((total, item) => total + item.unclassified_difference_count, 0);
  return {
    contract: P6_SHADOW_CONTRACT,
    boundary: "isolated_synthetic_only",
    fixture_count: fixtures.length,
    hard_difference_count: hardDifferenceCount,
    unclassified_difference_count: unclassifiedDifferenceCount,
    result: hardDifferenceCount === 0 && unclassifiedDifferenceCount === 0 ? "PASS" : "FAIL",
    results,
  };
}

export function operationReceipt({ operation, occurred_at, actor, expected_current, current, next, result, error = null }) {
  const material = { operation, occurred_at, actor, expected_current, current, next, result, error };
  const receipt_id = `p6r_${sha256(canonicalJson(material)).slice(0, 32)}`;
  return {
    receipt: { contract: "clued.p6.operation-receipt.v1", receipt_id, ...material },
    event: {
      contract: "clued.p6.operation-event.v1",
      event_id: `p6e_${sha256(canonicalJson({ receipt_id, operation, result })).slice(0, 32)}`,
      receipt_id,
      event_type: `p6_${operation}`,
      result,
      occurred_at,
    },
  };
}

async function exclusiveWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeImmutableEvidenceSet({ outputDirectory, files }) {
  const rows = [];
  for (const name of Object.keys(files).sort()) {
    if (name === "SHA256SUMS" || path.basename(name) !== name) throw new Error(`Invalid evidence filename: ${name}`);
    const content = files[name].replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    await exclusiveWrite(path.resolve(outputDirectory, name), content);
    rows.push(`${sha256(content)}  ${name}`);
  }
  const sums = `${rows.join("\n")}\n`;
  await exclusiveWrite(path.resolve(outputDirectory, "SHA256SUMS"), sums);
  return { contract: P6_EVIDENCE_CONTRACT, file_count: rows.length, sha256sums_sha256: sha256(sums) };
}

export async function verifyEvidenceSet(outputDirectory) {
  const sums = await readFile(path.resolve(outputDirectory, "SHA256SUMS"), "utf8");
  const files = [];
  for (const line of sums.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match) throw new Error("Invalid SHA256SUMS row.");
    const bytes = await readFile(path.resolve(outputDirectory, match[2]));
    const actual = sha256(bytes);
    if (actual !== match[1]) throw new Error(`Evidence hash mismatch: ${match[2]}`);
    files.push({ path: match[2], sha256: actual });
  }
  return { contract: P6_EVIDENCE_CONTRACT, result: "PASS", files };
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== "verify-evidence" || argv[1] !== "--directory" || !argv[2] || argv.length !== 3) {
    throw new Error("Usage: p6-shadow-canary.mjs verify-evidence --directory <path>");
  }
  return { command, directory: path.resolve(argv[2]) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await verifyEvidenceSet(options.directory);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
