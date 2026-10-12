import { createStorageCredentialVault, type StorageCredentialContext, type StorageCredentialEnvelope } from "./storage-credential-vault";
import type { StorageDemandResult } from "./storage-demand-refresh";
import { createStorageFetch } from "./storage-fetch";
import { MASTER_DISCLOSURE_VERSION, MASTER_RECONNECT_CONFIRMATION, REFRESH_RECONNECT_CONFIRMATION, RECONNECT_REFRESH_DISCLOSURE_VERSION } from "./storage-master-disclosure";

// Private Native route composition. Owner comes from requireSupabaseUser, not
// a browser field; rpc adds SHA256(fixed connector secret) and that user's JWT.
// No credential, admission or upstream response leaves this module.
type Data = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE = /^[A-Za-z0-9_-]{1,160}$/;
const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9]{1,30}$/;
const FOLDER = "application/vnd.google-apps.folder";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
export const STORAGE_OWNER_CONFIRMATION = "clued.storage-owner-confirmation/1";
export const STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION = "clued.storage-owner-confirmation/2";
export const STORAGE_OWNER_WHOLE_ROOT_MODE = "whole_created_root_v2";
export class StorageOwnerLifecycleError extends Error {
  constructor(readonly reason: string) { super("storage_owner_lifecycle_unavailable"); }
}
const deny = (reason = "lifecycle_unavailable"): never => { throw new StorageOwnerLifecycleError(reason); };
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, fields: string[]): v is Data => object(v) && Object.keys(v).sort().join() === [...fields].sort().join();
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(v => v.toString(16).padStart(2, "0")).join("");
type Budget = { deadline: number };
const budget = (): Budget => ({ deadline: Date.now() + 25000 });
function remaining(b: Budget) { const ms = b.deadline - Date.now(); if (ms <= 0) deny("operation_deadline"); return Math.min(ms, 10000); }
type Descriptor = StorageCredentialContext & { connection_version: number; profile_id: string; profile_version: number;
  credential_envelope: StorageCredentialEnvelope; root_folder_id: string; root_parent_id: string; created_by_clued: boolean;
  root_trash_confirmation_mode?: typeof STORAGE_OWNER_WHOLE_ROOT_MODE };
type Snapshot = { root_folder_id: string; root_parent_id: string; root_version: string; metadata_digest: string;
  etag: string; owned_by_me: boolean; can_trash: boolean; trashed: boolean; root_name: string; item_count: number };
export type OwnerReconnectInput = { connection_id: string; base_version: number; profile_version: number; root_stop_generation: number;
  request_id: string; confirmation: { contract: typeof STORAGE_OWNER_CONFIRMATION; root_folder_id: string; confirmed: true; normal_use: boolean }
    | { contract: typeof MASTER_RECONNECT_CONFIRMATION; root_folder_id: string; confirmed: true; master_enabled: boolean; disclosure_version: typeof MASTER_DISCLOSURE_VERSION }
    | { contract: typeof REFRESH_RECONNECT_CONFIRMATION; root_folder_id: string; confirmed: true; master_enabled: boolean; disclosure_version: typeof MASTER_DISCLOSURE_VERSION;
      default_refresh: boolean; refresh_disclosure_version: typeof RECONNECT_REFRESH_DISCLOSURE_VERSION } };
export type OwnerDeleteInput = { connection_id: string; base_version: number; profile_version: number; request_id: string;
  confirmation: { contract: typeof STORAGE_OWNER_CONFIRMATION; root_folder_id: string; confirmed: true; trash_created_root: boolean;
    metadata_digest?: string; root_version?: string } | { contract: typeof STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION;
    root_folder_id: string; confirmed: true; trash_created_root: true; confirmation_mode: typeof STORAGE_OWNER_WHOLE_ROOT_MODE } };

function descriptor(v: Data, owner: string): Descriptor {
  if (v.owner_id !== owner || !UUID.test(String(v.connection_id)) || !UUID.test(String(v.profile_id)) ||
    ![v.connection_version, v.profile_version, v.credential_version].every(x => Number.isSafeInteger(x) && Number(x) > 0) ||
    !FILE.test(String(v.root_folder_id)) || !FILE.test(String(v.root_parent_id)) ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(String(v.provider_subject)) || !/^[A-Za-z0-9._-]{1,255}$/.test(String(v.oauth_client_id)) ||
    !object(v.credential_envelope) || typeof v.created_by_clued !== "boolean") deny();
  return { ...v, provider: "google-drive" } as Descriptor;
}
function publicResult(v: Data) {
  if (v.status === "uncertain" && UUID.test(String(v.attempt_id)) && v.execution_permitted === false)
    return { status: "uncertain", attempt_id: String(v.attempt_id), execution_permitted: false };
  if (v.status !== "completed" || !UUID.test(String(v.receipt_id)) || !UUID.test(String(v.connection_id))) deny();
  if (v.master_state !== undefined && (!["on", "off", "partial"].includes(String(v.master_state)) ||
    (v.master_state === "on" && v.provider_scope_profile !== "full"))) deny();
  return { status: "completed", receipt_id: String(v.receipt_id), connection_id: String(v.connection_id),
    ...(UUID.test(String(v.attempt_id)) ? { attempt_id: String(v.attempt_id) } : {}),
    ...(UUID.test(String(v.profile_id)) ? { profile_id: String(v.profile_id) } : {}),
    ...(UUID.test(String(v.project_id)) ? { project_id: String(v.project_id) } : {}),
    ...(typeof v.root_trashed === "boolean" ? { root_trashed: v.root_trashed } : {}),
    ...(typeof v.normal_use_enabled === "boolean" ? { normal_use_enabled: v.normal_use_enabled } : {}),
    ...(v.master_state === undefined ? {} : { master_state: v.master_state }),
    ...(["legacy","normal","full"].includes(String(v.provider_scope_profile)) ? { provider_scope_profile: String(v.provider_scope_profile) } : {}),
    ...(["legacy","normal","full"].includes(String(v.requested_scope_profile)) ? { requested_scope_profile: String(v.requested_scope_profile) } : {}),
    ...(typeof v.refresh_enabled === "boolean" ? { refresh_enabled: v.refresh_enabled } : {}) };
}

export async function createStorageOwnerLifecycle(configuration: {
  rpc: (input: Data) => Promise<Data>;
  vault: Parameters<typeof createStorageCredentialVault>[0];
  /** Existing Native OAuth composition; its own attempts enforce PKCE/session,
   * live issuer, provider identity, scope and a fresh sealed credential. */
  oauth: { start(connectionId: string, defaultRefresh: boolean, scope: "keep" | "full",
    consent?: { disclosure_version: string }): Promise<{ authorization_url: string }> };
  fetch?: typeof fetch; clock?: () => number;
  credential_preflight?: (owner: string, connectionId: string, operation: "owner_metadata") => Promise<StorageDemandResult>;
}) {
  const vault = await createStorageCredentialVault(configuration.vault);
  const request = createStorageFetch(configuration.fetch), clock = configuration.clock ?? Date.now;
  const rpc = async (input: Data) => {
    try { const v = await configuration.rpc(input); if (!object(v)) deny(); return v; }
    catch (error) {
      if (error instanceof StorageOwnerLifecycleError) throw error;
      const allowed = new Set(["storage_owner_lifecycle_conflict", "storage_root_has_unresolved_mutation", "storage_owner_lifecycle_replayed", "storage_connection_unavailable"]);
      throw new StorageOwnerLifecycleError(error instanceof Error && allowed.has(error.message) ? error.message : "lifecycle_unavailable");
    }
  };
  const ownerValid = (owner: string) => { if (!UUID.test(owner)) deny("input_invalid"); };
  const load = async (owner: string, connection: string) => {
    if (configuration.credential_preflight &&
        (await configuration.credential_preflight(owner, connection, "owner_metadata")).status !== "ready")
      deny("fresh_authorization_required");
    return descriptor(await rpc({ action: "describe", connection_id: connection }), owner);
  };
  async function token(d: Descriptor) {
    const context: StorageCredentialContext = { owner_id: d.owner_id, connection_id: d.connection_id, provider: "google-drive",
      provider_subject: d.provider_subject, oauth_client_id: d.oauth_client_id, credential_version: d.credential_version };
    try {
      const raw: unknown = JSON.parse(await vault.open(d.credential_envelope, context));
      if (!object(raw) || raw.token_type !== "Bearer" || typeof raw.access_token !== "string" || raw.access_token.length < 16 ||
        /[\r\n]/.test(raw.access_token) || !Number.isFinite(raw.expires_at_ms) || Number(raw.expires_at_ms) - clock() < 60000) return deny("fresh_authorization_required");
      return raw.access_token as string;
    } catch { return deny("fresh_authorization_required"); }
  }
  async function json(url: string, access: string, b: Budget, unavailable = "metadata_unavailable"): Promise<{ value: Data; etag: string }> {
    try {
      const signal = AbortSignal.timeout(remaining(b));
      const r = await request(url, { headers: { authorization: "Bearer " + access }, cache: "no-store", signal });
      if (!r.ok) { await r.body?.cancel(); deny(unavailable); }
      if (!r.body) return deny(unavailable);
      const reader = r.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const abort = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          remaining(b); if (signal.aborted) deny("operation_deadline");
          const part = await reader.read(); if (signal.aborted) deny("operation_deadline"); if (part.done) break;
          size += part.value.byteLength;
          if (size > 262144) { await reader.cancel(); deny(unavailable); }
          chunks.push(part.value);
        }
      } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(text); if (!object(value)) return deny(unavailable);
      return { value, etag: r.headers.get("etag") ?? "" };
    } catch (error) {
      if (error instanceof StorageOwnerLifecycleError) throw error;
      return deny(unavailable);
    }
  }
  const fields = "id,name,mimeType,parents,version,trashed,ownedByMe,isAppAuthorized,driveId,capabilities(canTrash)";
  async function metadata(d: Descriptor, access: string, b: Budget, allowTrashed = false) {
    const m = await json(`${DRIVE}/${encodeURIComponent(d.root_folder_id)}?fields=${fields}`, access, b), v = m.value;
    if (v.id !== d.root_folder_id || v.mimeType !== FOLDER || typeof v.name !== "string" || !v.name || v.name.length > 1000 ||
      !VERSION.test(String(v.version)) || !Array.isArray(v.parents) || v.parents.length !== 1 || v.parents[0] !== d.root_parent_id ||
      typeof v.trashed !== "boolean" || (!allowTrashed && v.trashed) || v.ownedByMe !== true || v.isAppAuthorized !== true || v.driveId) deny("root_drift");
    return m;
  }
  async function snapshot(d: Descriptor, access: string, b: Budget): Promise<Snapshot> {
    const m = await metadata(d, access, b), rows: Data[] = [], queue = [{ id: d.root_folder_id, depth: 0 }], seen = new Set<string>();
    // Bounded, complete subtree metadata only. No file body, owner subject or
    // secret is recorded/returned. incompleteSearch/page/depth ambiguity denies.
    while (queue.length) {
      remaining(b); const node = queue.shift()!, parent = node.id;
      if (seen.has(parent) || seen.size >= 512 || node.depth >= 32) deny("inventory_unavailable"); seen.add(parent);
      let page: string | undefined;
      const pages = new Set<string>();
      do {
        const q = new URLSearchParams({ q: `'${parent}' in parents`, pageSize: "100", fields: `nextPageToken,incompleteSearch,files(id,name,mimeType,parents,version,trashed)`,
          ...(page ? { pageToken: page } : {}) });
        const listing = (await json(`${DRIVE}?${q}`, access, b, "inventory_unavailable")).value;
        if (listing.incompleteSearch === true || !Array.isArray(listing.files) || listing.files.length > 100) return deny("inventory_unavailable");
        for (const raw of listing.files) {
          if (!object(raw) || !FILE.test(String(raw.id)) || typeof raw.name !== "string" || raw.name.length > 1000 ||
            !VERSION.test(String(raw.version)) || typeof raw.trashed !== "boolean" || !Array.isArray(raw.parents) || raw.parents.length !== 1 ||
            raw.parents[0] !== parent || typeof raw.mimeType !== "string" || rows.length >= 512 || rows.some(x => x.id === raw.id) || seen.has(String(raw.id))) return deny("inventory_unavailable");
          rows.push({ id: raw.id, parent, name: raw.name, mimeType: raw.mimeType, version: raw.version, trashed: raw.trashed });
          if (raw.mimeType === FOLDER) queue.push({ id: String(raw.id), depth: node.depth + 1 });
        }
        if (listing.nextPageToken !== undefined && (typeof listing.nextPageToken !== "string" || !listing.nextPageToken || listing.nextPageToken.length > 2048)) deny("inventory_unavailable");
        const next = listing.nextPageToken as string | undefined;
        if (next && (pages.has(next) || pages.size >= 32)) deny("inventory_unavailable"); if (next) pages.add(next); page = next;
      } while (page);
    }
    rows.sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
    const end = await metadata(d, access, b);
    if (end.etag !== m.etag || JSON.stringify(end.value) !== JSON.stringify(m.value)) deny("root_drift");
    return { root_folder_id: d.root_folder_id, root_parent_id: d.root_parent_id, root_version: String(m.value.version),
      metadata_digest: await sha(JSON.stringify([m.value.id, m.value.name, m.value.parents, m.value.version, rows])), etag: m.etag,
      owned_by_me: true, can_trash: object(m.value.capabilities) && m.value.capabilities.canTrash === true,
      trashed: false, root_name: String(m.value.name), item_count: rows.length };
  }
  // V2 observes the fixed Root effect, not an atomic lock of its earlier name,
  // parent or contents. Both full pre-effect snapshots still enforce those.
  async function wholeRootObservation(d: Descriptor, access: string, b: Budget) {
    const v = (await json(`${DRIVE}/${encodeURIComponent(d.root_folder_id)}?fields=id,mimeType,trashed,version`, access, b)).value;
    if (v.id !== d.root_folder_id || v.mimeType !== FOLDER || typeof v.trashed !== "boolean" || !VERSION.test(String(v.version))) deny("root_drift");
    return v;
  }
  async function location(d: Descriptor, access: string, b: Budget) {
    const root = (await metadata(d, access, b)).value, parts = [String(root.name)], seen = new Set([d.root_folder_id]);
    // Only the provider's authenticated root alias establishes the terminal
    // My Drive identity. An ordinary ancestor with missing parents is unknown.
    const driveRoot = (await json(`${DRIVE}/root?fields=id,name,mimeType,trashed`, access, b)).value;
    if (!FILE.test(String(driveRoot.id)) || typeof driveRoot.name !== "string" || !driveRoot.name || driveRoot.name.length>1000 ||
      driveRoot.mimeType !== FOLDER || driveRoot.trashed !== false) return deny("location_unavailable");
    let parent = d.root_parent_id;
    for (let depth = 0; depth < 32; depth++) {
      if (parent === driveRoot.id) {
        parts.unshift(driveRoot.name);
        return { status: "verified", path: parts.join(" / "), root_name: root.name,
          root_folder_id: d.root_folder_id, source: "google_drive_metadata", observed_at: new Date(clock()).toISOString() };
      }
      if (seen.has(parent)) deny("location_unavailable"); seen.add(parent);
      const raw = (await json(`${DRIVE}/${encodeURIComponent(parent)}?fields=id,name,mimeType,parents,trashed`, access, b)).value;
      if (raw.id !== parent || raw.mimeType !== FOLDER || typeof raw.name !== "string" || !raw.name || raw.trashed !== false ||
        !Array.isArray(raw.parents) || raw.parents.length !== 1) return deny("location_unavailable");
      parts.unshift(raw.name);
      if (!FILE.test(String(raw.parents[0]))) deny("location_unavailable"); parent = String(raw.parents[0]);
    }
    return deny("location_unavailable");
  }
  const confirm = (v: unknown, root: string, fields: string[]) => {
    if (!exact(v, ["contract", "root_folder_id", "confirmed", ...fields]) || v.contract !== STORAGE_OWNER_CONFIRMATION || v.root_folder_id !== root || v.confirmed !== true) deny("confirmation_required");
  };
  function input(v: unknown, keys: string[]) {
    if (!exact(v, keys) || !UUID.test(String(v.connection_id)) || !UUID.test(String(v.request_id)) ||
      ![v.base_version, v.profile_version].every(x => Number.isSafeInteger(x) && Number(x) > 0) || !object(v.confirmation) || !FILE.test(String(v.confirmation.root_folder_id))) deny("input_invalid");
  }
  return Object.freeze({
    async list(owner: string) {
      ownerValid(owner); const b = budget(), listed = await rpc({ action: "list" });
      if (listed.contract !== "clued.storage-owner-lifecycle/1" || listed.complete !== true || !Array.isArray(listed.connections) || listed.connections.length > 100) return deny();
      const connections = [];
      for (const raw of listed.connections) {
        if (!object(raw) || !UUID.test(String(raw.id)) || !UUID.test(String(raw.profile_id)) || !UUID.test(String(raw.project_id)) ||
          !FILE.test(String(raw.root_folder_id)) || ![raw.version,raw.profile_version].every(v => Number.isSafeInteger(v) && Number(v)>0) ||
          raw.provider !== "google-drive" || !["awaiting_provider","active","reauthorization_required","revoked"].includes(String(raw.state)) ||
          !["legacy","account_policy","revoked"].includes(String(raw.auth_mode)) ||
          ![raw.created_by_clued,raw.root_stopped,raw.normal_use_enabled,raw.refresh_enabled,raw.policy_active,raw.database_execution_enabled,raw.profile_current].every(v=>typeof v === "boolean") ||
          !Array.isArray(raw.tracks) || raw.tracks.length>32 || !raw.tracks.every(v=>typeof v === "string") || !Array.isArray(raw.actions)) deny();
        // Select safe fields; never spread an RPC descriptor into a response.
        const row = Object.fromEntries(["id","version","provider","state","auth_mode","scope_name","provider_scope_profile","policy_active","actions","database_execution_enabled","profile_current","profile_id","profile_version","project_id","managed_root","root_folder_id","root_parent_id",
          "root_name","tracks","created_by_clued","root_stop_generation","root_stopped","normal_use_enabled","refresh_enabled"].map(k => [k,raw[k]]));
        const missing = raw.access_digest_missing;
        if (!exact(missing,["count","directories"]) || !Number.isSafeInteger(missing.count) || Number(missing.count)<0 ||
          !Array.isArray(missing.directories) || missing.directories.length>20 || missing.directories.length>Number(missing.count) ||
          !missing.directories.every(v=>exact(v,["path","since"]) && typeof v.path === "string" && v.path.length<=4096 &&
            !/[\x00-\x1f\x7f]/.test(v.path) && typeof v.since === "string" && Number.isFinite(Date.parse(v.since)))) return deny();
        row.access_digest_missing = { count: missing.count, directories: missing.directories.map(v=>({path:v.path,since:v.since})) };
        if (object(raw.pending_lifecycle) && UUID.test(String(raw.pending_lifecycle.attempt_id)) &&
          ["reconnect","delete"].includes(String(raw.pending_lifecycle.operation)) && ["prepared","started","uncertain"].includes(String(raw.pending_lifecycle.state)) &&
          raw.pending_lifecycle.execution_permitted === false) row.pending_lifecycle = { attempt_id: raw.pending_lifecycle.attempt_id,
            operation: raw.pending_lifecycle.operation, state: raw.pending_lifecycle.state,
            ...(typeof raw.pending_lifecycle.expires_at === "string" && Number.isFinite(Date.parse(raw.pending_lifecycle.expires_at))
              ? { expires_at: raw.pending_lifecycle.expires_at } : {}), execution_permitted: false };
        let physical: Data = { status: "unavailable", source: "google_drive_metadata" };
        if (raw.state === "active" && Date.now()<b.deadline) try { const d = await load(owner, String(raw.id)); physical = await location(d, await token(d), b); } catch { /* Registered path is never mislabeled physical. */ }
        connections.push({ ...row, physical_location: physical });
      }
      return { contract: "clued.storage-owner-lifecycle/1", complete: true, connections };
    },
    async reconnect(owner: string, value: OwnerReconnectInput) {
      ownerValid(owner); input(value, ["connection_id","base_version","profile_version","root_stop_generation","request_id","confirmation"]);
      const confirmation = value.confirmation;
      const refreshConsent = confirmation.contract === REFRESH_RECONNECT_CONFIRMATION;
      const master = refreshConsent || confirmation.contract === MASTER_RECONNECT_CONFIRMATION;
      if (master) {
        if (!exact(confirmation, ["contract", "root_folder_id", "confirmed", "master_enabled", "disclosure_version",
          ...(refreshConsent ? ["default_refresh", "refresh_disclosure_version"] : [])]) ||
          confirmation.confirmed !== true || typeof confirmation.master_enabled !== "boolean" ||
          confirmation.disclosure_version !== MASTER_DISCLOSURE_VERSION ||
          (refreshConsent && (typeof confirmation.default_refresh !== "boolean" ||
            confirmation.refresh_disclosure_version !== RECONNECT_REFRESH_DISCLOSURE_VERSION))) deny("confirmation_required");
      } else {
        confirm(confirmation, confirmation.root_folder_id, ["normal_use"]);
        if (typeof confirmation.normal_use !== "boolean") deny("input_invalid");
      }
      if (!Number.isSafeInteger(value.root_stop_generation) || value.root_stop_generation < 1) deny("input_invalid");
      const prepared = await rpc({ action: "reconnect_begin", ...value });
      if (prepared.status !== "prepared" || !UUID.test(String(prepared.connection_id)) || !UUID.test(String(prepared.attempt_id))) deny();
      // Initial-onboarding consent remains false. Fresh reconnect refresh consent
      // is bound to Native lifecycle activation after a completed Google grant.
      const result = master && confirmation.master_enabled
        ? await configuration.oauth.start(String(prepared.connection_id), false, "full", { disclosure_version: MASTER_DISCLOSURE_VERSION })
        : await configuration.oauth.start(String(prepared.connection_id), false, "keep");
      const url = new URL(result.authorization_url);
      if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") deny();
      return { authorization_url: url.href, connection_id: String(prepared.connection_id), lifecycle_attempt_id: String(prepared.attempt_id), refresh_enabled: false,
        ...(refreshConsent ? { refresh_requested: confirmation.default_refresh } : {}) };
    },
    /** Called ONLY after existing Native Google OAuth.complete has committed.
     * Replay checks the completed OAuth attempt; it never repeats token POST. */
    async completeReconnect(owner: string, state: string) {
      ownerValid(owner); if (!/^[A-Za-z0-9_-]{43}$/.test(state)) deny("input_invalid");
      const raw = await rpc({ action: "reconnect_activate", state_hash: await sha(state) });
      if (raw.status === "not_applicable") return { status: "not_applicable" };
      return publicResult(raw);
    },
    async previewDelete(owner: string, connectionId: string) {
      ownerValid(owner); if (!UUID.test(connectionId)) deny("input_invalid");
      const d = await load(owner, connectionId); if (!d.created_by_clued) return { trash_available: false, reason: "picked_or_legacy_root" };
      const s = await snapshot(d, await token(d), budget());
      const conditional = /^"[^"\r\n]{1,200}"$/.test(s.etag);
      const whole = d.root_trash_confirmation_mode === STORAGE_OWNER_WHOLE_ROOT_MODE;
      if (whole && (s.etag.length > 204 || /[\r\n]/.test(s.etag))) deny("metadata_unavailable");
      return { trash_available: s.can_trash && (whole || conditional),
        ...(whole ? { confirmation_contract: STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION, confirmation_mode: STORAGE_OWNER_WHOLE_ROOT_MODE } : {}),
        ...(!s.can_trash ? { reason: "can_trash_unavailable" } : !whole && !conditional ? { reason: "conditional_capability_unavailable" } : {}), root_folder_id: s.root_folder_id,
        root_name: s.root_name, root_version: s.root_version, metadata_digest: s.metadata_digest, item_count: s.item_count,
        connection_version: d.connection_version, profile_version: d.profile_version };
    },
    async delete(owner: string, value: OwnerDeleteInput) {
      ownerValid(owner); const b = budget(); input(value, ["connection_id","base_version","profile_version","request_id","confirmation"]);
      if (typeof value.confirmation.trash_created_root !== "boolean") deny("input_invalid");
      const trash = value.confirmation.trash_created_root;
      const confirmation = value.confirmation, whole = confirmation.contract === STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION;
      if (whole) {
        if (!exact(confirmation,["contract","root_folder_id","confirmed","trash_created_root","confirmation_mode"]) ||
          confirmation.confirmed !== true || confirmation.trash_created_root !== true || confirmation.confirmation_mode !== STORAGE_OWNER_WHOLE_ROOT_MODE) deny("confirmation_required");
      } else confirm(confirmation, confirmation.root_folder_id, trash ? ["trash_created_root","metadata_digest","root_version"] : ["trash_created_root"]);
      let d: Descriptor | undefined, s: Snapshot | undefined, access: string | undefined;
      if (trash) {
        d = await load(owner, value.connection_id); if (!d.created_by_clued) deny("picked_or_legacy_root");
        if (whole && d.root_trash_confirmation_mode !== STORAGE_OWNER_WHOLE_ROOT_MODE) deny("whole_root_trash_unavailable");
        if (d.connection_version !== value.base_version || d.profile_version !== value.profile_version) deny("root_drift");
        access = await token(d); s = await snapshot(d, access, b);
        if (whole && (s.etag.length > 204 || /[\r\n]/.test(s.etag))) deny("metadata_unavailable");
        if (!s.can_trash || s.root_folder_id !== confirmation.root_folder_id ||
          (confirmation.contract === STORAGE_OWNER_CONFIRMATION && (!/^"[^"\r\n]{1,200}"$/.test(s.etag) ||
            s.metadata_digest !== confirmation.metadata_digest || s.root_version !== confirmation.root_version))) deny("root_drift");
      }
      let prepared: Data;
      try { prepared = await rpc({ action: "delete_prepare", ...value, ...(s ? { snapshot: s } : {}) }); }
      catch (error) {
        // Unknown write completion is reconciled by read-only request lookup,
        // never by retrying prepare/start or issuing a provider request.
        const recovered = await rpc({ action: "recover_request", request_id: value.request_id });
        if (UUID.test(String(recovered.attempt_id)) && recovered.execution_permitted === false)
          return { status: "recovery_required", attempt_id: String(recovered.attempt_id), execution_permitted: false };
        throw error;
      }
      if (prepared.status !== "prepared" || !UUID.test(String(prepared.attempt_id)) || !UUID.test(String(prepared.admission))) {
        // Unknown/repeated prepare has no new admission: only recovery.
        if (UUID.test(String(prepared.attempt_id))) return { status: "recovery_required", attempt_id: String(prepared.attempt_id), execution_permitted: false };
        return deny();
      }
      const attempt = String(prepared.attempt_id), admission = String(prepared.admission), expires = Date.parse(String(prepared.expires_at));
      if (!Number.isFinite(expires) || expires <= clock()) deny("admission_expired");
      await rpc({ action: "delete_start", attempt_id: attempt, admission });
      if (trash) {
        try {
          // Durable Root journal fence is held before the second full scan.
          const current = await snapshot(d!, access!, b);
          if (JSON.stringify(current) !== JSON.stringify(s) || expires <= clock()) deny("root_drift");
          const checked = await rpc({ action: "delete_revalidate", attempt_id: attempt, admission });
          if (checked.status !== "admitted" || checked.attempt_id !== attempt || expires <= clock()) deny("admission_expired");
          // Local one-shot capability is never returned or serialized. A lost
          // PATCH reply cannot enter this path again: DB start is consumed.
          await request(`${DRIVE}/${encodeURIComponent(d!.root_folder_id)}?fields=id,version,trashed,parents`, {
            method: "PATCH", headers: { authorization: "Bearer " + access, "content-type": "application/json", ...(!whole ? { "if-match": s!.etag } : {}) },
            body: JSON.stringify({ trashed: true }), signal: AbortSignal.timeout(remaining(b)), cache: "no-store" }).then(async r => { await r.body?.cancel(); });
          const observed = whole ? await wholeRootObservation(d!, access!, b) : (await metadata(d!, access!, b, true)).value;
          if (observed.trashed !== true) deny("provider_completion_unknown");
          return publicResult(await rpc({ action: "delete_observe", attempt_id: attempt, root_folder_id: d!.root_folder_id,
            root_version: observed.version, outcome: "trashed" }));
        } catch {
          try { return publicResult(await rpc({ action: "delete_observe", attempt_id: attempt, root_folder_id: value.confirmation.root_folder_id, outcome: "uncertain" })); }
          catch { return { status: "uncertain", attempt_id: attempt, execution_permitted: false }; }
        }
      }
      return publicResult(await rpc({ action: "delete_observe", attempt_id: attempt, root_folder_id: value.confirmation.root_folder_id, outcome: "kept" }));
    },
    async recover(owner: string, attemptId: string) {
      ownerValid(owner); if (!UUID.test(attemptId)) deny("input_invalid");
      const raw = await rpc({ action: "recover", attempt_id: attemptId });
      if (raw.status === "completed") return publicResult(raw);
      if (!object(raw.descriptor) || !object(raw.snapshot)) return { status: String(raw.status), attempt_id: attemptId,
        ...(raw.operation === "reconnect" ? { operation: "reconnect" } : {}),
        ...(typeof raw.expires_at === "string" && Number.isFinite(Date.parse(raw.expires_at)) ? { expires_at: raw.expires_at } : {}), execution_permitted: false };
      const d = descriptor(raw.descriptor, owner), access = await token(d);
      const whole = raw.confirmation_contract === STORAGE_OWNER_WHOLE_ROOT_CONFIRMATION && raw.confirmation_mode === STORAGE_OWNER_WHOLE_ROOT_MODE;
      if ((raw.confirmation_contract !== undefined && raw.confirmation_contract !== STORAGE_OWNER_CONFIRMATION || raw.confirmation_mode !== undefined) && !whole) deny("root_drift");
      if (whole && (!d.created_by_clued || d.root_trash_confirmation_mode !== STORAGE_OWNER_WHOLE_ROOT_MODE)) deny("whole_root_trash_unavailable");
      const observed = whole ? await wholeRootObservation(d, access, budget()) : (await metadata(d, access, budget(), true)).value;
      if (observed.trashed !== true) return { status: "uncertain", attempt_id: attemptId, execution_permitted: false };
      return publicResult(await rpc({ action: "delete_observe", attempt_id: attemptId, root_folder_id: d.root_folder_id, root_version: observed.version, outcome: "trashed" }));
    },
  });
}
