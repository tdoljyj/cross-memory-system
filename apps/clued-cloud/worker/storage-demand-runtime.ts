import { createStorageDemandRefresh } from "./storage-demand-refresh";
import { createStorageGoogleRefresh } from "./storage-google-refresh";

type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Private composition for the fixed Worker issuer. Each prepare RPC remains
 * bound to its original caller (Agent hash, live Owner JWT, or exact job).
 * The adapter never accepts a connection ID as permission and never exposes
 * the Native proof or ciphertext in its result. No permissions are cached.
 */
export async function createStorageDemandRuntime(config: {
  client_id: string; client_secret: string;
  vault: Parameters<typeof createStorageGoogleRefresh>[0]["vault"];
  prepare: (request: Data) => Promise<Data>;
  refresh_rpc: (input: Data) => Promise<Data>;
  fetch?: typeof fetch; clock?: () => number;
}) {
  const refresher = await createStorageGoogleRefresh({ client_id: config.client_id, client_secret: config.client_secret,
    vault: config.vault, rpc: config.refresh_rpc, fetch: config.fetch, clock: config.clock });
  const demand = await createStorageDemandRefresh({ client_id: config.client_id, vault: config.vault,
    prepare: config.prepare, clock: config.clock,
    observe: input => config.refresh_rpc({ action: "observe_credential", ...input }),
    renew: input => refresher.run(input.connection_id, undefined, input.proof),
  });
  return Object.freeze({
    async agent(value: Data) {
      if (!object(value.input) || typeof value.token_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.token_hash))
        return { status: "unavailable" as const };
      return demand.ensure({ ...value.input, caller_kind: "agent_read", token_hash: value.token_hash });
    },
    async owner(owner: string, connection: string, operation: "owner_metadata" | "probe") {
      if (!UUID.test(owner) || !UUID.test(connection)) return { status: "unavailable" as const };
      // Owner identity is still derived from the caller's live JWT in Native.
      return demand.ensure({ connection_id: connection, caller_kind: "owner", owner_id: owner, operation },
        operation === "probe" ? 90_000 : 60_000);
    },
    async job(reference: Data) {
      if (!UUID.test(String(reference.connection_id)) || !UUID.test(String(reference.job_id)) ||
        Object.keys(reference).sort().join(",") !== "connection_id,job_id") return { status: "unavailable" as const };
      return demand.ensure({ ...reference, caller_kind: "job" }, 300_000);
    },
    async maintenance(reference: Data, minimumValidityMs = 60_000) {
      if (!UUID.test(String(reference.connection_id))) return { status: "unavailable" as const };
      return demand.ensure({ ...reference, caller_kind: "maintenance" }, minimumValidityMs);
    },
  });
}

/** Called only after demand consumers are qualified and idle scheduling is
 * enabled by the release. Empty due results never open a vault/refresher.
 */
export async function runStorageDemandRenewalScheduled(config: {
  client_id: string; client_secret: string;
  vault: Parameters<typeof createStorageGoogleRefresh>[0]["vault"];
  refresh_rpc: (input: Data) => Promise<Data>;
  fetch?: typeof fetch; clock?: () => number;
}) {
  try {
    const due = await config.refresh_rpc({ action: "due_demand" });
    if (due.status !== "ok" || !Array.isArray(due.connections) || due.connections.length > 10 ||
      !due.connections.every(value => object(value) && UUID.test(String(value.connection_id)) &&
        ["observe", "active", "keepalive"].includes(String(value.wake)) &&
        Object.keys(value).sort().join(",") === (value.job_id === undefined ? "connection_id,wake" : "connection_id,job_id,wake") &&
        (value.job_id === undefined || UUID.test(String(value.job_id))))) return { status: "unavailable" };
    let unavailable = Number.isSafeInteger(due.pending_expired) && Number(due.pending_expired) > 0 ? Number(due.pending_expired) : 0;
    if (due.connections.length === 0) return { status: unavailable ? "attention_required" : "ok", ready: 0, unavailable };
    const demand = await createStorageDemandRuntime({ ...config, prepare: request => {
      const job = request.caller_kind === "job";
      return config.refresh_rpc({ action: "prepare_credential", connection_id: request.connection_id,
        caller_kind: job ? "job" : "maintenance", request: job
          ? { connection_id: request.connection_id, job_id: request.job_id } : { operation: "scheduled" } });
    } });
    let ready = 0;
    for (const value of due.connections as Data[]) {
      const result = value.job_id === undefined ? await demand.maintenance({ connection_id: value.connection_id },value.wake === "active" ? 300_000 : 60_000)
        : await demand.job({ connection_id: value.connection_id, job_id: value.job_id });
      if (result.status === "ready") ready++; else unavailable++;
    }
    return { status: unavailable ? "attention_required" : "ok", ready, unavailable };
  } catch { return { status: "unavailable" }; }
}
