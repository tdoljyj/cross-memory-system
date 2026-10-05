import { NAMESPACE_READ_SCOPES as NAMESPACE_SCOPE_LIST } from "./resource-center-google-scopes.mjs";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,version,trashed,size,sha256Checksum,md5Checksum,headRevisionId";
const NAMESPACE_READ_SCOPES = new Set(NAMESPACE_SCOPE_LIST);

function driveLiteral(value) {
  if (typeof value !== "string" || !value || value.length > 1000) {
    throw new TypeError("Invalid Drive search value.");
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// workerd rejects fetch once an invocation exhausts its subrequest budget. Match
// only these fixed runtime literals so provider or exception text never leaks.
const SUBREQUEST_LIMIT_MESSAGE = /^Too many subrequests(?:\.| by single [Ww]orker invocation\.?)?$/;
const SUBREQUEST_LIMIT_HINT = "Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits";
const subrequestLimit = (error) => error instanceof Error &&
  (SUBREQUEST_LIMIT_MESSAGE.test(error.message) || error.message === SUBREQUEST_LIMIT_HINT);

/** Host-held Drive metadata-only access; never accepts a caller credential. */
/** @param {{get_credential?: Function, get_access_token?: Function, fetch?: typeof fetch, timeout_ms?: number, authorization_details?: boolean}} config */
export function createGoogleDriveMetadataApi({
  get_access_token: getAccessToken,
  get_credential: getCredential,
  fetch: fetchImpl = globalThis.fetch,
  timeout_ms: timeoutMs = 5000,
  authorization_details: authorizationDetails = false,
} = {}) {
  if ((typeof getAccessToken !== "function" && typeof getCredential !== "function") ||
    (getAccessToken !== undefined && getCredential !== undefined) || typeof fetchImpl !== "function") {
    throw new TypeError("A Host-owned Drive credential and fetch are required.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError("timeout_ms must be 1..10000.");
  }
  if (typeof authorizationDetails !== "boolean") throw new TypeError("authorization_details must be boolean.");
  const fields = FIELDS + (authorizationDetails ? ",isAppAuthorized,capabilities(canAddChildren)" : "");

  async function credential(requireNamespace) {
    // The token and its granted scope must be obtained together from the
    // Host's authenticated credential store, never from a tool payload or
    // from the scopes requested in an authorization URL. Legacy token-only
    // bootstrap remains usable for exact-ID reads, not absence/uniqueness.
    const value = getCredential ? await getCredential() : { access_token: await getAccessToken() };
    const token = value?.access_token;
    if (typeof token !== "string" || token.length < 16) throw new Error("DRIVE_CREDENTIAL_UNAVAILABLE");
    if (requireNamespace && (typeof value?.scope !== "string" ||
      !value.scope.split(/\s+/).some((scope) => NAMESPACE_READ_SCOPES.has(scope)))) {
      throw new Error("DRIVE_NAMESPACE_VISIBILITY_UNPROVEN");
    }
    return token;
  }

  async function read(url, token, signal) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, "cache-control": "no-store" },
        cache: "no-store", redirect: "error", signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Keep provider text out of post-write diagnostics while preserving the transport category.
      if (error?.name === "TimeoutError") throw new Error("DRIVE_METADATA_TIMEOUT");
      if (error?.name === "AbortError" || signal?.aborted) throw new Error("DRIVE_METADATA_ABORTED");
      if (subrequestLimit(error)) throw new Error("DRIVE_METADATA_SUBREQUEST_LIMIT");
      throw new Error("DRIVE_METADATA_REQUEST_FAILED");
    }
    signal?.throwIfAborted();
    if (!response.ok) throw new Error("DRIVE_METADATA_UNAVAILABLE");
    try {
      return await response.json();
    } catch (error) {
      if (error?.name === "TimeoutError") throw new Error("DRIVE_METADATA_TIMEOUT");
      if (error?.name === "AbortError" || signal?.aborted) throw new Error("DRIVE_METADATA_ABORTED");
      throw new Error("DRIVE_METADATA_RESPONSE_INVALID");
    }
  }

  async function getFile(id, {signal} = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new TypeError("Invalid Drive file ID.");
    }
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("supportsAllDrives", "true");
    signal?.throwIfAborted();
    const result = await read(url.href, await credential(false), signal);
    if (!result || result.id !== id) throw new Error("DRIVE_METADATA_MISMATCH");
    return result;
  }

  // Sharing state is read separately so every other metadata object keeps its
  // existing shape; see resource-center-google-drive-sharing.mjs.
  async function getSharing(id, {signal} = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new TypeError("Invalid Drive file ID.");
    }
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
    url.searchParams.set("fields", "id,shared,permissionIds");
    url.searchParams.set("supportsAllDrives", "true");
    signal?.throwIfAborted();
    const result = await read(url.href, await credential(false), signal);
    if (!result || result.id !== id) throw new Error("DRIVE_METADATA_MISMATCH");
    return { id: result.id, shared: result.shared, permissionIds: result.permissionIds };
  }

  // Every permission with its role (P6 directory move): read separately so
  // every other metadata object keeps its existing shape.
  async function getAccess(id, {signal} = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new TypeError("Invalid Drive file ID.");
    }
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
    url.searchParams.set("fields", "id,permissions(id,type,role,domain,allowFileDiscovery,expirationTime,deleted)");
    url.searchParams.set("supportsAllDrives", "true");
    signal?.throwIfAborted();
    const result = await read(url.href, await credential(false), signal);
    if (!result || result.id !== id) throw new Error("DRIVE_METADATA_MISMATCH");
    return { id: result.id, permissions: result.permissions };
  }

  // Ownership and trash capabilities of one file (P5 trash/untrash, §3.4 item 6).
  // Read separately so every other metadata object keeps its existing shape.
  async function getOwnership(id, {signal} = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new TypeError("Invalid Drive file ID.");
    }
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
    url.searchParams.set("fields", "id,ownedByMe,capabilities(canTrash,canUntrash)");
    url.searchParams.set("supportsAllDrives", "true");
    signal?.throwIfAborted();
    const result = await read(url.href, await credential(false), signal);
    if (!result || result.id !== id) throw new Error("DRIVE_METADATA_MISMATCH");
    return { id: result.id, owned_by_me: result.ownedByMe === true,
      can_trash: result.capabilities?.canTrash === true, can_untrash: result.capabilities?.canUntrash === true };
  }

  // One revision's retention flag and content identity (P4 replace/revert).
  // Whether this app created or opened the item (StorageFullCapability P7):
  // without the full scope Drive refuses writes to an item that is not.
  // Read separately so every other metadata object keeps its existing shape.
  async function getAppAuthorization(id, {signal} = {}) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new TypeError("Invalid Drive file ID.");
    }
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
    url.searchParams.set("fields", "id,isAppAuthorized");
    url.searchParams.set("supportsAllDrives", "true");
    signal?.throwIfAborted();
    const result = await read(url.href, await credential(false), signal);
    if (!result || result.id !== id) throw new Error("DRIVE_METADATA_MISMATCH");
    // null when Drive did not say: only an explicit false refuses early.
    return { id: result.id, app_authorized: typeof result.isAppAuthorized === "boolean" ? result.isAppAuthorized : null };
  }

  async function getRevision(fileId, revisionId, {signal} = {}) {
    if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]+$/.test(fileId) ||
      typeof revisionId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(revisionId)) {
      throw new TypeError("Invalid Drive revision ID.");
    }
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`);
    url.searchParams.set("fields", "id,keepForever,size,md5Checksum");
    signal?.throwIfAborted();
    const result = await read(url.href, await credential(false), signal);
    if (!result || result.id !== revisionId) throw new Error("DRIVE_METADATA_MISMATCH");
    return result;
  }

  // The bytes of one revision, at most maxBytes (P4 revert). Read-only.
  async function downloadRevision(fileId, revisionId, maxBytes, {signal} = {}) {
    if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]+$/.test(fileId) ||
      typeof revisionId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(revisionId) ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 10 * 1024 * 1024) throw new TypeError("Invalid Drive revision download.");
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`);
    url.searchParams.set("alt", "media");
    const token = await credential(false);
    let response;
    try {
      response = await fetchImpl(url.href, { method: "GET", headers: { authorization: `Bearer ${token}`, "cache-control": "no-store" },
        cache: "no-store", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error?.name === "TimeoutError") throw new Error("DRIVE_METADATA_TIMEOUT");
      if (subrequestLimit(error)) throw new Error("DRIVE_METADATA_SUBREQUEST_LIMIT");
      throw new Error("DRIVE_METADATA_REQUEST_FAILED");
    }
    if (!response.ok || !response.body) throw new Error("DRIVE_METADATA_UNAVAILABLE");
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new Error("DRIVE_REVISION_TOO_LARGE"); }
        chunks.push(value);
      }
    } catch (error) {
      if (error?.message === "DRIVE_REVISION_TOO_LARGE") throw error;
      throw new Error("DRIVE_METADATA_RESPONSE_INVALID");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  // Number of revisions of one file that Drive keeps forever (limit 200).
  async function countKeptRevisions(fileId, {signal} = {}) {
    if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]+$/.test(fileId)) throw new TypeError("Invalid Drive file ID.");
    const token = await credential(false);
    let pageToken = null, kept = 0;
    const seenTokens = new Set();
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(`${DRIVE_API}/${encodeURIComponent(fileId)}/revisions`);
      url.searchParams.set("fields", "nextPageToken,revisions(id,keepForever)");
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const result = await read(url.href, token, signal);
      if (!Array.isArray(result?.revisions)) throw new Error("DRIVE_LIST_INVALID");
      kept += result.revisions.filter((revision) => revision?.keepForever === true).length;
      const next = result.nextPageToken;
      if (!next) return kept;
      if (typeof next !== "string" || seenTokens.has(next)) throw new Error("DRIVE_PAGINATION_INVALID");
      seenTokens.add(next);
      pageToken = next;
    }
    throw new Error("DRIVE_PAGINATION_LIMIT");
  }

  // The boundary scanner's listings also request isAppAuthorized: its island
  // rule (StorageNormalUse §3.1) counts only app-authorized Clued-named
  // entries. The listing itself is never filtered; every entry is returned.
  const scanFields = authorizationDetails ? fields : FIELDS + ",isAppAuthorized";

  async function list({ parent_id: parentId, name }, enumerate, signal, withAppAuthorization = false) {
    const q = `${driveLiteral(parentId)} in parents${enumerate ? "" : ` and name = ${driveLiteral(name)}`} and trashed = false`;
    // drive.file silently omits files created by other applications, even
    // when incompleteSearch is false. An empty list is NOT proof of absence.
    // Pin one token across pagination and recheck grants on the next lookup.
    signal?.throwIfAborted();
    const token = await credential(true);
    const matches = [];
    let pageToken = null;
    const seenTokens = new Set();
    for (let page = 0; page < 100; page += 1) {
      signal?.throwIfAborted();
      const url = new URL(DRIVE_API);
      url.searchParams.set("q", q);
      url.searchParams.set("fields", `nextPageToken,incompleteSearch,files(${withAppAuthorization ? scanFields : fields})`);
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const result = await read(url.href, token, signal);
      if (!Array.isArray(result?.files) || result.incompleteSearch === true) {
        throw new Error("DRIVE_LIST_INVALID");
      }
      matches.push(...result.files);
      if (enumerate && matches.length > 10000) throw new Error("DRIVE_ENUMERATION_LIMIT");
      if (!enumerate && matches.length > 1) return matches;
      const next = result.nextPageToken;
      if (!next) return matches;
      if (typeof next !== "string" || seenTokens.has(next)) throw new Error("DRIVE_PAGINATION_INVALID");
      seenTokens.add(next);
      pageToken = next;
    }
    throw new Error("DRIVE_PAGINATION_LIMIT");
  }

  // Whether a folder has ANY child, trashed ones included (P5 empty-directory
  // trash/untrash). Needs namespace visibility: drive.file alone would hide
  // other applications' files, so an empty answer is never trusted without it.
  async function hasChildren(parentId, {signal} = {}) {
    signal?.throwIfAborted();
    const token = await credential(true);
    const url = new URL(DRIVE_API);
    url.searchParams.set("q", `${driveLiteral(parentId)} in parents`);
    url.searchParams.set("fields", "nextPageToken,incompleteSearch,files(id)");
    url.searchParams.set("pageSize", "1");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    const result = await read(url.href, token, signal);
    if (!Array.isArray(result?.files) || result.incompleteSearch === true) throw new Error("DRIVE_LIST_INVALID");
    return result.files.length > 0 || (typeof result.nextPageToken === "string" && result.nextPageToken.length > 0);
  }

  return Object.freeze({ getFile, getSharing, getAccess, getOwnership, getAppAuthorization, hasChildren, getRevision, countKeptRevisions, downloadRevision, listChildren: (input, {signal} = {}) => list(input, false, signal),
    listFolder: (parentId, {signal, app_authorized: appAuthorized = false} = {}) => {
      if (typeof appAuthorized !== "boolean") throw new TypeError("app_authorized must be boolean.");
      return list({ parent_id: parentId }, true, signal, appAuthorized);
    } });
}
