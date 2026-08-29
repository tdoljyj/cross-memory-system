#!/usr/bin/env node
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const REQUIRED_REGISTRY = "protocol/continuity/v1/requirements.yaml";
const FORBIDDEN_REVERSE_FIELDS = new Set(["test_refs", "gate_refs", "profile_refs"]);

function fail(code, message, details = {}) {
  process.stdout.write(JSON.stringify({ ok: false, code, message, details }) + "\n");
  process.exit(1);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function bomPayload(bom) {
  const copy = structuredClone(bom);
  if (!copy.integrity) throw new Error("integrity is missing");
  delete copy.integrity.content_digest;
  delete copy.integrity.signature;
  delete copy.integrity.public_key;
  return Buffer.from(canonical(copy));
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function repoPath(root, input) {
  if (typeof input !== "string" || input.length === 0 || isAbsolute(input) || input.includes("\0")) {
    throw new Error("invalid repository-relative path: " + String(input));
  }
  const lexical = resolve(root, input);
  const rel = relative(root, lexical);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("path escapes repository: " + input);
  const parent = realpathSync(dirname(lexical));
  const parentRel = relative(root, parent);
  if (parentRel === ".." || parentRel.startsWith(".." + sep) || isAbsolute(parentRel)) {
    throw new Error("path parent escapes repository: " + input);
  }
  if (lstatSync(lexical).isSymbolicLink()) throw new Error("symbolic link is not accepted: " + input);
  return lexical;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail("ARGUMENT_ERROR", "missing value for --" + key);
    args[key] = value;
    i += 1;
  }
  return args;
}

function validateRequirements(path) {
  const registry = JSON.parse(readFileSync(path, "utf8"));
  if (registry.schema_version !== "requirements-v1") throw new Error("unexpected requirements schema_version");
  if (registry.registry_status !== "frozen_pending_g1" || registry.g1_qualified !== false) {
    throw new Error("bootstrap registry must remain frozen_pending_g1 and not G1-qualified");
  }
  if (!Array.isArray(registry.requirements) || registry.requirements.length === 0) throw new Error("requirements set is empty");
  const ids = new Set();
  const uris = new Set();
  for (let index = 0; index < registry.requirements.length; index += 1) {
    const item = registry.requirements[index];
    for (const field of FORBIDDEN_REVERSE_FIELDS) if (field in item) throw new Error("forbidden reverse field: " + field);
    if (!item.requirement_id || ids.has(item.requirement_id)) throw new Error("duplicate or missing requirement_id at " + index);
    if (!item.typed_uri || uris.has(item.typed_uri)) throw new Error("duplicate or missing typed_uri at " + index);
    if (item.canonical_uri !== REQUIRED_REGISTRY || item.canonical_pointer !== "#/requirements/" + index) {
      throw new Error("non-canonical requirement pointer at " + index);
    }
    const expected = "sha256:" + sha256Bytes(Buffer.from(item.statement || "", "utf8"));
    if (item.content_digest !== expected) throw new Error("requirement digest mismatch: " + item.requirement_id);
    ids.add(item.requirement_id);
    uris.add(item.typed_uri);
  }
  return { count: registry.requirements.length, ids: [...ids] };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bom) fail("ARGUMENT_ERROR", "--bom is required");
  try {
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("not a Git worktree");
    if (git(root, ["status", "--porcelain=v1"]) !== "") throw new Error("Git worktree is not clean");
    const bom = JSON.parse(readFileSync(resolve(args.bom), "utf8"));
    if (bom.schema_version !== "release-bom-v00.1" || bom.object_type !== "release_bom" ||
        bom.release_scope !== "candidate_non_production") throw new Error("unexpected BOM identity or scope");
    const digest = sha256Bytes(bomPayload(bom));
    if (bom.integrity.content_digest !== "sha256:" + digest) throw new Error("BOM content digest mismatch");
    const publicKey = createPublicKey(bom.integrity.public_key);
    const valid = verifySignature(null, Buffer.from(digest, "hex"), publicKey, Buffer.from(bom.integrity.signature, "base64"));
    if (!valid) throw new Error("BOM signature is invalid");
    const head = git(root, ["rev-parse", "HEAD"]);
    const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
    if (head !== bom.source.commit_sha1 || tree !== bom.source.tree_sha1) throw new Error("Git identity does not match BOM");
    const boundary = bom.authorization_boundary;
    if (boundary.production_authorized !== false || boundary.incremental_cost_authorized !== false ||
        boundary.wait_over_30m_authorized !== false) throw new Error("authorization boundary is wider than V00");
    if (bom.machine_contract_inputs.requirements.path !== REQUIRED_REGISTRY) throw new Error("requirements path is not authoritative v1 path");
    if (bom.machine_contract_inputs.requirements.registry_status !== "frozen_pending_g1" ||
        bom.machine_contract_inputs.requirements.g1_qualified !== false) throw new Error("BOM attempts to overstate G1 status");
    for (const key of ["release_profile", "fixture", "policy", "observability"]) {
      const profile = bom.embedded_profiles?.[key];
      if (!profile || profile.sha256 !== "sha256:" + sha256Bytes(Buffer.from(canonical(profile.value)))) {
        throw new Error("embedded profile digest mismatch: " + key);
      }
    }
    if (bom.integrity.production_trusted !== false) throw new Error("V00 BOM cannot be production-trusted");
    const pinned = [bom.tools.driver, bom.tools.verifier, bom.machine_contract_inputs.requirements, ...(bom.generated_artifacts || [])];
    if (pinned.length < 4) throw new Error("generated artifact set is incomplete");
    for (const entry of pinned) {
      const path = repoPath(root, entry.path);
      if ("sha256:" + sha256File(path) !== entry.sha256) throw new Error("artifact digest mismatch: " + entry.path);
    }
    const driverPath = repoPath(root, bom.tools.driver.path);
    if ((statSync(driverPath).mode & 0o111) === 0) throw new Error("test driver is not executable");
    const requirements = validateRequirements(repoPath(root, REQUIRED_REGISTRY));
    process.stdout.write(JSON.stringify({
      ok: true,
      code: "GENERATED_ARTIFACTS_VERIFIED",
      repository: bom.source.repository,
      commit_sha1: head,
      tree_sha1: tree,
      bom_digest: "sha256:" + digest,
      signature_valid: true,
      requirements,
      verified_paths: [...new Set(pinned.map((entry) => entry.path))].sort(),
      writes: [],
    }) + "\n");
  } catch (error) {
    fail("GENERATED_ARTIFACTS_INVALID", error.message);
  }
}

main();
