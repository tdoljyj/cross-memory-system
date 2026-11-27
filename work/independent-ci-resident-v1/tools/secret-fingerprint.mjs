// Fingerprint of a controller secret, computed WITHOUT printing or keeping the secret (DESIGN.md section 30).
//   node secret-fingerprint.mjs app-key    < PEM on stdin    -> {"kind":"app-key","fingerprint":"<base64>"}
//   node secret-fingerprint.mjs ci-token   < token on stdin  -> {"kind":"ci-token","fingerprint":"<hex>"}
//   node secret-fingerprint.mjs heartbeat-token < token on stdin -> {"kind":"heartbeat-token","fingerprint":"<hex>"}
// The heartbeat token (DESIGN §41.6a) is a separate connection's token, issued with the prefix clued_hbt_; a CI connection
// token (clued_bnd_) is never a heartbeat token, so each kind accepts only its own prefix.
// install-resident.ps1 runs it with the package's pinned runtime\node.exe, from the package copy it has just hash-checked
// (held open, so it cannot change), and feeds the secret on stdin: the secret never reaches a command line, a file this
// tool writes or its output. The result is compared with the pin of the install record; a mismatch refuses the install
// before anything is written. The two formulas are exactly the ones the runtime applies on every entry start
// (resident-v2/entry-runtime.mjs#controllerPrincipal, role-probe-entry.mjs), so a fingerprint that matches here is the
// one the runtime will accept. On any problem this prints one code and nothing else (no message that could carry bytes).
// Self-contained on purpose: only node: built-ins, so it can be run straight from the package.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CI_TOKEN_DOMAIN = 'clued.independent-ci.ci-binding-pin/1\0';
const MAX_BYTES = 64 * 1024;
export const HEARTBEAT_TOKEN_DOMAIN = 'clued.independent-ci.heartbeat-token-pin/1\0';
const TOKEN = /^clued_bnd_[A-Za-z0-9_-]{8,480}$/;
const HEARTBEAT_TOKEN = /^clued_hbt_[A-Za-z0-9_-]{43}$/;   // 32 random bytes, base64url without padding (as issued)
const refuse = () => { throw Object.assign(new Error('SECRET_FINGERPRINT_REFUSED'), { code: 'SECRET_FINGERPRINT_REFUSED' }); };

// The base64 SHA-256 of the SPKI DER of the key's public half: the record's appPublicKeySha256Base64.
// The file must be a private RSA key (a GitHub App key); a public key or certificate is refused here.
export function fingerprintAppKey(pem) {
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'rsa') refuse();
    return createHash('sha256').update(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })).digest('base64');
  } catch { return refuse(); }
}

// The record's ciTokenPinSha256: the token as the runtime reads it (trimmed), under the binding-pin domain.
export function fingerprintCiToken(text) {
  const token = String(text).trim();
  if (!TOKEN.test(token)) refuse();
  return createHash('sha256').update(CI_TOKEN_DOMAIN + token).digest('hex');
}

// The heartbeat token's fingerprint (the install plan and receipt keep it; the runtime never needs it): trimmed, its own domain.
export function fingerprintHeartbeatToken(text) {
  const token = String(text).trim();
  if (!HEARTBEAT_TOKEN.test(token)) refuse();
  return createHash('sha256').update(HEARTBEAT_TOKEN_DOMAIN + token).digest('hex');
}

export async function main(argv = process.argv.slice(2), input = process.stdin, output = process.stdout) {
  try {
    if (argv.length !== 1 || !['app-key', 'ci-token', 'heartbeat-token', 'ci-rpc'].includes(argv[0])) refuse();
    const chunks = []; let size = 0;
    for await (const chunk of input) { size += chunk.length; if (size > MAX_BYTES) refuse(); chunks.push(chunk); }
    if (size === 0) refuse();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));   // a BOM stays, as in the runtime's utf8 read
    if (argv[0] === 'ci-rpc') {
      // Private stdout pipe to the protected lifecycle stage. This digest
      // authenticates an RPC and must never be printed in installation logs.
      const token = text.trim();
      if (!TOKEN.test(token)) refuse();
      output.write(JSON.stringify({ kind: 'ci-rpc', fingerprint: createHash('sha256').update(token, 'utf8').digest('hex') }) + '\n');
      return 0;
    }
    const fingerprint = argv[0] === 'app-key' ? fingerprintAppKey(text) : argv[0] === 'ci-token' ? fingerprintCiToken(text) : fingerprintHeartbeatToken(text);
    output.write(JSON.stringify({ kind: argv[0], fingerprint }) + '\n');
    return 0;
  } catch { process.stderr.write('SECRET_FINGERPRINT_REFUSED\n'); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
