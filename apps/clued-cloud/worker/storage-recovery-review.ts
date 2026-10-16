import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { ancestorChain, walkAncestorChain } from "../../../kernel/host/resource-center-google-drive-ancestors.mjs";
import { createStorageCredentialVault, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { createStorageFetch } from "./storage-fetch";
import { scopeProfile } from "./storage-google-scopes";

type Data = Record<string, unknown>;
type Reference = { connection_id: string; job_id: string };
type ReviewReference = { observation_id: string; base_version: number; source_receipt_id: string };
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = /^[A-Za-z0-9_-]{1,160}$/;
const safeName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(value);
function fail(reason = "DRIVE_POSTCONDITION_REQUEST_MISMATCH"): never { throw new Error(reason); }
const folderType = "application/vnd.google-apps.folder";

/** Owner review only observes the original target. Its private descriptor and
 * RPC come from the current same-Owner recovery route. It does not accept
 * browser metadata, change Drive, enable credentials or call an executor. */
export async function createStorageRecoveryReview(config: {
  client_id: string; vault: Parameters<typeof createStorageCredentialVault>[0]; descriptor: Data; source_receipt_id: string;
  rpc: (input: Data) => Promise<Data>; fetch?: typeof fetch; clock?: () => number; timeout_ms?: number;
}) {
  const vault = await createStorageCredentialVault(config.vault), fetcher = createStorageFetch(config.fetch), clock = config.clock ?? Date.now;
  const timeout = config.timeout_ms ?? 10000;
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id) || !uuid.test(config.source_receipt_id) || typeof config.rpc !== "function" ||
      !Number.isInteger(timeout) || timeout < 1 || timeout > 30000) fail();
  return Object.freeze({ async prepare(reference: Reference, revalidate?: ReviewReference) {
    if (!object(reference) || Object.keys(reference).sort().join(",") !== "connection_id,job_id" ||
        !uuid.test(reference.connection_id) || !uuid.test(reference.job_id)) fail();
    const d = structuredClone(config.descriptor);
    if (d.status !== "recovery_only" || d.connection_id !== reference.connection_id || d.job_id !== reference.job_id ||
        !uuid.test(String(d.owner_id)) || !uuid.test(String(d.intent_id)) || d.provider !== "google-drive" || d.oauth_client_id !== config.client_id ||
        !id.test(String(d.provider_subject)) || !Number.isSafeInteger(d.credential_version) || Number(d.credential_version) < 1 ||
        !Number.isSafeInteger(d.version) || Number(d.version) < 1 || !object(d.profile) || typeof d.profile.managed_root !== "string" ||
        !id.test(String(d.root_folder_id)) || !id.test(String(d.root_parent_id)) || !object(d.mutation) || !object(d.provider_before) ||
        !object(d.attempt) || !id.test(String(d.attempt.provider_file_id)) || d.mutation.target_kind !== "file") fail();
    if (revalidate && (!uuid.test(revalidate.observation_id) || revalidate.base_version !== d.version ||
        revalidate.source_receipt_id !== config.source_receipt_id)) fail();
    const profile = d.profile as Data, mutation = d.mutation as Data, before = d.provider_before as Data, attempt = d.attempt as Data;
    const root = String(profile.managed_root).replace(/\\/g, "/").replace(/\/$/, ""), targetId = String(attempt.provider_file_id);
    const paths = [...new Set([mutation.source_path, mutation.destination_path].filter((value): value is string => typeof value === "string"))];
    if (!paths.length || paths.some(path => !path.startsWith(root + "/") || path.includes("\\") || path.slice(root.length + 1).split("/").some(part => !safeName(part) || [".", ".."].includes(part)))) fail();
    const locations = paths.map(path => ({ path, name: path.slice(path.lastIndexOf("/") + 1), parentPath: path.slice(0, path.lastIndexOf("/")),
      parentId: path === mutation.destination_path ? before.destination_parent_id : before.source_parent_id }));
    if (locations.some(location => !id.test(String(location.parentId)) || location.parentPath.slice(root.length).split("/").length > 20)) fail();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("DRIVE_METADATA_TIMEOUT")), { once: true }));
    void aborted.catch(() => {});
    const bounded = <T>(work: Promise<T>) => Promise.race([work, aborted]);
    try {
      const secret: unknown = JSON.parse(await bounded(vault.open(d.credential_envelope as StorageCredentialEnvelope, {
        owner_id: String(d.owner_id), connection_id: reference.connection_id, provider: "google-drive", provider_subject: String(d.provider_subject),
        oauth_client_id: config.client_id, credential_version: Number(d.credential_version),
      })));
      const credential = async () => {
        controller.signal.throwIfAborted();
        if (!object(secret) || secret.token_type !== "Bearer" || typeof secret.access_token !== "string" || secret.access_token.length < 16 ||
            scopeProfile(secret.scope) === null || !Number.isFinite(secret.expires_at_ms) || !Number.isFinite(clock()) ||
            Number(secret.expires_at_ms) - clock() < Math.max(60000, timeout + 1000)) fail("storage_recovery_credential_expiring");
        return { access_token: secret.access_token, scope: secret.scope };
      };
      let targetStatus = 0;
      const metadata = createGoogleDriveMetadataApi({ get_credential: credential, transient_retries: 2,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          if (init?.method !== "GET" || init.body != null || url.origin !== "https://www.googleapis.com" || url.username || url.password || url.hash ||
              !/^\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname)) fail();
          const response = await bounded(fetcher(input, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) }));
          if (url.pathname === `/drive/v3/files/${targetId}`) targetStatus = response.status;
          return response;
        } });
      const getFile = (fileId: string) => bounded(metadata.getFile(fileId, { signal: controller.signal })) as Promise<Data>;
      const list = (parentId: string, name: string) => bounded(metadata.listChildren({ parent_id: parentId, name }, { signal: controller.signal })) as Promise<Data[]>;
      const folder = (file: Data, fileId: string, name: string, parentId: string) => {
        if (file.id !== fileId || file.name !== name || file.trashed !== false || file.mimeType !== folderType ||
            !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== parentId) fail("DRIVE_POSTCONDITION_ANCESTOR_CHANGED");
      };
      const parent = async (location: typeof locations[number]) => {
        const chain = ancestorChain(before, { root, root_folder_id: d.root_folder_id, root_parent_id: d.root_parent_id }, location.parentPath);
        if (chain) {
          if (chain.at(-1)?.id !== location.parentId) fail();
          return await bounded(walkAncestorChain(chain, getFile)) as Data;
        }
        let node = await getFile(String(d.root_folder_id));
        folder(node, String(d.root_folder_id), root.slice(root.lastIndexOf("/") + 1), String(d.root_parent_id));
        for (const name of location.parentPath.slice(root.length + 1).split("/").filter(Boolean)) {
          const children = await list(String(node.id), name);
          if (children.length !== 1) fail("DRIVE_POSTCONDITION_PARENT_AMBIGUOUS");
          folder(children[0], String(children[0].id), name, String(node.id)); node = children[0];
        }
        if (node.id !== location.parentId) fail("DRIVE_POSTCONDITION_ANCESTOR_CHANGED");
        return node;
      };
      const observe = async () => {
        targetStatus = 0;
        let file: Data | null = null;
        try { file = await getFile(targetId); } catch (error) { if (targetStatus !== 404) throw error; }
        if (!file) {
          for (const location of locations) {
            await parent(location);
            if ((await list(String(location.parentId), location.name)).length !== 0) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
          }
          return { observed_state: "absent", provider_file_id: targetId, provider_file_version: null, parent_id: null, name: null,
            trashed: null, mime_type: null, size: null, sha256: null, head_revision_id: null };
        }
        if (file.id !== targetId || !safeName(file.name) || !Array.isArray(file.parents) || file.parents.length !== 1 ||
            typeof file.trashed !== "boolean" || typeof file.version !== "string" || !/^[1-9]\d{0,39}$/.test(file.version) ||
            typeof file.mimeType !== "string" || file.mimeType.length > 255 || file.mimeType === folderType) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
        const location = locations.find(location => file!.name === location.name && file!.parents instanceof Array && file!.parents[0] === location.parentId);
        if (!location) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
        await parent(location);
        const matches = await list(String(location.parentId), location.name);
        if (file.trashed ? matches.length !== 0 : matches.length !== 1 || matches[0].id !== targetId) fail("DRIVE_POSTCONDITION_IDENTITY_MISMATCH");
        if (file.size != null && (typeof file.size !== "string" || !/^(0|[1-9]\d{0,19})$/.test(file.size)) ||
            file.sha256Checksum != null && (typeof file.sha256Checksum !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256Checksum)) ||
            file.headRevisionId != null && (typeof file.headRevisionId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(file.headRevisionId))) fail("DRIVE_METADATA_RESPONSE_INVALID");
        let state = "changed";
        const old = object(attempt.content_before) ? attempt.content_before : null, after = object(attempt.content_after) ? attempt.content_after : null;
        const beforeVersion = before.destination_file_id === targetId ? before.destination_file_version : before.source_file_version;
        if (file.version === beforeVersion && (!old || file.size === old.size && file.sha256Checksum === old.sha256 && file.headRevisionId === old.head_revision_id)) state = "before";
        else if (mutation.operation === "replace" && after && file.trashed === false && file.size === after.size && file.sha256Checksum === after.sha256 && file.headRevisionId !== attempt.pinned_revision_id) state = "after";
        else if ((mutation.operation === "delete" && file.trashed === true) || (mutation.operation === "restore" && file.trashed === false)) state = "after";
        else if (["rename", "move"].includes(String(mutation.operation)) && location.path === mutation.destination_path && file.trashed === false) state = "after";
        return { observed_state: state, provider_file_id: targetId, provider_file_version: file.version, parent_id: file.parents[0], name: file.name,
          trashed: file.trashed, mime_type: file.mimeType, size: file.size ?? null, sha256: file.sha256Checksum ?? null, head_revision_id: file.headRevisionId ?? null };
      };
      const first = await observe(), second = await observe();
      if (JSON.stringify(first) !== JSON.stringify(second)) fail("DRIVE_POSTCONDITION_SYNC_TIMEOUT");
      controller.signal.throwIfAborted();
      const observation = { observed_at: new Date(clock()).toISOString(), ...second };
      const result = await bounded(config.rpc({ action: revalidate ? "review_revalidate" : "review_observe", ...reference, base_version: d.version,
        source_receipt_id: config.source_receipt_id, ...(revalidate ? { observation_id: revalidate.observation_id } : {}), observation }));
      controller.signal.throwIfAborted();
      if (revalidate) {
        if (result.status !== "review_revalidated" || result.connection_id !== reference.connection_id || result.job_id !== reference.job_id ||
            result.observation_id !== revalidate.observation_id || result.source_receipt_id !== revalidate.source_receipt_id ||
            result.base_version !== revalidate.base_version || result.execution_permitted !== false) fail();
        return { status: "review_revalidated", ...reference, ...revalidate, execution_permitted: false };
      }
      if (result.status !== "review_prepared" || result.connection_id !== reference.connection_id || result.job_id !== reference.job_id ||
          !uuid.test(String(result.observation_id)) || result.base_version !== d.version ||
          result.source_receipt_id !== config.source_receipt_id || result.observed_state !== observation.observed_state ||
          typeof result.observed_at !== "string" || Date.parse(result.observed_at) !== Date.parse(observation.observed_at) ||
          result.execution_permitted !== false) fail();
      return { status: "review_prepared", ...reference, observation_id: result.observation_id, base_version: result.base_version,
        source_receipt_id: result.source_receipt_id, observed_at: result.observed_at, observed_state: result.observed_state,
        file_name: second.name ?? locations[0].name, provider_file_id: targetId, provider_file_version: second.provider_file_version,
        mime_type: second.mime_type, size: second.size, sha256: second.sha256, execution_permitted: false };
    } finally { clearTimeout(timer); controller.abort(); }
  }});
}
