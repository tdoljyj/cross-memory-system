import { createHash } from "node:crypto";

export class ArchivePolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "ArchivePolicyError";
    this.code = code;
  }
}
function reject(code) { throw new ArchivePolicyError(code); }
const sha = (value) => "sha256:" + createHash("sha256").update(
  typeof value === "string" ? value : JSON.stringify(value),
).digest("hex");
function normalizeEntryPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || path.includes("\0") ||
      /^(?:[a-z]:|[\\/]{2}|\/)/i.test(path)) reject("ARCHIVE_ABSOLUTE_PATH");
  const parts = path.normalize("NFKC").replaceAll("\\", "/").split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." ||
      /[. ]$/.test(part) || part.includes(":") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    reject("ARCHIVE_PATH_AMBIGUOUS");
  }
  return parts.join("/").toLocaleLowerCase("en-US");
}

export function validateArchiveEntries(entries, budget) {
  if (!Array.isArray(entries) || entries.length > budget.max_entries) reject("ARCHIVE_ENTRY_BUDGET_EXCEEDED");
  const names = new Set();
  let compressedBytes = 0;
  let expandedBytes = 0;
  const manifestEntries = [];
  for (const entry of entries) {
    const normalized = normalizeEntryPath(entry.path);
    if (names.has(normalized)) reject("ARCHIVE_NORMALIZATION_COLLISION");
    names.add(normalized);
    if (!["regular","directory"].includes(entry.type) || entry.symlink || entry.hardlink ||
        entry.reparse || entry.device || entry.fifo || entry.socket || entry.ads ||
        entry.sparse || entry.unknown_special) reject("ARCHIVE_SPECIAL_OBJECT_REJECTED");
    if (!Number.isSafeInteger(entry.compressed_size) || !Number.isSafeInteger(entry.expanded_size) ||
        entry.compressed_size < 0 || entry.expanded_size < 0 ||
        entry.expanded_size > budget.max_entry_bytes ||
        normalized.split("/").length > budget.max_depth) reject("ARCHIVE_ENTRY_INVALID");
    compressedBytes += entry.compressed_size;
    expandedBytes += entry.expanded_size;
    if (compressedBytes > budget.max_compressed_bytes ||
        expandedBytes > budget.max_expanded_bytes ||
        expandedBytes > Math.max(1, compressedBytes) * budget.max_compression_ratio) {
      reject("ARCHIVE_EXPANSION_BUDGET_EXCEEDED");
    }
    manifestEntries.push({
      normalized_path: normalized,
      type: entry.type,
      expanded_size: entry.expanded_size,
      content_digest: entry.content_digest,
    });
  }
  const sealed = {
    entries: manifestEntries.sort((a,b) => a.normalized_path.localeCompare(b.normalized_path)),
    compressed_bytes: compressedBytes,
    expanded_bytes: expandedBytes,
    network_access: false,
    executable: false,
    sandbox_profile: budget.sandbox_profile,
  };
  return Object.freeze({
    ...sealed,
    completeness: "complete",
    sealed_manifest_digest: sha(JSON.stringify(sealed)),
  });
}

export function classifyImportStorageApplicability(input) {
  const selected = input.release_profile?.capabilities?.includes("import-storage") ||
    input.release_bom?.artifacts?.some((artifact) => artifact.capability === "import-storage") ||
    input.runtime_entrypoints?.some((entry) => entry.capability === "import-storage");
  if (selected) {
    return Object.freeze({
      disposition: "REQUIRED",
      reason: "IMPORT_STORAGE_PRESENT_IN_PROFILE_BOM_OR_RUNTIME",
      na_proof_valid: false,
    });
  }
  const proofComplete =
    /^sha256:[0-9a-f]{64}$/.test(input.release_profile_digest || "") &&
    /^sha256:[0-9a-f]{64}$/.test(input.release_bom_digest || "") &&
    input.runtime_scan?.entrypoints_found === 0 &&
    input.runtime_scan?.scanner_digest?.startsWith("sha256:") &&
    input.negative_invocation?.result === "CAPABILITY_NOT_DECLARED" &&
    input.claim_exclusions?.v15 === true &&
    input.claim_exclusions?.v17 === true;
  if (!proofComplete) reject("IMPORT_STORAGE_NA_PROOF_INCOMPLETE");
  return Object.freeze({
    disposition: "N/A_WITH_PROOF",
    reason: "FINAL_PROFILE_BOM_AND_RUNTIME_OMIT_IMPORT_STORAGE",
    na_proof_valid: true,
    release_profile_digest: input.release_profile_digest,
    release_bom_digest: input.release_bom_digest,
  });
}
