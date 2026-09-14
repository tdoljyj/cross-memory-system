#!/usr/bin/env node
// Offline manifest regeneration only. It performs no network, SQL, signature, or authority action.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(arg('--repo-root')??path.join(here,'../../..'));
const dir=path.join(repo,'scripts/phase2-qualification/control-context-verifier-recovery-successor-root9'),manifestPath=path.join(dir,'ControllerSourceManifest.candidate.json');
const manifest=JSON.parse(fs.readFileSync(manifestPath)),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
if(manifest.generation_id!=='ctrgen_308a1dfc185cff633892638581e0a34c'||manifest.files?.length!==22)throw Error('ROOT9_EXACT22_REQUIRED');
const files=manifest.files.map(item=>{const bytes=fs.readFileSync(path.join(repo,item.path));return {path:item.path,sha256:sha(bytes),bytes:bytes.length};});
const rebuilt=Buffer.from(JSON.stringify({...manifest,files},null,2));
if(process.argv.includes('--write'))fs.writeFileSync(manifestPath,rebuilt);
else if(!rebuilt.equals(fs.readFileSync(manifestPath)))throw Error('MANIFEST_REBUILD_DRIFT');
console.log(JSON.stringify({state:'OFFLINE_ROOT9_MANIFEST_REBUILD_PASS_NOT_AUTHORITY',controller_sha256:sha(rebuilt),files:22,wrote:process.argv.includes('--write'),authority_effect:'NONE'}));
