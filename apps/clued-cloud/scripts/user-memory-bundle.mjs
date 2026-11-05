#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const BUNDLE_CONTRACT = "clued.user-memory-bundle";
export const BUNDLE_VERSION = "2.0.0";
export const BUNDLE_SCHEMA_VERSION = 2;
const READABLE_BUNDLE_VERSIONS = new Map([
  [1, "1.0.0"],
  [2, "2.0.0"],
]);

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LEGACY_EVIDENCE = [
  "画像.md",
  "状态.md",
  "决策.md",
  "待办.md",
  "归档.md",
];
const CONTEXT_EVIDENCE = ["contexts/projects/clued/日志.md"];
const AUDIT_EVIDENCE = ["audit/audit.log"];
const EXCLUDED_SYSTEM_PATHS = [
  "index.json",
  "object-index.json",
  "contexts/routes.json",
  "contexts/README.md",
  "session/",
];
const VIEW_FILES = ["State.md", "Task.md", "Decision.md", "Archive.md", "Log.md"];
const LEGAL_RECORD_STATUSES = {
  note: new Set(["active", "archived"]),
  state: new Set(["current", "superseded", "archived"]),
  task: new Set(["backlog", "ready", "in_progress", "blocked", "done", "cancelled", "archived"]),
  decision: new Set(["active", "superseded", "archived"]),
  archive_snapshot: new Set(["archived"]),
};

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function assertString(value, name, { min = 1, max = Infinity } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`${name} must be a string between ${min} and ${max} characters.`);
  }
}

function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe bundle path: ${value}`);
  }
  return value;
}

// Resolve links before opening a source. Compare path segments, not string prefixes:
// a sibling named "memory-outside" is not inside an authorized "memory" root.
async function containedPath(root, relativePath) {
  safeRelativePath(relativePath);
  const authorizedRoot = await realpath(root);
  const resolved = await realpath(path.resolve(authorizedRoot, relativePath));
  const relative = path.relative(authorizedRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes authorized root: ${relativePath}`);
  }
  return resolved;
}

function projectDirectory(sourceProjectId) {
  return encodeURIComponent(sourceProjectId).replaceAll("%", "~");
}

function titleFromObject(object) {
  const category = object.classification?.category ?? object.type;
  const normalized = object.content.replace(/\s+/g, " ").trim();
  const firstSentence = normalized.split(/[。！？!?\n]/, 1)[0].trim();
  const fallback = `${category} · ${object.id}`;
  return (firstSentence || fallback).slice(0, 120);
}

function targetRecordType(object) {
  const category = object.classification?.category;
  if (category === "state") return "state";
  if (category === "todo") return "task";
  if (category === "decision" || category === "constraint") return "decision";
  if (category === "history" || object.status === "superseded") return "archive_snapshot";
  return "note";
}

function targetStatus(object, recordType) {
  if (recordType === "archive_snapshot") return "archived";
  if (object.status === "candidate") {
    return recordType === "task" ? "backlog" : "archived";
  }
  if (recordType === "state") return "current";
  if (recordType === "task") return "in_progress";
  if (recordType === "decision") return "active";
  return "active";
}

function targetPriority(object) {
  return object.classification?.priority === "high" ? 80 : 40;
}

export function mapMemoryObject(object) {
  if (!object || typeof object !== "object") throw new Error("Memory object must be an object.");
  assertString(object.id, "memory object id", { max: 160 });
  assertString(object.content, `${object.id}.content`, { max: 8000 });
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(object.id)) {
    throw new Error(`Unsupported memory object id: ${object.id}`);
  }
  if (!["global", "project", "machine"].includes(object.scope)) {
    throw new Error(`Unsupported scope for ${object.id}: ${object.scope}`);
  }
  if (object.scope === "project") assertString(object.project_id, `${object.id}.project_id`, { max: 120 });

  const recordType = targetRecordType(object);
  const scope = object.scope === "project" ? "project" : "global";
  return {
    source_id: object.id,
    source_schema_version: object.schema_version,
    source_type: object.type,
    source_category: object.classification?.category ?? null,
    source_status: object.status,
    scope,
    source_project_id: scope === "project" ? object.project_id : null,
    record_type: recordType,
    record_key: `umb:v1:${object.id}`,
    title: titleFromObject(object),
    content: object.content,
    status: targetStatus(object, recordType),
    priority: targetPriority(object),
    source_ref: object.provenance?.source_ref ?? null,
    source_updated_at: object.source?.updated_at ?? null,
    version: 1,
  };
}

function projectFromRecords(sourceProjectId, records) {
  return {
    source_project_id: sourceProjectId,
    name: sourceProjectId,
    progress_status: "active",
    recognition_evidence: "Existing structured project memories are material-work evidence.",
    record_count: records.filter((record) => record.source_project_id === sourceProjectId).length,
  };
}

function viewFileFor(record) {
  if (record.record_type === "state") return "State.md";
  if (record.record_type === "task") return "Task.md";
  if (record.record_type === "decision") return "Decision.md";
  if (record.record_type === "archive_snapshot") return "Archive.md";
  return "State.md";
}

function mirrorReference(record) {
  const category = record.source_category ?? record.source_type;
  return `- \`${record.source_id}\` — ${category}: Source record reference; see records.jsonl#${record.source_id} [status=${record.status}; version=${record.version}]`;
}

async function writeMirrors(outputDirectory, records) {
  const groups = new Map();
  for (const record of records) {
    const base = record.scope === "global"
      ? "Global"
      : `Projects/${projectDirectory(record.source_project_id)}`;
    const relativePath = `${base}/${viewFileFor(record)}`;
    const lines = groups.get(relativePath) ?? [];
    lines.push(mirrorReference(record));
    groups.set(relativePath, lines);
  }

  const bases = new Set(["Global"]);
  for (const record of records) {
    if (record.scope === "project") bases.add(`Projects/${projectDirectory(record.source_project_id)}`);
  }
  for (const base of [...bases].sort()) {
    for (const view of VIEW_FILES) {
      const relativePath = `${base}/${view}`;
      const lines = (groups.get(relativePath) ?? []).sort();
      const heading = `# ${path.basename(base)} / ${view.replace(/\.md$/, "")}`;
      const body = lines.length > 0 ? `${lines.join("\n")}\n` : "_No records in this view._\n";
      const absolutePath = path.resolve(outputDirectory, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, `${heading}\n\n${body}`, "utf8");
    }
  }
}

async function copyEvidence(memoryDirectory, outputDirectory) {
  const copied = [];
  for (const relativePath of [...LEGACY_EVIDENCE, ...CONTEXT_EVIDENCE, ...AUDIT_EVIDENCE]) {
    let source;
    try {
      source = await containedPath(memoryDirectory, relativePath);
      if (!(await stat(source)).isFile()) continue;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const targetRelative = `evidence/${relativePath}`;
    const target = path.resolve(outputDirectory, targetRelative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    copied.push(targetRelative);
  }
  return copied;
}

async function listBundleFiles(root, relative = "") {
  const directory = relative ? await containedPath(root, relative) : await realpath(root);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    await containedPath(root, child);
    if (entry.isDirectory()) files.push(...await listBundleFiles(root, child));
    else if (entry.isFile() && child !== "manifest.json") files.push(child);
  }
  return files;
}

async function fileDescriptor(root, relativePath) {
  safeRelativePath(relativePath);
  const bytes = await readFile(await containedPath(root, relativePath));
  return { path: relativePath, bytes: bytes.length, sha256: sha256(bytes) };
}

export async function exportUserMemoryBundle({
  memoryDirectory,
  outputDirectory,
  sourceGitCommit,
  createdAt,
  overwrite = false,
}) {
  if (!memoryDirectory || !outputDirectory) throw new Error("memoryDirectory and outputDirectory are required.");
  if (!/^[a-f0-9]{40}$/.test(sourceGitCommit ?? "")) {
    throw new Error("sourceGitCommit must be a full lowercase Git commit.");
  }
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("createdAt must be a valid timestamp for reproducible export.");
  }

  memoryDirectory = await realpath(memoryDirectory);
  outputDirectory = path.resolve(outputDirectory);
  const objectDirectory = await containedPath(memoryDirectory, "objects");
  if (overwrite) await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: false });

  const objectFiles = (await readdir(objectDirectory))
    .filter((name) => /^mem_[a-f0-9]+\.json$/.test(name))
    .sort();
  const records = [];
  for (const name of objectFiles) {
    const object = JSON.parse(await readFile(await containedPath(memoryDirectory, `objects/${name}`), "utf8"));
    records.push(mapMemoryObject(object));
  }
  records.sort((left, right) => left.source_id.localeCompare(right.source_id));
  if (new Set(records.map((record) => record.source_id)).size !== records.length) {
    throw new Error("Duplicate source memory object IDs are not allowed.");
  }

  const sourceProjectIds = [...new Set(
    records.filter((record) => record.scope === "project").map((record) => record.source_project_id),
  )].sort();
  const projects = sourceProjectIds.map((projectId) => projectFromRecords(projectId, records));
  const recordsJsonl = records.map(jsonLine).join("");
  const projectsJsonl = projects.map(jsonLine).join("");
  await writeFile(path.resolve(outputDirectory, "records.jsonl"), recordsJsonl, "utf8");
  await writeFile(path.resolve(outputDirectory, "projects.jsonl"), projectsJsonl, "utf8");
  await writeMirrors(outputDirectory, records);
  const evidenceFiles = await copyEvidence(memoryDirectory, outputDirectory);

  const bundleDigest = sha256(
    `${BUNDLE_CONTRACT}\n${BUNDLE_VERSION}\n${projectsJsonl}${recordsJsonl}`,
  );
  const files = await Promise.all(
    (await listBundleFiles(outputDirectory)).map((relativePath) => fileDescriptor(outputDirectory, relativePath)),
  );
  const counts = {
    projects: projects.length,
    records: records.length,
    global_records: records.filter((record) => record.scope === "global").length,
    project_records: records.filter((record) => record.scope === "project").length,
    by_record_type: Object.fromEntries(
      [...records.reduce((map, record) => {
        map.set(record.record_type, (map.get(record.record_type) ?? 0) + 1);
        return map;
      }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  const manifest = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    contract: BUNDLE_CONTRACT,
    contract_version: BUNDLE_VERSION,
    bundle_id: `umb_${bundleDigest.slice(0, 24)}`,
    bundle_digest: bundleDigest,
    created_at: new Date(createdAt).toISOString(),
    source: {
      kind: "cross-memory-system",
      git_commit: sourceGitCommit,
      canonical_path: "memory/objects",
    },
    boundaries: {
      production_canonical_store: "supabase",
      bundle_role: "portable_single_user_historical_export",
      fixture_authority: false,
      current_truth_authority: false,
      markdown_role: "read_only_stable_id_reference_mirror",
      evidence_role: "read_only_not_imported_as_current_truth",
      direct_git_runtime_writes: false,
      multi_tenant_data_plane: false,
    },
    excluded_system_paths: EXCLUDED_SYSTEM_PATHS,
    evidence_files: evidenceFiles.sort(),
    counts,
    files,
  };
  await writeFile(path.resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await validateUserMemoryBundle(outputDirectory);
  return { manifest, projects, records };
}

async function parseJsonLines(filePath) {
  const text = await readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${path.basename(filePath)} line ${index + 1} is not valid JSON.`);
      }
    });
}

export async function validateUserMemoryBundle(bundleDirectory) {
  bundleDirectory = await realpath(bundleDirectory);
  const manifest = JSON.parse(await readFile(await containedPath(bundleDirectory, "manifest.json"), "utf8"));
  if (manifest.contract !== BUNDLE_CONTRACT) throw new Error("Unsupported bundle contract.");
  const readableContractVersion = READABLE_BUNDLE_VERSIONS.get(manifest.schema_version);
  if (!readableContractVersion) throw new Error("Unsupported bundle schema_version.");
  if (manifest.contract_version !== readableContractVersion) throw new Error("Unsupported bundle contract_version.");
  if (manifest.boundaries?.production_canonical_store !== "supabase") {
    throw new Error("Bundle must declare Supabase as the production canonical store.");
  }
  if (manifest.boundaries?.direct_git_runtime_writes !== false) {
    throw new Error("Bundle must forbid direct production Git writes.");
  }
  for (const descriptor of manifest.files ?? []) {
    safeRelativePath(descriptor.path);
    const actual = await fileDescriptor(bundleDirectory, descriptor.path);
    if (actual.bytes !== descriptor.bytes || actual.sha256 !== descriptor.sha256) {
      throw new Error(`Bundle file checksum mismatch: ${descriptor.path}`);
    }
  }

  const projects = await parseJsonLines(await containedPath(bundleDirectory, "projects.jsonl"));
  const records = await parseJsonLines(await containedPath(bundleDirectory, "records.jsonl"));
  if (projects.length !== manifest.counts.projects || records.length !== manifest.counts.records) {
    throw new Error("Bundle manifest counts do not match JSONL payloads.");
  }
  if (new Set(projects.map((project) => project.source_project_id)).size !== projects.length) {
    throw new Error("Duplicate source project IDs are not allowed.");
  }
  if (new Set(records.map((record) => record.source_id)).size !== records.length) {
    throw new Error("Duplicate source record IDs are not allowed.");
  }
  const projectIds = new Set(projects.map((project) => project.source_project_id));
  for (const project of projects) {
    assertString(project.source_project_id, "project.source_project_id", { max: 120 });
    assertString(project.name, `${project.source_project_id}.name`, { max: 120 });
    assertString(project.progress_status, `${project.source_project_id}.progress_status`, { max: 40 });
    if (!new Set(["not_started", "active", "paused", "completed", "archived"]).has(project.progress_status)) {
      throw new Error(`Unsupported Project progress_status: ${project.progress_status}`);
    }
    if (!Number.isInteger(project.record_count) || project.record_count < 1) {
      throw new Error(`${project.source_project_id}.record_count must be a positive integer.`);
    }
    if (manifest.schema_version === 1) {
      const allowed = new Set(["source_project_id", "name", "certainty_status", "progress_status", "evidence", "record_count"]);
      if (Object.keys(project).some((key) => !allowed.has(key))) throw new Error("Bundle v1 Project contains an unsupported field.");
      if (project.certainty_status !== "confirmed") throw new Error("Bundle v1 Project must remain confirmed historical input.");
      assertString(project.evidence, `${project.source_project_id}.evidence`, { max: 8000 });
    } else {
      if ("certainty_status" in project || "confirmed_at" in project || "confidence" in project) {
        throw new Error("Bundle v2 Project must not expose the retired certainty axis.");
      }
      const allowed = new Set(["source_project_id", "name", "progress_status", "recognition_evidence", "record_count"]);
      if (Object.keys(project).some((key) => !allowed.has(key))) throw new Error("Bundle v2 Project contains an unsupported field.");
      assertString(project.recognition_evidence, `${project.source_project_id}.recognition_evidence`, { max: 500 });
    }
  }
  for (const record of records) {
    assertString(record.source_id, "record.source_id", { max: 160 });
    assertString(record.title, `${record.source_id}.title`, { max: 120 });
    assertString(record.content, `${record.source_id}.content`, { max: 8000 });
    assertString(record.record_key, `${record.source_id}.record_key`, { max: 160 });
    if (!["note", "state", "task", "decision", "archive_snapshot"].includes(record.record_type)) {
      throw new Error(`Unsupported target record type: ${record.record_type}`);
    }
    if (!LEGAL_RECORD_STATUSES[record.record_type].has(record.status)) {
      throw new Error(`Unsupported target status for ${record.record_type}: ${record.status}`);
    }
    if (record.scope === "project" && !projectIds.has(record.source_project_id)) {
      throw new Error(`Record references an unknown source project: ${record.source_id}`);
    }
    if ("user_id" in record || "access_token" in record || "service_role" in record) {
      throw new Error(`Bundle contains a forbidden tenant or credential field: ${record.source_id}`);
    }
  }
  for (const project of projects) {
    const actualRecordCount = records.filter((record) => record.source_project_id === project.source_project_id).length;
    if (project.record_count !== actualRecordCount) {
      throw new Error(`Project record_count does not match records.jsonl: ${project.source_project_id}`);
    }
  }

  const expectedDigest = sha256(
    `${BUNDLE_CONTRACT}\n${manifest.contract_version}\n${projects.map(jsonLine).join("")}${records.map(jsonLine).join("")}`,
  );
  if (manifest.bundle_digest !== expectedDigest || manifest.bundle_id !== `umb_${expectedDigest.slice(0, 24)}`) {
    throw new Error("Bundle digest or ID does not match canonical payloads.");
  }
  return { manifest, projects, records };
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  const booleanFlags = new Set(["--overwrite"]);
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (booleanFlags.has(name)) {
      options[name.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    if (!["--memory", "--output", "--source-commit", "--created-at", "--bundle"].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${name} requires a value.`);
    options[name.slice(2).replaceAll("-", "_")] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "export") {
    const result = await exportUserMemoryBundle({
      memoryDirectory: path.resolve(options.memory ?? path.resolve(REPO_ROOT, "memory")),
      outputDirectory: path.resolve(options.output),
      sourceGitCommit: options.source_commit,
      createdAt: options.created_at,
      overwrite: options.overwrite ?? false,
    });
    process.stdout.write(`${JSON.stringify({ status: "exported", ...result.manifest.counts, bundle_id: result.manifest.bundle_id })}\n`);
    return;
  }
  if (command === "validate") {
    const result = await validateUserMemoryBundle(path.resolve(options.bundle));
    process.stdout.write(`${JSON.stringify({ status: "valid", ...result.manifest.counts, bundle_id: result.manifest.bundle_id })}\n`);
    return;
  }
  throw new Error("Usage: user-memory-bundle.mjs <export|validate> [options]");
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
