// Any user, read-only: validate a prepared install record with the commit's own runtime validator
// (resident-v2/record.mjs#validateRecordV2: canonical bytes, bindings, node profile, pins, controllerRelay refs, signer refs)
// and print the per-role controllerRelay refs (the Linux policies' sourceAcceptanceRef/hostAcceptanceRef must equal them).
//   node check-record.mjs <tree root> <record dir>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [tree, dir] = process.argv.slice(2);
const { validateRecordV2 } = await import(pathToFileURL(path.join(tree, 'work/actions-hosted-migration/independent-ci-v1/src/resident-v2/record.mjs')).href);
const docs = Object.fromEntries(['installation.json', 'acceptance.json', 'source-manifest.json', 'signers.json'].map(n => [n, fs.readFileSync(path.join(dir, n))]));
const manifest = JSON.parse(docs['source-manifest.json']);
const relay = Object.fromEntries(Object.entries(manifest.roles).map(([r, v]) => [r, { sourceAcceptanceRef: v.controllerRelay.sourceAcceptanceRef, hostQualificationRef: v.controllerRelay.hostQualificationRef }]));
const signers = JSON.parse(docs['signers.json']).signers.map(s => ({ keyId: s.keyId, sourceAcceptanceRef: s.sourceAcceptanceRef, qualificationRef: s.qualificationRef }));
try { validateRecordV2(docs); console.log(JSON.stringify({ status: 'RECORD_V2_VALID', relay, signers })); }
catch (e) { console.log(JSON.stringify({ status: 'RECORD_V2_REFUSED', code: e.code ?? e.message, relay, signers })); process.exitCode = 2; }
