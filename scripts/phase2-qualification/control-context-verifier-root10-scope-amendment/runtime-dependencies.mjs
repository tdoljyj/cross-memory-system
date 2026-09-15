// Verify the complete Ajv runtime package trees before any caller loads Ajv.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const REPO=path.resolve(HERE,'..','..','..');
const MANIFEST=fileURLToPath(new URL('./RuntimeDependencyManifest.json',import.meta.url));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const need=(ok,why)=>{if(!ok)throw Error(why);};
const relative=p=>path.relative(REPO,p).split(path.sep).join('/');
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');

function packageTree(root){
 const entries=[];
 const walk=(dir,prefix='')=>{
  for(const name of fs.readdirSync(dir).sort()){
   const rel=prefix?prefix+'/'+name:name,absolute=path.join(dir,name),stat=fs.lstatSync(absolute);
   need(!stat.isSymbolicLink(),'RUNTIME_DEPENDENCY_SYMLINK:'+relative(absolute));
   if(stat.isDirectory())walk(absolute,rel);
   else {need(stat.isFile(),'RUNTIME_DEPENDENCY_SPECIAL_FILE:'+relative(absolute));const bytes=fs.readFileSync(absolute);entries.push({path:rel,bytes:bytes.length,sha256:sha(bytes)});}
  }
 };
 walk(root);
 return entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}

export function verifyRuntimeDependencies(){
 const raw=fs.readFileSync(MANIFEST,'utf8'),manifest=JSON.parse(raw);
 need(JSON.stringify(manifest,null,2)+'\n'===raw,'EXACT_RUNTIME_DEPENDENCY_MANIFEST_BYTES');
 need(exactKeys(manifest,['object_type','schema_version','algorithm','resolver_base','entry_request','resolved_entry','packages','authority_effect'])&&manifest.object_type==='RuntimeDependencyManifest'&&manifest.schema_version===1&&manifest.algorithm==='SORTED_PACKAGE_TREE_JSON_LF_SHA256_V1'&&manifest.resolver_base==='apps/clued-cloud/package.json'&&manifest.entry_request==='ajv'&&manifest.authority_effect==='NONE','EXACT_RUNTIME_DEPENDENCY_MANIFEST');
 need(Array.isArray(manifest.packages)&&manifest.packages.length===5,'EXACT_RUNTIME_DEPENDENCY_PACKAGE_SET');
 const expectedRequests=['ajv','fast-deep-equal','fast-json-stable-stringify','json-schema-traverse','uri-js'];
 need(JSON.stringify(manifest.packages.map(x=>x.request))===JSON.stringify(expectedRequests),'ORDERED_RUNTIME_DEPENDENCY_PACKAGE_SET');
 const require=createRequire(path.join(REPO,manifest.resolver_base));
 for(const item of manifest.packages){
  need(exactKeys(item,['request','path','resolved_entry','files','bytes','tree_sha256'])&&expectedRequests.includes(item.request)&&typeof item.path==='string'&&item.path===`apps/clued-cloud/node_modules/${item.request}`&&!item.path.includes('..')&&typeof item.resolved_entry==='string'&&item.resolved_entry.startsWith(item.path+'/')&&Number.isSafeInteger(item.files)&&item.files>0&&Number.isSafeInteger(item.bytes)&&item.bytes>0&&/^[a-f0-9]{64}$/.test(item.tree_sha256),'EXACT_RUNTIME_DEPENDENCY_PACKAGE_DESCRIPTOR:'+String(item.request));
  const root=path.join(REPO,item.path),resolved=relative(require.resolve(item.request));
  need(resolved===item.resolved_entry,'EXACT_RUNTIME_DEPENDENCY_RESOLUTION:'+item.request);
  const entries=packageTree(root),encoded=JSON.stringify(entries)+'\n';
  need(entries.length===item.files&&entries.reduce((n,e)=>n+e.bytes,0)===item.bytes&&sha(encoded)===item.tree_sha256,'RUNTIME_DEPENDENCY_PACKAGE_TREE_DRIFT:'+item.request);
 }
 need(manifest.resolved_entry===manifest.packages[0].resolved_entry,'EXACT_AJV_ENTRY_BINDING');
 return Object.freeze({manifest_sha256:sha(raw),packages:manifest.packages.length,files:manifest.packages.reduce((n,x)=>n+x.files,0),bytes:manifest.packages.reduce((n,x)=>n+x.bytes,0),authority_effect:'NONE'});
}
