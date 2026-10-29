// Root, Linux, the pinned toolchain node: sign the three Source v2 runtime qualifications (schema v2) with the EXISTING
// Linux result key. It reads the private key itself and never prints, copies or logs it; the output is the signed
// qualification files (public data) next to byte copies of the reviewed role policies v3.
//
//   /var/lib/clued-independent-ci/toolchain-build-legacy-v1/node sign-qualification-v2.mjs --in DIR --out NEW_DIR
//
// DIR holds, for each of gitleaks, trivy, contract-placement: <role>.json (policy v3) and
// <role>.qualification.payload.json (unsigned, qualifiedAt null), as written by derive-linux-v2.mjs roles.
// Before signing, for every role:
//   - the private key is a protected root file (0600, single link, no symlink on its path), Ed25519, and it is
//     exactly the key of the installed public key file the policies name;
//   - the installed, still-signed v1 qualification of the same role verifies against that public key and carries
//     the isolation facts (same image, key, runtime identity) that the v2 payload repeats;
//   - the payload is schema v2, not a fixture, claim-free, never expires (expiresAt null = until the Source
//     changes, Owner decision 1b5d3687) and binds exactly the policy it is next to.
// qualifiedAt is set to the signing instant (the only field the signer adds). Each signature is verified with the
// public key before anything is written; files are created, never replaced.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
export const FIXED = Object.freeze({
  key: '/etc/clued-independent-ci/verify-result-key.pem',
  pub: '/etc/clued-independent-ci/verify-result-public.pem',
  v1: '/etc/clued-independent-ci/roles',
  node: '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node',
});
const FACTS = ['prCannotReadSignerKey', 'noControllerMounts', 'noCredentials', 'networkDisabled', 'cleanupQualified'];
const BIND = ['runtimeIdentity', 'sourceManifestSha256', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256', 'proofSha256',
  'jobSha256', 'nodeExecutable', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const sha256 = b => createHash('sha256').update(b).digest('hex');
// Byte-identical to worker-v2.mjs#canonicalJson (what loadQualifiedPolicyV2 verifies the signature over).
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_JSON');
  return JSON.stringify(value);
}
const spki = key => createPublicKey(key).export({ type: 'spki', format: 'der' });

export function signAll({ keyPem, pubPem, v1Dir, inDir, outDir, now = new Date(), fixed = FIXED }) {
  const priv = createPrivateKey(keyPem);
  check(priv.asymmetricKeyType === 'ed25519' && spki(priv).equals(spki(pubPem)), 'RESULT_KEY_NOT_THE_INSTALLED_PUBLIC_KEY');
  const pubSha = sha256(pubPem), qualifiedAt = now.toISOString();
  const prepared = [];
  for (const role of ROLES) {
    const policyBytes = fs.readFileSync(path.join(inDir, `${role}.json`)), payloadBytes = fs.readFileSync(path.join(inDir, `${role}.qualification.payload.json`));
    const policy = JSON.parse(policyBytes), payload = JSON.parse(payloadBytes);
    check(policy.schema === 'independent-ci.linux-policy.v3' && policy.role === role && policy.formalEnabled === true && !('currentClaim' in policy) && !('claimId' in policy)
      && policy.signingKeyFile === fixed.key && policy.publicKeyFile === fixed.pub && policy.nodeExecutable === fixed.node, 'ROLE_POLICY_V3_REFUSED');
    check(payload.schema === 'independent-ci.runtime-qualification.v2' && payload.fixture === false && payload.role === role && payload.qualifiedAt === null
      && payload.expiresAt === null && !('currentClaim' in payload) && payload.resultPublicKeySha256 === pubSha
      && payload.isolation === 'root-managed-single-job-container' && FACTS.every(k => payload[k] === true)
      && BIND.every(k => typeof payload[k] === 'string' && payload[k] === policy[k])
      && (policy.executionMode === 'scanner' || (payload.containerNodeExecutable === policy.containerNodeExecutable && payload.containerNodeSha256 === policy.containerNodeSha256)),
    'UNSIGNED_PAYLOAD_REFUSED');
    // The installed v1 qualification of the same role: its signature, image, key, runtime and isolation facts.
    const v1 = JSON.parse(fs.readFileSync(path.join(v1Dir, `${role}.qualification.json`), 'utf8'));
    check(v1 && Object.keys(v1).length === 2 && verify(null, Buffer.from(canonicalJson(v1.payload)), pubPem, Buffer.from(v1.signature, 'base64'))
      && v1.payload.schema === 'independent-ci.runtime-qualification.v1' && v1.payload.fixture === false && v1.payload.role === role
      && v1.payload.image === payload.image && v1.payload.keyId === payload.keyId && v1.payload.runtimeIdentity === payload.runtimeIdentity
      && v1.payload.resultPublicKeySha256 === pubSha && v1.payload.isolation === payload.isolation && FACTS.every(k => v1.payload[k] === true), 'V1_QUALIFICATION_FACTS_REFUSED');
    prepared.push({ role, policyBytes, payloadBytes, payload });
  }
  check(!fs.existsSync(outDir), 'OUTPUT_EXISTS_PRESERVE');
  fs.mkdirSync(outDir, { mode: 0o755 });
  const roles = {};
  for (const { role, policyBytes, payloadBytes, payload } of prepared) {
    const signedPayload = { ...payload, qualifiedAt };
    const bytes = Buffer.from(canonicalJson(signedPayload));
    const signature = sign(null, bytes, priv).toString('base64');
    check(verify(null, bytes, pubPem, Buffer.from(signature, 'base64')), 'SIGNATURE_SELF_CHECK_FAILED');
    const qText = canonicalJson({ payload: signedPayload, signature }) + '\n';
    fs.writeFileSync(path.join(outDir, `${role}.json`), policyBytes, { flag: 'wx', mode: 0o644 });
    fs.writeFileSync(path.join(outDir, `${role}.qualification.json`), qText, { flag: 'wx', mode: 0o644 });
    roles[role] = { policySha256: sha256(policyBytes), unsignedPayloadSha256: sha256(payloadBytes), qualificationSha256: sha256(Buffer.from(qText)) };
  }
  return { status: 'QUALIFICATIONS_V2_SIGNED', qualifiedAt, publicKeySha256: pubSha, roles, privateKeyPrinted: false };
}

// The private key's whole path is root-owned and not group/other-writable, the file is 0600 and single-link.
function protectedKey(file) {
  for (let p = file; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    check(!s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022), 'UNPROTECTED_KEY_PATH');
    if (p === path.dirname(p)) break;
  }
  const s = fs.lstatSync(file);
  check(s.isFile() && s.nlink === 1 && (s.mode & 0o777) === 0o600 && s.size > 0 && s.size < 4096, 'UNPROTECTED_KEY_FILE');
}

function main(argv) {
  check(process.platform === 'linux' && process.getuid?.() === 0, 'ROOT_LINUX_REQUIRED');
  check(process.execPath === FIXED.node, 'PINNED_TOOLCHAIN_NODE_REQUIRED');
  check(argv.length === 4 && argv[0] === '--in' && argv[2] === '--out' && path.isAbsolute(argv[1]) && path.isAbsolute(argv[3]), 'USAGE: --in DIR --out NEW_DIR');
  protectedKey(FIXED.key);
  const keyPem = fs.readFileSync(FIXED.key), pubPem = fs.readFileSync(FIXED.pub);
  return signAll({ keyPem, pubPem, v1Dir: FIXED.v1, inDir: argv[1], outDir: argv[3] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.log(JSON.stringify({ status: 'REFUSED', code: String(error.code ?? 'SIGNING_REFUSED').slice(0, 80), privateKeyPrinted: false })); process.exitCode = 1; }
}
