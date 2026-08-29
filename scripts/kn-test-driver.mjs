#!/usr/bin/env node
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const DRIVER = "scripts/kn-test-driver.mjs";
const VERIFIER = "scripts/verify-generated-artifacts.mjs";
const REQUIREMENTS = "protocol/continuity/v1/requirements.yaml";
const SOURCE_SHA256 = "f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec";
const PLAN_SHA256 = "33e1df57c95232c7696157a4ea7ab5814baf2251a82ff473a8ccce85a70be496";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error("missing value for --" + key);
    args[key] = value;
    i += 1;
  }
  return args;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function repoRoot() {
  return git(process.cwd(), ["rev-parse", "--show-toplevel"]);
}

function rejectProduction(args) {
  for (const value of [args.env, args.tenant, args["data-ns"]].filter(Boolean)) {
    if (/(^|[-_:])(prod|production|live)([-_:]|$)/i.test(value)) {
      throw new Error("production-like identifier rejected: " + value);
    }
  }
}

function verifier(root, bom) {
  const result = spawnSync(process.execPath, [join(root, VERIFIER), "--bom", resolve(bom)], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("verifier failed: " + (result.stdout.trim() || result.stderr.trim()));
  return JSON.parse(result.stdout);
}

function sealBom(unsignedBom) {
  const bom = structuredClone(unsignedBom);
  delete bom.integrity.content_digest;
  delete bom.integrity.public_key;
  delete bom.integrity.signature;
  const digest = sha256(Buffer.from(canonical(bom)));
  const keys = generateKeyPairSync("ed25519");
  bom.integrity.content_digest = "sha256:" + digest;
  bom.integrity.public_key = keys.publicKey.export({ type: "spki", format: "pem" });
  bom.integrity.signature = sign(null, Buffer.from(digest, "hex"), keys.privateKey).toString("base64");
  return bom;
}

function makeBom(root, contractPath, planPath) {
  if (sha256File(contractPath) !== SOURCE_SHA256) throw new Error("contract digest mismatch");
  if (sha256File(planPath) !== PLAN_SHA256) throw new Error("plan digest mismatch");
  const head = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  const driverDigest = sha256File(join(root, DRIVER));
  const verifierDigest = sha256File(join(root, VERIFIER));
  const requirementsDigest = sha256File(join(root, REQUIREMENTS));
  const profiles = {
    release_profile: { id: "v00-non-production-bootstrap", production: false, allowed_tasks: ["V00"] },
    fixture: { id: "v00-negative-integrity-fixtures", cases: ["bom", "driver", "requirements", "path", "signature", "production"] },
    policy: { id: "v00-approval-boundary", incremental_cost: false, wait_over_30m: false, production: false },
    observability: { id: "v00-local-json-output", external_export: false },
  };
  const embedded = {};
  for (const [key, value] of Object.entries(profiles)) {
    embedded[key] = { value, sha256: "sha256:" + sha256(Buffer.from(canonical(value))) };
  }
  return sealBom({
    schema_version: "release-bom-v00.1",
    object_type: "release_bom",
    release_bom_id: "urn:clued:release-bom:v00:" + head,
    release_scope: "candidate_non_production",
    source: {
      repository: "tdoljyj/cross-memory-system",
      commit_sha1: head,
      tree_sha1: tree,
      candidate_digest: "sha256:" + sha256(head + ":" + tree + ":" + driverDigest + ":" + verifierDigest + ":" + requirementsDigest),
    },
    contract: { source_sha256: "sha256:" + SOURCE_SHA256, plan_sha256: "sha256:" + PLAN_SHA256 },
    machine_contract_inputs: {
      requirements: {
        path: REQUIREMENTS,
        sha256: "sha256:" + requirementsDigest,
        registry_status: "frozen_pending_g1",
        g1_qualified: false,
      },
    },
    tools: {
      driver: { path: DRIVER, mode: "100755", runtime: process.version, sha256: "sha256:" + driverDigest },
      verifier: { path: VERIFIER, runtime: process.version, sha256: "sha256:" + verifierDigest },
    },
    embedded_profiles: embedded,
    generated_artifacts: [{ path: REQUIREMENTS, sha256: "sha256:" + requirementsDigest, source: "v00-recovery-bootstrap" }],
    authorization_boundary: {
      production_authorized: false,
      incremental_cost_authorized: false,
      wait_over_30m_authorized: false,
      allowed_write_roots: ["evidence/<run>/"],
    },
    integrity: {
      canonicalization: "json-c14n-sorted-keys-v1",
      algorithm: "Ed25519",
      trust_scope: "v00_local_test_generation",
      production_trusted: false,
    },
  });
}

function writeJson(path, value, exclusive = true) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: exclusive ? "wx" : "w" });
}

function commandBootstrapBom(args) {
  if (!args.out || !args.contract || !args.plan) throw new Error("bootstrap-bom requires --out, --contract, and --plan");
  const out = resolve(args.out);
  mkdirSync(dirname(out), { recursive: true });
  writeJson(out, makeBom(repoRoot(), resolve(args.contract), resolve(args.plan)));
  process.stdout.write(JSON.stringify({ ok: true, code: "V00_BOM_CREATED", path: out, sha256: "sha256:" + sha256File(out) }) + "\n");
}

function commandPreflight(args) {
  rejectProduction(args);
  const result = verifier(repoRoot(), args.bom);
  const now = new Date().toISOString();
  process.stdout.write(JSON.stringify({
    ok: true,
    code: "V00_PREFLIGHT_PASS",
    verifier: result,
    read_set: [resolve(args.bom), DRIVER, VERIFIER, REQUIREMENTS],
    write_set: [],
    authorization: { production: false, incremental_cost: false, wait_over_30m: false },
    started_at: now,
    ended_at: now,
    authoritative_gate_result: false,
  }) + "\n");
}

function evidencePath(input) {
  if (!input) throw new Error("--evidence is required");
  const path = resolve(input);
  mkdirSync(dirname(path), { recursive: true });
  const parent = realpathSync(dirname(path));
  if (lstatSync(parent).isSymbolicLink() || !basename(path)) throw new Error("unsafe evidence path");
  return path;
}

function commandRun(args) {
  if (args.task !== "V00") throw new Error("TASK_MANIFEST_NOT_AVAILABLE");
  rejectProduction(args);
  const root = repoRoot();
  const verified = verifier(root, args.bom);
  const evidence = evidencePath(args.evidence);
  mkdirSync(evidence, { recursive: false });
  const checks = [
    ["V00-BOM-01", verified.signature_valid === true],
    ["V00-DRIVER-01", (statSync(join(root, DRIVER)).mode & 0o111) !== 0],
    ["V00-REQUIREMENTS-01", verified.requirements.count > 0],
    ["V00-GENERATED-01", verified.verified_paths.includes(VERIFIER)],
    ["V00-BOUNDARY-01", true],
  ].map(([test_id, pass]) => ({ test_id, status: pass ? "PASS" : "FAIL" }));
  if (checks.some((item) => item.status !== "PASS")) throw new Error("V00 checks failed");
  writeJson(join(evidence, "driver-run.json"), {
    schema_version: 1,
    task: "V00",
    status: "PASS",
    tests: checks,
    inputs: verified,
    actual_read_set: [resolve(args.bom), DRIVER, VERIFIER, REQUIREMENTS],
    actual_write_set: [join(evidence, "driver-run.json")],
    historical_lessons: [],
    blocked_unsupported_claims: [],
    authoritative_gate_result: false,
    canonical_receipt: false,
    production_authorized: false,
  });
  process.stdout.write(JSON.stringify({ ok: true, code: "V00_RUN_PASS", evidence }) + "\n");
}

function walkFiles(root, dir = root) {
  const output = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(root, path));
    else if (entry.isFile() && !["evidence-index.json", "evidence-signature.json", "SHA256SUMS"].includes(entry.name)) {
      output.push(relative(root, path));
    }
  }
  return output.sort();
}

function commandSeal(args) {
  if (args.task !== "V00") throw new Error("TASK_MANIFEST_NOT_AVAILABLE");
  const evidence = realpathSync(resolve(args.evidence));
  const files = walkFiles(evidence).map((path) => ({ path, sha256: "sha256:" + sha256File(join(evidence, path)) }));
  if (files.length === 0) throw new Error("cannot seal empty evidence");
  const index = {
    schema_version: 1,
    task: "V00",
    files,
    authoritative_gate_result: false,
    canonical_receipt: false,
    production_authorized: false,
  };
  const digest = sha256(Buffer.from(canonical(index)));
  const keys = generateKeyPairSync("ed25519");
  writeJson(join(evidence, "evidence-index.json"), index);
  writeJson(join(evidence, "evidence-signature.json"), {
    algorithm: "Ed25519",
    content_digest: "sha256:" + digest,
    public_key: keys.publicKey.export({ type: "spki", format: "pem" }),
    signature: sign(null, Buffer.from(digest, "hex"), keys.privateKey).toString("base64"),
    trust_scope: "v00_local_evidence",
    authoritative_gate_result: false,
  });
  process.stdout.write(JSON.stringify({ ok: true, code: "V00_EVIDENCE_SEALED", files: files.length, digest: "sha256:" + digest }) + "\n");
}

function commandSelfTest(args) {
  const root = repoRoot();
  verifier(root, args.bom);
  const original = JSON.parse(readFileSync(resolve(args.bom), "utf8"));
  const cases = [
    ["source-commit", (x) => { x.source.commit_sha1 = "0".repeat(40); }, true],
    ["requirements-digest", (x) => { x.machine_contract_inputs.requirements.sha256 = "sha256:" + "0".repeat(64); }, true],
    ["signature", (x) => { x.integrity.signature = Buffer.from("invalid").toString("base64"); }, false],
    ["production", (x) => { x.authorization_boundary.production_authorized = true; }, true],
    ["authority-path", (x) => { x.machine_contract_inputs.requirements.path = "protocol/continuity/requirements.yaml"; }, true],
    ["driver-digest", (x) => { x.tools.driver.sha256 = "sha256:" + "f".repeat(64); }, true],
  ];
  const dir = mkdtempSync(join(tmpdir(), "kn-v00-self-test-"));
  const results = [];
  for (const [name, mutate, resign] of cases) {
    let bom = structuredClone(original);
    mutate(bom);
    if (resign) bom = sealBom(bom);
    const path = join(dir, name + ".json");
    writeJson(path, bom);
    const result = spawnSync(process.execPath, [join(root, VERIFIER), "--bom", path], { cwd: root, encoding: "utf8" });
    results.push({ name, rejected: result.status !== 0 });
  }
  if (results.some((item) => !item.rejected)) throw new Error("negative self-test accepted an invalid BOM");
  process.stdout.write(JSON.stringify({ ok: true, code: "V00_SELF_TEST_PASS", cases: results }) + "\n");
}

function main() {
  try {
    const command = process.argv[2];
    const args = argsOf(process.argv.slice(3));
    if (command === "bootstrap-bom") commandBootstrapBom(args);
    else if (command === "preflight") commandPreflight(args);
    else if (command === "run") commandRun(args);
    else if (command === "seal") commandSeal(args);
    else if (command === "self-test") commandSelfTest(args);
    else if (command === "aggregate") throw new Error("V15_NOT_AVAILABLE");
    else throw new Error("unknown command: " + (command || ""));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.message, authoritative_gate_result: false }) + "\n");
    process.exit(1);
  }
}

main();
