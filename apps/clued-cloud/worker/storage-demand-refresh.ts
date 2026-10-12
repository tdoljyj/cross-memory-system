import { createStorageCredentialVault, type StorageCredentialContext, type StorageCredentialEnvelope } from "./storage-credential-vault";
import { scopeProfile } from "./storage-google-scopes";

type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const proof = /^clued_srp_[0-9a-f]{64}$/;
const unavailable = () => new Error("storage_demand_refresh_unavailable");

export type StorageDemandResult = {
  status: "ready" | "pending" | "renewal_disabled" | "unavailable";
  credential_version?: number;
};

/** Internal preflight only. Native must authorize the original operation before
 * prepare returns a sealed credential or renewal proof. The operation obtains
 * its own fresh admission afterwards; this result is never an admission.
 * Each caller rechecks Native state independently even when an exchange is shared.
 */
export async function createStorageDemandRefresh(config: {
  client_id: string;
  vault: Parameters<typeof createStorageCredentialVault>[0];
  prepare: (request: Data) => Promise<Data>;
  observe: (input: { proof: string; credential_version: number; expires_at: string }) => Promise<Data>;
  renew: (input: { connection_id: string; proof: string }) => Promise<{ status: string }>;
  clock?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
  max_wait_ms?: number;
}) {
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(config.client_id)) throw unavailable();
  const maxWait = config.max_wait_ms ?? 30_000;
  if (!Number.isSafeInteger(maxWait) || maxWait < 100 || maxWait > 45_000) throw unavailable();
  const clock = config.clock ?? Date.now;
  const pause = config.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const vault = await createStorageCredentialVault(config.vault);
  const exchanges = new Map<string, { promise: Promise<{ status: string }>; completed: boolean; retainUntil: number }>();

  async function read(request: Data) {
    const v = await config.prepare(request);
    if (!object(v) || v.contract !== "clued.storage-demand-preflight/1" ||
        v.connection_id !== request.connection_id || !uuid.test(String(v.connection_id)) ||
        !uuid.test(String(v.owner_id)) || v.oauth_client_id !== config.client_id ||
        (request.owner_id !== undefined && request.owner_id !== v.owner_id) ||
        !/^[A-Za-z0-9_-]{1,255}$/.test(String(v.provider_subject)) ||
        !Number.isSafeInteger(v.credential_version) || Number(v.credential_version) < 1 ||
        !Number.isSafeInteger(v.delegation_version) || Number(v.delegation_version) < 0 ||
        typeof v.renewal_enabled !== "boolean" || !["idle", "pending", "uncertain"].includes(String(v.refresh_state)) ||
        !proof.test(String(v.proof))) throw unavailable();
    const context: StorageCredentialContext = { owner_id: String(v.owner_id), connection_id: String(v.connection_id),
      provider: "google-drive", provider_subject: String(v.provider_subject), oauth_client_id: config.client_id,
      credential_version: Number(v.credential_version) };
    const credential: unknown = JSON.parse(await vault.open(v.credential_envelope as StorageCredentialEnvelope, context));
    if (!object(credential) || credential.token_type !== "Bearer" || typeof credential.access_token !== "string" ||
        credential.access_token.length < 16 || /[\r\n]/.test(credential.access_token) ||
        typeof credential.refresh_token !== "string" || credential.refresh_token.length < 16 ||
        scopeProfile(credential.scope) === null || scopeProfile(credential.scope) !== v.provider_scope_profile ||
        !Number.isFinite(credential.expires_at_ms)) throw unavailable();
    return { v, context, expires: Number(credential.expires_at_ms) };
  }

  return Object.freeze({
    async ensure(request: Data, minimumValidityMs = 60_000): Promise<StorageDemandResult> {
      if (!object(request) || !uuid.test(String(request.connection_id)) ||
          !Number.isSafeInteger(minimumValidityMs) || minimumValidityMs < 60_000 || minimumValidityMs > 300_000)
        return { status: "unavailable" };
      const started = clock(), deadline = started + maxWait;
      if (!Number.isFinite(started)) return { status: "unavailable" };
      const timedOut = Symbol("storage-demand-wait-ended");
      let lastTime = started;
      const time = () => {
        const now = clock();
        if (!Number.isFinite(now) || now < lastTime) throw unavailable();
        lastTime = now;
        return now;
      };
      const bounded = async <T>(operation: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        return await Promise.race([operation, new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(timedOut), Math.max(0, deadline - time()));
        })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      };
      let firstVersion: number | null = null, renewalGeneration: number | null = null, attempted = false;
      const observedVersions = new Set<number>();
      let polls = 0, staleReloads = 0;
      try {
        while (true) {
          const now = time();
          if (now >= deadline) return { status: "pending" };
          const current = await bounded(read(request));
          if (time() >= deadline) return { status: "pending" };
          if (firstVersion === null) firstVersion = current.context.credential_version;
          // Owner disable/re-enable changes the delegation generation. A late
          // result cannot finish an old demand after either of those changes.
          if (renewalGeneration !== null && (current.v.renewal_enabled !== true ||
              current.v.delegation_version !== renewalGeneration)) return { status: "renewal_disabled" };
          if (!observedVersions.has(current.context.credential_version)) {
            const observed = await bounded(config.observe({ proof: String(current.v.proof),
              credential_version: current.context.credential_version, expires_at: new Date(current.expires).toISOString() }));
            if (object(observed) && observed.status === "stale") {
              if (++staleReloads > 3) throw unavailable();
              continue;
            }
            if (!object(observed) || observed.status !== "current") throw unavailable();
            observedVersions.add(current.context.credential_version);
          }
          if (current.expires - time() > minimumValidityMs) {
            return { status: "ready", credential_version: current.context.credential_version };
          }
          if (current.v.renewal_enabled !== true) return { status: "renewal_disabled" };
          if (current.v.refresh_state === "uncertain") return { status: "pending" };
          renewalGeneration ??= Number(current.v.delegation_version);
          if (current.v.refresh_state === "pending" || attempted) {
            // No second provider exchange after a lost or ambiguous result.
            // Native state is reloaded within the caller's bounded wait.
            if (attempted && current.v.refresh_state === "idle" && current.context.credential_version === firstVersion)
              return { status: "pending" };
            await bounded(pause(Math.min(Math.min(200 * 2 ** Math.min(polls++, 3), 1000), Math.max(0, deadline - time()))));
            continue;
          }
          attempted = true;
          for (const [entryKey, entry] of exchanges) if (entry.completed && entry.retainUntil <= time()) exchanges.delete(entryKey);
          const key = current.context.owner_id + ":" + current.context.connection_id + ":" + current.context.credential_version;
          let entry = exchanges.get(key);
          if (!entry) {
            if (exchanges.size >= 32) throw unavailable();
            const exchange = config.renew({ connection_id: current.context.connection_id, proof: String(current.v.proof) });
            entry = { promise: exchange, completed: false, retainUntil: Infinity };
            exchanges.set(key, entry);
            const original = entry;
            // A caller can still be opening the previous sealed version when
            // the exchange finishes. Retain only its nonsecret outcome for a
            // bounded period; every caller still reloads Native authorization.
            void exchange.finally(() => { original.completed = true; original.retainUntil = clock() + maxWait; }).catch(() => undefined);
          }
          const result = await bounded(entry.promise);
          if (!["committed", "pending", "not_acquired", "uncertain"].includes(result.status)) throw unavailable();
          if (result.status === "pending" || result.status === "uncertain") return { status: "pending" };
          // Reload after success or another caller's claim, then revalidate
          // permissions and versions. The refreshed token is never an API reply.
        }
      } catch (error) { return { status: error === timedOut ? "pending" : "unavailable" }; }
    },
  });
}
