import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const MODES = new Set(["0644", "0755"]);
const MEDIA_TYPES = new Set([
  "application/vnd.clued.local-rc.artifact.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
]);

function fault(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    fault("NON_CANONICAL_VALUE", "unsupported canonical JSON value");
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function requireDigest(value, label) {
  if (!SHA256_REF.test(value || "")) fault("INVALID_DIGEST", label + " must be a sha256 reference");
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) fault("INVALID_FIELD", label + " must be a non-empty string");
  return value;
}

function uniqueSorted(values, label) {
  if (!Array.isArray(values)) fault("INVALID_FIELD", label + " must be an array");
  const normalized = values.map((item) => requireString(item, label + " item"));
  if (new Set(normalized).size !== normalized.length) fault("DUPLICATE_VALUE", label + " contains a duplicate");
  return [...normalized].sort();
}

export function normalizeArtifactPath(value) {
  requireString(value, "artifact path");
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    fault("UNSAFE_ARTIFACT_PATH", "artifact path must be portable and repository-relative");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    fault("UNSAFE_ARTIFACT_PATH", "artifact path contains an empty or traversal segment");
  }
  return parts.join("/");
}

export function assertRegularEntryKind(kind) {
  if (kind !== "file") fault("SPECIAL_ENTRY_REJECTED", "only regular files may enter the content artifact");
  return true;
}

function normalizeEntry(input) {
  assertRegularEntryKind(input && (input.kind || "file"));
  const path = normalizeArtifactPath(input.path);
  const mode = input.mode || "0644";
  if (!MODES.has(mode)) fault("INVALID_FILE_MODE", "artifact mode must be 0644 or 0755");
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes ?? "", "utf8");
  return {
    path,
    mode,
    size: bytes.length,
    sha256: sha256(bytes),
    content_base64: bytes.toString("base64"),
  };
}

function decodeEntry(entry) {
  const bytes = Buffer.from(requireString(entry.content_base64, "entry content_base64"), "base64");
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
    fault("ARTIFACT_ENTRY_DIGEST_MISMATCH", "artifact entry bytes do not match size/digest: " + entry.path);
  }
  return bytes;
}

export function buildDeterministicArtifact({
  files,
  sourceDateEpoch,
  environment = "minimum-local-rc",
  buildEnvironmentDigest,
  disabledAdapters = [],
}) {
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    fault("SOURCE_DATE_EPOCH_REQUIRED", "sourceDateEpoch must be a fixed non-negative integer");
  }
  requireString(environment, "environment");
  requireDigest(buildEnvironmentDigest, "buildEnvironmentDigest");
  if (!Array.isArray(files) || files.length === 0) fault("EMPTY_BUILD", "at least one file is required");
  const entries = files.map(normalizeEntry).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    fault("DUPLICATE_ARTIFACT_PATH", "artifact contains duplicate paths");
  }
  const artifact = {
    schema_version: "clued.v15.local-rc-artifact/1",
    object_type: "HermeticContentArtifact",
    environment,
    source_date_epoch: sourceDateEpoch,
    build_environment_digest: buildEnvironmentDigest,
    disabled_adapters: uniqueSorted(disabledAdapters, "disabledAdapters"),
    entries,
  };
  return Buffer.from(canonicalJson(artifact) + "\n", "utf8");
}

export function parseDeterministicArtifact(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let artifact;
  try {
    artifact = JSON.parse(buffer.toString("utf8"));
  } catch {
    fault("INVALID_ARTIFACT_JSON", "artifact is not valid JSON");
  }
  if (artifact.schema_version !== "clued.v15.local-rc-artifact/1" || artifact.object_type !== "HermeticContentArtifact") {
    fault("INVALID_ARTIFACT_IDENTITY", "artifact identity is invalid");
  }
  if (!Number.isSafeInteger(artifact.source_date_epoch) || artifact.source_date_epoch < 0) {
    fault("INVALID_ARTIFACT_EPOCH", "artifact source epoch is invalid");
  }
  requireDigest(artifact.build_environment_digest, "artifact build environment digest");
  const disabled = uniqueSorted(artifact.disabled_adapters, "artifact disabled adapters");
  if (canonicalJson(disabled) !== canonicalJson(artifact.disabled_adapters)) {
    fault("NON_CANONICAL_ADAPTER_SET", "disabled adapters must be sorted");
  }
  if (!Array.isArray(artifact.entries) || artifact.entries.length === 0) fault("EMPTY_ARTIFACT", "artifact has no entries");
  let previous = "";
  for (const entry of artifact.entries) {
    normalizeArtifactPath(entry.path);
    if (entry.path <= previous) fault("NON_CANONICAL_ENTRY_ORDER", "artifact entries must be unique and sorted");
    previous = entry.path;
    if (!MODES.has(entry.mode)) fault("INVALID_FILE_MODE", "artifact entry mode is invalid");
    requireDigest(entry.sha256, "entry digest");
    decodeEntry(entry);
  }
  const expected = Buffer.from(canonicalJson(artifact) + "\n", "utf8");
  if (!buffer.equals(expected)) fault("NON_CANONICAL_ARTIFACT_BYTES", "artifact bytes are not canonical UTF-8/LF JSON");
  return artifact;
}

export function createContentManifest(artifactBytes) {
  const artifact = parseDeterministicArtifact(artifactBytes);
  const tree = artifact.entries.map(({ path, mode, size, sha256: digest }) => ({ path, mode, size, sha256: digest }));
  return {
    schema_version: "clued.v15.content-manifest/1",
    object_type: "ContentManifest",
    artifact_digest: sha256(artifactBytes),
    artifact_size: Buffer.byteLength(artifactBytes),
    content_tree_digest: sha256(Buffer.from(canonicalJson(tree), "utf8")),
    environment: artifact.environment,
    source_date_epoch: artifact.source_date_epoch,
    build_environment_digest: artifact.build_environment_digest,
    disabled_adapters: artifact.disabled_adapters,
    entries: tree,
  };
}

function requireBuilder(builder, label) {
  requireString(builder && builder.id, label + " id");
  requireDigest(builder && builder.image_digest, label + " image_digest");
  if (builder.clean !== true) fault("BUILDER_NOT_CLEAN", label + " must attest clean=true");
  return builder;
}

export function assertIndependentBuilds(left, right) {
  const leftBuilder = requireBuilder(left && left.builder, "left builder");
  const rightBuilder = requireBuilder(right && right.builder, "right builder");
  if (leftBuilder.id === rightBuilder.id) fault("BUILDERS_NOT_INDEPENDENT", "the two builder identities must differ");
  if (leftBuilder.image_digest !== rightBuilder.image_digest) fault("BUILD_ENVIRONMENT_DRIFT", "builder image digests differ");
  const leftArtifact = Buffer.from(left.artifact);
  const rightArtifact = Buffer.from(right.artifact);
  parseDeterministicArtifact(leftArtifact);
  parseDeterministicArtifact(rightArtifact);
  if (!leftArtifact.equals(rightArtifact)) fault("NON_DETERMINISTIC_BUILD", "the two artifact byte streams differ");
  if (canonicalJson(left.manifest) !== canonicalJson(right.manifest)) {
    fault("NON_DETERMINISTIC_MANIFEST", "the two content manifests differ");
  }
  if (left.manifest.artifact_digest !== sha256(leftArtifact)) fault("MANIFEST_ARTIFACT_MISMATCH", "left manifest does not bind artifact");
  return { artifact_digest: sha256(leftArtifact), content_manifest_digest: sha256(Buffer.from(canonicalJson(left.manifest))) };
}

export function verifySbom({ sbom, artifactDigest, runtimeDependencies = [] }) {
  if (sbom && sbom.schema_version !== "clued.v15.sbom-evidence/1") fault("INVALID_SBOM", "SBOM schema version is invalid");
  if (sbom.tool?.id !== "syft") fault("INVALID_SBOM_TOOL", "SBOM must identify Syft");
  requireString(sbom.tool.version, "Syft version");
  requireDigest(sbom.tool.artifact_digest, "Syft tool artifact digest");
  if (!new Set(["spdx-json", "cyclonedx-json"]).has(sbom.format)) fault("INVALID_SBOM_FORMAT", "SBOM format is not allowed");
  if (sbom.subject_digest !== artifactDigest) fault("SBOM_SUBJECT_MISMATCH", "SBOM does not bind the final artifact digest");
  if (!Array.isArray(sbom.components)) fault("INVALID_SBOM", "SBOM components must be an array");
  const componentIds = new Set();
  for (const component of sbom.components) {
    const id = requireString(component.component_id, "SBOM component_id");
    if (componentIds.has(id)) fault("DUPLICATE_SBOM_COMPONENT", "duplicate SBOM component: " + id);
    componentIds.add(id);
    requireString(component.version, "SBOM component version");
    requireString(component.license, "SBOM component license");
    requireDigest(component.digest, "SBOM component digest");
    if (typeof component.runtime !== "boolean") fault("INVALID_SBOM_COMPONENT", "SBOM runtime flag must be boolean");
  }
  for (const dependency of uniqueSorted(runtimeDependencies, "runtimeDependencies")) {
    if (!componentIds.has(dependency)) fault("UNREGISTERED_RUNTIME_DEPENDENCY", "runtime dependency is absent from SBOM: " + dependency);
  }
  return { components: componentIds.size, sbom_digest: sha256(Buffer.from(canonicalJson(sbom))) };
}

export function verifyProvenance({ provenance, artifactDigest, allowedBuilders, allowedWorkflows }) {
  if (provenance?.schema_version !== "clued.v15.provenance/1") fault("INVALID_PROVENANCE", "provenance schema version is invalid");
  if (provenance.subject_digest !== artifactDigest) fault("PROVENANCE_SUBJECT_MISMATCH", "provenance subject digest mismatch");
  requireBuilder({ ...provenance.builder, clean: true }, "provenance builder");
  requireString(provenance.workflow?.id, "workflow id");
  requireDigest(provenance.workflow?.digest, "workflow digest");
  if (!allowedBuilders.includes(provenance.builder.id)) fault("BUILDER_IDENTITY_DENIED", "builder identity is not allowed");
  if (!allowedWorkflows.includes(provenance.workflow.id)) fault("WORKFLOW_IDENTITY_DENIED", "workflow identity is not allowed");
  if (!/^[0-9a-f]{40}$/.test(provenance.source?.commit || "") || !/^[0-9a-f]{40}$/.test(provenance.source?.tree || "")) {
    fault("INVALID_PROVENANCE_SOURCE", "provenance must bind commit and tree");
  }
  if (!Array.isArray(provenance.materials) || provenance.materials.length === 0) fault("EMPTY_PROVENANCE_MATERIALS", "provenance materials are required");
  for (const material of provenance.materials) {
    requireString(material.uri, "material uri");
    requireDigest(material.digest, "material digest");
  }
  return sha256(Buffer.from(canonicalJson(provenance)));
}

function signatureStatement(envelope) {
  return Buffer.from(canonicalJson({
    subject_digest: envelope.subject_digest,
    statement_digest: envelope.statement_digest,
    key_id: envelope.key_id,
    generation: envelope.generation,
    trust_scope: envelope.trust_scope,
  }), "utf8");
}

export function verifyTestSignature({ envelope, allowedKeys, revokedGenerations = [] }) {
  if (envelope?.schema_version !== "clued.v15.local-signature/1" || envelope.algorithm !== "Ed25519") {
    fault("INVALID_SIGNATURE_ENVELOPE", "local signature envelope identity is invalid");
  }
  if (envelope.trust_scope !== "test_generation" || envelope.production_trusted !== false) {
    fault("SIGNATURE_SCOPE_DENIED", "local RC signature must be test_generation and non-production");
  }
  requireDigest(envelope.subject_digest, "signature subject digest");
  requireDigest(envelope.statement_digest, "signature statement digest");
  requireString(envelope.key_id, "signature key_id");
  if (!Number.isSafeInteger(envelope.generation) || envelope.generation < 1) fault("INVALID_KEY_GENERATION", "signature generation is invalid");
  if (revokedGenerations.includes(envelope.generation)) fault("KEY_GENERATION_REVOKED", "signature generation is revoked");
  const key = allowedKeys.find((item) => item.key_id === envelope.key_id && item.generation === envelope.generation);
  if (!key) fault("UNTRUSTED_SIGNING_ROOT", "signing key/generation is not allowed");
  const publicKey = createPublicKey(key.public_key);
  if (sha256(publicKey.export({ type: "spki", format: "der" })) !== key.public_key_digest) {
    fault("TRUST_ROOT_DIGEST_MISMATCH", "allowed public key digest mismatch");
  }
  let verified = false;
  try {
    verified = verifySignature(null, signatureStatement(envelope), publicKey, Buffer.from(envelope.signature || "", "base64"));
  } catch {
    verified = false;
  }
  if (!verified) fault("SIGNATURE_INVALID", "signature verification failed");
  return true;
}

export function signaturePayload(envelope) {
  return signatureStatement(envelope);
}

export function verifyOciDescriptor({ descriptor, artifactBytes, allowedMediaTypes = [...MEDIA_TYPES], repositoryNamespace }) {
  if (descriptor?.schema_version !== "clued.v15.oci-descriptor/1") fault("INVALID_OCI_DESCRIPTOR", "OCI descriptor identity is invalid");
  const digest = sha256(artifactBytes);
  if (descriptor.digest !== digest || descriptor.size !== Buffer.byteLength(artifactBytes)) {
    fault("OCI_SUBJECT_MISMATCH", "OCI descriptor size/digest does not bind artifact bytes");
  }
  if (!allowedMediaTypes.includes(descriptor.media_type)) fault("OCI_MEDIA_TYPE_DENIED", "OCI media type is not allowed");
  requireString(descriptor.repository, "OCI repository");
  if (!descriptor.repository.startsWith(repositoryNamespace + "/")) fault("OCI_NAMESPACE_DENIED", "OCI repository namespace is not allowed");
  if (descriptor.reference !== descriptor.repository + "@" + digest || descriptor.mutable_tag) {
    fault("MUTABLE_OCI_REFERENCE_DENIED", "OCI reference must use only the immutable digest");
  }
  requireString(descriptor.retention_policy_id, "OCI retention policy");
  requireString(descriptor.access_policy_id, "OCI access policy");
  if (descriptor.consumer_verified !== true) fault("CONSUMER_VERIFICATION_REQUIRED", "consumer-side verification is required");
  return digest;
}

function requireLifecycle(value, label) {
  if (!value || typeof value !== "object") fault("INCOMPLETE_RELEASE_OBJECT", label + " is required");
  requireString(value.strategy, label + " strategy");
  requireString(value.procedure_ref, label + " procedure_ref");
}

export function verifyReleaseObjects({ releaseObjects, knownArtifactDigests }) {
  if (!Array.isArray(releaseObjects) || releaseObjects.length === 0) fault("EMPTY_RELEASE_SURFACE", "release object inventory is required");
  const ids = new Set();
  for (const item of releaseObjects) {
    const id = requireString(item.object_id, "release object id");
    if (ids.has(id)) fault("DUPLICATE_RELEASE_OBJECT", "duplicate release object: " + id);
    ids.add(id);
    for (const field of ["kind", "version", "source", "license", "security_profile_id"]) requireString(item[field], "release object " + field);
    requireDigest(item.artifact_digest, "release object artifact_digest");
    if (!knownArtifactDigests.includes(item.artifact_digest)) fault("UNKNOWN_RELEASE_ARTIFACT", "release object artifact digest is unknown");
    for (const field of ["sbom_digest", "vulnerability_result_digest", "provenance_digest", "signature_digest", "permissions_digest"]) {
      requireDigest(item[field], "release object " + field);
    }
    requireLifecycle(item.update, "update");
    requireLifecycle(item.revocation, "revocation");
    requireLifecycle(item.rollback, "rollback");
  }
  return ids.size;
}

export function verifyObservabilityClosure({ profile, artifact, runtimeDependencies, registeredDependencies }) {
  if (!profile || !new Set(["none", "sentry", "other"]).has(profile.provider)) fault("INVALID_OBSERVABILITY_PROFILE", "observability provider is invalid");
  const dependencies = uniqueSorted(runtimeDependencies, "observability runtimeDependencies");
  const registered = new Set(uniqueSorted(registeredDependencies, "registeredDependencies"));
  for (const dependency of dependencies) {
    if (!registered.has(dependency)) fault("UNREGISTERED_OBSERVABILITY_DEPENDENCY", "observability dependency is not registered: " + dependency);
  }
  const parsed = parseDeterministicArtifact(artifact);
  const hasSentry = dependencies.some((item) => /(^|[/@-])sentry([/-]|$)/i.test(item));
  if (profile.provider === "none") {
    if (!parsed.disabled_adapters.includes("sentry")) fault("SENTRY_DISABLEMENT_NOT_BOUND", "provider=none artifact must bind sentry disablement");
    if (hasSentry) fault("DISABLED_SENTRY_DEPENDENCY_PRESENT", "disabled Sentry dependency remains in runtime closure");
  }
  if (profile.provider === "sentry" && !hasSentry) fault("SENTRY_ADAPTER_MISSING", "Sentry profile lacks a Sentry runtime dependency");
  return { provider: profile.provider, dependency_count: dependencies.length };
}

export function assertNoPostVerificationRebuild({ verifiedArtifactDigest, currentArtifactBytes }) {
  requireDigest(verifiedArtifactDigest, "verified artifact digest");
  if (sha256(currentArtifactBytes) !== verifiedArtifactDigest) {
    fault("POST_VERIFICATION_REBUILD_DETECTED", "artifact bytes changed after verification");
  }
  return true;
}

export function verifySupplyChainBundle({
  artifactBytes,
  contentManifest,
  sbom,
  provenance,
  signatureEnvelope,
  allowedKeys,
  ociDescriptor,
  repositoryNamespace,
  releaseObjects,
  runtimeDependencies,
  observabilityRuntimeDependencies,
  observabilityProfile,
  registeredObservabilityDependencies,
  allowedBuilders,
  allowedWorkflows,
}) {
  parseDeterministicArtifact(artifactBytes);
  const artifactDigest = sha256(artifactBytes);
  if (canonicalJson(createContentManifest(artifactBytes)) !== canonicalJson(contentManifest)) {
    fault("CONTENT_MANIFEST_MISMATCH", "content manifest does not match artifact bytes");
  }
  const sbomResult = verifySbom({ sbom, artifactDigest, runtimeDependencies });
  const provenanceDigest = verifyProvenance({ provenance, artifactDigest, allowedBuilders, allowedWorkflows });
  if (signatureEnvelope.subject_digest !== artifactDigest || signatureEnvelope.statement_digest !== provenanceDigest) {
    fault("SIGNATURE_SUBJECT_MISMATCH", "signature does not bind artifact and provenance");
  }
  verifyTestSignature({ envelope: signatureEnvelope, allowedKeys });
  verifyOciDescriptor({ descriptor: ociDescriptor, artifactBytes, repositoryNamespace });
  const releaseObjectCount = verifyReleaseObjects({ releaseObjects, knownArtifactDigests: [artifactDigest] });
  const observability = verifyObservabilityClosure({
    profile: observabilityProfile,
    artifact: artifactBytes,
    runtimeDependencies: observabilityRuntimeDependencies,
    registeredDependencies: registeredObservabilityDependencies,
  });
  assertNoPostVerificationRebuild({ verifiedArtifactDigest: artifactDigest, currentArtifactBytes: artifactBytes });
  return {
    status: "PASS",
    scope: "V15_LOCAL_REFERENCE_SUPPLY_CHAIN_ONLY",
    ci_50_claim: "REFERENCE_IMPLEMENTATION_TESTED",
    actual_syft_cosign_oras_execution: false,
    artifact_digest: artifactDigest,
    content_manifest_digest: sha256(Buffer.from(canonicalJson(contentManifest))),
    sbom_digest: sbomResult.sbom_digest,
    provenance_digest: provenanceDigest,
    release_object_count: releaseObjectCount,
    observability,
    production: false,
    published: false,
    authority_effect: "NONE",
  };
}
