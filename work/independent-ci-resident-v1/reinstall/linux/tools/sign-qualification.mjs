// Reinstall of a node (one path for every node; Source v1 is retired and phase A moves any leftover of it aside). Root, Linux, the
// pinned toolchain node: sign the three runtime qualifications v2 of the new Source with the node's EXISTING result key. It reads the
// private key itself and never prints, copies or logs it. The lineage is the node's installed, signed v2 qualifications:
//   - the INSTALLED, signed v2 qualification of the same role (/etc/clued-independent-ci/roles-v3, read before phase B moves it aside)
//     verifies against the node's public key and names that key, and the new payload is that payload with only the Source values
//     derive-roles changes (sourceManifestSha256, the two refs, the five Source pins) and qualifiedAt different: same image, key,
//     runtime identity, isolation facts and everything else;
//   - the new policy is the installed policy with only the same values different.
// canonicalJson, ROLES and FIXED are shared with sign-first-qualification.mjs (a first install).
//
//   /var/lib/clued-independent-ci/toolchain-build-legacy-v1/node sign-qualification.mjs --in DIR --out NEW_DIR
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
export const FIXED = Object.freeze({
  key: '/etc/clued-independent-ci/verify-result-key.pem',
  pub: '/etc/clued-independent-ci/verify-result-public.pem',
  node: '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node',
});
// Byte-identical to worker-v2.mjs#canonicalJson (what loadQualifiedPolicyV2 verifies the signature over).
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_JSON');
  return JSON.stringify(value);
}

export const INSTALLED_V2 = '/etc/clued-independent-ci/roles-v3';
const FACTS = ['prCannotReadSignerKey', 'noControllerMounts', 'noCredentials', 'networkDisabled', 'cleanupQualified'];
const BIND = ['runtimeIdentity', 'sourceManifestSha256', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256', 'proofSha256',
  'jobSha256', 'nodeExecutable', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef'];
// what derive-roles.py changes (CHANGED + its five Source pins); nothing else may differ from the installed role
export const SOURCE_VALUES = Object.freeze(['sourceManifestSha256', 'sourceAcceptanceRef', 'hostAcceptanceRef', 'entrySha256', 'qualificationSha256', 'workerSha256',
  'proofSha256', 'jobSha256']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const sha256 = b => createHash('sha256').update(b).digest('hex');
const spki = key => createPublicKey(key).export({ type: 'spki', format: 'der' });
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

export function signQualifications({ keyPem, pubPem, installedDir, inDir, outDir, now = new Date(), fixed = FIXED }) {
  const priv = createPrivateKey(keyPem);
  check(priv.asymmetricKeyType === 'ed25519' && spki(priv).equals(spki(pubPem)), 'RESULT_KEY_NOT_THE_INSTALLED_PUBLIC_KEY');
  const pubSha = sha256(pubPem), qualifiedAt = now.toISOString();
  const prepared = [];
  for (const role of ROLES) {
    const policyBytes = fs.readFileSync(path.join(inDir, `${role}.json`)), payloadBytes = fs.readFileSync(path.join(inDir, `${role}.qualification.payload.json`));
    const policy = JSON.parse(policyBytes), payload = JSON.parse(payloadBytes);
    // the policy and payload checks
    check(policy.schema === 'independent-ci.linux-policy.v3' && policy.role === role && policy.formalEnabled === true && !('currentClaim' in policy) && !('claimId' in policy)
      && policy.signingKeyFile === fixed.key && policy.publicKeyFile === fixed.pub && policy.nodeExecutable === fixed.node, 'ROLE_POLICY_V3_REFUSED');
    check(payload.schema === 'independent-ci.runtime-qualification.v2' && payload.fixture === false && payload.role === role && payload.qualifiedAt === null
      && payload.expiresAt === null && !('currentClaim' in payload) && payload.resultPublicKeySha256 === pubSha
      && payload.isolation === 'root-managed-single-job-container' && FACTS.every(k => payload[k] === true)
      && BIND.every(k => typeof payload[k] === 'string' && payload[k] === policy[k])
      && (policy.executionMode === 'scanner' || (payload.containerNodeExecutable === policy.containerNodeExecutable && payload.containerNodeSha256 === policy.containerNodeSha256)),
    'UNSIGNED_PAYLOAD_REFUSED');
    // The lineage: the installed v2 qualification of the same role, signed by this node's key, and its policy.
    const q = JSON.parse(fs.readFileSync(path.join(installedDir, `${role}.qualification.json`), 'utf8'));
    check(q && Object.keys(q).length === 2 && verify(null, Buffer.from(canonicalJson(q.payload)), pubPem, Buffer.from(String(q.signature), 'base64'))
      && q.payload.schema === 'independent-ci.runtime-qualification.v2' && q.payload.fixture === false && q.payload.role === role
      && q.payload.image === payload.image && q.payload.keyId === payload.keyId && q.payload.runtimeIdentity === payload.runtimeIdentity
      && q.payload.resultPublicKeySha256 === pubSha && q.payload.isolation === payload.isolation && FACTS.every(k => q.payload[k] === true),
    'INSTALLED_V2_QUALIFICATION_FACTS_REFUSED');
    check(canonicalJson(without(q.payload, [...SOURCE_VALUES, 'qualifiedAt'])) === canonicalJson(without(payload, [...SOURCE_VALUES, 'qualifiedAt'])),
      'PAYLOAD_DIFFERS_FROM_THE_INSTALLED_OUTSIDE_SOURCE_VALUES');
    const ip = JSON.parse(fs.readFileSync(path.join(installedDir, `${role}.json`), 'utf8'));
    check(BIND.every(k => ip[k] === q.payload[k]) && canonicalJson(without(ip, SOURCE_VALUES)) === canonicalJson(without(policy, SOURCE_VALUES)),
      'POLICY_DIFFERS_FROM_THE_INSTALLED_OUTSIDE_SOURCE_VALUES');
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
  return { status: 'QUALIFICATIONS_V2_SIGNED_FROM_INSTALLED_V2', qualifiedAt, publicKeySha256: pubSha, roles, privateKeyPrinted: false };
}

// protectedKey: the private key's whole path is root-owned and not group/other-writable, 0600, single link.
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
  return signQualifications({ keyPem: fs.readFileSync(FIXED.key), pubPem: fs.readFileSync(FIXED.pub), installedDir: INSTALLED_V2, inDir: argv[1], outDir: argv[3] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.log(JSON.stringify({ status: 'REFUSED', code: String(error.code ?? 'SIGNING_REFUSED').slice(0, 80), privateKeyPrinted: false })); process.exitCode = 1; }
}
