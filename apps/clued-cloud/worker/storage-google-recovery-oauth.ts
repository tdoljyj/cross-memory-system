import { isStorageScopeProfile } from "./storage-google-scopes";
import { createStorageGoogleOAuth } from "./storage-google-oauth";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Request-local server composition only. Its RPC targets the recovery start
 * contract; callback routing is decided by the database's unique state record.
 * No browser-selected purpose, profile, default-refresh consent or vault value.
 */
export async function createStorageGoogleRecoveryOAuth(
  configuration: Parameters<typeof createStorageGoogleOAuth>[0],
  target: { connection_id: string; job_id: string },
) {
  const { connection_id: connection, job_id: job } = target;
  if (Object.keys(target).length !== 2 || !uuid.test(connection) || !uuid.test(job)) throw new Error("storage_google_connection_unavailable");
  let binding: string | undefined;
  const connector = await createStorageGoogleOAuth({ ...configuration, rpc: async input => {
    if (input.connection_id !== connection) throw new Error("storage_google_connection_unavailable");
    if (input.action === "describe") {
      const result = await configuration.rpc({ ...input, job_id: job });
      if (typeof result.recovery_binding !== "string" || !/^[0-9a-f]{64}$/.test(result.recovery_binding) ||
        typeof result.provider_subject !== "string" || result.provider_subject.length === 0 ||
        !isStorageScopeProfile(result.provider_scope_profile)) throw new Error("storage_google_connection_unavailable");
      binding = result.recovery_binding;
      return result;
    }
    if (input.action !== "prepare" || !binding || "default_refresh_consent" in input) throw new Error("storage_google_connection_unavailable");
    const exact = binding; binding = undefined;
    return configuration.rpc({ ...input, job_id: job, recovery_binding: exact });
  } });
  let used = false;
  return Object.freeze({ start: async () => {
    if (used) throw new Error("storage_google_connection_unavailable");
    used = true;
    // Recovery requests exactly the sealed profile's set (StorageNormalUse §2.2 item 7).
    return connector.start(connection, false, "sealed");
  } });
}
