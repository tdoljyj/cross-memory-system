import { createStorageCredentialVault, type StorageCredentialContext, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageFetch } from "./storage-fetch";
import { bytesToBase64Url } from "./storage-base64";
import { isStorageScopeProfile, scopeProfile, scopeString, type StorageScopeProfile } from "./storage-google-scopes";
import { StorageGoogleConnectionError } from "./storage-google-oauth";
import { ONBOARD_DISCLOSURE_VERSION, onboardChoiceValid, renderOnboardDisclosure, type OnboardChoice } from "./storage-onboard-disclosure";

/** StorageNormalUse.v0.1 N0 (§8.1): self-service onboarding, Worker side.
 *
 * begin: the page's confirmed choice -> onboard attempt + PKCE OAuth attempt
 *   (no canonical row), Google consent URL for the normal or legacy set.
 * complete (from the OAuth callback, purpose 'onboard'): exchange the code,
 *   stage the sealed credential, run the idempotent Drive directory effects
 *   (root: create or check the picked folder; tracks), check overlap, then one
 *   activation transaction in the database. Any failure records it (fail) with
 *   the created objects as orphans; Clued never deletes or trashes them.
 * resume: retry the effects and activation of a failed attempt within its 30
 *   minutes with the staged credential (no second consent, no duplicate folder).
 *
 * One run at a time: stage_credential and resume hand out a run token with a
 * lease; every effect call, activate and fail carry it, and the database
 * refuses a resume while another run holds the lease. A folder this run created
 * but could not record (superseded run, ambiguous or unconfirmed result) is
 * reported with effect_stray and stays listed as an orphan. A failure that a
 * resume cannot fix drops the staged credential at once (retryable: false).
 *
 * Only fixed reason labels leave this module; never a token, code, subject,
 * upstream body or provider URL. */
const encoder = new TextEncoder();
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fileId = /^[A-Za-z0-9_-]{1,160}$/;
const FOLDER = "application/vnd.google-apps.folder";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const MAX_DEPTH = 32;
type RecordValue = Record<string, unknown>;

/** Page-only reason labels (§5.3 list plus fixed technical stages). */
export const ONBOARD_PAGE_REASONS = Object.freeze([
  "root_shared_drive", "root_not_owned", "root_overlaps_existing", "root_name_changed", "onboard_track_name_conflict",
  "onboard_effect_ambiguous", "root_multiple_parents", "root_not_folder", "root_trashed", "root_not_authorized", "root_not_writable",
  "root_metadata_unavailable", "root_ancestry_unavailable", "onboard_effect_unconfirmed", "activation_unconfirmed", "onboard_expired",
  "onboard_not_allowed", "onboard_unavailable", "onboard_disabled", "picker_unconfigured", "refresh_unavailable", "refresh_token_limit",
  "onboard_input_invalid", "onboard_disclosure_changed", "attempt_unavailable", "verifier_unavailable", "token_exchange_unconfirmed",
  "token_response_invalid", "refresh_token_missing", "scope_mismatch", "provider_identity_unconfirmed", "token_lifetime_insufficient",
  "credential_seal_unavailable", "credential_commit_unconfirmed", "onboard_run_active", "onboard_run_superseded",
]);
// Failures a resume of the same attempt cannot fix: the attempt's root, name,
// tracks or disclosure are fixed, or the staged credential itself is unusable.
// The database then drops the staged envelope immediately.
const TERMINAL = new Set(["root_shared_drive", "root_not_owned", "root_not_folder", "root_name_changed", "root_overlaps_existing",
  "onboard_not_allowed", "onboard_input_invalid", "onboard_disclosure_changed", "onboard_expired", "attempt_unavailable",
  "verifier_unavailable", "token_lifetime_insufficient"]);
export class StorageOnboardError extends StorageGoogleConnectionError {
  constructor(reason: string, onboardAttemptId?: string) { super(reason, onboardAttemptId); }
}
class Refusal extends Error { constructor(readonly reason: string) { super(reason); } }
const refuse = (reason: string): never => { throw new Refusal(reason); };
// Database labels the page may show (§8.1); everything else is generic.
const databaseReason: Record<string, string> = Object.freeze({
  storage_onboard_not_allowed: "onboard_not_allowed", storage_onboard_unavailable: "onboard_unavailable",
  storage_refresh_token_limit: "refresh_token_limit", storage_onboard_root_overlaps_existing: "root_overlaps_existing",
  storage_onboard_disclosure_changed: "onboard_disclosure_changed", storage_onboard_input_invalid: "onboard_input_invalid",
  storage_onboard_effect_ambiguous: "onboard_effect_ambiguous", storage_onboard_expired: "onboard_expired",
  storage_onboard_run_active: "onboard_run_active", storage_onboard_run_superseded: "onboard_run_superseded",
}) as Record<string, string>;
const known = (error: unknown) => error instanceof Error ? databaseReason[error.message] : undefined;
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s))), b => b.toString(16).padStart(2, "0")).join("");
const quote = (value: string) => "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";

export type OnboardResult = {
  status: "completed"; purpose: "onboard"; receipt_id: string; onboard_attempt_id: string; connection_id: string;
  provider_scope_profile: StorageScopeProfile; requested_scope_profile: StorageScopeProfile;
  normal_use_enabled: boolean; refresh_enabled: boolean;
};
type Staged = {
  onboard_attempt_id: string; run_token: string; root: { mode: "new" | "picked"; name: string; folder_id?: string }; tracks: string[];
  effects: Record<string, RecordValue>; active_roots: string[];
};

export function onboardResult(raw: RecordValue): OnboardResult {
  if (raw.status !== "completed" || raw.purpose !== "onboard" || !id.test(String(raw.receipt_id)) || !id.test(String(raw.onboard_attempt_id)) ||
    !id.test(String(raw.connection_id)) || !isStorageScopeProfile(raw.provider_scope_profile) || !isStorageScopeProfile(raw.requested_scope_profile) ||
    typeof raw.normal_use_enabled !== "boolean" || typeof raw.refresh_enabled !== "boolean") refuse("activation_unconfirmed");
  return { status: "completed", purpose: "onboard", receipt_id: String(raw.receipt_id), onboard_attempt_id: String(raw.onboard_attempt_id),
    connection_id: String(raw.connection_id), provider_scope_profile: raw.provider_scope_profile as StorageScopeProfile,
    requested_scope_profile: raw.requested_scope_profile as StorageScopeProfile, normal_use_enabled: raw.normal_use_enabled as boolean,
    refresh_enabled: raw.refresh_enabled as boolean };
}
function staged(raw: RecordValue): Staged {
  const root = raw.root as RecordValue | undefined;
  if (!id.test(String(raw.onboard_attempt_id)) || !id.test(String(raw.run_token)) || !root || (root.mode !== "new" && root.mode !== "picked") || typeof root.name !== "string" ||
    (root.mode === "picked" && !fileId.test(String(root.folder_id))) || !Array.isArray(raw.tracks) || !raw.tracks.every(t => typeof t === "string") ||
    !raw.effects || typeof raw.effects !== "object" || Array.isArray(raw.effects) ||
    !Array.isArray(raw.active_roots) || !raw.active_roots.every(r => typeof r === "string" && fileId.test(r))) refuse("attempt_unavailable");
  return raw as unknown as Staged;
}

export async function createStorageGoogleOnboard(configuration: {
  client_id: string; client_secret: string; redirect_uri: string;
  vault: Parameters<typeof createStorageCredentialVault>[0];
  /** public.clued_storage_onboard_v1 as the native user with the connector issuer secret. */
  rpc: (input: RecordValue) => Promise<RecordValue>;
  /** Server feature switches; absent Picker configuration refuses "picked". */
  picker_configured: boolean; refresh_available: boolean;
  fetch?: typeof fetch; clock?: () => number;
}) {
  const { client_id: client, client_secret: clientSecret, redirect_uri: redirect, rpc } = configuration;
  const callback = new URL(redirect);
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(client) || typeof clientSecret !== "string" || clientSecret.length < 16 ||
      callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash ||
      callback.pathname !== "/storage/google/callback" || typeof rpc !== "function") throw new Error("storage_onboard_unavailable");
  const vault = await createStorageCredentialVault(configuration.vault);
  const fetcher = createStorageFetch(configuration.fetch);
  const clock = configuration.clock ?? Date.now;
  const context = (owner: string, connection: string, subject: string): StorageCredentialContext =>
    ({ owner_id: owner, connection_id: connection, provider: "google-drive", provider_subject: subject, oauth_client_id: client, credential_version: 1 });

  async function request(url: string, init: RequestInit, reason: string): Promise<RecordValue>;
  async function request(url: string, init: RequestInit, reason: string, missing: true): Promise<RecordValue | null>;
  async function request(url: string, init: RequestInit, reason: string, missing = false): Promise<RecordValue | null> {
    let response: Response;
    try { response = await fetcher(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(10000) }); }
    catch { return refuse(reason); }
    if (missing && response.status === 404) { await response.body?.cancel().catch(() => undefined); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); refuse(reason); }
    try {
      const text = await response.text();
      if (text.length > 262144) refuse(reason);
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) refuse(reason);
      return value as RecordValue;
    } catch (error) { if (error instanceof Refusal) throw error; return refuse(reason); }
  }
  function drive(token: string) {
    const headers = { authorization: "Bearer " + token };
    return {
      get: (file: string, fields: string, reason = "root_metadata_unavailable") =>
        request(`${DRIVE}/${encodeURIComponent(file)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=false`, { headers }, reason),
      /** null only for 404 (not visible to this account); any other failure refuses. */
      find: (file: string, fields: string, reason: string) =>
        request(`${DRIVE}/${encodeURIComponent(file)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=false`, { headers }, reason, true),
      list: async (q: string, reason: string) => {
        const result = await request(`${DRIVE}?${new URLSearchParams({ q, spaces: "drive", pageSize: "10", corpora: "user",
          fields: "files(id,name,mimeType,parents,trashed,version,appProperties)" })}`, { headers }, reason);
        if (!Array.isArray(result.files)) refuse(reason);
        return result.files as RecordValue[];
      },
      create: (body: RecordValue) => request(`${DRIVE}?fields=${encodeURIComponent("id,name,mimeType,parents,trashed,version")}`,
        { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }, "onboard_effect_unconfirmed"),
    };
  }
  type Drive = ReturnType<typeof drive>;
  const folder = (raw: RecordValue, reason: string) => {
    if (!fileId.test(String(raw.id)) || raw.mimeType !== FOLDER || raw.trashed !== false || !/^[0-9]{1,40}$/.test(String(raw.version)) ||
      !Array.isArray(raw.parents) || raw.parents.length !== 1 || !fileId.test(String(raw.parents[0]))) refuse(reason);
    return { id: String(raw.id), version: String(raw.version), parents: [String((raw.parents as unknown[])[0])] };
  };
  // Parent chain up to My Drive (≤ 32 levels): [parent, grandparent, ...].
  async function ancestors(api: Drive, start: string): Promise<string[]> {
    const chain: string[] = []; let current = start;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      chain.push(current);
      const meta = await api.get(current, "id,parents", "root_ancestry_unavailable");
      if (meta.id !== current) refuse("root_ancestry_unavailable");
      if (!Array.isArray(meta.parents) || meta.parents.length === 0) return chain;
      if (meta.parents.length !== 1 || !fileId.test(String(meta.parents[0])) || chain.includes(String(meta.parents[0]))) refuse("root_ancestry_unavailable");
      current = String(meta.parents[0]);
    }
    return refuse("root_ancestry_unavailable");
  }
  async function effect(s: Staged, role: string, found: RecordValue[], create: () => Promise<RecordValue>) {
    const attempt = s.onboard_attempt_id, run_token = s.run_token;
    if (found.length > 1) refuse("onboard_effect_ambiguous");
    // Intent first (idempotent), then create; a replay finds and reuses the object.
    await rpc({ action: "effect_intent", onboard_attempt_id: attempt, run_token, role });
    const raw = found.length === 1 ? found[0] : await create();
    try {
      const object = folder(raw, "onboard_effect_unconfirmed");
      const recorded = await rpc({ action: "effect_result", onboard_attempt_id: attempt, run_token, role, provider_file_id: object.id,
        version: object.version, parents: object.parents, created: true });
      if (recorded.status !== "recorded" || (recorded.effect as RecordValue | undefined)?.provider_file_id !== object.id) refuse("onboard_effect_ambiguous");
      return object;
    } catch (error) {
      // The folder exists (its ID came back) but no effect records it: keep it
      // as an orphan. Best effort; the failure itself is what the page shows.
      if (fileId.test(String(raw.id))) {
        try { await rpc({ action: "effect_stray", onboard_attempt_id: attempt, role, provider_file_id: String(raw.id) }); } catch { /* ignore */ }
      }
      throw error;
    }
  }
  const marker = (attempt: string, role: string) =>
    `appProperties has { key='clued_onboard_attempt_id' and value=${quote(attempt)} } and appProperties has { key='clued_onboard_role' and value=${quote(role)} } and trashed=false`;

  async function run(s: Staged, token: string): Promise<OnboardResult> {
    const api = drive(token), attempt = s.onboard_attempt_id, run_token = s.run_token;
    let root: { id: string; version: string; parents: string[] };
    if (s.root.mode === "new") {
      const recorded = s.effects.root as RecordValue | undefined;
      root = await effect(s, "root", await api.list(marker(attempt, "root"), "onboard_effect_unconfirmed"), () => api.create({
        name: s.root.name, mimeType: FOLDER, appProperties: { clued_onboard_attempt_id: attempt, clued_onboard_role: "root" } }));
      if (recorded?.provider_file_id && recorded.provider_file_id !== root.id) refuse("onboard_effect_ambiguous");
    } else {
      // m-b: the picked folder, read with the server credential.
      const meta = await api.get(String(s.root.folder_id),
        "id,name,mimeType,trashed,driveId,ownedByMe,parents,isAppAuthorized,capabilities(canAddChildren),version");
      if (meta.id !== s.root.folder_id || meta.mimeType !== FOLDER) refuse("root_not_folder");
      if (meta.trashed !== false) refuse("root_trashed");
      if (meta.driveId) refuse("root_shared_drive");
      if (meta.ownedByMe !== true) refuse("root_not_owned");
      if (!Array.isArray(meta.parents) || meta.parents.length !== 1) refuse("root_multiple_parents");
      if (meta.isAppAuthorized !== true) refuse("root_not_authorized");
      if ((meta.capabilities as RecordValue | undefined)?.canAddChildren !== true) refuse("root_not_writable");
      if (meta.name !== s.root.name) refuse("root_name_changed");
      root = folder(meta, "root_metadata_unavailable");
      await rpc({ action: "effect_result", onboard_attempt_id: attempt, run_token, role: "root", provider_file_id: root.id, version: root.version,
        parents: root.parents, created: false });
    }
    // Overlap: the root equals, is inside, or contains an active root of this Google account.
    const chain = await ancestors(api, root.parents[0]);
    for (const active of s.active_roots) {
      if (active === root.id || chain.includes(active)) refuse("root_overlaps_existing");
      // An active root this account cannot see (404) cannot lie under the new
      // root; any other failure refuses (fail closed).
      const meta = await api.find(active, "id,parents,trashed", "root_ancestry_unavailable");
      if (meta === null || meta.trashed === true || !Array.isArray(meta.parents) || meta.parents.length === 0) continue;
      if (meta.parents.length !== 1 || !fileId.test(String(meta.parents[0]))) refuse("root_ancestry_unavailable");
      if ((await ancestors(api, String(meta.parents[0]))).includes(root.id)) refuse("root_overlaps_existing");
    }
    for (const track of s.tracks) {
      const role = "track:" + track;
      const named = await api.list(`${quote(root.id)} in parents and name = ${quote(track)} and mimeType = '${FOLDER}' and trashed = false`,
        "onboard_effect_unconfirmed");
      const ours = named.filter(f => (f.appProperties as RecordValue | undefined)?.clued_onboard_attempt_id === attempt &&
        (f.appProperties as RecordValue | undefined)?.clued_onboard_role === role);
      if (ours.length !== named.length) refuse("onboard_track_name_conflict");
      await effect(s, role, ours, () => api.create({ name: track, mimeType: FOLDER, parents: [root.id],
        appProperties: { clued_onboard_attempt_id: attempt, clued_onboard_role: role } }));
    }
    let activated: RecordValue;
    try { activated = await rpc({ action: "activate", onboard_attempt_id: attempt, run_token, ancestors: chain }); }
    catch (error) { return refuse(known(error) ?? "activation_unconfirmed"); }
    return onboardResult(activated);
  }
  async function guarded(attempt: string, runToken: string | null, work: () => Promise<OnboardResult>): Promise<OnboardResult> {
    try { return await work(); }
    catch (error) {
      const reason = error instanceof Refusal ? error.reason : known(error) ?? "activation_unconfirmed";
      // Separate transaction: the attempt fails, created objects become orphans.
      // A superseded run leaves the attempt to the run that holds the lease.
      if (reason !== "onboard_run_superseded") {
        try {
          await rpc({ action: "fail", onboard_attempt_id: attempt, code: reason, retryable: !TERMINAL.has(reason),
            ...(runToken ? { run_token: runToken } : {}) });
        } catch { /* status stays readable */ }
      }
      throw new StorageOnboardError(reason, attempt);
    }
  }

  return Object.freeze({
    async begin(owner: string, input: OnboardChoice & { disclosure_version: string }): Promise<{ authorization_url: string; onboard_attempt_id: string }> {
      try {
        if (!id.test(owner) || !input || typeof input !== "object") refuse("onboard_input_invalid");
        const { disclosure_version: version, ...choice } = input;
        if (version !== ONBOARD_DISCLOSURE_VERSION) refuse("onboard_disclosure_changed");
        if (!onboardChoiceValid(choice)) refuse("onboard_input_invalid");
        if (choice.root.mode === "picked" && !configuration.picker_configured) refuse("picker_unconfigured");
        if (choice.default_refresh && !configuration.refresh_available) refuse("refresh_unavailable");
        const text = renderOnboardDisclosure(choice);
        const attempt = crypto.randomUUID(), oauthAttempt = crypto.randomUUID(), connection = crypto.randomUUID();
        const state = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
        const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
        const challenge = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
        const sealed = await vault.seal(verifier, context(owner, connection, "oauth_" + oauthAttempt));
        let begun: RecordValue;
        try {
          begun = await rpc({ action: "begin", owner_id: owner, onboard_attempt_id: attempt, oauth_attempt_id: oauthAttempt, connection_id: connection,
            state_hash: await hash(state), verifier_envelope: sealed, root: choice.root, tracks: choice.tracks,
            normal_use_requested: choice.normal_use, default_refresh_requested: choice.default_refresh,
            disclosure_version: version, disclosure_text: text, disclosure_sha256: await hash(text) });
        } catch (error) { return refuse(known(error) ?? "onboard_unavailable"); }
        if (begun.status !== "begun" || begun.onboard_attempt_id !== attempt || begun.oauth_client_id !== client || begun.redirect_uri !== redirect)
          refuse("onboard_unavailable");
        const requested: StorageScopeProfile = choice.normal_use ? "normal" : "legacy";
        if (begun.requested_scope_profile !== requested) refuse("onboard_unavailable");
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        url.search = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: "code", scope: scopeString(requested),
          state, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", include_granted_scopes: "false" }).toString();
        return { authorization_url: url.href, onboard_attempt_id: attempt };
      } catch (error) {
        throw new StorageOnboardError(error instanceof Refusal ? error.reason : "onboard_unavailable");
      }
    },
    /** Called by the OAuth callback after an onboard claim (purpose 'onboard'). */
    async complete(claimed: RecordValue, code: string, stateHash: string): Promise<OnboardResult> {
      const attempt = String(claimed.onboard_attempt_id);
      let stage = "attempt_unavailable";
      if (claimed.status !== "claimed" || claimed.purpose !== "onboard" || !id.test(attempt) || !id.test(String(claimed.attempt_id)) ||
        !id.test(String(claimed.owner_id)) || !id.test(String(claimed.connection_id)) || claimed.oauth_client_id !== client ||
        claimed.redirect_uri !== redirect || claimed.credential_version !== 1 || claimed.provider_subject !== null ||
        !isStorageScopeProfile(claimed.requested_scope_profile)) throw new StorageOnboardError(stage);
      const owner = String(claimed.owner_id), connection = String(claimed.connection_id);
      const requested = claimed.requested_scope_profile as StorageScopeProfile;
      let token: string, s: Staged;
      try {
        stage = "verifier_unavailable";
        const verifier = await vault.open(claimed.verifier_envelope as StorageCredentialEnvelope, context(owner, connection, "oauth_" + claimed.attempt_id));
        if (!/^[A-Za-z0-9_-]{43}$/.test(verifier)) refuse(stage);
        const requestedAt = clock(); if (!Number.isFinite(requestedAt)) refuse(stage);
        stage = "token_exchange_unconfirmed";
        const tokens = await request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: client, client_secret: clientSecret, redirect_uri: redirect, code, code_verifier: verifier,
            grant_type: "authorization_code" }).toString() }, stage);
        stage = "token_response_invalid";
        if (tokens.token_type !== "Bearer" || typeof tokens.access_token !== "string" || tokens.access_token.length < 16 ||
          !Number.isInteger(tokens.expires_in) || Number(tokens.expires_in) < 120 || Number(tokens.expires_in) > 86400) refuse(stage);
        stage = "refresh_token_missing";
        if (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length < 16) refuse(stage);
        // §8.1 step 4: an allowed profile; normal requested may come back legacy (§2.3).
        stage = "scope_mismatch";
        const granted = scopeProfile(tokens.scope);
        if (granted === null || (granted !== requested && granted !== "legacy")) refuse(stage);
        stage = "provider_identity_unconfirmed";
        const about = await request("https://www.googleapis.com/drive/v3/about?fields=user(permissionId,me)",
          { headers: { authorization: "Bearer " + tokens.access_token } }, stage);
        const user = about.user as RecordValue | undefined, subject = typeof user?.permissionId === "string" ? user.permissionId : "";
        if (!user || user.me !== true || !/^[A-Za-z0-9_-]{1,255}$/.test(subject)) refuse(stage);
        stage = "token_lifetime_insufficient";
        const now = clock(), expiresAt = requestedAt + Number(tokens.expires_in) * 1000;
        if (!Number.isFinite(now) || now < requestedAt || expiresAt - now < 60000) refuse(stage);
        stage = "credential_seal_unavailable";
        const sealed = await vault.seal(JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token,
          token_type: "Bearer", scope: scopeString(granted!), expires_at_ms: expiresAt }), context(owner, connection, subject));
        stage = "credential_commit_unconfirmed";
        s = staged(await rpc({ action: "stage_credential", state_hash: stateHash, provider_subject: subject, credential_envelope: sealed,
          provider_scope_profile: granted }));
        if (s.onboard_attempt_id !== attempt) refuse(stage);
        token = String(tokens.access_token);
      } catch (error) {
        // Before the credential is staged there is nothing to retry: a new consent is needed.
        try { await rpc({ action: "fail", onboard_attempt_id: attempt, code: error instanceof Refusal ? error.reason : stage, retryable: false }); }
        catch { /* ignore */ }
        throw new StorageOnboardError(error instanceof Refusal ? error.reason : stage, attempt);
      }
      return await guarded(attempt, s.run_token, () => run(s, token));
    },
    /** §8.1 step 5: retry within 30 minutes with the staged credential. */
    async resume(attempt: string): Promise<OnboardResult> {
      if (!id.test(attempt)) throw new StorageOnboardError("onboard_input_invalid");
      let raw: RecordValue;
      try { raw = await rpc({ action: "resume", onboard_attempt_id: attempt }); }
      catch (error) { throw new StorageOnboardError(known(error) ?? "attempt_unavailable", attempt); }
      const runToken = id.test(String(raw.run_token)) ? String(raw.run_token) : null;
      return await guarded(attempt, runToken, async () => {
        const s = staged(raw);
        if (s.onboard_attempt_id !== attempt || !id.test(String(raw.owner_id)) || !id.test(String(raw.connection_id)) ||
          raw.oauth_client_id !== client || raw.credential_version !== 1 || !/^[A-Za-z0-9_-]{1,255}$/.test(String(raw.provider_subject)))
          refuse("attempt_unavailable");
        let plain: RecordValue;
        try {
          plain = JSON.parse(await vault.open(raw.credential_envelope as StorageCredentialEnvelope,
            context(String(raw.owner_id), String(raw.connection_id), String(raw.provider_subject)))) as RecordValue;
        } catch { return refuse("verifier_unavailable"); }
        if (typeof plain.access_token !== "string" || !Number.isFinite(plain.expires_at_ms) || Number(plain.expires_at_ms) - clock() < 60000)
          refuse("token_lifetime_insufficient");
        return await run(s, String(plain.access_token));
      });
    },
  });
}
