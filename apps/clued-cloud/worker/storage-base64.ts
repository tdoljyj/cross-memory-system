/** StorageNormalUse.v0.1 §3 item 7: `btoa(String.fromCharCode(...bytes))`
 * throws RangeError for large arrays (argument count limit). Every binary
 * encoding in the storage Worker goes through these helpers, which convert at
 * most 32 KiB per String.fromCharCode call. */
const CHUNK = 32768;

/** Standard base64 (with padding) of any number of bytes. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes required");
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  return btoa(binary);
}

/** base64url without padding (RFC 4648 §5), as used for cursors, PKCE and state. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decodes standard or url-safe base64; throws on any other character. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) throw new TypeError("base64 required");
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
