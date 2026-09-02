import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertIndependentBuilds, assertNoPostVerificationRebuild, assertRegularEntryKind,
  buildDeterministicArtifact, canonicalJson, createContentManifest, normalizeArtifactPath,
  parseDeterministicArtifact, sha256, signaturePayload, verifyObservabilityClosure,
  verifyOciDescriptor, verifyProvenance, verifyReleaseObjects, verifySbom,
  verifySupplyChainBundle, verifyTestSignature,
} from "../../kernel/release/supply-chain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const CLI = join(ROOT, "scripts", "build-local-release-candidate.mjs");
const BUILD = "sha256:" + "1".repeat(64);
const TOOL = "sha256:" + "2".repeat(64);
const WORKFLOW = "sha256:" + "3".repeat(64);
const COMMIT = "4".repeat(40);
const TREE = "5".repeat(40);

function artifact(files = [
  { path: "kernel/core.mjs", mode: "0644", bytes: "export const core = true;\n" },
  { path: "scripts/run.mjs", mode: "0755", bytes: "#!/usr/bin/env node\n" },
]) {
  return buildDeterministicArtifact({
    files, sourceDateEpoch: 1_788_194_400, environment: "minimum-local-rc",
    buildEnvironmentDigest: BUILD, disabledAdapters: ["sentry"],
  });
}

function fixture(bytes = artifact()) {
  const digest = sha256(bytes);
  const sbom = {
    schema_version: "clued.v15.sbom-evidence/1",
    tool: { id: "syft", version: "1.30.0", artifact_digest: TOOL },
    format: "spdx-json", subject_digest: digest,
    components: [
      { component_id: "node:crypto", version: process.versions.node, license: "Node.js", digest: TOOL, runtime: true },
      { component_id: "otel-api", version: "1.0.0-test", license: "Apache-2.0", digest: WORKFLOW, runtime: true },
    ],
  };
  const provenance = {
    schema_version: "clued.v15.provenance/1", subject_digest: digest,
    builder: { id: "builder-a", image_digest: BUILD },
    workflow: { id: "v12-local-reference", digest: WORKFLOW },
    source: { commit: COMMIT, tree: TREE },
    materials: [{ uri: "git+local://clued@" + COMMIT, digest: "sha256:" + "6".repeat(64) }],
  };
  const provenanceDigest = sha256(Buffer.from(canonicalJson(provenance)));
  const keys = generateKeyPairSync("ed25519");
  const envelope = {
    schema_version: "clued.v15.local-signature/1", algorithm: "Ed25519",
    trust_scope: "test_generation", production_trusted: false,
    subject_digest: digest, statement_digest: provenanceDigest,
    key_id: "v12-test-root", generation: 1,
  };
  envelope.signature = sign(null, signaturePayload(envelope), keys.privateKey).toString("base64");
  const allowedKeys = [{
    key_id: envelope.key_id, generation: 1,
    public_key: keys.publicKey.export({ type: "spki", format: "pem" }),
    public_key_digest: sha256(keys.publicKey.export({ type: "spki", format: "der" })),
  }];
  const descriptor = {
    schema_version: "clued.v15.oci-descriptor/1", digest, size: bytes.length,
    media_type: "application/vnd.clued.local-rc.artifact.v1+json",
    repository: "local/clued/kernel-next", reference: "local/clued/kernel-next@" + digest,
    retention_policy_id: "local-append-only", access_policy_id: "local-read-only", consumer_verified: true,
  };
  const releaseObjects = [{
    object_id: "kernel-next-local-rc", kind: "local-rc-content-artifact", version: "0.0.0-local-v15",
    artifact_digest: digest, source: "git-tree:" + TREE, license: "repository-declared",
    sbom_digest: sha256(Buffer.from(canonicalJson(sbom))),
    vulnerability_result_digest: "sha256:" + "8".repeat(64), provenance_digest: provenanceDigest,
    signature_digest: sha256(Buffer.from(envelope.signature, "base64")),
    permissions_digest: "sha256:" + "9".repeat(64), security_profile_id: "dev_software_limited",
    update: { strategy: "replace-by-digest", procedure_ref: "local://v12/update" },
    revocation: { strategy: "append-revoked-status", procedure_ref: "local://v12/revoke" },
    rollback: { strategy: "select-prior-qualified-digest", procedure_ref: "local://v12/rollback" },
  }];
  return { digest, sbom, provenance, provenanceDigest, envelope, allowedKeys, descriptor, releaseObjects };
}

test("V12-BUILD-01 two clean independent builders produce identical content bytes", () => {
  const left = artifact(), right = artifact();
  const result = assertIndependentBuilds(
    { builder: { id: "builder-a", image_digest: BUILD, clean: true }, artifact: left, manifest: createContentManifest(left) },
    { builder: { id: "builder-b", image_digest: BUILD, clean: true }, artifact: right, manifest: createContentManifest(right) },
  );
  assert.equal(result.artifact_digest, sha256(left));
});

test("V12-BUILD-02 artifact fixes epoch, LF JSON, path order and modes", () => {
  const parsed = parseDeterministicArtifact(artifact());
  assert.equal(parsed.source_date_epoch, 1_788_194_400);
  assert.deepEqual(parsed.entries.map((item) => [item.path, item.mode]), [["kernel/core.mjs", "0644"], ["scripts/run.mjs", "0755"]]);
});

test("V12-BUILD-03 traversal, duplicate paths and special entries fail closed", () => {
  for (const path of ["../escape", "/absolute", "C:/drive", "a\\b", "a//b", "a/./b"]) assert.throws(() => normalizeArtifactPath(path), { code: "UNSAFE_ARTIFACT_PATH" });
  assert.throws(() => artifact([{ path: "same", bytes: "a" }, { path: "same", bytes: "b" }]), { code: "DUPLICATE_ARTIFACT_PATH" });
  for (const kind of ["symlink", "hardlink", "device", "socket", "fifo", "directory"]) assert.throws(() => assertRegularEntryKind(kind), { code: "SPECIAL_ENTRY_REJECTED" });
});

test("V12-BUILD-04 fixed epoch and independent builder identity are mandatory", () => {
  assert.throws(() => buildDeterministicArtifact({ files: [{ path: "x", bytes: "x" }], buildEnvironmentDigest: BUILD }), { code: "SOURCE_DATE_EPOCH_REQUIRED" });
  const bytes = artifact(), manifest = createContentManifest(bytes);
  assert.throws(() => assertIndependentBuilds(
    { builder: { id: "same", image_digest: BUILD, clean: true }, artifact: bytes, manifest },
    { builder: { id: "same", image_digest: BUILD, clean: true }, artifact: bytes, manifest },
  ), { code: "BUILDERS_NOT_INDEPENDENT" });
});

test("V12-SBOM-01 Syft evidence binds final digest and runtime closure", () => {
  const bytes = artifact(), f = fixture(bytes);
  assert.equal(verifySbom({ sbom: f.sbom, artifactDigest: f.digest, runtimeDependencies: ["node:crypto", "otel-api"] }).components, 2);
  const missing = structuredClone(f.sbom); missing.components.pop();
  assert.throws(() => verifySbom({ sbom: missing, artifactDigest: f.digest, runtimeDependencies: ["otel-api"] }), { code: "UNREGISTERED_RUNTIME_DEPENDENCY" });
});

test("V12-PROV-SIGN-01 provenance and signature require allowed identities/root generation", () => {
  const bytes = artifact(), f = fixture(bytes);
  assert.equal(verifyProvenance({ provenance: f.provenance, artifactDigest: f.digest, allowedBuilders: ["builder-a"], allowedWorkflows: ["v12-local-reference"] }), f.provenanceDigest);
  assert.throws(() => verifyProvenance({ provenance: f.provenance, artifactDigest: f.digest, allowedBuilders: ["builder-b"], allowedWorkflows: ["v12-local-reference"] }), { code: "BUILDER_IDENTITY_DENIED" });
  assert.equal(verifyTestSignature({ envelope: f.envelope, allowedKeys: f.allowedKeys }), true);
  assert.throws(() => verifyTestSignature({ envelope: f.envelope, allowedKeys: f.allowedKeys, revokedGenerations: [1] }), { code: "KEY_GENERATION_REVOKED" });
  assert.throws(() => verifyTestSignature({ envelope: { ...f.envelope, signature: Buffer.from("bad").toString("base64") }, allowedKeys: f.allowedKeys }), { code: "SIGNATURE_INVALID" });
});

test("V12-OCI-01 OCI descriptor is immutable, typed and namespace-bound", () => {
  const bytes = artifact(), f = fixture(bytes);
  assert.equal(verifyOciDescriptor({ descriptor: f.descriptor, artifactBytes: bytes, repositoryNamespace: "local" }), f.digest);
  assert.throws(() => verifyOciDescriptor({ descriptor: { ...f.descriptor, media_type: "application/octet-stream" }, artifactBytes: bytes, repositoryNamespace: "local" }), { code: "OCI_MEDIA_TYPE_DENIED" });
  assert.throws(() => verifyOciDescriptor({ descriptor: { ...f.descriptor, mutable_tag: "latest" }, artifactBytes: bytes, repositoryNamespace: "local" }), { code: "MUTABLE_OCI_REFERENCE_DENIED" });
});

test("V12-SURFACE-01 release inventory requires full lifecycle evidence", () => {
  const f = fixture();
  assert.equal(verifyReleaseObjects({ releaseObjects: f.releaseObjects, knownArtifactDigests: [f.digest] }), 1);
  const incomplete = structuredClone(f.releaseObjects); delete incomplete[0].rollback;
  assert.throws(() => verifyReleaseObjects({ releaseObjects: incomplete, knownArtifactDigests: [f.digest] }), { code: "INCOMPLETE_RELEASE_OBJECT" });
});

test("V12-OBS-01 provider none excludes Sentry and retains registered OTel", () => {
  const bytes = artifact();
  assert.deepEqual(verifyObservabilityClosure({ profile: { provider: "none" }, artifact: bytes, runtimeDependencies: ["otel-api"], registeredDependencies: ["otel-api"] }), { provider: "none", dependency_count: 1 });
  assert.throws(() => verifyObservabilityClosure({ profile: { provider: "none" }, artifact: bytes, runtimeDependencies: ["@sentry/node"], registeredDependencies: ["@sentry/node"] }), { code: "DISABLED_SENTRY_DEPENDENCY_PRESENT" });
});

test("V12-CHAIN-01 local reference chain passes without tool-execution/production claims", () => {
  const bytes = artifact(), f = fixture(bytes);
  const result = verifySupplyChainBundle({
    artifactBytes: bytes, contentManifest: createContentManifest(bytes), sbom: f.sbom,
    provenance: f.provenance, signatureEnvelope: f.envelope, allowedKeys: f.allowedKeys,
    ociDescriptor: f.descriptor, repositoryNamespace: "local", releaseObjects: f.releaseObjects,
    runtimeDependencies: ["node:crypto", "otel-api"], observabilityRuntimeDependencies: ["otel-api"], observabilityProfile: { provider: "none" },
    registeredObservabilityDependencies: ["otel-api"], allowedBuilders: ["builder-a"], allowedWorkflows: ["v12-local-reference"],
  });
  assert.deepEqual([result.status, result.actual_syft_cosign_oras_execution, result.production, result.authority_effect], ["PASS", false, false, "NONE"]);
});

test("V12-CHAIN-02 post-verification byte change is rejected", () => {
  const bytes = artifact();
  assert.equal(assertNoPostVerificationRebuild({ verifiedArtifactDigest: sha256(bytes), currentArtifactBytes: bytes }), true);
  assert.throws(() => assertNoPostVerificationRebuild({ verifiedArtifactDigest: sha256(bytes), currentArtifactBytes: Buffer.concat([bytes, Buffer.from(" ")]) }), { code: "POST_VERIFICATION_REBUILD_DETECTED" });
});

test("V12-CLI-01 isolated builders emit identical artifact and content manifest", () => {
  const temp = mkdtempSync(join(tmpdir(), "clued-v12-cli-")), source = join(temp, "source");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src", "main.mjs"), "export const answer = 42;\n");
  const common = {
    schema_version: "clued.v15.v12-build-input/1", object_type: "V12BuildInput",
    source_date_epoch: 1_788_194_400, environment: "minimum-local-rc", build_environment_digest: BUILD,
    disabled_adapters: ["sentry"], clean: true,
    files: [{ path: "src/main.mjs", mode: "0644", sha256: sha256(readFileSync(join(source, "src", "main.mjs"))) }],
  };
  const built = [];
  for (const builder of ["builder-a", "builder-b"]) {
    const input = join(temp, builder + ".json"), out = join(temp, builder);
    writeFileSync(input, canonicalJson({ ...common, builder_id: builder }) + "\n");
    execFileSync(process.execPath, [CLI, "--input", input, "--source-root", source, "--out", out], { cwd: ROOT });
    built.push([readFileSync(join(out, "artifact.clued-local-rc.json")), readFileSync(join(out, "content-manifest.json"))]);
  }
  assert.equal(Buffer.compare(built[0][0], built[1][0]), 0);
  assert.equal(Buffer.compare(built[0][1], built[1][1]), 0);
});

test("V12-NEG-01 subject drift is independently rejected across SBOM/provenance/OCI", () => {
  const bytes = artifact(), f = fixture(bytes), wrong = "sha256:" + "0".repeat(64);
  assert.throws(() => verifySbom({ sbom: { ...f.sbom, subject_digest: wrong }, artifactDigest: f.digest }), { code: "SBOM_SUBJECT_MISMATCH" });
  assert.throws(() => verifyProvenance({ provenance: { ...f.provenance, subject_digest: wrong }, artifactDigest: f.digest, allowedBuilders: ["builder-a"], allowedWorkflows: ["v12-local-reference"] }), { code: "PROVENANCE_SUBJECT_MISMATCH" });
  assert.throws(() => verifyOciDescriptor({ descriptor: { ...f.descriptor, digest: wrong }, artifactBytes: bytes, repositoryNamespace: "local" }), { code: "OCI_SUBJECT_MISMATCH" });
});
