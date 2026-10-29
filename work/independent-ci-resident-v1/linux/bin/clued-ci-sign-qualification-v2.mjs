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
//
// In-place upgrade (task 018da927, installed frozen as /opt/clued-independent-ci/upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs
// and run by clued-ci-upgrade-linux stage):
//
//   node clued-ci-sign-qualification-v2.mjs --in DIR --out NEW_DIR --against-installed-v2 <gitleaks>,<trivy>,<contract-placement>
//
// The reference is then the INSTALLED v2 qualification (/etc/clued-independent-ci/roles-v3), not v1: it must verify against
// the same public key, and the new policy and payload may differ from the installed policy and payload only in the Source
// binding fields of qualification-v2.mjs:46-56 (SOURCE_KEYS; qualifiedAt is null until signed). Each new policy must hash
// to the value named on the command line (the package's rolesDerivedSha256), so only the derived, reviewed policy is
// signed. Output files are root-private (directory 0700, files 0600), as loadQualifiedPolicyV2 requires.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
export const FIXED = Object.freeze({
  key: '/etc/clued-independent-ci/verify-result-key.pem',
  pub: '/etc/clued-independent-ci/verify-result-public.pem',
  v1: '/etc/clued-independent-ci/roles',
  v2: '/etc/clued-independent-ci/roles-v3',
  node: '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node',
});
const FACTS = ['prCannotReadSignerKey', 'noControllerMounts', 'noCredentials', 'networkDisabled', 'cleanupQualified'];
const BIND = ['runtimeIdentity', 'sourceManifestSha256', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256', 'proofSha256',
  'jobSha256', 'nodeExecutable', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef'];
// qualification-v2.mjs:46-56: the fields that bind the Source; everything else is a host fact carried unchanged.
export const SOURCE_KEYS = Object.freeze(['sourceManifestSha256', 'entrySha256', 'qualificationSha256', 'workerSha256', 'proofSha256', 'jobSha256', 'sourceAcceptanceRef']);
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

const sameExcept = (a, b, keys) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && (keys.includes(k) || canonicalJson(a[k]) === canonicalJson(b[k])));

// against = null: the original reference (installed, still-signed v1). against = { v2Dir, policySha256: {role: sha} }: the upgrade reference.
export function signAll({ keyPem, pubPem, v1Dir, inDir, outDir, now = new Date(), fixed = FIXED, against = null }) {
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
    if (against) {
      // The installed v2 policy and qualification of the same role: the signature verifies with the same key, and the new
      // policy/payload change nothing but the Source binding (plus qualifiedAt, null until signed here).
      check(/^[0-9a-f]{64}$/.test(against.policySha256?.[role] ?? '') && sha256(policyBytes) === against.policySha256[role], 'POLICY_NOT_THE_DERIVED_ONE');
      const oldPolicy = JSON.parse(fs.readFileSync(path.join(against.v2Dir, `${role}.json`), 'utf8'));
      const v2 = JSON.parse(fs.readFileSync(path.join(against.v2Dir, `${role}.qualification.json`), 'utf8'));
      check(v2 && Object.keys(v2).length === 2 && verify(null, Buffer.from(canonicalJson(v2.payload)), pubPem, Buffer.from(v2.signature, 'base64'))
        && v2.payload.schema === 'independent-ci.runtime-qualification.v2' && v2.payload.fixture === false && v2.payload.role === role
        && v2.payload.resultPublicKeySha256 === pubSha && v2.payload.isolation === payload.isolation && FACTS.every(k => v2.payload[k] === true)
        && BIND.every(k => v2.payload[k] === oldPolicy[k]), 'V2_QUALIFICATION_FACTS_REFUSED');
      check(oldPolicy.schema === 'independent-ci.linux-policy.v3' && oldPolicy.role === role && sameExcept(policy, oldPolicy, SOURCE_KEYS), 'POLICY_DIFF_OUTSIDE_SOURCE_BINDING');
      check(sameExcept(payload, v2.payload, [...SOURCE_KEYS, 'qualifiedAt']), 'PAYLOAD_DIFF_OUTSIDE_SOURCE_BINDING');
      prepared.push({ role, policyBytes, payloadBytes, payload });
      continue;
    }
    // The installed v1 qualification of the same role: its signature, image, key, runtime and isolation facts.
    const v1 = JSON.parse(fs.readFileSync(path.join(v1Dir, `${role}.qualification.json`), 'utf8'));
    check(v1 && Object.keys(v1).length === 2 && verify(null, Buffer.from(canonicalJson(v1.payload)), pubPem, Buffer.from(v1.signature, 'base64'))
      && v1.payload.schema === 'independent-ci.runtime-qualification.v1' && v1.payload.fixture === false && v1.payload.role === role
      && v1.payload.image === payload.image && v1.payload.keyId === payload.keyId && v1.payload.runtimeIdentity === payload.runtimeIdentity
      && v1.payload.resultPublicKeySha256 === pubSha && v1.payload.isolation === payload.isolation && FACTS.every(k => v1.payload[k] === true), 'V1_QUALIFICATION_FACTS_REFUSED');
    prepared.push({ role, policyBytes, payloadBytes, payload });
  }
  check(!fs.existsSync(outDir), 'OUTPUT_EXISTS_PRESERVE');
  const dirMode = against ? 0o700 : 0o755, fileMode = against ? 0o600 : 0o644;
  fs.mkdirSync(outDir, { mode: dirMode });
  const roles = {};
  for (const { role, policyBytes, payloadBytes, payload } of prepared) {
    const signedPayload = { ...payload, qualifiedAt };
    const bytes = Buffer.from(canonicalJson(signedPayload));
    const signature = sign(null, bytes, priv).toString('base64');
    check(verify(null, bytes, pubPem, Buffer.from(signature, 'base64')), 'SIGNATURE_SELF_CHECK_FAILED');
    const qText = canonicalJson({ payload: signedPayload, signature }) + '\n';
    fs.writeFileSync(path.join(outDir, `${role}.json`), policyBytes, { flag: 'wx', mode: fileMode });
    fs.writeFileSync(path.join(outDir, `${role}.qualification.json`), qText, { flag: 'wx', mode: fileMode });
    roles[role] = { policySha256: sha256(policyBytes), unsignedPayloadSha256: sha256(payloadBytes), qualificationSha256: sha256(Buffer.from(qText)) };
  }
  // The original (v1-referenced) output is unchanged, byte for byte; only the upgrade mode names its reference.
  return { status: 'QUALIFICATIONS_V2_SIGNED', qualifiedAt, publicKeySha256: pubSha, roles, ...(against ? { reference: 'installed-v2' } : {}), privateKeyPrinted: false };
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
  check((argv.length === 4 || (argv.length === 6 && argv[4] === '--against-installed-v2' && /^[0-9a-f]{64}(,[0-9a-f]{64}){2}$/.test(argv[5])))
    && argv[0] === '--in' && argv[2] === '--out' && path.isAbsolute(argv[1]) && path.isAbsolute(argv[3]), 'USAGE: --in DIR --out NEW_DIR [--against-installed-v2 SHA,SHA,SHA]');
  const against = argv.length === 6 ? { v2Dir: FIXED.v2, policySha256: Object.fromEntries(argv[5].split(',').map((s, i) => [ROLES[i], s])) } : null;
  protectedKey(FIXED.key);
  const keyPem = fs.readFileSync(FIXED.key), pubPem = fs.readFileSync(FIXED.pub);
  return signAll({ keyPem, pubPem, v1Dir: FIXED.v1, inDir: argv[1], outDir: argv[3], against });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.log(JSON.stringify({ status: 'REFUSED', code: String(error.code ?? 'SIGNING_REFUSED').slice(0, 80), privateKeyPrinted: false })); process.exitCode = 1; }
}
