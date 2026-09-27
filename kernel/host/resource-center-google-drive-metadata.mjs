const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,version,trashed,size,sha256Checksum";
const NAMESPACE_READ_SCOPES = new Set([
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.metadata",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive",
]);

function driveLiteral(value) {
  if (typeof value !== "string" || !value || value.length > 1000) {
    throw new TypeError("Invalid Drive search value.");
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

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
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "cache-control": "no-store" },
      cache: "no-store", redirect: "error", signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    signal?.throwIfAborted();
    if (!response.ok) throw new Error("DRIVE_METADATA_UNAVAILABLE");
    return await response.json();
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

  async function list({ parent_id: parentId, name }, enumerate, signal) {
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
      url.searchParams.set("fields", `nextPageToken,incompleteSearch,files(${fields})`);
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

  return Object.freeze({ getFile, listChildren: (input, {signal} = {}) => list(input, false, signal),
    listFolder: (parentId, {signal} = {}) => list({ parent_id: parentId }, true, signal) });
}
