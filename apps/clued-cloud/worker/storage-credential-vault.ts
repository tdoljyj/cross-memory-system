/** Server-only credential envelope. Policy and revocation stay in Canonical.
 * The keyring is deployment configuration, never a request field. Database rows
 * contain ciphertext only; no route may return the result of open().
 */
export type StorageCredentialContext = Readonly<{
  owner_id: string;
  connection_id: string;
  provider: "google-drive";
  provider_subject: string;
  oauth_client_id: string;
  credential_version: number;
}>;
export type StorageCredentialEnvelope = Readonly<{
  contract: "clued.storage-credential/1";
  key_id: string;
  nonce: string;
  ciphertext: string;
}>;

const CONTRACT = "clued.storage-credential/1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyId = /^[a-zA-Z0-9_-]{1,64}$/;
const denied = () => new Error("storage_credential_unavailable");
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k));
}
function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value: unknown, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw denied();
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  if (bytes.length < min || bytes.length > max || encode(bytes) !== value) throw denied();
  return bytes;
}
function aad(context: StorageCredentialContext, key: string): Uint8Array<ArrayBuffer> {
  if (!exact(context, ["owner_id", "connection_id", "provider", "provider_subject", "oauth_client_id", "credential_version"]) ||
      !uuid.test(context.owner_id) || !uuid.test(context.connection_id) || context.provider !== "google-drive" ||
      !/^[A-Za-z0-9_-]{1,255}$/.test(context.provider_subject) ||
      !/^[A-Za-z0-9._-]{1,255}$/.test(context.oauth_client_id) ||
      !Number.isSafeInteger(context.credential_version) || context.credential_version < 1 || !keyId.test(key)) throw denied();
  // Ordered tuple: no ambiguous delimiters, caller JSON order or unbound fields.
  return encoder.encode(JSON.stringify([CONTRACT, key, context.owner_id, context.connection_id,
    context.provider, context.provider_subject, context.oauth_client_id, context.credential_version]));
}

export async function createStorageCredentialVault(configuration: {
  current_key_id: string; keys: Record<string, string>;
}) {
  try {
    if (!exact(configuration, ["current_key_id", "keys"]) || !keyId.test(configuration.current_key_id) ||
        !configuration.keys || typeof configuration.keys !== "object" || Array.isArray(configuration.keys) ||
        !Object.hasOwn(configuration.keys, configuration.current_key_id) ||
        Object.keys(configuration.keys).length > 4) throw denied();
    const current = configuration.current_key_id;
    const keys = new Map<string, CryptoKey>();
    for (const [id, raw] of Object.entries(configuration.keys)) {
      if (!keyId.test(id)) throw denied();
      const bytes = decode(raw, 32, 32);
      try { keys.set(id, await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"])); }
      finally { bytes.fill(0); }
    }
    return Object.freeze({
      async seal(secret: string, context: StorageCredentialContext): Promise<StorageCredentialEnvelope> {
        let plaintext: Uint8Array<ArrayBuffer> | undefined;
        try {
          if (typeof secret !== "string") throw denied();
          plaintext = encoder.encode(secret);
          if (plaintext.length < 1 || plaintext.length > 16384) throw denied();
          const additionalData = aad(context, current);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, keys.get(current)!, plaintext);
          return Object.freeze({ contract: CONTRACT, key_id: current, nonce: encode(iv), ciphertext: encode(new Uint8Array(encrypted)) });
        } catch { throw denied(); }
        finally { plaintext?.fill(0); }
      },
      async open(envelope: StorageCredentialEnvelope, expected: StorageCredentialContext): Promise<string> {
        let plaintext: Uint8Array<ArrayBuffer> | undefined;
        try {
          if (!exact(envelope, ["contract", "key_id", "nonce", "ciphertext"]) || envelope.contract !== CONTRACT ||
              !keyId.test(envelope.key_id) || !keys.has(envelope.key_id)) throw denied();
          const additionalData = aad(expected, envelope.key_id);
          const iv = decode(envelope.nonce, 12, 12);
          const ciphertext = decode(envelope.ciphertext, 17, 16400);
          plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, keys.get(envelope.key_id)!, ciphertext));
          return decoder.decode(plaintext);
        } catch { throw denied(); }
        finally { plaintext?.fill(0); }
      },
    });
  } catch { throw denied(); }
}
