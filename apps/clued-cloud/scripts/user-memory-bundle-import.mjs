#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { sha256, validateUserMemoryBundle } from "./user-memory-bundle.mjs";

const DEFAULT_ENDPOINT = "https://clued.pixelgrav.com";

function deterministicKey(prefix, bundleId, sourceId) {
  return `${prefix}:${sha256(`${bundleId}\n${sourceId}`).slice(0, 40)}`;
}

function sourceRef(bundleId, sourceId) {
  return `user-memory-bundle-v1:${bundleId}:${sourceId}`.slice(0, 500);
}

function targetView(recordType) {
  if (recordType === "archive_snapshot") return "archive";
  return recordType;
}

function safeOutputDirectory(value) {
  if (!value || path.resolve(value) === path.parse(path.resolve(value)).root) {
    throw new Error("A narrow target mirror directory is required.");
  }
  return path.resolve(value);
}

async function apiRequest(fetchImpl, endpoint, token, pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetchImpl(`${endpoint}${pathname}`, { ...init, headers });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${pathname} returned non-JSON HTTP ${response.status}.`);
    }
  }
  if (!response.ok) {
    const message = payload?.error ?? payload?.message ?? text ?? response.statusText;
    throw new Error(`${pathname} failed with HTTP ${response.status}: ${message}`);
  }
  return payload;
}

export function buildImportPlan(bundle) {
  const { manifest, projects, records } = bundle;
  const projectActions = projects.map((project) => ({
    source_project_id: project.source_project_id,
    request: {
      name: project.name,
      intent: "confirmed",
      idempotency_key: deterministicKey("umbv1-project", manifest.bundle_id, project.source_project_id),
      summary: `Imported from ${manifest.bundle_id} as a portable single-user fixture.`,
      evidence_summary: project.evidence,
      source_ref: `umbv1:${manifest.bundle_id}`,
      confidence: 1,
      progress_status: project.progress_status,
    },
  }));
  const recordActions = records.map((record) => ({
    source_id: record.source_id,
    source_project_id: record.source_project_id,
    request: {
      action: "create",
      idempotency_key: deterministicKey("umbv1-record", manifest.bundle_id, record.source_id),
      record_type: record.record_type,
      scope: record.scope,
      title: record.title,
      content: record.content,
      record_key: record.record_key,
      status: record.status,
      priority: record.priority,
      source_ref: sourceRef(manifest.bundle_id, record.source_id),
    },
  }));
  return {
    bundle_id: manifest.bundle_id,
    bundle_digest: manifest.bundle_digest,
    project_actions: projectActions,
    record_actions: recordActions,
  };
}

function projectRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.projects)) return payload.projects;
  if (Array.isArray(payload?.records)) return payload.records;
  return [];
}

function recordRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  return [];
}

async function resolveProjects({ fetchImpl, endpoint, token, plan }) {
  const existingPayload = await apiRequest(
    fetchImpl,
    endpoint,
    token,
    "/v1/projects?include_dismissed=true&limit=200",
  );
  const byNormalizedName = new Map(
    projectRows(existingPayload).map((project) => [String(project.name).trim().toLocaleLowerCase(), project]),
  );
  const results = [];
  for (const action of plan.project_actions) {
    const normalized = action.request.name.trim().toLocaleLowerCase();
    let project = byNormalizedName.get(normalized);
    let status = "existing";
    if (!project || project.certainty_status !== "confirmed") {
      const payload = await apiRequest(fetchImpl, endpoint, token, "/v1/projects/observe", {
        method: "POST",
        body: JSON.stringify(action.request),
      });
      project = payload?.project;
      status = payload?.status ?? "written";
    }
    if (!project?.id || project.certainty_status !== "confirmed") {
      throw new Error(`Project was not resolved as confirmed: ${action.source_project_id}`);
    }
    byNormalizedName.set(normalized, project);
    results.push({ source_project_id: action.source_project_id, target_project_id: project.id, status });
  }
  return results;
}

async function writeRecords({ fetchImpl, endpoint, token, plan, projectMap, onProgress }) {
  const results = [];
  for (let index = 0; index < plan.record_actions.length; index += 1) {
    const action = plan.record_actions[index];
    const request = { ...action.request };
    if (request.scope === "project") {
      request.project_id = projectMap.get(action.source_project_id);
      if (!request.project_id) throw new Error(`Missing target project for ${action.source_id}.`);
    }
    const payload = await apiRequest(fetchImpl, endpoint, token, "/v1/records", {
      method: "POST",
      body: JSON.stringify(request),
    });
    const record = payload?.record;
    if (!record?.id) throw new Error(`Record write did not return a canonical ID: ${action.source_id}`);
    results.push({
      source_id: action.source_id,
      target_record_id: record.id,
      target_project_id: record.project_id ?? null,
      record_type: record.record_type,
      status: payload.status,
      version: record.version,
    });
    onProgress?.({ completed: index + 1, total: plan.record_actions.length, source_id: action.source_id });
  }
  return results;
}

async function verifyImportedRecords({ fetchImpl, endpoint, token, bundle, projectResults, recordResults }) {
  const actualByKey = new Map();
  const recordTypes = [...new Set(bundle.records.map((record) => targetView(record.record_type)))].sort();
  const scopes = [{ level: "global", source_project_id: null, target_project_id: null }];
  scopes.push(...projectResults.map((project) => ({
    level: "project",
    source_project_id: project.source_project_id,
    target_project_id: project.target_project_id,
  })));

  for (const scope of scopes) {
    for (const recordType of recordTypes) {
      const params = new URLSearchParams({ level: scope.level, record_type: recordType, limit: "200" });
      if (scope.target_project_id) params.set("project_id", scope.target_project_id);
      const payload = await apiRequest(fetchImpl, endpoint, token, `/v1/records?${params}`);
      for (const record of recordRows(payload)) {
        if (record.record_key) actualByKey.set(record.record_key, record);
      }
    }
  }

  const resultBySourceId = new Map(recordResults.map((result) => [result.source_id, result]));
  const mismatches = [];
  for (const source of bundle.records) {
    const expectedResult = resultBySourceId.get(source.source_id);
    const actual = actualByKey.get(source.record_key);
    if (!actual) {
      mismatches.push({ source_id: source.source_id, reason: "missing_record_key" });
      continue;
    }
    if (
      actual.id !== expectedResult?.target_record_id ||
      actual.title !== source.title ||
      actual.content !== source.content ||
      actual.status !== source.status ||
      actual.version !== expectedResult.version
    ) {
      mismatches.push({ source_id: source.source_id, reason: "canonical_record_mismatch" });
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Imported record verification failed for ${mismatches.length} records.`);
  }
  return { verified: bundle.records.length, mismatches: [] };
}

function mirrorLine(source, target) {
  return `- \`${target.target_record_id}\` — ${source.source_category ?? source.source_type}: Imported source reference ${source.source_id} [status=${source.status}; version=${target.version}]`;
}

function viewName(recordType) {
  if (recordType === "state" || recordType === "note") return "State.md";
  if (recordType === "task") return "Task.md";
  if (recordType === "decision") return "Decision.md";
  return "Archive.md";
}

async function writeTargetMirrors(directory, bundle, projectResults, recordResults) {
  const root = safeOutputDirectory(directory);
  const projectMap = new Map(projectResults.map((item) => [item.source_project_id, item.target_project_id]));
  const resultMap = new Map(recordResults.map((item) => [item.source_id, item]));
  const files = new Map();
  for (const source of bundle.records) {
    const target = resultMap.get(source.source_id);
    const base = source.scope === "global" ? "Global" : `Projects/${projectMap.get(source.source_project_id)}`;
    const relativePath = `${base}/${viewName(source.record_type)}`;
    const lines = files.get(relativePath) ?? [];
    lines.push(mirrorLine(source, target));
    files.set(relativePath, lines);
  }
  const bases = new Set(["Global", ...projectResults.map((item) => `Projects/${item.target_project_id}`)]);
  for (const base of [...bases].sort()) {
    for (const name of ["State.md", "Task.md", "Decision.md", "Archive.md", "Log.md"]) {
      const relativePath = `${base}/${name}`;
      const lines = (files.get(relativePath) ?? []).sort();
      const absolutePath = path.resolve(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(
        absolutePath,
        `# ${path.basename(base)} / ${name.replace(/\.md$/, "")}\n\n${lines.length > 0 ? `${lines.join("\n")}\n` : "_No records in this view._\n"}`,
        "utf8",
      );
    }
  }
}

export async function importUserMemoryBundle({
  bundleDirectory,
  endpoint = DEFAULT_ENDPOINT,
  accessToken,
  execute = false,
  verify = true,
  receiptPath = null,
  targetMirrorDirectory = null,
  fetchImpl = globalThis.fetch,
  onProgress = null,
}) {
  const bundle = await validateUserMemoryBundle(bundleDirectory);
  const plan = buildImportPlan(bundle);
  if (!execute) {
    return {
      status: "dry_run",
      bundle_id: plan.bundle_id,
      projects: plan.project_actions.length,
      records: plan.record_actions.length,
      network_writes: 0,
    };
  }
  if (!accessToken) throw new Error("An authenticated user access token is required for --execute.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  endpoint = endpoint.replace(/\/$/, "");

  const config = await apiRequest(fetchImpl, endpoint, null, "/v1/records/config");
  if (config?.enabled !== true || config?.semantic_contract?.version !== "two-level-five-view-v1") {
    throw new Error("Target Clued endpoint does not expose the required enabled V2 contract.");
  }
  const projectResults = await resolveProjects({ fetchImpl, endpoint, token: accessToken, plan });
  const projectMap = new Map(projectResults.map((item) => [item.source_project_id, item.target_project_id]));
  const recordResults = await writeRecords({
    fetchImpl,
    endpoint,
    token: accessToken,
    plan,
    projectMap,
    onProgress,
  });
  const verification = verify
    ? await verifyImportedRecords({ fetchImpl, endpoint, token: accessToken, bundle, projectResults, recordResults })
    : { verified: 0, mismatches: [] };
  const receipt = {
    schema_version: 1,
    contract: "clued.user-memory-bundle-import-receipt",
    bundle_id: plan.bundle_id,
    bundle_digest: plan.bundle_digest,
    target_endpoint: endpoint,
    completed_at: new Date().toISOString(),
    projects: projectResults,
    records: recordResults,
    verification,
  };
  if (receiptPath) {
    await mkdir(path.dirname(path.resolve(receiptPath)), { recursive: true });
    await writeFile(path.resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
  if (targetMirrorDirectory) {
    await writeTargetMirrors(targetMirrorDirectory, bundle, projectResults, recordResults);
  }
  return { status: "imported", receipt };
}

function parseArgs(argv) {
  const options = {};
  const flags = new Set(["--execute", "--no-verify"]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (flags.has(name)) {
      options[name.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    if (!["--bundle", "--endpoint", "--access-token-env", "--receipt", "--target-mirror"].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${name} requires a value.`);
    options[name.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.bundle) throw new Error("--bundle is required.");
  const tokenEnvironmentName = options.access_token_env ?? "CLUED_ACCESS_TOKEN";
  const result = await importUserMemoryBundle({
    bundleDirectory: path.resolve(options.bundle),
    endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    accessToken: process.env[tokenEnvironmentName],
    execute: options.execute ?? false,
    verify: !(options.no_verify ?? false),
    receiptPath: options.receipt ?? null,
    targetMirrorDirectory: options.target_mirror ?? null,
    onProgress: options.execute
      ? ({ completed, total }) => {
        if (completed === 1 || completed === total || completed % 25 === 0) {
          process.stderr.write(`Imported ${completed}/${total} records.\n`);
        }
      }
      : null,
  });
  if (result.status === "dry_run") process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      bundle_id: result.receipt.bundle_id,
      projects: result.receipt.projects.length,
      records: result.receipt.records.length,
      verified: result.receipt.verification.verified,
    })}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
