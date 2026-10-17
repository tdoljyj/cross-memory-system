import { isDeepStrictEqual } from "node:util";
import { googleDriveAccessDigest } from "./resource-center-google-drive-sharing.mjs";
import { textCreateMimeType } from "./resource-center-google-drive-create-effect.mjs";
import { ancestorChain, walkAncestorChain } from "./resource-center-google-drive-ancestors.mjs";

export const GOOGLE_DRIVE_SEMANTIC_ATTEMPT = "clued.storage-semantic-attempt/1";
const folder = "application/vnd.google-apps.folder";
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const name = value => typeof value === "string" && value.length > 0 && value.length <= 1000 && !/[\u0000-\u001f\u007f/\\]/.test(value);
const client = value => typeof value === "string" && /^[A-Za-z0-9._-]{1,255}$/.test(value);
const fail = () => { throw new Error("DRIVE_SEMANTIC_EVIDENCE_UNPROVEN"); };
const baseName = value => typeof value === "string" ? value.slice(value.lastIndexOf("/") + 1) : null;
const stateKeys = ["access_digest", "explicitly_trashed", "head_revision_id", "marker", "mime_type", "name", "parent_ids", "provider_file_id", "sha256", "trashed"];
function stateValid(state) {
  return object(state) && Object.keys(state).sort().join(",") === stateKeys.join(",") &&
    id(state.provider_file_id) && name(state.name) && Array.isArray(state.parent_ids) &&
    state.parent_ids.length === 1 && id(state.parent_ids[0]) &&
    typeof state.trashed === "boolean" && typeof state.explicitly_trashed === "boolean" &&
    (!state.explicitly_trashed || state.trashed) &&
    typeof state.mime_type === "string" && state.mime_type.length > 0 && state.mime_type.length <= 255 &&
    (state.marker === null || (typeof state.marker === "string" && state.marker.length > 0 &&
      state.marker.length <= 255 && !/[\u0000-\u001f\u007f]/.test(state.marker))) &&
    (state.sha256 === null || sha(state.sha256)) &&
    (state.mime_type === folder ? state.head_revision_id === null && state.sha256 === null && sha(state.access_digest)
      : state.access_digest === null && typeof state.head_revision_id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(state.head_revision_id));
}

/** Complete semantic metadata, deliberately excluding Drive's incidental version.
 * The caller must request explicitlyTrashed and appProperties using the same
 * private OAuth client that executed the write; no permission is derived here. */
export function googleDriveSemanticState(file) {
  if (!object(file) || (file.appProperties !== undefined && file.appProperties !== null && !object(file.appProperties))) fail();
  const state = {
    access_digest: file.mimeType === folder ? googleDriveAccessDigest(file) : null,
    provider_file_id: file.id, parent_ids: Array.isArray(file.parents) ? [...file.parents] : null,
    name: file.name, trashed: file.trashed, explicitly_trashed: file.explicitlyTrashed,
    mime_type: file.mimeType, head_revision_id: file.headRevisionId ?? null,
    sha256: file.sha256Checksum ?? null, marker: file.appProperties?.clued_intent_id ?? null,
  };
  if (!stateValid(state)) fail();
  return Object.freeze({ ...state, parent_ids: Object.freeze(state.parent_ids) });
}

/** The database independently derives and validates these predicates from the
 * immutable request, attempt and actual issuer client before acknowledging them. */
export function createGoogleDriveSemanticAttempt({ oauth_client_id, mutation, attempt, file }) {
  return semanticAttemptFromState({ oauth_client_id, mutation, attempt,
    before: mutation?.operation === "create" ? file : googleDriveSemanticState(file) });
}
function semanticAttemptFromState({ oauth_client_id, mutation, attempt, before: capturedBefore }) {
  if (!client(oauth_client_id) || !object(mutation) || !object(attempt) ||
    !uuid(attempt.intent_id) || !id(attempt.provider_file_id) || !id(attempt.parent_id) ||
    !["create", "rename", "move", "replace", "delete", "restore"].includes(mutation.operation) ||
    (mutation.operation === "move" && mutation.target_kind === "directory")) fail();
  const operation = mutation.operation;
  let before, expected;
  if (operation === "create") {
    if (capturedBefore !== null || !["file", "directory"].includes(mutation.target_kind) || !name(baseName(mutation.destination_path))) fail();
    const mime = mutation.target_kind === "directory" ? folder
      : mutation.content_ref?.mime_type ?? textCreateMimeType(baseName(mutation.destination_path));
    const checksum = mutation.target_kind === "directory" ? null : attempt.sha256;
    if (mutation.target_kind === "file" ? !sha(checksum) : checksum !== null) fail();
    before = Object.freeze({ exists: false, provider_file_id: attempt.provider_file_id });
    expected = { provider_file_id: attempt.provider_file_id, parent_id: attempt.parent_id,
      name: baseName(mutation.destination_path), mime_type: mime, trashed: false, explicitly_trashed: false,
      sha256: checksum, head_revision: mutation.target_kind === "directory" ? "none" : "any", marker: attempt.intent_id };
  } else {
    before = capturedBefore;
    if (!stateValid(before)) fail();
    if (before.provider_file_id !== attempt.provider_file_id || before.marker === attempt.intent_id ||
      (operation !== "delete" && operation !== "restore" && before.mime_type === folder)) fail();
    const finalName = ["rename", "move", "restore"].includes(operation) && mutation.destination_path != null
      ? baseName(mutation.destination_path) : before.name;
    if (!name(finalName)) fail();
    expected = { provider_file_id: attempt.provider_file_id, parent_id: attempt.parent_id, name: finalName,
      // The existing replace verifier separately validates the text MIME correction.
      mime_type: operation === "replace" ? null : before.mime_type,
      trashed: operation === "delete", explicitly_trashed: operation === "delete",
      sha256: operation === "replace" ? attempt.content_after?.sha256 : before.sha256,
      head_revision: operation === "replace" ? "different" : before.mime_type === folder ? "none" : "same",
      marker: attempt.intent_id };
    if (operation === "replace" ? !sha(expected.sha256) : expected.sha256 !== null && !sha(expected.sha256)) fail();
  }
  return Object.freeze({ contract: GOOGLE_DRIVE_SEMANTIC_ATTEMPT, intent_id: attempt.intent_id,
    oauth_client_id, operation, before, expected_after: Object.freeze(expected) });
}

function attemptValid(attempt) {
  if (!object(attempt) || attempt.contract !== GOOGLE_DRIVE_SEMANTIC_ATTEMPT ||
    Object.keys(attempt).sort().join(",") !== "before,contract,expected_after,intent_id,oauth_client_id,operation" ||
    !uuid(attempt.intent_id) || !client(attempt.oauth_client_id) ||
    !["create", "rename", "move", "replace", "delete", "restore"].includes(attempt.operation) ||
    !object(attempt.expected_after)) return false;
  const e = attempt.expected_after;
  return Object.keys(e).sort().join(",") === "explicitly_trashed,head_revision,marker,mime_type,name,parent_id,provider_file_id,sha256,trashed" &&
    id(e.provider_file_id) && id(e.parent_id) && name(e.name) && e.marker === attempt.intent_id &&
    typeof e.trashed === "boolean" && typeof e.explicitly_trashed === "boolean" &&
    (e.mime_type === null || (typeof e.mime_type === "string" && e.mime_type.length > 0 && e.mime_type.length <= 255)) &&
    (e.sha256 === null || sha(e.sha256)) && ["any", "none", "same", "different"].includes(e.head_revision) &&
    (attempt.operation === "create" ? object(attempt.before) &&
      Object.keys(attempt.before).sort().join(",") === "exists,provider_file_id" &&
      attempt.before.exists === false && attempt.before.provider_file_id === e.provider_file_id
      : stateValid(attempt.before) && attempt.before.provider_file_id === e.provider_file_id &&
        attempt.before.marker !== attempt.intent_id);
}
function afterMatches(attempt, state) {
  const e = attempt.expected_after;
  return state.provider_file_id === e.provider_file_id && isDeepStrictEqual(state.parent_ids, [e.parent_id]) &&
    state.name === e.name && state.trashed === e.trashed && state.explicitly_trashed === e.explicitly_trashed &&
    (e.mime_type === null || state.mime_type === e.mime_type) && state.sha256 === e.sha256 &&
    state.marker === e.marker &&
    (e.head_revision === "any" ? state.head_revision_id !== null
      : e.head_revision === "none" ? state.head_revision_id === null
      : e.head_revision === "same" ? state.head_revision_id === attempt.before.head_revision_id
      : state.head_revision_id !== null && state.head_revision_id !== attempt.before.head_revision_id);
}

/** Classifies metadata only. It never changes Drive, retries an effect, grants
 * execution, or concludes absence for a create from an ID 404 alone.
 * The database must recheck I2, I3, original attempt and observation CAS itself. */
export function classifyGoogleDriveSemanticObservation({ attempt, file, oauth_client_id, now_ms, no_effect_after_ms }) {
  if (!attemptValid(attempt) || oauth_client_id !== attempt.oauth_client_id ||
    !Number.isFinite(now_ms) || !Number.isFinite(no_effect_after_ms) || now_ms < 0 || no_effect_after_ms < 0) fail();
  const state = file === null ? null : googleDriveSemanticState(file);
  if (state && afterMatches(attempt, state)) return Object.freeze({ outcome: "after", state, execution_permitted: false });
  if (now_ms < no_effect_after_ms) return Object.freeze({ outcome: "deferred", state, execution_permitted: false });
  if (attempt.operation === "create" && state === null)
    return Object.freeze({ outcome: "absence_probe_required", state: null, execution_permitted: false });
  if (state && attempt.operation !== "create" && isDeepStrictEqual(state, attempt.before))
    return Object.freeze({ outcome: "before", state, execution_permitted: false });
  return Object.freeze({ outcome: "conflict", state, execution_permitted: false });
}

/** Private, bounded two-read observation shared by normal verification and
 * recovery. Folder identity is walked by registered IDs before and after it.
 * No provider write, refresh, execution retry or caller-selected URL exists. */
export async function observeGoogleDriveSemanticAttempt({
  semantic, oauth_client_id, mutation, provider_attempt, provider_before, profile,
  root_folder_id, root_parent_id, get_file, list_children, clock = Date.now, timeout_ms = 10000, signal,
}) {
  if (!object(semantic) || !uuid(semantic.receipt_id) || !Number.isFinite(semantic.no_effect_after_ms) ||
    typeof get_file !== "function" || typeof list_children !== "function" || typeof clock !== "function" ||
    !Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 30000) fail();
  const evidence = structuredClone(semantic.evidence), request = structuredClone(mutation);
  const original = structuredClone(provider_attempt), beforeIdentity = structuredClone(provider_before);
  if (!attemptValid(evidence) || oauth_client_id !== evidence.oauth_client_id ||
    original?.intent_id !== evidence.intent_id || !id(root_folder_id) || !id(root_parent_id) ||
    beforeIdentity?.root_folder_id !== root_folder_id || beforeIdentity?.root_parent_id !== root_parent_id ||
    typeof profile?.managed_root !== "string") fail();
  if (!isDeepStrictEqual(semanticAttemptFromState({ oauth_client_id, mutation: request, attempt: original,
    before: evidence.operation === "create" ? null : evidence.before }), evidence)) fail();
  const root = profile.managed_root.replace(/\\/g, "/").replace(/\/$/, "");
  const paths = [...new Set([request.source_path, request.destination_path].filter(v => typeof v === "string"))];
  if (!paths.length || paths.some(v => !v.startsWith(root + "/") || v.includes("\\") ||
    v.slice(root.length + 1).split("/").some(part => !name(part) || part === "." || part === ".."))) fail();
  const parents = [...new Set(paths.map(v => v.slice(0, v.lastIndexOf("/"))))];
  const chains = parents.map(parent => ancestorChain(beforeIdentity, { root, root_folder_id, root_parent_id }, parent));
  if (chains.some(chain => !chain) || chains.some(chain => chain.length > 21)) fail();
  for (const path of paths) {
    const expectedParent = path === request.source_path
      ? beforeIdentity.source_parent_id ?? original.source_parent_id : beforeIdentity.destination_parent_id;
    const chain = chains[parents.indexOf(path.slice(0, path.lastIndexOf("/")))];
    if (chain.at(-1).id !== expectedParent) fail();
  }
  const links = new Map();
  for (let index = 0; index < chains.length; index++) {
    const parent = parents[index], parts = parent === root ? [] : parent.slice(root.length + 1).split("/");
    for (let depth = 0; depth < chains[index].length; depth++) {
      const path = depth === 0 ? root : root + "/" + parts.slice(0, depth).join("/");
      const link = { ...chains[index][depth], path };
      if (links.has(path) && !isDeepStrictEqual(links.get(path), link)) fail();
      links.set(path, link);
    }
  }
  if (links.size > 41 || new Set([...links.values()].map(x => x.id)).size !== links.size) fail();
  const controller = new AbortController(), combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const expired = new Promise((_, reject) => {
    if (combined.aborted) reject(new Error("DRIVE_SEMANTIC_OBSERVATION_ABORTED"));
    else combined.addEventListener("abort", () => reject(new Error("DRIVE_SEMANTIC_OBSERVATION_ABORTED")), { once: true });
  });
  void expired.catch(() => {});
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  const bounded = async work => { const value = await Promise.race([work, expired]); combined.throwIfAborted(); return value; };
  const read = async (identifier, allowMissing = false) => {
    combined.throwIfAborted();
    return bounded(get_file(identifier, { signal: combined, allow_missing: allowMissing }));
  };
  const readAncestors = async () => {
    const cache = new Map();
    for (const chain of chains) await bounded(walkAncestorChain(chain, async identifier => {
      if (!cache.has(identifier)) cache.set(identifier, await read(identifier));
      return cache.get(identifier);
    }));
    return [...links.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(link => {
      const item = cache.get(link.id);
      return { path: link.path, provider_file_id: item.id, provider_file_version: item.version,
        name: item.name, parent_id: item.parents[0], trashed: item.trashed, mime_type: item.mimeType };
    });
  };
  const readTarget = async () => {
    const current = await read(original.provider_file_id, true);
    if (current !== null && (!object(current) || current.id !== original.provider_file_id ||
      typeof current.version !== "string" || !/^[1-9]\d{0,39}$/.test(current.version))) fail();
    return { file: current, state: current === null ? null : googleDriveSemanticState(current),
      provider_file_version: current === null ? null : current.version };
  };
  const readSlots = async () => {
    const slots = [];
    for (const path of [...paths].sort()) {
      const parent = links.get(path.slice(0, path.lastIndexOf("/"))).id, slotName = baseName(path);
      const matches = await bounded(list_children({ parent_id: parent, name: slotName }, { signal: combined }));
      if (!Array.isArray(matches) || matches.length > 1000 || matches.some(item => !object(item) ||
        !id(item.id) || item.name !== slotName || item.trashed !== false || !isDeepStrictEqual(item.parents, [parent]))) fail();
      const ids = matches.map(item => item.id).sort();
      if (new Set(ids).size !== ids.length) fail();
      slots.push({ path, parent_id: parent, name: slotName, object_ids: ids });
    }
    return slots;
  };
  try {
    const ancestorsBefore = await readAncestors();
    const slotsBefore = await readSlots();
    const first = await readTarget(), second = await readTarget();
    const slotsAfter = await readSlots();
    const ancestorsAfter = await readAncestors(), now = clock();
    if (!Number.isFinite(now) || now < 0 || !isDeepStrictEqual(first.state, second.state) || !isDeepStrictEqual(slotsBefore, slotsAfter))
      throw new Error("DRIVE_SEMANTIC_OBSERVATION_UNSTABLE");
    const classified = classifyGoogleDriveSemanticObservation({ attempt: evidence, file: second.file,
      oauth_client_id, now_ms: now, no_effect_after_ms: semantic.no_effect_after_ms });
    if (classified.outcome === "after" && first.provider_file_version !== second.provider_file_version)
      throw new Error("DRIVE_SEMANTIC_OBSERVATION_UNSTABLE");
    const slotsMatch = slotsAfter.every(slot => isDeepStrictEqual(slot.object_ids,
      second.state && !second.state.trashed && second.state.name === slot.name && second.state.parent_ids[0] === slot.parent_id
        ? [original.provider_file_id] : []));
    const outcome = slotsMatch ? classified.outcome : now < semantic.no_effect_after_ms ? "deferred" : "conflict";
    return Object.freeze({ outcome, execution_permitted: false,
      proof: Object.freeze({ contract: "clued.storage-semantic-observation/1", intent_id: evidence.intent_id,
        semantic_attempt_receipt_id: semantic.receipt_id, oauth_client_id, observed_at_ms: now,
        first: { state: first.state, provider_file_version: first.provider_file_version },
        second: { state: second.state, provider_file_version: second.provider_file_version },
        ancestors_before: ancestorsBefore, ancestors_after: ancestorsAfter, slots_before: slotsBefore, slots_after: slotsAfter }) });
  } finally { clearTimeout(timer); controller.abort(); }
}
