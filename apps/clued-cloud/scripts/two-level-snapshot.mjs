#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const SNAPSHOT_CONTRACT = "clued.two-level-five-view.snapshot";
export const SNAPSHOT_SCHEMA_VERSION = 6;
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS = new Set([5, 6]);
export const INDEX_SCHEMA_VERSION = 1;
export const GENERATOR_VERSION = "1.7.0";
export const DEFAULT_EXPORT_POLICY_VERSION = "clued-m0-offline-v1";
export const SNAPSHOT_PUBLICATION_LOCK_POLICY = Object.freeze({
  stale_lock_seconds: 900,
  retry_schedule_ms: [100, 500, 2_000],
});
const PUBLICATION_TRANSITION_RETRY_MS = Object.freeze([0, 1, 5, 25, 100, 500, 2_000]);

const RECORD_TYPES = new Set(["state", "task", "decision", "profile_fact", "note"]);
const TERMINAL_RECORD_STATUSES = new Set([
  "completed",
  "cancelled",
  "superseded",
  "archived",
  "revoked",
]);
const VIEW_NAMES = ["state.md", "task.md", "decision.md", "archive.md", "log.md"];
const LEGACY_MEMORY_EVIDENCE = [
  "画像.md",
  "状态.md",
  "决策.md",
  "待办.md",
  "归档.md",
  "contexts/projects/clued/日志.md",
  "audit/audit.log",
];
const SECRET_PATTERNS = [
  /\bgh[op]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/i,
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  if (typeof value === "string") return value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Canonical JSON forbids non-finite numbers.");
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function prettyJson(value) {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function safeOpaquePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) throw new Error("Invalid opaque ID.");
  return encodeURIComponent(value).replaceAll("%", "~");
}

function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error(`Unsafe relative path: ${value}`);
  return value;
}

function hasSecret(value) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function assertIso(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp.`);
}

function assertHex(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be sha256.`);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeText(root, relativePath, content) {
  safeRelativePath(relativePath);
  const target = path.resolve(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), "utf8");
}

async function writeJson(root, relativePath, value) {
  await writeText(root, relativePath, prettyJson(value));
}

async function listFiles(root, relative = "") {
  const directory = path.resolve(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function descriptor(root, relativePath, snapshotVersion) {
  const bytes = await readFile(path.resolve(root, relativePath));
  return { path: relativePath, sha256: sha256(bytes), snapshot_version: snapshotVersion };
}

function withoutContentHash(envelope) {
  const copy = structuredClone(envelope);
  if (copy.data && typeof copy.data === "object") delete copy.data.content_hash;
  return copy;
}

function envelope(kind, snapshotVersion, canonicalId, canonicalVersion, data, { selfHash = false } = {}) {
  const result = {
    kind,
    schema_version: 1,
    snapshot_version: snapshotVersion,
    canonical_id: canonicalId,
    canonical_version: canonicalVersion,
    data: structuredClone(data),
  };
  if (selfHash) result.data.content_hash = sha256(canonicalJson(withoutContentHash(result)));
  return result;
}

function recordIsCanonical(record) {
  return Boolean(
    record &&
    typeof record.id === "string" &&
    Number.isInteger(record.record_schema_version) && record.record_schema_version > 0 &&
    RECORD_TYPES.has(record.record_type) &&
    typeof record.lifecycle_status === "string" &&
    typeof record.scope === "string" &&
    Number.isInteger(record.version) && record.version > 0 &&
    typeof record.content_hash === "string",
  );
}

function projectIsCanonical(project, sourceSchemaVersion) {
  const common = Boolean(
    project &&
    typeof project.canonical_project_id === "string" &&
    Number.isInteger(project.version) && project.version > 0 &&
    ["not_started", "active", "paused", "completed", "archived"].includes(project.progress_status) &&
    ["active", "merged"].includes(project.lifecycle_status),
  );
  if (!common) return false;
  if (sourceSchemaVersion === 1) {
    return project.project_schema_version === 1 && project.certainty_status === "confirmed";
  }
  return project.project_schema_version === 2 && !("certainty_status" in project) &&
    !("confirmed_at" in project) && !("confidence" in project);
}

function projectForV2Snapshot(project) {
  if (project.project_schema_version === 2) return structuredClone(project);
  const successor = structuredClone(project);
  delete successor.certainty_status;
  delete successor.confirmed_at;
  delete successor.confidence;
  successor.project_schema_version = 2;
  return successor;
}

function eventIsCanonical(event) {
  return Boolean(
    event &&
    typeof event.event_id === "string" &&
    Number.isInteger(event.event_schema_version) && event.event_schema_version > 0 &&
    typeof event.committed_canonical_version !== "undefined" &&
    typeof event.event_type === "string" &&
    typeof event.event_scope === "string" &&
    ["audit_only", "work_log"].includes(event.audit_visibility) &&
    ["success", "failure"].includes(event.result) &&
    typeof event.receipt_id === "string" &&
    typeof event.content_hash === "string",
  );
}

function evidenceIsCanonical(item) {
  return Boolean(
    item &&
    typeof item.evidence_id === "string" &&
    Number.isInteger(item.evidence_schema_version) && item.evidence_schema_version > 0 &&
    typeof item.content_hash === "string" &&
    typeof item.storage_ref === "string",
  );
}

function recordTitle(record) {
  return typeof record.title === "string" && record.title.trim() ? record.title.trim().slice(0, 160) : "Untitled record";
}

function mirrorLine(record) {
  const summary = record.closure_summary || recordTitle(record);
  return `- \`${record.id}\` — ${recordTitle(record)}: ${String(summary).replace(/\s+/g, " ").slice(0, 240)} [lifecycle_status=${record.lifecycle_status}; version=${record.version}]`;
}

function eventLine(event) {
  return `- \`${event.event_id}\` — ${event.event_type}: ${event.result} [occurred_at=${event.occurred_at ?? "unknown"}; receipt=${event.receipt_id}]`;
}

function emptyView(title, pending = false) {
  const suffix = pending ? "\n> Current view is incomplete because legacy items require review.\n" : "";
  return `# ${title}\n${suffix}\n_No records in this view._\n`;
}

function sourceIdentity(source) {
  const material = {
    canonical_version: source.canonical_version,
    source_verification: source.source_verification,
    projects: source.projects ?? [],
    records: source.records ?? [],
    events: source.events ?? [],
    evidence: source.evidence ?? [],
    legacy_projects: source.legacy_projects ?? [],
    legacy_records: source.legacy_records ?? [],
    legacy_events: source.legacy_events ?? [],
    legacy_evidence: source.legacy_evidence ?? [],
    referenced_receipts: source.referenced_receipts ?? [],
  };
  return sha256(canonicalJson(material));
}

function sourceCounts(source) {
  return {
    projects: (source.projects ?? []).length,
    records: (source.records ?? []).length,
    events: (source.events ?? []).length,
    evidence: (source.evidence ?? []).length,
    referenced_receipts: new Set(source.referenced_receipts ?? []).size,
  };
}

export async function readLegacyMemorySource({ memoryDirectory, canonicalVersion, sourceGitCommit }) {
  if (!memoryDirectory) throw new Error("memoryDirectory is required.");
  const objectDirectory = path.resolve(memoryDirectory, "objects");
  const files = (await readdir(objectDirectory)).filter((name) => /^mem_[A-Za-z0-9_-]+\.json$/.test(name)).sort();
  const legacyRecords = [];
  const projectIds = new Set();
  for (const name of files) {
    const bytes = await readFile(path.resolve(objectDirectory, name));
    const payload = JSON.parse(bytes.toString("utf8"));
    if (typeof payload.id !== "string") throw new Error(`${name} is missing its legacy ID.`);
    if (payload.scope === "project" && typeof payload.project_id === "string") projectIds.add(payload.project_id);
    const text = bytes.toString("utf8");
    legacyRecords.push({
      kind: "legacy_record",
      legacy_id: payload.id,
      legacy_schema_version: payload.schema_version ?? null,
      legacy_record_type: payload.type ?? null,
      inline_payload: hasSecret(text) ? null : payload,
      protected_payload_ref: hasSecret(text) ? `memory/objects/${name}` : null,
      content_hash: sha256(bytes),
      missing_required_fields: ["canonical_id", "record_schema_version", "lifecycle_status", "receipt_id"],
      migration_status: "pending_review",
      omitted_reason: hasSecret(text) ? "secret_detected" : null,
    });
  }
  const legacyEvidence = [];
  for (const relativePath of LEGACY_MEMORY_EVIDENCE) {
    const absolutePath = path.resolve(memoryDirectory, relativePath);
    if (!await exists(absolutePath) || !(await stat(absolutePath)).isFile()) continue;
    const bytes = await readFile(absolutePath);
    const text = bytes.toString("utf8");
    legacyEvidence.push({
      kind: "legacy_evidence",
      legacy_id: `legacy_file_${sha256(relativePath).slice(0, 20)}`,
      legacy_schema_version: null,
      legacy_record_type: null,
      source_path: relativePath.replaceAll("\\", "/"),
      inline_payload: hasSecret(text) ? null : text,
      protected_payload_ref: hasSecret(text) ? relativePath.replaceAll("\\", "/") : null,
      content_hash: sha256(bytes),
      missing_required_fields: ["evidence_id", "evidence_schema_version", "storage_ref"],
      migration_status: "preserved",
      omitted_reason: hasSecret(text) ? "secret_detected" : null,
    });
  }
  return {
    schema_version: 1,
    canonical_version: canonicalVersion ?? `git:${sourceGitCommit}:memory-objects`,
    source_verification: "bundle_only",
    views_complete: false,
    source_git_commit: sourceGitCommit ?? null,
    projects: [], records: [], events: [], evidence: [], referenced_receipts: [],
    legacy_projects: [...projectIds].sort().map((legacyId) => ({
      kind: "legacy_project",
      legacy_id: legacyId,
      legacy_schema_version: null,
      legacy_record_type: null,
      inline_payload: { source_project_id: legacyId },
      protected_payload_ref: null,
      content_hash: sha256(canonicalJson({ source_project_id: legacyId })),
      missing_required_fields: ["canonical_project_id", "project_schema_version", "version", "receipt_id"],
      migration_status: "pending_review",
      omitted_reason: null,
    })),
    legacy_records: legacyRecords,
    legacy_events: [],
    legacy_evidence: legacyEvidence,
    excluded_evidence_counts: {},
  };
}

function validateSource(source) {
  if (!source || ![1, 2].includes(source.schema_version)) throw new Error("Unsupported source snapshot schema.");
  if (typeof source.canonical_version !== "string" || !source.canonical_version) throw new Error("source.canonical_version is required.");
  if (!['live_rechecked', 'bundle_only'].includes(source.source_verification)) throw new Error("Invalid source_verification.");
  if (source.source_verification === "live_rechecked" && source.views_complete !== true) {
    throw new Error("A live-rechecked current source must have views_complete=true.");
  }
  for (const project of source.projects ?? []) if (!projectIsCanonical(project, source.schema_version)) throw new Error("Source contains a non-canonical Project outside a legacy envelope.");
  for (const record of source.records ?? []) if (!recordIsCanonical(record)) throw new Error("Source contains a non-canonical Record outside a legacy envelope.");
  for (const event of source.events ?? []) if (!eventIsCanonical(event)) throw new Error("Source contains a non-canonical Event outside a legacy envelope.");
  for (const evidence of source.evidence ?? []) if (!evidenceIsCanonical(evidence)) throw new Error("Source contains non-canonical Evidence outside a legacy envelope.");
}

function makeSnapshotIdentity({ source, buildEpoch, migrationRunId, generatorVersion, exportPolicyVersion }) {
  const baselineClaim = source.source_verification === "live_rechecked" ? "current" : "historical_offline";
  const generatorConfig = {
    contract: SNAPSHOT_CONTRACT,
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    record_schema: "clued-record-v1.6",
    project_schema: "clued-project-v2",
    event_schema: "clued-event-v1.6",
    index_schema_version: INDEX_SCHEMA_VERSION,
    event_rollups_enabled: false,
    receipt_export: "references_only",
  };
  const generatorConfigHash = sha256(canonicalJson(generatorConfig));
  const material = {
    canonical_version: source.canonical_version,
    source_inventory_hash: sourceIdentity(source),
    generator_version: generatorVersion,
    generator_config_hash: generatorConfigHash,
    export_policy_version: exportPolicyVersion,
    build_epoch: buildEpoch,
    baseline_claim: baselineClaim,
    source_verification: source.source_verification,
    views_complete: source.views_complete === true,
    migration_run_id: migrationRunId,
  };
  return {
    snapshotVersion: `snap_${sha256(canonicalJson(material)).slice(0, 32)}`,
    baselineClaim,
    generatorConfigHash,
  };
}

function projectById(projects) {
  return new Map(projects.map((project) => [project.canonical_project_id, project]));
}

function resolveProject(projects, id) {
  const byId = projectById(projects);
  const visited = [];
  let current = id;
  while (current) {
    if (visited.includes(current)) throw new Error(`Project redirect cycle: ${visited.join(" -> ")} -> ${current}`);
    visited.push(current);
    const project = byId.get(current);
    if (!project) throw new Error(`Project redirect target does not exist: ${current}`);
    if (project.lifecycle_status !== "merged") return { finalId: current, path: visited };
    current = project.merged_into_project_id;
  }
  throw new Error(`Merged Project is missing its target: ${id}`);
}

function recordScopeProjectId(scope) {
  return typeof scope === "string" && scope.startsWith("project:") ? scope.slice("project:".length) : null;
}

async function renderViews(memoryRoot, source, snapshotVersion, pendingCount) {
  const records = source.records ?? [];
  const projects = source.projects ?? [];
  const events = source.events ?? [];
  const incomplete = source.views_complete !== true;
  const activeProfile = records.filter((record) => record.scope === "profile" && record.record_type === "profile_fact" && record.lifecycle_status === "active");
  await writeText(memoryRoot, "profile.md", activeProfile.length
    ? `# Profile\n\n${activeProfile.map(mirrorLine).sort().join("\n")}\n`
    : emptyView("Profile", incomplete));

  const globalGroups = new Map(VIEW_NAMES.map((name) => [name, []]));
  for (const record of records.filter((item) => item.scope === "global")) {
    const view = TERMINAL_RECORD_STATUSES.has(record.lifecycle_status)
      ? "archive.md"
      : record.lifecycle_status === "active" && ["state", "task", "decision"].includes(record.record_type)
        ? `${record.record_type}.md`
        : null;
    if (view) globalGroups.get(view).push(mirrorLine(record));
  }
  for (const event of events.filter((item) => item.event_scope === "global" && item.audit_visibility === "work_log")) {
    globalGroups.get("log.md").push(eventLine(event));
  }
  const activeProjects = projects.filter((project) => project.lifecycle_status !== "merged");
  for (const project of activeProjects) {
    const label = project.progress_status === "completed" || project.progress_status === "archived" ? "archive.md" : "state.md";
    globalGroups.get(label).push(`- \`${project.canonical_project_id}\` — ${project.name}: Project [progress_status=${project.progress_status}; version=${project.version}]`);
  }
  for (const name of VIEW_NAMES) {
    const lines = globalGroups.get(name).sort();
    await writeText(memoryRoot, `global/${name}`, lines.length ? `# Global / ${name.replace(".md", "")}\n\n${lines.join("\n")}\n` : emptyView(`Global / ${name.replace(".md", "")}`, incomplete));
  }

  for (const project of activeProjects) {
    const id = project.canonical_project_id;
    const groups = new Map(VIEW_NAMES.map((name) => [name, []]));
    for (const record of records) {
      const storedId = recordScopeProjectId(record.scope);
      if (!storedId) continue;
      const resolved = resolveProject(projects, storedId);
      if (resolved.finalId !== id) continue;
      const view = TERMINAL_RECORD_STATUSES.has(record.lifecycle_status)
        ? "archive.md"
        : record.lifecycle_status === "active" && ["state", "task", "decision"].includes(record.record_type)
          ? `${record.record_type}.md`
          : null;
      if (view) groups.get(view).push(mirrorLine(record));
    }
    for (const event of events) {
      const eventProject = recordScopeProjectId(event.event_scope);
      if (!eventProject || event.audit_visibility !== "work_log") continue;
      if (resolveProject(projects, eventProject).finalId === id) groups.get("log.md").push(eventLine(event));
    }
    for (const name of VIEW_NAMES) {
      const lines = groups.get(name).sort();
      await writeText(memoryRoot, `projects/${safeOpaquePath(id)}/${name}`, lines.length
        ? `# ${project.name} / ${name.replace(".md", "")}\n\n${lines.join("\n")}\n`
        : emptyView(`${project.name} / ${name.replace(".md", "")}`, incomplete));
    }
  }
  if (pendingCount > 0 && activeProjects.length === 0) {
    await writeText(memoryRoot, "projects/.pending-review", `${pendingCount} legacy items require canonical project mapping.\n`);
  }
}

export async function buildSnapshot({
  source,
  outputDirectory,
  buildEpoch,
  migrationRunId,
  generatorVersion = GENERATOR_VERSION,
  exportPolicyVersion = DEFAULT_EXPORT_POLICY_VERSION,
  failAfter = null,
}) {
  validateSource(source);
  assertIso(buildEpoch, "buildEpoch");
  if (typeof migrationRunId !== "string" || !migrationRunId) throw new Error("migrationRunId is required.");
  const { snapshotVersion, baselineClaim, generatorConfigHash } = makeSnapshotIdentity({
    source, buildEpoch, migrationRunId, generatorVersion, exportPolicyVersion,
  });
  const canonicalProjects = (source.projects ?? []).map(projectForV2Snapshot);
  const canonicalSource = { ...source, projects: canonicalProjects };
  const snapshotRoot = path.resolve(outputDirectory);
  const memoryRoot = path.resolve(snapshotRoot, "memory");
  if (await exists(snapshotRoot)) throw new Error(`Snapshot output already exists: ${snapshotRoot}`);
  await mkdir(memoryRoot, { recursive: true });
  const pending = [];
  const destinationMap = [];
  const byId = {};
  const byScope = { profile: [], global: [], projects: {}, storage_scope: {} };
  const byStatus = { pending_review: [], legacy_compatibility: [], merged_redirect: [] };
  const search = {};
  const receiptRefs = new Set(source.referenced_receipts ?? []);

  try {
    for (const project of [...canonicalProjects].sort((a, b) => a.canonical_project_id.localeCompare(b.canonical_project_id))) {
      const id = project.canonical_project_id;
      const relative = `objects/projects/${safeOpaquePath(id)}.json`;
      await writeJson(memoryRoot, relative, envelope("project", snapshotVersion, id, source.canonical_version, project));
      byId[id] = { path: relative, kind: "project", storage_scope: null, effective_scope: `project:${resolveProject(canonicalProjects, id).finalId}`, lifecycle_status: project.lifecycle_status, final_target_id: resolveProject(canonicalProjects, id).finalId, view_refs: [] };
      destinationMap.push({ source_kind: "project", source_id: id, destination: relative, disposition: "canonical_object" });
      if (project.receipt_id) receiptRefs.add(project.receipt_id);
      if (project.lifecycle_status === "merged") {
        const resolved = resolveProject(canonicalProjects, id);
        if (Array.isArray(project.redirect_path) && project.redirect_path.length > 0 && project.redirect_path.every((segment) => segment.merge_receipt_id && segment.source_committed_version && segment.target_committed_version)) {
          const redirectRelative = `projects/${safeOpaquePath(id)}/redirect.json`;
          const redirect = envelope("project_redirect", snapshotVersion, id, source.canonical_version, {
            source_project_id: id,
            final_target_project_id: resolved.finalId,
            redirect_path: project.redirect_path,
            closure_hash: sha256(canonicalJson(project.redirect_path)),
          }, { selfHash: true });
          await writeJson(memoryRoot, redirectRelative, redirect);
          byId[id].view_refs.push(redirectRelative);
          byStatus.merged_redirect.push(id);
        } else {
          pending.push({ kind: "project_redirect", id, reason: "missing_merge_proof" });
          byStatus.pending_review.push(id);
        }
      }
    }
    if (failAfter === "projects") throw new Error("INJECTED_FAILURE_AFTER_PROJECTS");

    for (const record of [...(source.records ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
      const relative = `objects/records/${safeOpaquePath(record.id)}.json`;
      await writeJson(memoryRoot, relative, envelope("record", snapshotVersion, record.id, source.canonical_version, record));
      const storedProject = recordScopeProjectId(record.scope);
      const effectiveProject = storedProject ? resolveProject(canonicalProjects, storedProject).finalId : null;
      const effectiveScope = effectiveProject ? `project:${effectiveProject}` : record.scope;
      byId[record.id] = { path: relative, kind: "record", storage_scope: record.scope, effective_scope: effectiveScope, lifecycle_status: record.lifecycle_status, final_target_id: record.merged_into ?? null, view_refs: [] };
      byScope.storage_scope[record.scope] ??= [];
      byScope.storage_scope[record.scope].push(record.id);
      if (effectiveScope === "profile") byScope.profile.push(record.id);
      else if (effectiveScope === "global") byScope.global.push(record.id);
      else {
        byScope.projects[effectiveProject] ??= [];
        byScope.projects[effectiveProject].push(record.id);
      }
      search[record.id] = { title: recordTitle(record), record_type: record.record_type, scope: effectiveScope, lifecycle_status: record.lifecycle_status };
      destinationMap.push({ source_kind: "record", source_id: record.id, destination: relative, disposition: "canonical_object" });
      if (record.receipt_id) receiptRefs.add(record.receipt_id);
    }

    const legacyGroups = [
      ["legacy_project", "project", source.legacy_projects ?? []],
      ["legacy_record", "record", source.legacy_records ?? []],
    ];
    for (const [kind, directory, items] of legacyGroups) {
      for (const item of [...items].sort((a, b) => a.legacy_id.localeCompare(b.legacy_id))) {
        const relative = `objects/legacy/${directory}/${safeOpaquePath(item.legacy_id)}.json`;
        await writeJson(memoryRoot, relative, envelope(kind, snapshotVersion, null, null, item));
        byId[`legacy:${kind}:${item.legacy_id}`] = { path: relative, kind, storage_scope: null, effective_scope: null, lifecycle_status: "pending_review", final_target_id: null, view_refs: [] };
        byStatus.pending_review.push(`legacy:${kind}:${item.legacy_id}`);
        byStatus.legacy_compatibility.push(`legacy:${kind}:${item.legacy_id}`);
        pending.push({ kind, id: item.legacy_id, reason: "legacy_schema_mapping_required" });
        destinationMap.push({ source_kind: kind, source_id: item.legacy_id, destination: relative, disposition: "legacy_compatibility" });
      }
    }
    if (failAfter === "objects") throw new Error("INJECTED_FAILURE_AFTER_OBJECTS");

    const rawEventInventory = [];
    for (const event of [...(source.events ?? [])].sort((a, b) => a.event_id.localeCompare(b.event_id))) {
      const relative = `events/raw/${safeOpaquePath(event.event_id)}.json`;
      let projection;
      if (event.event_scope === "profile" || event.audit_visibility === "audit_only") {
        projection = envelope("event_stub", snapshotVersion, event.event_id, source.canonical_version, {
          event_id: event.event_id,
          event_stream_id: event.event_stream_id ?? null,
          stream_generation: event.stream_generation ?? null,
          event_sequence: event.event_sequence ?? null,
          committed_canonical_version: event.committed_canonical_version,
          event_scope: event.event_scope,
          audit_visibility: event.audit_visibility,
          content_hash: event.content_hash,
          omitted_reason: event.audit_visibility === "audit_only" ? "audit_only" : "sensitive",
          erased_at: null,
          erase_receipt_id: null,
        });
      } else {
        const actorKind = event.actor_user_id == null && event.actor_binding_id === "system" ? "system" : event.actor_binding_id ? "agent_binding" : "self";
        const actorRef = actorKind === "agent_binding" ? `actor_${sha256(`${snapshotVersion}:${event.actor_binding_id}`).slice(0, 20)}` : null;
        const data = structuredClone(event);
        delete data.actor_user_id;
        delete data.actor_binding_id;
        delete data.content_hash;
        data.actor_kind = actorKind;
        data.actor_ref = actorRef;
        data.canonical_content_hash = event.content_hash;
        const projected = envelope("event", snapshotVersion, event.event_id, source.canonical_version, data);
        projected.data.export_content_hash = sha256(canonicalJson(projected.data));
        projection = projected;
      }
      await writeJson(memoryRoot, relative, projection);
      byId[event.event_id] = { path: relative, kind: projection.kind, storage_scope: event.event_scope, effective_scope: event.event_scope, lifecycle_status: null, final_target_id: null, view_refs: [] };
      rawEventInventory.push({ event_id: event.event_id, committed_canonical_version: event.committed_canonical_version, disposition: projection.kind, canonical_content_hash: event.content_hash });
      destinationMap.push({ source_kind: "event", source_id: event.event_id, destination: relative, disposition: projection.kind });
      receiptRefs.add(event.receipt_id);
    }
    for (const item of [...(source.legacy_events ?? [])].sort((a, b) => a.legacy_id.localeCompare(b.legacy_id))) {
      const relative = `events/raw/${safeOpaquePath(item.legacy_id)}.json`;
      await writeJson(memoryRoot, relative, envelope("legacy_event", snapshotVersion, null, null, item));
      const key = `legacy:legacy_event:${item.legacy_id}`;
      byId[key] = { path: relative, kind: "legacy_event", storage_scope: null, effective_scope: null, lifecycle_status: "pending_review", final_target_id: null, view_refs: [] };
      byStatus.pending_review.push(key);
      byStatus.legacy_compatibility.push(key);
      pending.push({ kind: "legacy_event", id: item.legacy_id, reason: "legacy_schema_mapping_required" });
      rawEventInventory.push({ legacy_id: item.legacy_id, disposition: "legacy_event", content_hash: item.content_hash });
      destinationMap.push({ source_kind: "legacy_event", source_id: item.legacy_id, destination: relative, disposition: "legacy_compatibility" });
    }

    for (const item of [...(source.evidence ?? [])].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id))) {
      const id = item.evidence_id;
      const metadataRelative = `evidence/items/${safeOpaquePath(id)}/metadata.json`;
      const data = { ...item, export_disposition: item.export_disposition ?? "omitted" };
      await writeJson(memoryRoot, metadataRelative, envelope("evidence_metadata", snapshotVersion, id, source.canonical_version, data));
      if (item.export_disposition === "included" && typeof item.inline_payload === "string" && !hasSecret(item.inline_payload)) {
        await writeText(memoryRoot, `evidence/items/${safeOpaquePath(id)}/payload`, item.inline_payload);
      } else {
        await writeJson(memoryRoot, `evidence/items/${safeOpaquePath(id)}/omitted.json`, { content_hash: item.content_hash, protected_storage_ref: item.storage_ref, omitted_reason: item.omitted_reason ?? "unauthorized" });
      }
      byId[id] = { path: metadataRelative, kind: "evidence_metadata", storage_scope: null, effective_scope: null, lifecycle_status: null, final_target_id: null, view_refs: [] };
      destinationMap.push({ source_kind: "evidence", source_id: id, destination: metadataRelative, disposition: data.export_disposition });
      if (item.receipt_id) receiptRefs.add(item.receipt_id);
    }
    for (const item of [...(source.legacy_evidence ?? [])].sort((a, b) => a.legacy_id.localeCompare(b.legacy_id))) {
      const base = `evidence/legacy/${safeOpaquePath(item.legacy_id)}`;
      const metadataRelative = `${base}.json`;
      await writeJson(memoryRoot, metadataRelative, envelope("legacy_evidence", snapshotVersion, null, null, item));
      if (typeof item.inline_payload === "string" && !hasSecret(item.inline_payload)) await writeText(memoryRoot, `${base}.payload`, item.inline_payload);
      else await writeJson(memoryRoot, `${base}.omitted.json`, { content_hash: item.content_hash, protected_payload_ref: item.protected_payload_ref, omitted_reason: item.omitted_reason ?? "unauthorized" });
      destinationMap.push({ source_kind: "legacy_evidence", source_id: item.legacy_id, destination: metadataRelative, disposition: item.omitted_reason ? "omitted_stub" : "preserved" });
    }

    await renderViews(memoryRoot, canonicalSource, snapshotVersion, pending.length);
    for (const section of Object.values(byScope)) {
      if (Array.isArray(section)) section.sort();
      else for (const ids of Object.values(section)) ids.sort();
    }
    for (const ids of Object.values(byStatus)) ids.sort();
    const index = { schema_version: INDEX_SCHEMA_VERSION, snapshot_version: snapshotVersion, by_id: byId, by_scope: byScope, by_status: byStatus, search };
    await writeJson(memoryRoot, "index.json", index);

    const sourceInventory = {
      canonical_counts: sourceCounts(source),
      legacy_counts: {
        projects: (source.legacy_projects ?? []).length,
        records: (source.legacy_records ?? []).length,
        events: (source.legacy_events ?? []).length,
        evidence: (source.legacy_evidence ?? []).length,
      },
      excluded_evidence_counts: source.excluded_evidence_counts ?? {},
      source_git_commit: source.source_git_commit ?? null,
    };
    const reportRelative = `evidence/migration/${snapshotVersion}/migration-report.json`;
    const report = {
      schema_version: 1,
      snapshot_version: snapshotVersion,
      migration_run_id: migrationRunId,
      source_inventory: sourceInventory,
      destination_map: destinationMap.sort((a, b) => `${a.source_kind}:${a.source_id}`.localeCompare(`${b.source_kind}:${b.source_id}`)),
      raw_event_inventory: rawEventInventory,
      pending_review: pending,
      validation: { status: "ready", errors: [], semantic_changes: 0, automatic_merges: 0, scope_changes: 0 },
    };
    await writeJson(memoryRoot, reportRelative, report);

    const allBeforeManifest = (await listFiles(memoryRoot)).filter((name) => name !== "manifest.json");
    const files = await Promise.all(allBeforeManifest.map((relative) => descriptor(memoryRoot, relative, snapshotVersion)));
    const objectCount = files.filter((file) => file.path.startsWith("objects/") && file.path.endsWith(".json")).length;
    const rawEventCount = files.filter((file) => file.path.startsWith("events/raw/") && file.path.endsWith(".json")).length;
    const evidenceItemCount = files.filter((file) => file.path.startsWith("evidence/items/") && file.path.endsWith("/metadata.json")).length;
    const legacyItemCount = files.filter((file) => file.path.startsWith("objects/legacy/") || file.path.includes("legacy_event") || file.path.startsWith("evidence/legacy/") && file.path.endsWith(".json")).length;
    const reportHash = sha256(await readFile(path.resolve(memoryRoot, reportRelative)));
    const manifest = {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      contract: SNAPSHOT_CONTRACT,
      snapshot_version: snapshotVersion,
      canonical_version: source.canonical_version,
      bundle_scope: "user",
      owner_ref: source.owner_ref ?? null,
      export_receipt_id: source.export_receipt_id ?? null,
      migration_run_id: migrationRunId,
      status: "ready",
      baseline_claim: baselineClaim,
      source_verification: source.source_verification,
      views_stale: false,
      views_complete: source.views_complete === true,
      generated_at: new Date(buildEpoch).toISOString(),
      generator_version: generatorVersion,
      generator_config_hash: generatorConfigHash,
      export_policy_version: exportPolicyVersion,
      build_epoch: new Date(buildEpoch).toISOString(),
      event_rollups_enabled: false,
      receipt_export: "references_only",
      index: { path: "index.json", schema_version: INDEX_SCHEMA_VERSION },
      canonical_counts: sourceCounts(source),
      snapshot_counts: {
        objects: objectCount,
        raw_events: rawEventCount,
        raw_event_stubs: files.filter((file) => file.path.startsWith("events/raw/")).length - (source.events ?? []).filter((event) => event.audit_visibility === "work_log" && event.event_scope !== "profile").length - (source.legacy_events ?? []).length,
        erasure_tombstones: 0,
        event_rollups: 0,
        evidence_items: evidenceItemCount,
        legacy_items: legacyItemCount,
        pending_review: pending.length,
      },
      source_inventory_hash: sha256(canonicalJson(sourceInventory)),
      destination_map_hash: sha256(canonicalJson(report.destination_map)),
      event_stream_ordering_enabled: false,
      raw_event_inventory_hash: sha256(canonicalJson(rawEventInventory)),
      event_stream_coverage_hash: null,
      receipt_refs_hash: sha256(canonicalJson([...receiptRefs].sort())),
      reports: [{ path: reportRelative, sha256: reportHash }],
      files,
    };
    await writeJson(memoryRoot, "manifest.json", manifest);
    await validateSnapshot(snapshotRoot);
    return { snapshotRoot, memoryRoot, manifest };
  } catch (error) {
    await writeJson(snapshotRoot, "failure-report.json", {
      schema_version: 1,
      snapshot_version: snapshotVersion,
      migration_run_id: migrationRunId,
      status: "failed",
      views_stale: true,
      error_code: error.message,
      failed_at: new Date(buildEpoch).toISOString(),
      retry_count: 0,
    });
    throw error;
  }
}

export async function validateSnapshot(snapshotDirectory) {
  const snapshotRoot = path.resolve(snapshotDirectory);
  const memoryRoot = path.resolve(snapshotRoot, "memory");
  const manifestPath = path.resolve(memoryRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS.has(manifest.schema_version) || manifest.contract !== SNAPSHOT_CONTRACT) throw new Error("Unsupported snapshot contract.");
  if (manifest.status !== "ready" || manifest.views_stale !== false) throw new Error("Only a ready, non-stale snapshot is valid.");
  if (manifest.index?.path !== "index.json" || manifest.index?.schema_version !== INDEX_SCHEMA_VERSION) throw new Error("Snapshot must contain one canonical index.json.");
  if (manifest.event_rollups_enabled !== false || manifest.snapshot_counts?.event_rollups !== 0) throw new Error("M0 cannot claim Event Rollups.");
  if (manifest.event_stream_ordering_enabled !== false || manifest.event_stream_coverage_hash !== null) throw new Error("M0 ordering extension must remain disabled.");
  const actualFiles = (await listFiles(memoryRoot)).filter((name) => name !== "manifest.json");
  if (actualFiles.includes("object-index.json") || actualFiles.filter((name) => name === "index.json").length !== 1) throw new Error("Bundle index is not singular.");
  const declared = [...(manifest.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  if (canonicalJson(actualFiles.sort()) !== canonicalJson(declared.map((item) => item.path))) throw new Error("Manifest file inventory does not match the snapshot.");
  for (const item of declared) {
    safeRelativePath(item.path);
    if (item.snapshot_version !== manifest.snapshot_version) throw new Error(`Mixed snapshot version in ${item.path}.`);
    const actual = await descriptor(memoryRoot, item.path, manifest.snapshot_version);
    if (actual.sha256 !== item.sha256) throw new Error(`Snapshot checksum mismatch: ${item.path}`);
  }
  const index = JSON.parse(await readFile(path.resolve(memoryRoot, "index.json"), "utf8"));
  if (index.schema_version !== INDEX_SCHEMA_VERSION || index.snapshot_version !== manifest.snapshot_version) throw new Error("Index version does not match Manifest.");
  if (index.by_status?.pending_review?.length !== manifest.snapshot_counts.pending_review) throw new Error("Pending-review count is inconsistent.");
  const reportRef = manifest.reports?.[0];
  if (!reportRef) throw new Error("Migration report is required.");
  assertHex(reportRef.sha256, "reports[0].sha256");
  const reportBytes = await readFile(path.resolve(memoryRoot, reportRef.path));
  if (sha256(reportBytes) !== reportRef.sha256) throw new Error("Migration report hash mismatch.");
  const report = JSON.parse(reportBytes.toString("utf8"));
  if (report.snapshot_version !== manifest.snapshot_version || report.migration_run_id !== manifest.migration_run_id) throw new Error("Migration report identity mismatch.");
  if (sha256(canonicalJson(report.source_inventory)) !== manifest.source_inventory_hash) throw new Error("Source inventory hash mismatch.");
  if (sha256(canonicalJson(report.destination_map)) !== manifest.destination_map_hash) throw new Error("Destination map hash mismatch.");
  if (sha256(canonicalJson(report.raw_event_inventory)) !== manifest.raw_event_inventory_hash) throw new Error("Raw Event inventory hash mismatch.");
  if (report.pending_review.length !== manifest.snapshot_counts.pending_review) throw new Error("Migration report pending-review mismatch.");
  return { manifest, index, report };
}

async function syncFile(filePath) {
  const handle = await open(filePath, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWriteJson(filePath, value, { failAt = null } = {}) {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true });
  const temporary = path.resolve(parent, `.current.${process.pid}.${sha256(canonicalJson(value)).slice(0, 12)}.tmp`);
  try {
    if (failAt === "pointer_temp_write") throw new Error("INJECTED_FAILURE:pointer_temp_write");
    await writeFile(temporary, prettyJson(value), "utf8");
    if (failAt === "pointer_fsync") throw new Error("INJECTED_FAILURE:pointer_fsync");
    await syncFile(temporary);
    if (failAt === "pointer_rename") throw new Error("INJECTED_FAILURE:pointer_rename");
    await rename(temporary, filePath);
    if (failAt === "pointer_directory_sync") throw new Error("INJECTED_FAILURE:pointer_directory_sync");
    try {
      const directory = await open(parent, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (failAt === "pointer_directory_sync") throw error;
      // Windows does not consistently allow directory handles; file sync + atomic rename remains enforced.
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function publicationPaths(exportRoot) {
  const root = path.resolve(exportRoot);
  return {
    root,
    published: path.resolve(root, "published"),
    staging: path.resolve(root, "staging"),
    current: path.resolve(root, "current.json"),
    runtime: path.resolve(root, "m2", "runtime"),
    lock: path.resolve(root, "m2", "runtime", "publish.lock"),
    transitionLock: path.resolve(root, "m2", "runtime", "publish.lock.transition"),
  };
}

async function delay(milliseconds) {
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function observePublicationLock(lockPath) {
  try {
    const [bytes, lockStat] = await Promise.all([readFile(lockPath), stat(lockPath)]);
    let payload = null;
    try {
      payload = JSON.parse(bytes.toString("utf8"));
    } catch {
      // A malformed lock still participates in stale detection, but never in an owner release.
    }
    return {
      identity: sha256(bytes),
      lockStat,
      payload,
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function isPublicationTransitionContentionError(error, platform = process.platform) {
  return error?.code === "EEXIST" || (platform === "win32" && error?.code === "EPERM");
}

async function acquirePublicationTransitionLock(paths, operation) {
  for (const waitMs of PUBLICATION_TRANSITION_RETRY_MS) {
    await delay(waitMs);
    let handle;
    try {
      handle = await open(paths.transitionLock, "wx");
    } catch (error) {
      if (!isPublicationTransitionContentionError(error)) throw error;
      continue;
    }
    const transition = {
      lock_schema_version: 1,
      operation,
      owner_ref: `pid:${process.pid}`,
      owner_token: randomUUID(),
      acquired_at: new Date().toISOString(),
    };
    try {
      await handle.writeFile(prettyJson(transition), "utf8");
      await handle.sync();
      return transition;
    } catch (error) {
      await rm(paths.transitionLock, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  }
  throw new Error("publication_lock_transition_busy");
}

async function withPublicationLockTransition(paths, operation, callback) {
  await acquirePublicationTransitionLock(paths, operation);
  try {
    return await callback();
  } finally {
    try {
      await rm(paths.transitionLock, { force: false });
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("publication_lock_transition_lost");
      throw error;
    }
  }
}

async function createSnapshotPublicationLock(paths, { occurredAt, operation }) {
  const handle = await open(paths.lock, "wx");
  const lock = {
    lock_schema_version: 2,
    operation,
    owner_ref: `pid:${process.pid}`,
    owner_token: randomUUID(),
    acquired_at: new Date().toISOString(),
    requested_at: occurredAt,
  };
  try {
    await handle.writeFile(prettyJson(lock), "utf8");
    await handle.sync();
    return lock;
  } catch (error) {
    await rm(paths.lock, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

async function tryAcquireSnapshotPublicationLock(paths, options) {
  return withPublicationLockTransition(paths, `acquire:${options.operation}`, async () => {
    try {
      return await createSnapshotPublicationLock(paths, options);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const observation = await observePublicationLock(paths.lock);
    if (!observation) return createSnapshotPublicationLock(paths, options);
    const ageSeconds = Math.max(0, Date.now() - observation.lockStat.mtimeMs) / 1_000;
    if (ageSeconds <= options.policy.stale_lock_seconds) return null;
    await rm(paths.lock, { force: false });
    return createSnapshotPublicationLock(paths, options);
  });
}

async function releaseSnapshotPublicationLock(paths, acquiredLock) {
  return withPublicationLockTransition(paths, `release:${acquiredLock.operation}`, async () => {
    const observation = await observePublicationLock(paths.lock);
    if (!observation) return false;
    if (
      typeof acquiredLock.owner_token !== "string"
      || observation.payload?.owner_token !== acquiredLock.owner_token
    ) return false;
    try {
      await rm(paths.lock, { force: false });
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
}

async function acquireSnapshotPublicationLock(paths, { occurredAt, operation, policy }) {
  assertIso(occurredAt, "occurredAt");
  await mkdir(paths.runtime, { recursive: true });
  const schedule = [0, ...(policy.retry_schedule_ms ?? [])];
  for (let attempt = 0; attempt < schedule.length; attempt += 1) {
    await delay(schedule[attempt]);
    const lock = await tryAcquireSnapshotPublicationLock(paths, { occurredAt, operation, policy });
    if (lock) return lock;
    if (attempt === schedule.length - 1) throw new Error("publication_lock_busy");
  }
  throw new Error("publication_lock_busy");
}

export async function withSnapshotPublicationLock({
  exportRoot,
  occurredAt,
  operation,
  policy = SNAPSHOT_PUBLICATION_LOCK_POLICY,
}, callback) {
  const paths = publicationPaths(exportRoot);
  const acquiredLock = await acquireSnapshotPublicationLock(paths, { occurredAt, operation, policy });
  try {
    return await callback(paths);
  } finally {
    await releaseSnapshotPublicationLock(paths, acquiredLock);
  }
}

async function readPointerIfPresent(pointerPath) {
  if (!await exists(pointerPath)) return null;
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  if (pointer.pointer_schema_version !== 1 || typeof pointer.snapshot_version !== "string") {
    throw new Error("invalid_current_pointer");
  }
  return pointer;
}

export async function readFormalSnapshot({ exportRoot }) {
  const paths = publicationPaths(exportRoot);
  const pointer = await readPointerIfPresent(paths.current);
  if (!pointer) throw new Error("current_pointer_missing");
  if (pointer.bundle_path !== `published/${pointer.snapshot_version}/memory`) {
    throw new Error("current_pointer_bundle_path_mismatch");
  }
  const snapshotRoot = path.resolve(paths.published, pointer.snapshot_version);
  const { manifest } = await validateSnapshot(snapshotRoot);
  const manifestHash = sha256(await readFile(path.resolve(snapshotRoot, "memory", "manifest.json")));
  if (manifestHash !== pointer.manifest_sha256) throw new Error("current_pointer_manifest_hash_mismatch");
  if (manifest.snapshot_version !== pointer.snapshot_version) throw new Error("current_pointer_snapshot_mismatch");
  return { pointer, manifest, snapshotRoot, manifestHash };
}

async function publishImmutableSnapshot({ snapshotDirectory, paths, manifest, failAt }) {
  const destination = path.resolve(paths.published, manifest.snapshot_version);
  if (await exists(destination)) {
    const existing = await validateSnapshot(destination);
    if (canonicalJson(existing.manifest) !== canonicalJson(manifest)) throw new Error("Published snapshot identity already exists with different bytes.");
  } else {
    const staging = path.resolve(paths.staging, `${manifest.snapshot_version}.${process.pid}`);
    await mkdir(paths.staging, { recursive: true });
    await rm(staging, { recursive: true, force: true });
    try {
      if (failAt === "staging_copy") throw new Error("INJECTED_FAILURE:staging_copy");
      await cp(path.resolve(snapshotDirectory), staging, { recursive: true, force: false, errorOnExist: true });
      if (failAt === "staging_hash") {
        await writeFile(path.resolve(staging, "memory", "global", "state.md"), "INJECTED_CORRUPTION\n", "utf8");
      }
      await validateSnapshot(staging);
      await mkdir(paths.published, { recursive: true });
      if (failAt === "immutable_promote") throw new Error("INJECTED_FAILURE:immutable_promote");
      await rename(staging, destination);
      await validateSnapshot(destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return destination;
}

function pointerFor(manifest, manifestHash, previousSnapshotVersion) {
  return {
    pointer_schema_version: 1,
    snapshot_version: manifest.snapshot_version,
    bundle_path: `published/${manifest.snapshot_version}/memory`,
    manifest_sha256: manifestHash,
    previous_snapshot_version: previousSnapshotVersion,
  };
}

async function restorePointer(paths, previousPointer) {
  if (previousPointer) {
    await atomicWriteJson(paths.current, previousPointer);
    const restored = await readFormalSnapshot({ exportRoot: paths.root });
    if (canonicalJson(restored.pointer) !== canonicalJson(previousPointer)) throw new Error("pointer_recovery_readback_failed");
  } else {
    await rm(paths.current, { force: true });
  }
}

export async function publishSnapshot({
  snapshotDirectory,
  exportRoot,
  activate = false,
  expectedCurrentSnapshotVersion,
  publishedAt = new Date().toISOString(),
  lockPolicy = SNAPSHOT_PUBLICATION_LOCK_POLICY,
  failAt = null,
  afterSwitch = null,
  afterRecovery = null,
}) {
  const { manifest } = await validateSnapshot(snapshotDirectory);
  if (activate && expectedCurrentSnapshotVersion === undefined) {
    throw new Error("expected_current_required");
  }
  return withSnapshotPublicationLock({ exportRoot, occurredAt: publishedAt, operation: activate ? "publish_activate" : "publish_offline", policy: lockPolicy }, async (paths) => {
    const previousPointer = await readPointerIfPresent(paths.current);
    const actualCurrent = previousPointer?.snapshot_version ?? null;
    if (activate && actualCurrent !== expectedCurrentSnapshotVersion) throw new Error("stale_current_pointer");
    const destination = await publishImmutableSnapshot({ snapshotDirectory, paths, manifest, failAt });
    if (!activate) return { status: "published_offline", snapshot_version: manifest.snapshot_version, destination };
    if (manifest.baseline_claim !== "current" || manifest.source_verification !== "live_rechecked" || manifest.views_complete !== true) {
      throw new Error("Only a complete, live-rechecked current snapshot may become the formal pointer.");
    }
    const manifestHash = sha256(await readFile(path.resolve(destination, "memory", "manifest.json")));
    const pointer = pointerFor(manifest, manifestHash, actualCurrent);
    let switched = false;
    try {
      await atomicWriteJson(paths.current, pointer, { failAt });
      switched = true;
      if (failAt === "formal_readback") throw new Error("INJECTED_FAILURE:formal_readback");
      const formal = await readFormalSnapshot({ exportRoot });
      if (canonicalJson(formal.pointer) !== canonicalJson(pointer)) throw new Error("formal_pointer_readback_failed");
      if (afterSwitch) await afterSwitch({ pointer, formal, previousPointer });
      if (failAt === "post_switch_audit") throw new Error("INJECTED_FAILURE:post_switch_audit");
      return {
        status: "activated",
        pointer,
        receipt: {
          contract: "clued.snapshot-publication-receipt.v1",
          operation: "publish",
          occurred_at: publishedAt,
          expected_current: expectedCurrentSnapshotVersion,
          previous_current: actualCurrent,
          new_current: pointer.snapshot_version,
          result: "success",
          receipt_id: `pub_${sha256(canonicalJson({ publishedAt, pointer, expectedCurrentSnapshotVersion })).slice(0, 32)}`,
        },
      };
    } catch (error) {
      if (switched || await exists(paths.current)) {
        const active = await readPointerIfPresent(paths.current).catch(() => null);
        if (switched || active?.snapshot_version === pointer.snapshot_version) {
          await restorePointer(paths, previousPointer);
          if (afterRecovery) await afterRecovery({ previousPointer, failedPointer: pointer, error });
        }
      }
      throw error;
    }
  });
}

export async function rollbackSnapshot({
  exportRoot,
  expectedCurrentSnapshotVersion,
  rolledBackAt = new Date().toISOString(),
  lockPolicy = SNAPSHOT_PUBLICATION_LOCK_POLICY,
  failAt = null,
  afterSwitch = null,
  afterRecovery = null,
}) {
  if (expectedCurrentSnapshotVersion === undefined) throw new Error("expected_current_required");
  return withSnapshotPublicationLock({ exportRoot, occurredAt: rolledBackAt, operation: "rollback", policy: lockPolicy }, async (paths) => {
    const current = await readPointerIfPresent(paths.current);
    if (!current || current.snapshot_version !== expectedCurrentSnapshotVersion) throw new Error("stale_current_pointer");
    if (!current.previous_snapshot_version) throw new Error("No previous snapshot is available for rollback.");
    const previousRoot = path.resolve(paths.published, current.previous_snapshot_version);
    const { manifest } = await validateSnapshot(previousRoot);
    const manifestHash = sha256(await readFile(path.resolve(previousRoot, "memory", "manifest.json")));
    const rolledBack = pointerFor(manifest, manifestHash, current.snapshot_version);
    let switched = false;
    try {
      await atomicWriteJson(paths.current, rolledBack, { failAt });
      switched = true;
      if (failAt === "formal_readback") throw new Error("INJECTED_FAILURE:formal_readback");
      const formal = await readFormalSnapshot({ exportRoot });
      if (canonicalJson(formal.pointer) !== canonicalJson(rolledBack)) throw new Error("formal_pointer_readback_failed");
      if (afterSwitch) await afterSwitch({ pointer: rolledBack, formal, previousPointer: current });
      return {
        status: "rolled_back",
        pointer: rolledBack,
        receipt: {
          contract: "clued.snapshot-publication-receipt.v1",
          operation: "rollback",
          occurred_at: rolledBackAt,
          expected_current: expectedCurrentSnapshotVersion,
          previous_current: current.snapshot_version,
          new_current: rolledBack.snapshot_version,
          result: "success",
          receipt_id: `rb_${sha256(canonicalJson({ rolledBackAt, rolledBack, expectedCurrentSnapshotVersion })).slice(0, 32)}`,
        },
      };
    } catch (error) {
      if (switched || (await readPointerIfPresent(paths.current).catch(() => null))?.snapshot_version === rolledBack.snapshot_version) {
        await restorePointer(paths, current);
        if (afterRecovery) await afterRecovery({ previousPointer: current, failedPointer: rolledBack, error });
      }
      throw error;
    }
  });
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  const flags = new Set(["--activate"]);
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (flags.has(name)) { options[name.slice(2)] = true; continue; }
    if (!["--source", "--legacy-memory", "--source-commit", "--canonical-version", "--output", "--build-epoch", "--migration-run-id", "--snapshot", "--export-root", "--expected-current", "--at"].includes(name)) throw new Error(`Unknown argument: ${name}`);
    const value = argv[++index];
    if (!value) throw new Error(`${name} requires a value.`);
    options[name.slice(2).replaceAll("-", "_")] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "build") {
    const source = options.source
      ? JSON.parse(await readFile(path.resolve(options.source), "utf8"))
      : await readLegacyMemorySource({ memoryDirectory: path.resolve(options.legacy_memory), canonicalVersion: options.canonical_version, sourceGitCommit: options.source_commit });
    const result = await buildSnapshot({ source, outputDirectory: path.resolve(options.output), buildEpoch: options.build_epoch, migrationRunId: options.migration_run_id });
    process.stdout.write(`${JSON.stringify({ status: "ready", snapshot_version: result.manifest.snapshot_version, baseline_claim: result.manifest.baseline_claim, views_complete: result.manifest.views_complete, pending_review: result.manifest.snapshot_counts.pending_review })}\n`);
    return;
  }
  if (command === "validate") {
    const result = await validateSnapshot(path.resolve(options.snapshot));
    process.stdout.write(`${JSON.stringify({ status: "valid", snapshot_version: result.manifest.snapshot_version })}\n`);
    return;
  }
  if (command === "publish") {
    const expectedCurrent = options.expected_current === "NONE" ? null : options.expected_current;
    const result = await publishSnapshot({
      snapshotDirectory: path.resolve(options.snapshot),
      exportRoot: path.resolve(options.export_root),
      activate: options.activate ?? false,
      expectedCurrentSnapshotVersion: options.activate ? expectedCurrent : undefined,
      publishedAt: options.at ?? new Date().toISOString(),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "rollback") {
    const result = await rollbackSnapshot({
      exportRoot: path.resolve(options.export_root),
      expectedCurrentSnapshotVersion: options.expected_current,
      rolledBackAt: options.at ?? new Date().toISOString(),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error("Usage: two-level-snapshot.mjs <build|validate|publish|rollback> [options]");
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
