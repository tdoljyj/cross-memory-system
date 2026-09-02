#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { buildDeterministicArtifact, canonicalJson, createContentManifest, normalizeArtifactPath, sha256 } from "../kernel/release/supply-chain.mjs";

function argsOf(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index]?.startsWith("--") || !values[index + 1] || values[index + 1].startsWith("--")) throw new Error("invalid arguments");
    output[values[index].slice(2)] = values[index + 1];
  }
  return output;
}

function loadFiles(root, entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("input files required");
  return entries.map((entry) => {
    const path = normalizeArtifactPath(entry.path);
    const absolute = resolve(root, ...path.split("/"));
    const rel = relative(root, absolute);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("source path escapes root");
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("source entry is not a regular file");
    const bytes = readFileSync(absolute);
    if (entry.sha256 && entry.sha256 !== sha256(bytes)) throw new Error("source digest mismatch: " + path);
    return { path, mode: entry.mode || "0644", kind: "file", bytes };
  });
}

try {
  const args = argsOf(process.argv.slice(2));
  if (!args.input || !args["source-root"] || !args.out) throw new Error("--input, --source-root and --out are required");
  const input = JSON.parse(readFileSync(resolve(args.input), "utf8"));
  if (input.schema_version !== "clued.v15.v12-build-input/1" || input.object_type !== "V12BuildInput" || input.clean !== true) throw new Error("invalid build input");
  const artifact = buildDeterministicArtifact({
    files: loadFiles(resolve(args["source-root"]), input.files),
    sourceDateEpoch: input.source_date_epoch,
    environment: input.environment,
    buildEnvironmentDigest: input.build_environment_digest,
    disabledAdapters: input.disabled_adapters,
  });
  const manifest = createContentManifest(artifact);
  const output = resolve(args.out);
  mkdirSync(output, { recursive: false });
  writeFileSync(resolve(output, "artifact.clued-local-rc.json"), artifact, { flag: "wx" });
  writeFileSync(resolve(output, "content-manifest.json"), canonicalJson(manifest) + "\n", { flag: "wx" });
  const result = {
    schema_version: "clued.v15.v12-content-build-result/1",
    object_type: "V12ContentBuildResult",
    status: "PASS",
    builder_id: input.builder_id,
    clean: true,
    builder_image_digest: input.build_environment_digest,
    artifact_digest: sha256(artifact),
    content_manifest_digest: sha256(Buffer.from(canonicalJson(manifest))),
    actual_syft_cosign_oras_execution: false,
    production: false,
    published: false,
    authority_effect: "NONE",
  };
  writeFileSync(resolve(output, "build-result.json"), canonicalJson(result) + "\n", { flag: "wx" });
  process.stdout.write(canonicalJson({ ok: true, ...result }) + "\n");
} catch (error) {
  process.stdout.write(canonicalJson({ ok: false, code: error.code || "V12_BUILD_FAILED", message: error.message }) + "\n");
  process.exit(1);
}
