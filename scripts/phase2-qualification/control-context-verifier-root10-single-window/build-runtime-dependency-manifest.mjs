// Re-measure the complete fixed Ajv package trees on the target Linux host. No writes or authority effect.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'..','..','..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),relative=p=>path.relative(REPO,p).split(path.sep).join('/');
const requests=['ajv','fast-deep-equal','fast-json-stable-stringify','json-schema-traverse','uri-js'];
const require=createRequire(path.join(REPO,'apps/clued-cloud/package.json'));
function tree(root){const out=[];const walk=(dir,prefix='')=>{for(const name of fs.readdirSync(dir).sort()){const rel=prefix?prefix+'/'+name:name,p=path.join(dir,name),s=fs.lstatSync(p);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw Error('UNSUPPORTED_RUNTIME_DEPENDENCY_ENTRY:'+relative(p));if(s.isDirectory())walk(p,rel);else{const b=fs.readFileSync(p);out.push({path:rel,bytes:b.length,sha256:sha(b)});}}};walk(root);return out.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);}
const packages=requests.map(request=>{const base=`apps/clued-cloud/node_modules/${request}`,entries=tree(path.join(REPO,base));return {request,path:base,resolved_entry:relative(require.resolve(request)),files:entries.length,bytes:entries.reduce((n,e)=>n+e.bytes,0),tree_sha256:sha(JSON.stringify(entries)+'\n')};});
const manifest={object_type:'RuntimeDependencyManifest',schema_version:1,algorithm:'SORTED_PACKAGE_TREE_JSON_LF_SHA256_V1',resolver_base:'apps/clued-cloud/package.json',entry_request:'ajv',resolved_entry:packages[0].resolved_entry,packages,authority_effect:'NONE'};
process.stdout.write(JSON.stringify(manifest,null,2)+'\n');
