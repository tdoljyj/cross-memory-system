// The universal values of one accepted Source (Decisions ddb4300f, b5d041d2 v2), computed from the commit's tree alone, with the
// commit's own code where it exports it (build-package.mjs upgraderCopy). They are the values every node's assembled /4 package
// carries, and the ones the server's accepted-Source record holds:
//   residentManifestSha256   build-package.mjs: src/, tools/, windows/ of the resident tree (per-directory sorted walk, no __pycache__)
//   sourceManifestSha256     build-package.mjs: the CI Source closure in its listed order, plus the generated bridge v4 manifest
//   upgraderManifestSha256   build-package.mjs upgraderCopy
//   universalFilesSha256     the server's definition over the package's resident\<r>\ and source\<c>\ files, hash segment removed
//                            (universalFilesSha256())
// Not universal: ciSourceManifestSha256 (the record's source-manifest.json binds each node's installed sourceAcceptanceRef,
// hostQualificationRef and formal role material, which may differ per node); neither the archive nor the server holds it.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RESIDENT = 'work/independent-ci-resident-v1';
export const CIV1 = 'work/actions-hosted-migration/independent-ci-v1';
export const CLOSURE = `${CIV1}/src/resident-v2/source-closure.json`;
export const PREPARE_RECORD = `${CIV1}/src/resident-v2/prepare-record.mjs`;
// build-package.mjs RESIDENT_FILES, BRIDGE_DIR, BRIDGE_FILES (not exported there; the fleet test proves the copy against a real build)
const RESIDENT_FILES = ['src', 'tools', 'windows'];
const BRIDGE_DIR = `${CIV1}/worker/protected-job-bridge-v4`;
const BRIDGE_FILES = ['boundary.mjs', 'formal-spool-acl.ps1', 'issue-job.mjs', 'linux-worker.mjs', 'mailbox.mjs', 'protocol.mjs', 'relay-public.ps1', 'relay-record.mjs', 'signed-result.mjs', 'windows-issuer.mjs'];

const sha = b => createHash('sha256').update(b).digest('hex');
const fail = (code, detail) => { throw Object.assign(new Error(code), { code, detail }); };
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// The server's universal_files_sha256 (migration 20261112150000): the files whose target starts with resident\<residentManifestSha256>\
// or source\<ciSourceManifestSha256>\ (the package's own two hashes), that hash segment removed (resident\<rest>, source\<rest>),
// by that target in byte order, "target TAB sha256 LF" each, SHA-256 of the UTF-8 string. Equal on every node of one Source.
export function universalFilesSha256(files, residentManifestSha256, ciSourceManifestSha256) {
  const rp = `resident\\${residentManifestSha256}\\`, sp = `source\\${ciSourceManifestSha256}\\`;
  const rows = files.flatMap(f => (f.target.startsWith(rp) ? [{ target: `resident\\${f.target.slice(rp.length)}`, sha256: f.sha256 }]
    : f.target.startsWith(sp) ? [{ target: `source\\${f.target.slice(sp.length)}`, sha256: f.sha256 }] : []))
    .sort((x, y) => byteOrder(x.target, y.target));
  if (rows.length === 0) fail('UNIVERSAL_FILES_EMPTY');
  return sha(Buffer.from(rows.map(f => `${f.target}\t${f.sha256}\n`).join(''), 'utf8'));
}

// build-package.mjs listFiles: a directory's names sorted, recursively, files only, no link, no __pycache__.
async function listFiles(base, rel) {
  const st = await fs.lstat(path.join(base, rel));
  if (st.isSymbolicLink()) fail('PACKAGE_LINK_REFUSED', rel);
  if (st.isFile()) return /(^|\/)__pycache__\//.test(rel.replace(/\\/g, '/')) ? [] : [rel.replace(/\\/g, '/')];
  const out = [];
  for (const name of (await fs.readdir(path.join(base, rel))).sort()) if (name !== '__pycache__') out.push(...await listFiles(base, path.join(rel, name)));
  return out;
}

const fileEntry = async (file, rel) => { const b = await fs.readFile(file); return { path: rel, sha256: sha(b), bytes: b.length }; };

export async function computeUniversalFacts({ tree }) {
  const imp = rel => import(pathToFileURL(path.join(tree, ...rel.split('/'))).href);
  const { canonicalJson } = await imp(`${RESIDENT}/src/canonical.mjs`);
  const { INSTALLED_MANIFEST_CONTRACT } = await imp(`${RESIDENT}/src/service-ports.mjs`);
  const { BRIDGE_MANIFEST_CONTRACT, upgraderCopy } = await imp(`${RESIDENT}/tools/build-package.mjs`);
  const residentDir = path.join(tree, ...RESIDENT.split('/'));
  const manifestSha = m => sha(Buffer.from(canonicalJson(m) + '\n'));

  const residentEntries = [];
  for (const rel of RESIDENT_FILES) for (const f of await listFiles(residentDir, rel)) residentEntries.push(await fileEntry(path.join(residentDir, ...f.split('/')), f));
  const residentManifestSha256 = manifestSha({ contract: INSTALLED_MANIFEST_CONTRACT, root: 'resident', files: residentEntries });

  const closure = JSON.parse((await fs.readFile(path.join(tree, ...CLOSURE.split('/')))).toString('utf8'));
  if (closure?.contract !== 'clued.independent-ci.source-closure/2' || !Array.isArray(closure.paths)) fail('SOURCE_CLOSURE_REFUSED');
  const sourceEntries = [];
  for (const rel of closure.paths) sourceEntries.push(await fileEntry(path.join(tree, ...rel.split('/')), rel));
  let bridgeManifestSha256 = null;
  if (BRIDGE_FILES.every(n => closure.paths.includes(`${BRIDGE_DIR}/${n}`))) {
    const runtimeFiles = Object.fromEntries(BRIDGE_FILES.map(n => { const e = sourceEntries.find(x => x.path === `${BRIDGE_DIR}/${n}`); return [n, { bytes: e.bytes, sha256: e.sha256 }]; }));
    const text = canonicalJson({ contract: BRIDGE_MANIFEST_CONTRACT, runtimeFiles });
    bridgeManifestSha256 = sha(Buffer.from(text));
    sourceEntries.push({ path: `${BRIDGE_DIR}/manifest.json`, sha256: bridgeManifestSha256, bytes: Buffer.byteLength(text) });
  }
  const sourceManifestSha256 = manifestSha({ contract: INSTALLED_MANIFEST_CONTRACT, root: 'source', files: sourceEntries });

  const upgrader = await upgraderCopy(residentDir);
  const files = [
    ...residentEntries.map(e => ({ target: `resident\\${residentManifestSha256}\\${e.path.replace(/\//g, '\\')}`, sha256: e.sha256 })),
    // the CI Source hash is a node's; the normalised digest does not depend on it ('x' stands in)
    ...sourceEntries.map(e => ({ target: `source\\x\\${e.path.replace(/\//g, '\\')}`, sha256: e.sha256 })),
  ];
  return { residentManifestSha256, sourceManifestSha256, upgraderManifestSha256: upgrader.manifestSha256, bridgeManifestSha256,
    universalFilesSha256: universalFilesSha256(files, residentManifestSha256, 'x'), closurePaths: closure.paths };
}
