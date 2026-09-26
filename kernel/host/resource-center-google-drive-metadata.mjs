const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,version,trashed";

function driveLiteral(value) {
  if (typeof value !== "string" || !value || value.length > 1000) {
    throw new TypeError("Invalid Drive search value.");
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Host-held Drive metadata-only access; never accepts a caller credential. */
export function createGoogleDriveMetadataApi({
  get_access_token: getAccessToken,
  fetch: fetchImpl = globalThis.fetch,
  timeout_ms: timeoutMs = 5000,
} = {}) {
  if (typeof getAccessToken !== "function" || typeof fetchImpl !== "function") {
    throw new TypeError("A Host-owned Drive credential and fetch are required.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError("timeout_ms must be 1..10000.");
  }

  async function read(url) {
    const token = await getAccessToken();
    if (typeof token !== "string" || token.length < 16) throw new Error("DRIVE_CREDENTIAL_UNAVAILABLE");
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "cache-control": "no-store" },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error("DRIVE_METADATA_UNAVAILABLE");
    return await response.json();
  }

  async function getFile(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new TypeError("Invalid Drive file ID.");
    }
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
    url.searchParams.set("fields", FIELDS);
    url.searchParams.set("supportsAllDrives", "true");
    const result = await read(url.href);
    if (!result || result.id !== id) throw new Error("DRIVE_METADATA_MISMATCH");
    return result;
  }

  async function listChildren({ parent_id: parentId, name }) {
    const q = `${driveLiteral(parentId)} in parents and name = ${driveLiteral(name)} and trashed = false`;
    const matches = [];
    let pageToken = null;
    const seenTokens = new Set();
    for (let page = 0; page < 100; page += 1) {
      const url = new URL(DRIVE_API);
      url.searchParams.set("q", q);
      url.searchParams.set("fields", `nextPageToken,files(${FIELDS})`);
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const result = await read(url.href);
      if (!Array.isArray(result?.files) || result.incompleteSearch === true) {
        throw new Error("DRIVE_LIST_INVALID");
      }
      matches.push(...result.files);
      if (matches.length > 1) return matches;
      const next = result.nextPageToken;
      if (!next) return matches;
      if (typeof next !== "string" || seenTokens.has(next)) throw new Error("DRIVE_PAGINATION_INVALID");
      seenTokens.add(next);
      pageToken = next;
    }
    throw new Error("DRIVE_PAGINATION_LIMIT");
  }

  return Object.freeze({ getFile, listChildren });
}
