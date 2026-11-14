#!/usr/bin/env node
// Refresh only proven, policy-listed COMPONENT_VERSION changes. Historical
// implementation snapshots, workflow bytes, FullRoles and authority stay bound
// to the caller's trusted base; this command grants no execution qualification.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const CONTROL_SOURCE_MODULE='scripts/ci/clued-control-workflow-source.mjs';
export const CONTROL_SOURCE_REGISTRY='scripts/ci/clued-control-workflow-sources.json';
export const MECHANICAL_POLICY='config/clued-mechanical-files.json';
export const CONTROL_SOURCE_PIN_FIX='node scripts/ci/clued-control-source-pins.mjs --root <checkout> --base <trusted main commit> --write';
const EXPORT='export const MERGE_RECONCILE_CONTROL_SOURCE=freeze(';
const PROFILE='scripts/ci/clued-workflow-profile.mjs';
const DEFAULT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const refuse=m=>{throw new Error(`control Source pins: ${m}`);};
const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
const lf=s=>s.replace(/\r\n/g,'\n');
const blob=s=>{const b=Buffer.from(lf(s));return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');};
function readPlain(root,name){
  const full=path.join(root,name);
  for(let p=full;;p=path.dirname(p)){
    const st=fs.lstatSync(p);
    if(st.isSymbolicLink()||(p===full?!st.isFile()||st.size>2**21:!st.isDirectory()))refuse(`not a plain path: ${name}`);
    if(path.dirname(p)===p)break;
  }
  return lf(new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(full)));
}
function assertBaseMode(root,base,name){
  const old=git(root,['ls-tree','-z',base,'--',name]).match(/^([0-9]{6}) blob [a-f0-9]{40}\t[^\0]+\0$/);
  const current=git(root,['ls-files','--stage','-z','--',name]).match(/^([0-9]{6}) [a-f0-9]{40} 0\t[^\0]+\0$/);
  if(!old||!current||!['100644','100755'].includes(old[1])||current[1]!==old[1])refuse(`file mode differs from trusted base: ${name}`);
  if(process.platform!=='win32'&&Boolean(fs.statSync(path.join(root,name)).mode&0o111)!==(old[1]==='100755'))refuse(`working file mode differs from trusted base: ${name}`);
}
function descriptor(text){
  const start=text.indexOf(EXPORT);
  if(start<0||text.indexOf(EXPORT,start+1)!==-1)refuse('one descriptor export required');
  const a=start+EXPORT.length,b=text.indexOf('\n});',a);
  if(b<0)refuse('descriptor boundary missing');
  const value=JSON.parse(text.slice(a,b+2));
  if(!value||Array.isArray(value)||!value.implementation_blobs)refuse('descriptor invalid');
  return {a,b:b+2,value};
}
function version(text){
  const rows=[...text.matchAll(/^export const COMPONENT_VERSION[ \t]*=[ \t]*(['"])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)\1[ \t]*;[ \t]*$/gm)];
  if(rows.length!==1)refuse('exactly one component version marker required');
  return rows[0][2];
}
function withoutVersion(text){version(text);return text.replace(/^(export const COMPONENT_VERSION[ \t]*=[ \t]*['"])[^'"]+(['"][ \t]*;[ \t]*)$/m,'$1<component-version>$2');}
// Same narrow normalisation as the base policy, without executing a mutable
// candidate policy module. Exactly one marker is mandatory in both texts.
function mechanicalVersionOnly(before,after){return withoutVersion(before)===withoutVersion(after);}
// Candidates for a refresh: the descriptor's pinned version-bearing modules that
// the trusted base's one generated-file list declares (no second list). Only a
// pin that still tracks its file at the trusted base follows a version-only
// change; every other pin is historical and stays as it is (see the plan).
// Pinned generated registries (.json) keep their historical pin.
export function controlSourceMechanicalFiles(policy,implementationBlobs){
  if(policy?.schema!==1||policy.repository!=='tdoljyj/cross-memory-system'||!Array.isArray(policy.mechanical_paths)
    ||policy.mechanical_paths.some(p=>typeof p!=='string'))refuse('trusted mechanical policy invalid');
  // Both sections of the one list; a policy from before marker_paths existed lists them as mechanical.
  const listed=[...policy.mechanical_paths,...(Array.isArray(policy.marker_paths)?policy.marker_paths:[])];
  const declared=name=>listed.some(p=>name===p||(typeof p==='string'&&p.endsWith('/**')&&name.startsWith(p.slice(0,-2))));
  const names=Object.keys(implementationBlobs??{}).filter(n=>n.endsWith('.mjs')&&declared(n)).sort();
  if(!names.length)refuse('no mechanical pin declared by trusted policy');
  return names;
}
function projectedDescriptor(value,names){
  const result=structuredClone(value);
  for(const name of names){if(!/^[a-f0-9]{40}$/.test(result.implementation_blobs[name]??''))refuse(`missing mechanical pin: ${name}`);result.implementation_blobs[name]='<mechanical-version-blob>';}
  return result;
}
function initialEntry(registry,file){
  const rows=registry?.workflows?.[file]?.sources;
  if(!Array.isArray(rows)||rows.length!==1||rows[0]?.source_kind!=='merge_reconcile_initial')refuse('one initial reconciliation registration required');
  return rows[0];
}
function projectedRegistry(value,file,names){const result=structuredClone(value),entry=initialEntry(result,file);entry.implementation_blobs=projectedDescriptor({implementation_blobs:entry.implementation_blobs},names).implementation_blobs;return result;}
function ensureVersionManifest(manifest,file,text){
  // A marker file is relative to its component root (e.g. root scripts/ci, file clued-source-only-workflow.mjs).
  const rows=manifest.components?.filter(c=>typeof c.version_marker?.file==='string'&&path.posix.join(c.root??'.',c.version_marker.file)===file);
  if(rows?.length!==1||rows[0].version!==version(text))refuse(`version/manifest mismatch: ${file}`);
}

export async function planControlSourcePins(root=DEFAULT_ROOT,{base}={}){
  root=path.resolve(root);
  if(!/^[a-f0-9]{40}$/.test(base??''))refuse('exact trusted base commit required');
  git(root,['rev-parse','--verify',`${base}^{commit}`]);
  const before=lf(git(root,['show',`${base}:${CONTROL_SOURCE_MODULE}`]));
  const beforeRegistry=JSON.parse(git(root,['show',`${base}:${CONTROL_SOURCE_REGISTRY}`]));
  const old=descriptor(before);
  let policy;try{policy=JSON.parse(git(root,['show',`${base}:${MECHANICAL_POLICY}`]));}catch{refuse('trusted mechanical policy invalid');}
  const mechanical=controlSourceMechanicalFiles(policy,old.value.implementation_blobs);
  for(const name of [CONTROL_SOURCE_MODULE,CONTROL_SOURCE_REGISTRY,PROFILE,...mechanical])assertBaseMode(root,base,name);
  const source=readPlain(root,CONTROL_SOURCE_MODULE),registered=readPlain(root,CONTROL_SOURCE_REGISTRY);
  const d=descriptor(source),registry=JSON.parse(registered);
  if(!isDeepStrictEqual(projectedDescriptor(d.value,mechanical),projectedDescriptor(old.value,mechanical)))refuse('frozen descriptor changed beyond mechanical pins');
  const moduleShape=(text,part)=>withoutVersion(text.slice(0,part.a)+'<registered-descriptor>'+text.slice(part.b));
  if(moduleShape(source,d)!==moduleShape(before,old))refuse('Source implementation changed beyond its version marker');
  if(!isDeepStrictEqual(projectedRegistry(registry,d.value.file,mechanical),projectedRegistry(beforeRegistry,old.value.file,mechanical)))refuse('frozen catalogue/Role/workflow/authority changed');
  const entry=initialEntry(registry,d.value.file);
  if(!isDeepStrictEqual(entry.implementation_blobs,d.value.implementation_blobs))refuse('descriptor/catalogue pins disagree');
  const manifest=JSON.parse(readPlain(root,'config/clued-components.json'));
  ensureVersionManifest(manifest,CONTROL_SOURCE_MODULE,source);
  const next=structuredClone(d.value),changes=[];
  for(const name of mechanical){
    const expected=old.value.implementation_blobs[name],current=readPlain(root,name),actual=blob(current);
    const candidate=d.value.implementation_blobs[name];
    let derived=expected;
    // A pin equal to the file's blob at the trusted base tracks that file; any
    // other pin is a historical snapshot and never moves. A tracking pin moves
    // only with a version-marker change; any other edit leaves it as it was, so
    // implementation logic is never converted into registry metadata.
    const tracking=git(root,['rev-parse',`${base}:${name}`]).trim()===expected;
    if(tracking&&actual!==expected){
      ensureVersionManifest(manifest,name,current);
      // The old content comes from an authenticated Git object, never a caller-
      // supplied old string or the mutable candidate's self-reported digest.
      const historical=lf(git(root,['cat-file','blob',expected]));
      if(blob(historical)!==expected)refuse(`historical object mismatch: ${name}`);
      if(mechanicalVersionOnly(historical,current))derived=actual;
    }
    if(candidate!==expected&&candidate!==derived)refuse(`candidate pin is neither trusted nor derived: ${name}`);
    next.implementation_blobs[name]=derived;
    if(candidate!==derived)changes.push({file:name,before:candidate,after:derived});
  }
  // Historical descriptors use the compiler from the trusted base, even when
  // the candidate contains a compiler successor. Keep the candidate path
  // checks, but never execute its bytes to authenticate historical metadata.
  readPlain(root,PROFILE);
  const profile=lf(git(root,['show',`${base}:${PROFILE}`]));
  const profileImport="'./clued-workflow-profile.mjs'";
  if(source.split(profileImport).length!==2)refuse('one known profile import required');
  const profileUrl='data:text/javascript;base64,'+Buffer.from(profile).toString('base64');
  const verified=source.replace(profileImport,JSON.stringify(profileUrl));
  const mod=await import('data:text/javascript;base64,'+Buffer.from(verified).toString('base64'));
  const roles=registry.roles?.[d.value.file]?.[entry.workflow_blob];
  const compiled=mod.compileControlWorkflowSource(d.value.file,entry.source_yaml,{parseYaml:()=>entry.workflow_definition,accepted_roles:roles,source_kind:'merge_reconcile_initial'});
  if(!isDeepStrictEqual(compiled,entry))refuse('registered initial Source does not compile exactly');
  const nextRegistry=structuredClone(registry);initialEntry(nextRegistry,d.value.file).implementation_blobs={...next.implementation_blobs};
  const outputModule=source.slice(0,d.a)+JSON.stringify(next,null,2)+source.slice(d.b);
  return {base,changes,outputs:{[CONTROL_SOURCE_MODULE]:outputModule,[CONTROL_SOURCE_REGISTRY]:JSON.stringify(nextRegistry,null,2)+'\n'},originals:{[CONTROL_SOURCE_MODULE]:source,[CONTROL_SOURCE_REGISTRY]:registered}};
}
export async function checkControlSourcePins(root=DEFAULT_ROOT,options={}){
  const fix=CONTROL_SOURCE_PIN_FIX.replace('<checkout>',JSON.stringify(path.resolve(root))).replace('<trusted main commit>',options.base??'<trusted main commit>');
  try{const p=await planControlSourcePins(root,options);return {id:'control-source-pins',status:p.changes.length?'stale':'ok',registry:CONTROL_SOURCE_REGISTRY,details:p.changes.map(c=>`mechanical version pin stale: ${c.file}`),fix};}
  catch(error){return {id:'control-source-pins',status:options.base?'stale':'unchecked',registry:CONTROL_SOURCE_REGISTRY,details:[error.message],fix};}
}
export async function writeControlSourcePins(root=DEFAULT_ROOT,options={}){
  root=path.resolve(root);const p=await planControlSourcePins(root,options);
  if(!p.changes.length)return {changed:false,base:p.base,changes:[]};
  // All semantic checks above precede either write. Check both original byte
  // observations again before materialising the two derived registry mirrors.
  for(const [name,value]of Object.entries(p.originals))if(readPlain(root,name)!==value)refuse(`input changed during generation: ${name}`);
  const written=[];
  try{for(const [name,value]of Object.entries(p.outputs)){fs.writeFileSync(path.join(root,name),value);written.push(name);}}
  catch(error){for(const name of written.reverse())fs.writeFileSync(path.join(root,name),p.originals[name]);throw error;}
  return {changed:true,base:p.base,changes:p.changes,qualification:'mechanical_metadata_only_not_execution_authority'};
}
if(import.meta.main){
  try{let root=DEFAULT_ROOT,base,write=false;for(let i=2;i<process.argv.length;i++){const a=process.argv[i];if(a==='--root'&&process.argv[i+1])root=path.resolve(process.argv[++i]);else if(a==='--base'&&process.argv[i+1])base=process.argv[++i];else if(a==='--write')write=true;else refuse(`unknown argument: ${a}`);}
    const value=write?await writeControlSourcePins(root,{base}):await checkControlSourcePins(root,{base});console.log(JSON.stringify(value));if(!write&&value.status!=='ok')process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
