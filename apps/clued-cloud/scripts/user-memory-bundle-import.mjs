#!/usr/bin/env node

import path from "node:path";

import { sha256, validateUserMemoryBundle } from "./user-memory-bundle.mjs";

function deterministicKey(prefix, bundleId, sourceId) {
  return `${prefix}:${sha256(`${bundleId}\n${sourceId}`).slice(0, 40)}`;
}

function sourceRef(bundleId, sourceId) {
  return `user-memory-bundle-v1:${bundleId}:${sourceId}`.slice(0, 500);
}

export function buildImportPlan(bundle) {
  // Preserve the retired mapping for inspection only; these are not current M1 requests.
  const { manifest, projects, records } = bundle;
  const projectActions = projects.map((project) => ({
    source_project_id: project.source_project_id,
    request: {
      name: project.name,
      intent: "confirmed",
      idempotency_key: deterministicKey("umbv1-project", manifest.bundle_id, project.source_project_id),
      summary: `Historical mapping from portable single-user export ${manifest.bundle_id}.`,
      evidence_summary: project.recognition_evidence ?? project.evidence,
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
    mapping_status: "historical_contract_only",
    executable: false,
    fixture_authority: false,
    current_truth_authority: false,
    project_actions: projectActions,
    record_actions: recordActions,
  };
}

export async function importUserMemoryBundle({
  bundleDirectory,
  execute = false,
}) {
  if (execute) throw new Error("USER_MEMORY_BUNDLE_EXECUTE_RETIRED: legacy import execution is disabled; use read-only historical dry-run mapping.");
  const bundle = await validateUserMemoryBundle(bundleDirectory);
  const plan = buildImportPlan(bundle);
  if (!execute) {
    return {
      status: "dry_run",
      bundle_id: plan.bundle_id,
      projects: plan.project_actions.length,
      records: plan.record_actions.length,
      network_writes: 0,
      filesystem_writes: 0,
      mapping_status: plan.mapping_status,
      executable: false,
      fixture_authority: false,
      current_truth_authority: false,
    };
  }
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
  const result = await importUserMemoryBundle({
    bundleDirectory: path.resolve(options.bundle),
    execute: options.execute ?? false,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
