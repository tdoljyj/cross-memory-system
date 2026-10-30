// r4, root on Linux, read-only, NO private key: check the three signed role sets BEFORE the installed Source34 is moved
// aside (replaces `derive-linux-v2.mjs verify-signed`, whose Windows copy no longer exists).
//  1. Review B-2: before any import, the five modules it imports (qualification-v2.mjs, worker-v2.mjs, job-v2.mjs, proof.mjs,
//     queue.mjs: the whole relative import closure) must equal the record manifest's pins byte for byte.
//  2. The new commit's own validatePolicyShape / validateQualificationPayload and the Ed25519 signature against the PUBLIC key.
//  3. Review B-1: policy.sourceAcceptanceRef / hostAcceptanceRef equal the manifest's controllerRelay refs of that role.
//  4. Review minor 7: the signed policy bytes equal roles-in, and the signed payload equals the unsigned one except qualifiedAt.
//   node verify-signed-r4.mjs <extracted independent-ci-v1 dir> <roles-signed> <roles-in> <public key pem> <record source-manifest.json>
import { readFile } from 'node:fs/promises';
import { verify, createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [ciDir, signedDir, inDir, pubFile, manifestFile] = process.argv.slice(2);
const sha = b => createHash('sha256').update(b).digest('hex');
const fail = (code, detail) => { console.log(JSON.stringify({ status: 'REFUSED', code, detail })); process.exit(1); };
const manifestBytes = await readFile(manifestFile), manifest = JSON.parse(manifestBytes);
const PRE = 'work/actions-hosted-migration/independent-ci-v1/';
const pins = new Map();
for (const r of Object.values(manifest.roles)) for (const f of r.sourceFiles) pins.set(f.path, f.sha256);
for (const rel of ['worker/qualification-v2.mjs', 'src/worker-v2.mjs', 'src/job-v2.mjs', 'src/proof.mjs', 'src/queue.mjs']) {
  const got = sha(await readFile(path.join(ciDir, ...rel.split('/'))));
  if (!pins.has(PRE + rel) || pins.get(PRE + rel) !== got) fail('IMPORTED_MODULE_NOT_PINNED', { rel, got, pinned: pins.get(PRE + rel) ?? null });
}
const q2 = await import(pathToFileURL(path.join(ciDir, 'worker', 'qualification-v2.mjs')).href);
const w2 = await import(pathToFileURL(path.join(ciDir, 'src', 'worker-v2.mjs')).href);
const pub = await readFile(pubFile);
const out = { status: null, ciSourceManifestSha256: sha(manifestBytes), publicKeySha256: sha(pub), roles: {} };
for (const role of ['gitleaks', 'trivy', 'contract-placement']) {
  const polBytes = await readFile(path.join(signedDir, role + '.json')), qBytes = await readFile(path.join(signedDir, role + '.qualification.json'));
  const inPol = await readFile(path.join(inDir, role + '.json')), inPay = JSON.parse(await readFile(path.join(inDir, role + '.qualification.payload.json')));
  const policy = JSON.parse(polBytes), q = JSON.parse(qBytes), relay = manifest.roles[role]?.controllerRelay;
  try { q2.validatePolicyShape(policy); } catch (e) { fail('POLICY_SHAPE_REFUSED', { role, code: e.code ?? e.message }); }
  if (!(Object.keys(q).length === 2 && verify(null, Buffer.from(w2.canonicalJson(q.payload)), pub, Buffer.from(String(q.signature), 'base64')))) fail('QUALIFICATION_SIGNATURE_REFUSED', { role });
  try { q2.validateQualificationPayload(q.payload, policy, pub); } catch (e) { fail('QUALIFICATION_PAYLOAD_REFUSED', { role, code: e.code ?? e.message }); }
  if (policy.role !== role || policy.sourceManifestSha256 !== out.ciSourceManifestSha256 || !relay
    || policy.sourceAcceptanceRef !== relay.sourceAcceptanceRef || policy.hostAcceptanceRef !== relay.hostQualificationRef) fail('POLICY_NOT_BOUND_TO_THE_RECORD_RELAY', { role, relay });
  if (!polBytes.equals(inPol)) fail('SIGNED_POLICY_NOT_THE_DERIVED_ONE', { role });
  const qualifiedAt = q.payload.qualifiedAt;
  if (typeof qualifiedAt !== 'string' || !Number.isFinite(Date.parse(qualifiedAt)) || inPay.qualifiedAt !== null
    || w2.canonicalJson({ ...q.payload, qualifiedAt: null }) !== w2.canonicalJson(inPay)) fail('SIGNED_PAYLOAD_NOT_THE_DERIVED_ONE', { role });
  out.roles[role] = { policySha256: sha(polBytes), qualificationSha256: sha(qBytes), qualifiedAt };
}
out.status = 'SIGNED_QUALIFICATIONS_V2_VERIFIED';
console.log(JSON.stringify(out));
