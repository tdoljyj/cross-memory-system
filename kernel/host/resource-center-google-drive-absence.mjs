import { NAMESPACE_READ_SCOPES as NAMESPACE_SCOPE_LIST } from "./resource-center-google-scopes.mjs";

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const NAMESPACE_READ_SCOPES = new Set(NAMESPACE_SCOPE_LIST);
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,160}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CREATE_ABSENT_CONTRACT = "clued.storage-create-absent/1";
const fail = (code) => { throw new Error(code); };

/** BUG-20261007-005: GET-only proof that an attempted create never took effect.
 *
 * A create sends its file with the ID it generated and records beforehand, and
 * tags it with appProperties.clued_intent_id. The effect is absent only when
 * Drive answers 404 for that exact ID AND a search for the intent's tag (trashed
 * files included) finds nothing. Any other answer (the file exists, a tagged file
 * exists, an error, a timeout, a partial page, a credential without namespace
 * visibility) is not a proof: the probe returns null for a present effect and
 * throws otherwise. It never writes. Whether the create can still run is the
 * database's decision (admission expiry and attempt age), not this probe's. */
/** @param {{get_credential?: Function, fetch?: typeof fetch, timeout_ms?: number}} config */
export function createGoogleDriveCreateAbsenceProbe({
  get_credential: getCredential, fetch: fetchImpl = globalThis.fetch, timeout_ms: timeoutMs = 5000,
} = {}) {
  if (typeof getCredential !== "function" || typeof fetchImpl !== "function" ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError("A Host-owned Drive credential, fetch and bounded timeout are required.");
  }
  async function request(url, token, signal) {
    signal?.throwIfAborted();
    try {
      return await fetchImpl(url, {
        method: "GET", headers: { authorization: `Bearer ${token}`, "cache-control": "no-store" },
        cache: "no-store", redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch { return fail("DRIVE_ABSENCE_REQUEST_FAILED"); }
  }
  return async function probe({ provider_file_id: fileId, parent_id: parentId, intent_id: intentId } = {}, { signal } = {}) {
    if (typeof fileId !== "string" || !PROVIDER_ID.test(fileId) || typeof parentId !== "string" || !PROVIDER_ID.test(parentId) ||
      typeof intentId !== "string" || !UUID.test(intentId)) throw new TypeError("Invalid absence probe input.");
    const credential = await getCredential();
    const token = credential?.access_token;
    if (typeof token !== "string" || token.length < 16) fail("DRIVE_CREDENTIAL_UNAVAILABLE");
    // Absence needs namespace visibility, as the metadata API's absence checks do.
    if (typeof credential.scope !== "string" ||
      !credential.scope.split(/\s+/).some((scope) => NAMESPACE_READ_SCOPES.has(scope))) fail("DRIVE_NAMESPACE_VISIBILITY_UNPROVEN");
    const byId = new URL(`${DRIVE_API}/${encodeURIComponent(fileId)}`);
    byId.searchParams.set("fields", "id");
    byId.searchParams.set("supportsAllDrives", "true");
    const exact = await request(byId.href, token, signal);
    if (exact.status === 200) return null;
    if (exact.status !== 404) fail("DRIVE_ABSENCE_UNPROVEN");
    const tagged = new URL(DRIVE_API);
    tagged.searchParams.set("q", `appProperties has { key='clued_intent_id' and value='${intentId}' }`);
    tagged.searchParams.set("fields", "files(id),nextPageToken");
    tagged.searchParams.set("pageSize", "10");
    tagged.searchParams.set("supportsAllDrives", "true");
    tagged.searchParams.set("includeItemsFromAllDrives", "true");
    const search = await request(tagged.href, token, signal);
    if (!search.ok) fail("DRIVE_ABSENCE_UNPROVEN");
    let page;
    try { page = await search.json(); } catch { return fail("DRIVE_ABSENCE_UNPROVEN"); }
    if (!page || typeof page !== "object" || !Array.isArray(page.files) || page.nextPageToken !== undefined) fail("DRIVE_ABSENCE_UNPROVEN");
    if (page.files.length) return null;
    signal?.throwIfAborted();
    return Object.freeze({ contract: CREATE_ABSENT_CONTRACT, provider_file_id: fileId, parent_id: parentId, intent_id: intentId });
  };
}
