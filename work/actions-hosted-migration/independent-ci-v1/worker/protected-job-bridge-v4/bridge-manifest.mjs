// Install-time tool (not a runtime file): the bridge v4 bundle manifest that relay-public.ps1 checks byte for
// byte before every transfer, and whose SHA-256 the companion configuration pins (bridgeManifestSha256).
//   node bridge-manifest.mjs --dir <installed protected-job-bridge-v4 directory> --out <manifest.json>
// Pure WORK otherwise: it reads only the fixed runtime file names in --dir and writes the new --out.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonical } from '../../src/proof.mjs';
import { LOCAL_FILES } from './boundary.mjs';

export const BRIDGE_MANIFEST_CONTRACT = 'clued.independent-ci.protected-job-bridge-source/4';
const sha = b => createHash('sha256').update(b).digest('hex');
export function bridgeManifest(dir) {
  const runtimeFiles = {};
  for (const name of [...LOCAL_FILES].sort()) {
    const file = path.join(dir, name), st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw Object.assign(new Error('BRIDGE_FILE_BOUNDARY'), { code: 'BRIDGE_FILE_BOUNDARY' });
    const b = fs.readFileSync(file);
    runtimeFiles[name] = { bytes: b.length, sha256: sha(b) };
  }
  const text = canonical({ contract: BRIDGE_MANIFEST_CONTRACT, runtimeFiles });
  return { text, sha256: sha(text) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const a = process.argv.slice(2), dir = a[a.indexOf('--dir') + 1], out = a[a.indexOf('--out') + 1];
  if (a.length !== 4 || !dir || !out) { console.error('BRIDGE_MANIFEST_ARGUMENTS_REQUIRED'); process.exitCode = 2; }
  else { const m = bridgeManifest(dir); fs.writeFileSync(out, m.text, { flag: 'wx' }); console.log(JSON.stringify({ status: 'BRIDGE_MANIFEST_WRITTEN', sha256: m.sha256 })); }
}
