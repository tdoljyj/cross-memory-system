// First install of a node's Linux half (Z1, Owner Decision: DESK-W-591 Linux host qualification derived from TURING's reviewed
// roles-v3). Root, Linux, the pinned toolchain node: sign the three runtime qualifications v2 with THIS node's new result key. It
// reads the private key itself and never prints, copies or logs it. Same checks and the same signing bytes as the reviewed
// sign-qualification-v2.mjs (whose canonicalJson, ROLES and FIXED it imports), except where that tool requires the node's own
// installed v1 qualification, which a new node does not have. Instead each payload must be the TEMPLATE node's reviewed, signed
// qualification of the same role (signature verified with the template's public key, pinned by its SHA-256) with only the values
// that belong to this record and this node changed: sourceManifestSha256, sourceAcceptanceRef, hostAcceptanceRef (derive-roles),
// keyId, runtimeIdentity, resultPublicKeySha256 (first-node-facts), and a Source pin derive-roles repinned from the commit. Image,
// isolation facts and everything else are the template's.
//
//   /var/lib/clued-independent-ci/toolchain-build-legacy-v1/node sign-first-qualification.mjs --in DIR --out NEW_DIR
//       --template DIR --template-public FILE --template-public-sha256 HEX
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalJson, FIXED, ROLES } from './sign-qualification-v2.mjs';

const FACTS = ['prCannotReadSignerKey', 'noControllerMounts', 'noCredentials', 'networkDisabled', 'cleanupQualified'];
const BIND = ['runtimeIdentity', 'sourceManifestSha256', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256', 'proofSha256',
  'jobSha256', 'nodeExecutable', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef'];
// + the Source pins derive-roles repins from the commit when it changed them (verify-signed-r4 checks them against the record manifest)
export const NODE_OR_RECORD = Object.freeze(['sourceManifestSha256', 'sourceAcceptanceRef', 'hostAcceptanceRef', 'keyId', 'runtimeIdentity', 'resultPublicKeySha256',
  'entrySha256', 'qualificationSha256', 'workerSha256', 'proofSha256', 'jobSha256']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const sha256 = b => createHash('sha256').update(b).digest('hex');
const spki = key => createPublicKey(key).export({ type: 'spki', format: 'der' });
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

export function signFirst({ keyPem, pubPem, templateDir, templatePubPem, templatePubSha256, inDir, outDir, now = new Date(), fixed = FIXED }) {
  const priv = createPrivateKey(keyPem);
  check(priv.asymmetricKeyType === 'ed25519' && spki(priv).equals(spki(pubPem)), 'RESULT_KEY_NOT_THE_INSTALLED_PUBLIC_KEY');
  check(sha256(templatePubPem) === templatePubSha256 && createPublicKey(templatePubPem).asymmetricKeyType === 'ed25519', 'TEMPLATE_PUBLIC_KEY_NOT_THE_PINNED_ONE');
  const pubSha = sha256(pubPem), qualifiedAt = now.toISOString();
  check(pubSha !== templatePubSha256, 'NODE_KEY_IS_THE_TEMPLATE_KEY');
  const prepared = [];
  for (const role of ROLES) {
    const policyBytes = fs.readFileSync(path.join(inDir, `${role}.json`)), payloadBytes = fs.readFileSync(path.join(inDir, `${role}.qualification.payload.json`));
    const policy = JSON.parse(policyBytes), payload = JSON.parse(payloadBytes);
    // sign-qualification-v2.mjs's policy and payload checks, unchanged
    check(policy.schema === 'independent-ci.linux-policy.v3' && policy.role === role && policy.formalEnabled === true && !('currentClaim' in policy) && !('claimId' in policy)
      && policy.signingKeyFile === fixed.key && policy.publicKeyFile === fixed.pub && policy.nodeExecutable === fixed.node, 'ROLE_POLICY_V3_REFUSED');
    check(payload.schema === 'independent-ci.runtime-qualification.v2' && payload.fixture === false && payload.role === role && payload.qualifiedAt === null
      && payload.expiresAt === null && !('currentClaim' in payload) && payload.resultPublicKeySha256 === pubSha
      && payload.isolation === 'root-managed-single-job-container' && FACTS.every(k => payload[k] === true)
      && BIND.every(k => typeof payload[k] === 'string' && payload[k] === policy[k])
      && (policy.executionMode === 'scanner' || (payload.containerNodeExecutable === policy.containerNodeExecutable && payload.containerNodeSha256 === policy.containerNodeSha256)),
    'UNSIGNED_PAYLOAD_REFUSED');
    // In place of the v1 lineage: the template node's reviewed, signed qualification of the same role, identical but for this
    // record's and this node's values.
    const t = JSON.parse(fs.readFileSync(path.join(templateDir, `${role}.qualification.json`), 'utf8'));
    check(t && Object.keys(t).length === 2 && verify(null, Buffer.from(canonicalJson(t.payload)), templatePubPem, Buffer.from(String(t.signature), 'base64'))
      && t.payload.schema === 'independent-ci.runtime-qualification.v2' && t.payload.fixture === false && t.payload.role === role
      && t.payload.resultPublicKeySha256 === templatePubSha256 && t.payload.isolation === payload.isolation && FACTS.every(k => t.payload[k] === true),
    'TEMPLATE_QUALIFICATION_REFUSED');
    check(canonicalJson(without(t.payload, [...NODE_OR_RECORD, 'qualifiedAt'])) === canonicalJson(without(payload, [...NODE_OR_RECORD, 'qualifiedAt'])),
      'PAYLOAD_DIFFERS_FROM_THE_TEMPLATE_OUTSIDE_NODE_AND_RECORD_VALUES');
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
  return { status: 'FIRST_QUALIFICATIONS_V2_SIGNED', qualifiedAt, publicKeySha256: pubSha, templatePublicKeySha256: templatePubSha256, roles, privateKeyPrinted: false };
}

// sign-qualification-v2.mjs's protectedKey: the private key's whole path is root-owned and not group/other-writable, 0600, single link.
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
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i]] = argv[i + 1];
  check(argv.length === 10 && ['--in', '--out', '--template', '--template-public'].every(k => typeof o[k] === 'string' && path.isAbsolute(o[k]))
    && /^[0-9a-f]{64}$/.test(o['--template-public-sha256'] ?? ''), 'USAGE: --in DIR --out NEW_DIR --template DIR --template-public FILE --template-public-sha256 HEX');
  protectedKey(FIXED.key);
  return signFirst({ keyPem: fs.readFileSync(FIXED.key), pubPem: fs.readFileSync(FIXED.pub), templateDir: o['--template'], templatePubPem: fs.readFileSync(o['--template-public']),
    templatePubSha256: o['--template-public-sha256'], inDir: o['--in'], outDir: o['--out'] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.log(JSON.stringify({ status: 'REFUSED', code: String(error.code ?? 'SIGNING_REFUSED').slice(0, 80), privateKeyPrinted: false })); process.exitCode = 1; }
}
