// Rebuild the recovery-successor source-only manifest.
//
// Owner accepted the reduced meaning of controller_sha256 for this window: it commits to
// exactly the 23 repository files in this directory, and to no host binaries, interpreter
// bytes, node_modules, or absolute paths. This builder preserves that meaning. It never grows
// the evidence set by discovery outside this directory and never silently drops a declared
// source. The manifest does not list itself.
//
// Run: node build-linux-manifest.mjs          (dry run)
//      node build-linux-manifest.mjs --write  (replace the local candidate manifest)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const REPO=path.resolve(HERE,'..','..','..');
const REL='scripts/phase2-qualification/control-context-verifier-recovery-successor-root9';
const MANIFEST=path.join(HERE,'ControllerSourceManifest.candidate.json');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const need=(ok,why)=>{if(!ok)throw Error(why);};
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');

const prior=JSON.parse(fs.readFileSync(MANIFEST,'utf8'));
need(exact(prior,['object_type','schema_version','generation_id','not_before','expires_at','files','qualification_issued','authority_effect']),'EXACT_MANIFEST_TOP_LEVEL');
need(prior.object_type==='ControllerSourceManifest'&&prior.schema_version===1&&prior.qualification_issued===false&&prior.authority_effect==='NONE','EXACT_MANIFEST_METADATA');
need(Array.isArray(prior.files)&&prior.files.length===23,'EXACT_23_DECLARED_SOURCE_FILES');
need(prior.files.every(e=>exact(e,['path','sha256','bytes'])),'SOURCE_ONLY_ENTRY_SHAPE');

const declared=prior.files.map(e=>e.path).sort();
need(new Set(declared).size===23,'DUPLICATE_DECLARED_SOURCE_PATH');
const actual=fs.readdirSync(HERE,{withFileTypes:true})
 .filter(e=>e.isFile()&&e.name!=='ControllerSourceManifest.candidate.json')
 .map(e=>REL+'/'+e.name).sort();
need(actual.length===23&&JSON.stringify(actual)===JSON.stringify(declared),'EXACT_23_DIRECTORY_SOURCE_SET');

const files=declared.map(p=>{
 need(p.startsWith(REL+'/')&&!p.includes('..')&&!path.isAbsolute(p),'LOCAL_SOURCE_PATH_REQUIRED');
 const b=fs.readFileSync(path.join(REPO,p));
 return {path:p,sha256:sha(b),bytes:b.length};
});
const manifest={...prior,files};
const raw=JSON.stringify(manifest,null,2);
need(JSON.parse(raw).files.length===23,'REBUILT_EXACT_23_REQUIRED');
console.log(JSON.stringify({state:'EXACT_23_SOURCE_MANIFEST_REBUILT',files:23,manifest_sha256:sha(raw),bytes:Buffer.byteLength(raw),write:process.argv.includes('--write')}));
if(process.argv.includes('--write'))fs.writeFileSync(MANIFEST,raw);
