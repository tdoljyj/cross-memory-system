import { createGoogleDriveMetadataApi } from '../../../kernel/host/resource-center-google-drive-metadata.mjs';
import { createGoogleDriveExternalRegistrationObserver } from '../../../kernel/host/resource-center-google-drive-external-registration.mjs';
import { createStorageCredentialVault, type StorageCredentialEnvelope } from './storage-credential-vault';
import { createStorageFetch } from './storage-fetch';
import { createStorageDemandRuntime } from './storage-demand-runtime';
import { scopeProfile } from './storage-google-scopes';
import { databaseGatewayToken } from './database-gateway';
import { resolveSupabasePublicConfig } from '../app/supabase-public-config';
import type { StorageAccessDigestBackfillEnv } from './storage-access-digest-backfill';

type Data = Record<string, unknown>;
const object = (x: unknown): x is Data => !!x && typeof x === 'object' && !Array.isArray(x);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const denied = () => new Error('storage_external_registration_unavailable');

async function boundedJson(response: Response): Promise<Data> {
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw denied(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 8 * 1024 * 1024) throw denied(); chunks.push(value); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
  if (!object(value)) throw denied(); return value;
}

/** The existing scheduled maintenance issuer reads metadata only. The Native
 * per-connection opt-in and all live authority checks remain in the database.
 * No Agent credential, public callback, Drive writer or content reader exists.
 */
export async function runStorageExternalRegistrationScheduled(env: StorageAccessDigestBackfillEnv,
  deps: { fetch?: typeof fetch; clock?: () => number } = {}) {
  if (env.CLUED_STORAGE_ACCOUNT_V1 !== 'true' || env.CLUED_STORAGE_GOOGLE_V1 !== 'true' ||
      env.CLUED_STORAGE_JOBS_V2 !== 'true' || env.CLUED_STORAGE_EXECUTOR_V1 !== 'true') return { status: 'disabled' } as const;
  const issuer = env.CLUED_STORAGE_CONNECTOR_ISSUER, gateway = databaseGatewayToken(env), clientId = env.CLUED_STORAGE_GOOGLE_CLIENT_ID;
  if (!issuer || !gateway || !clientId || !env.CLUED_STORAGE_VAULT_KEYS) return { status: 'unavailable' } as const;
  const fetcher = deps.fetch ?? fetch, clock = deps.clock ?? Date.now;
  let rpc: (input: Data, signal?: AbortSignal) => Promise<Data>;
  let demand: Awaited<ReturnType<typeof createStorageDemandRuntime>> | undefined;
  let vault: Awaited<ReturnType<typeof createStorageCredentialVault>>;
  let listed: Data[];
  try {
    const config = resolveSupabasePublicConfig({}), url = (env.SUPABASE_URL ?? config.url).replace(/\/$/, '');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(issuer));
    const proof = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    const native = async (name: string, input: Data, signal?: AbortSignal) => boundedJson(await fetcher(url + '/rest/v1/rpc/' + name, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY ?? config.key, authorization: 'Bearer ' + gateway, 'content-type': 'application/json' },
      body: JSON.stringify({ p_issuer_hash: proof, p_input: input }),
    }));
    rpc = (input, signal) => native('clued_storage_access_digest_backfill_v1', input, signal);
    const due = await rpc({ action: 'external_due' });
    if (due.status !== 'ok' || !Array.isArray(due.directories) || due.directories.length > 2 ||
        !due.directories.every(x => object(x) && uuid.test(String(x.connection_id)) && uuid.test(String(x.artifact_id)))) throw denied();
    listed = due.directories;
    if (listed.length === 0) return { status: 'ok', changed: 0, unchanged: 0, skipped: 0 } as const;
    vault = await createStorageCredentialVault(JSON.parse(env.CLUED_STORAGE_VAULT_KEYS));
    if (env.CLUED_STORAGE_REFRESH_V1 === 'true') {
      const refreshRpc = (input: Data) => native('clued_storage_refresh_worker_v1', input);
      demand = await createStorageDemandRuntime({ client_id: clientId,
        client_secret: env.CLUED_STORAGE_GOOGLE_CLIENT_SECRET ?? '', vault: JSON.parse(env.CLUED_STORAGE_VAULT_KEYS),
        fetch: fetcher, clock, refresh_rpc: refreshRpc,
        prepare: request => refreshRpc({ action: 'prepare_credential', connection_id: request.connection_id,
          caller_kind: 'maintenance', request: { operation: 'external_registration', artifact_id: request.artifact_id } }) });
    }
  } catch { return { status: 'unavailable' } as const; }
  let changed = 0, unchanged = 0, skipped = 0;
  const driveFetch = createStorageFetch(fetcher);
  for (const entry of listed) {
    const signal = AbortSignal.timeout(90000);
    let attemptId: string | undefined;
    try {
      if (demand && (await demand.maintenance(entry, 240000)).status !== 'ready') throw denied();
      // Renewal is only a preflight. Reload the current authority and sealed
      // credential afterwards, so the plan pins the renewed version.
      const d = await rpc({ action: 'external_load', connection_id: entry.connection_id, artifact_id: entry.artifact_id }, signal);
      const a = d.authority, plan = d.plan;
      if (d.status !== 'read_only' || d.execution_permitted !== false || !uuid.test(String(d.attempt_id)) ||
          !object(a) || a.connection_id !== entry.connection_id || !uuid.test(String(a.owner_id)) ||
          !Number.isSafeInteger(a.credential_version) || Number(a.credential_version) < 1 ||
          !object(plan) || plan.contract !== 'clued.storage-external-registration-plan/1' || plan.root_folder_id !== a.root_folder_id ||
          plan.root_parent_id !== a.root_parent_id || plan.managed_root !== a.managed_root ||
          d.oauth_client_id !== clientId || typeof d.provider_subject !== 'string' || !object(d.credential_envelope)) throw denied();
      attemptId = String(d.attempt_id);
      const credential: unknown = JSON.parse(await vault.open(d.credential_envelope as StorageCredentialEnvelope, {
        owner_id: String(a.owner_id), connection_id: String(entry.connection_id), provider: 'google-drive',
        provider_subject: d.provider_subject, oauth_client_id: clientId, credential_version: Number(a.credential_version),
      }));
      const getCredential = async () => {
        signal.throwIfAborted();
        if (!object(credential) || credential.token_type !== 'Bearer' || typeof credential.access_token !== 'string' ||
            credential.access_token.length < 16 || scopeProfile(credential.scope) !== 'full' ||
            !Number.isFinite(credential.expires_at_ms) || Number(credential.expires_at_ms) - clock() < 105000) throw denied();
        return { access_token: credential.access_token, scope: credential.scope };
      };
      await getCredential();
      const metadata = createGoogleDriveMetadataApi({ registration_details: true, get_credential: getCredential, transient_retries: 1,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          if (init?.method !== 'GET' || init.body != null || url.origin !== 'https://www.googleapis.com' || url.username || url.password ||
              !/^\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname) ||
              [...url.searchParams.keys()].some(k => !['fields','supportsAllDrives','includeItemsFromAllDrives','includePermissionsForView','q','pageSize','pageToken'].includes(k))) throw denied();
          return driveFetch(input, { ...init, signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) });
        } });
      const observation = await createGoogleDriveExternalRegistrationObserver({ metadata, clock }).observe(plan, { signal });
      const result = await rpc({ action: 'external_commit', connection_id: entry.connection_id, attempt_id: d.attempt_id, observation }, signal);
      if (result.attempt_id !== d.attempt_id || result.execution_permitted !== false || !Number.isSafeInteger(result.changed) || Number(result.changed) < 0) throw denied();
      if (result.status === 'committed' && uuid.test(String(result.receipt_id)) && Number(result.changed) > 0) changed += Number(result.changed);
      else if (result.status === 'unchanged' && result.changed === 0) unchanged++;
      else throw denied();
    } catch {
      skipped++;
      if (attemptId) await rpc({ action: 'external_failed', connection_id: entry.connection_id,
        attempt_id: attemptId, reason: 'scan_unavailable' }).catch(() => undefined);
    }
  }
  return { status: 'ok', changed, unchanged, skipped } as const;
}
