// Build the Root10 source-only manifest. No publication or authority effect.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const REL='scripts/phase2-qualification/control-context-verifier-root10-single-window';
const REPO=process.env.CLUED_CONTROLLER_REPO?path.resolve(process.env.CLUED_CONTROLLER_REPO):path.resolve(HERE,'..','..','..');
const MANIFEST=path.join(HERE,'ControllerSourceManifest.candidate.json');
const CONTRACT=path.join(HERE,'Root10ControllerContract.candidate.json');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const need=(ok,why)=>{if(!ok)throw Error(why);};

const contractRaw=fs.readFileSync(CONTRACT,'utf8'),contract=JSON.parse(contractRaw);
need(contract.ready===true&&contract.schema_version==='root10-single-window-controller-contract/1','FINAL_ROOT10_CONTRACT_REQUIRED');
const local=fs.readdirSync(HERE,{withFileTypes:true}).filter(e=>e.isFile()&&e.name!=='ControllerSourceManifest.candidate.json').map(e=>({path:REL+'/'+e.name,absolute:path.join(HERE,e.name)}));
const external=contract.source_closure.map(e=>({path:e.path,absolute:path.join(REPO,e.path),expected:e.sha256}));
const declared=[...local,...external].sort((a,b)=>a.path.localeCompare(b.path));
need(new Set(declared.map(e=>e.path)).size===declared.length,'DUPLICATE_ROOT10_SOURCE_PATH');
const files=declared.map(entry=>{const bytes=fs.readFileSync(entry.absolute),digest=sha(bytes);need(!entry.expected||entry.expected===digest,'HISTORICAL_COMPONENT_SOURCE_DRIFT:'+entry.path);return {path:entry.path,sha256:digest,bytes:bytes.length};});
const manifest={object_type:'ControllerSourceManifest',schema_version:1,generation_id:contract.generation_id,not_before:contract.window.not_before,expires_at:contract.window.expires_at,files,qualification_issued:false,authority_effect:'NONE'};
const raw=JSON.stringify(manifest,null,2)+'\n';
if(process.argv.includes('--stdout'))process.stdout.write(raw);
else console.log(JSON.stringify({state:'ROOT10_COMPLETE_SOURCE_MANIFEST_REBUILT',files:files.length,manifest_sha256:sha(raw),bytes:Buffer.byteLength(raw),write:process.argv.includes('--write')}));
if(process.argv.includes('--write'))fs.writeFileSync(MANIFEST,raw);
