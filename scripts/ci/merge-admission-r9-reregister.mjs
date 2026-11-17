#!/usr/bin/env node
// One-command re-registration of scripts/ci/merge-admission-r9-source.json.
//
// The registry pins the exact bytes of every file the independent R9 loader
// authenticates. When one of those files changes, the registry has to be
// re-pinned AND the generation it replaces has to be remembered in a bounded
// history, otherwise observations made by the older generation stop
// authenticating. This script does both, deterministically:
//
//   node scripts/ci/merge-admission-r9-reregister.mjs            # report only, exit 1 when stale
//   node scripts/ci/merge-admission-r9-reregister.mjs --write    # rewrite the registry
//
// History is computed from the registry on main (--base, default origin/main),
// never from the working copy, so running it twice or after several local
// re-pins gives the same bytes. Each history is oldest first. A new generation
// is appended and, when the list is over its capacity, the OLDEST generation is
// dropped (and printed, so the reviewer sees what stops being accepted).
//
// Recomputed here: every blob / sha256 pin, and the previous_* histories.
// NOT touched (review by hand, see docs/maintenance/production-publisher-admission.md):
// paths, job ids and names, required steps, source_paths, publisher job fields,
// scope, forward_epoch, clock, operation_coverage, bindings and registration_status.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const R9_REGISTRY_PATH='scripts/ci/merge-admission-r9-source.json';
export const R9_REREGISTER_COMMAND='node scripts/ci/merge-admission-r9-reregister.mjs --write';
// Capacities: previous_execution_sources is enforced by the loader and previous_source_versions by
// merge-admission-natural-intake.mjs (tests tie both to the consumer). previous_admission_sources is
// the registry's own bound (runtime only caps all admission sources at 20); only the tests hold it.
export const R9_HISTORY_CAPS=Object.freeze({previous_admission_sources:4,previous_execution_sources:4,previous_source_versions:6});
export const R9_EXECUTION_FILES=Object.freeze({profiles_sha256:'scripts/ci/clued-gated-proof-profiles.json',role_specs_sha256:'scripts/ci/clued-gated-proof-role-specs.json'});
const ADMISSION_KINDS=['script','workflow','reverify_workflow','policy'];
const SHA1=/^[a-f0-9]{40}$/,SHA256=/^[a-f0-9]{64}$/;

export const gitBlobSha=bytes=>{const b=Buffer.from(bytes);return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`),b])).digest('hex');};
export const sha256Hex=bytes=>createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const fail=(code,detail)=>{throw Error(`${code}: ${detail}`);};

// Appends to an oldest-first list, dropping from the front beyond `cap`.
export function appendRotating(list,entry,cap){
  const next=[...list,entry],dropped=next.splice(0,Math.max(0,next.length-cap));
  return {list:next,dropped};
}

// Whether `live` (oldest first) is `sealed` with its oldest entries rotated out and newer ones appended.
// live = front + rest. `front` is the part of the sealed history that survived: it must appear unchanged and in
// order. Everything sealed that is older than front[0] was rotated out, which needs at least that many appended
// entries (so the oldest entries cannot simply be deleted). A sealed entry newer than front[0] that is missing
// was removed because it became the current generation again; it must then be back in `rest` as a newer
// generation, as decided by `reappears(missing, entry)` (nothing reappears by default); `rest` may not contain
// a copy of a sealed entry otherwise. Entries equal to
// `current` are exempt: a history never repeats the current generation. This protects the sealed part only;
// what a pull request appended is checked by re-deriving the registry from main (see the helper test).
export function sealedWindowAgrees(sealed,live,{current=()=>false,reappears=()=>false}={}){
  const S=sealed.filter(e=>!current(e));
  if(!S.length)return true;
  if(!live.length)return false;
  for(let split=0;split<=live.length;split+=1){
    const front=live.slice(0,split),rest=live.slice(split),matched=[];
    let at=-1,ok=true;
    for(const entry of front){
      const i=S.findIndex((s,index)=>index>at&&same(s,entry));
      if(i<0){ok=false;break;}
      matched.push(i);at=i;
    }
    if(!ok)continue;
    const rotatedOut=front.length?matched[0]:S.length;
    if(rotatedOut>rest.length)continue;
    const missing=S.map((entry,index)=>({entry,index})).filter(({index})=>index>=rotatedOut&&!matched.includes(index));
    if(!missing.every(({entry})=>rest.some(r=>reappears(entry,r))))continue;
    // An appended entry that is byte-identical to a sealed one is a copy of it, not a new generation, unless that
    // is exactly how a reappearance of an entry that left the history looks.
    const copies=rest.every(r=>S.every((s,index)=>!same(s,r)||(!matched.includes(index)&&reappears(s,r))));
    if(copies)return true;
  }
  return false;
}

// Pins read from bytes: read(path) -> Buffer|string. Paths come from `cfg`.
export function computePins(cfg,read){
  const blob=p=>{let b;try{b=read(p);}catch(error){fail('R9_REREGISTER_FILE_MISSING',`${p} (${error.message})`);}return gitBlobSha(b);};
  const admission=Object.fromEntries(ADMISSION_KINDS.map(k=>[k+'_blob',blob(cfg.admission_source[k+'_path'])]));
  const bytes=p=>{try{return read(p);}catch(error){fail('R9_REREGISTER_FILE_MISSING',`${p} (${error.message})`);}};
  const execution=Object.fromEntries(Object.entries(R9_EXECUTION_FILES).map(([k,p])=>[k,sha256Hex(bytes(p))]));
  const producers=cfg.natural_producers.map(d=>{
    if(d.source_blobs===null||typeof d.source_blobs!=='object')fail('R9_REREGISTER_PRODUCER_NEW',`${d.workflow_path}#${d.job_id} has no source_blobs; register it by hand`);
    const source_blobs=Object.fromEntries(Object.keys(d.source_blobs).map(p=>[p,blob(p)]));
    return {workflow_path:d.workflow_path,job_id:d.job_id,source_blobs};
  });
  const wf=bytes(cfg.publisher_role.workflow_path);
  return {admission,execution,producers,publisher:{workflow_blob:gitBlobSha(wf),workflow_source_sha256:sha256Hex(wf)}};
}
// The same shape, as currently written in the registry.
export function registeredPins(cfg){
  return {admission:Object.fromEntries(ADMISSION_KINDS.map(k=>[k+'_blob',cfg.admission_source[k+'_blob']])),
    execution:{profiles_sha256:cfg.execution_source.profiles_sha256,role_specs_sha256:cfg.execution_source.role_specs_sha256},
    producers:cfg.natural_producers.map(d=>({workflow_path:d.workflow_path,job_id:d.job_id,source_blobs:d.source_blobs})),
    publisher:{workflow_blob:cfg.publisher_role.workflow_blob,workflow_source_sha256:cfg.publisher_role.workflow_source_sha256}};
}

// The rules the runtime consumers apply to the histories, so a rotated registry is never written
// in a form the loader or the natural intake would refuse.
export function assertHistoryInvariants(cfg){
  const caps=R9_HISTORY_CAPS,bad=detail=>fail('R9_HISTORY_INVALID',detail);
  const pas=cfg.previous_admission_sources??[],pes=cfg.previous_execution_sources??[];
  if(!Array.isArray(pas)||pas.length>caps.previous_admission_sources)bad(`previous_admission_sources must hold at most ${caps.previous_admission_sources}`);
  const admissionKeys=[...Object.keys(cfg.admission_source),'source_checkout_sha','default_branch'].sort().join('|'),checkouts=new Set();
  for(const e of pas){
    if(Object.keys(e).sort().join('|')!==admissionKeys||!SHA1.test(e.source_checkout_sha)||checkouts.has(e.source_checkout_sha))bad('previous_admission_sources entry shape or checkout');
    checkouts.add(e.source_checkout_sha);
  }
  if(!Array.isArray(pes)||pes.length>caps.previous_execution_sources)bad(`previous_execution_sources must hold at most ${caps.previous_execution_sources}`);
  const pairs=new Set([cfg.execution_source.profiles_sha256+':'+cfg.execution_source.role_specs_sha256]),execCheckouts=new Set();
  for(const e of pes){
    const pair=e.profiles_sha256+':'+e.role_specs_sha256;
    if(Object.keys(e).sort().join('|')!=='profiles_sha256|role_specs_sha256|source_checkout_sha'||!SHA1.test(e.source_checkout_sha)||
      !SHA256.test(e.profiles_sha256)||!SHA256.test(e.role_specs_sha256)||execCheckouts.has(e.source_checkout_sha)||pairs.has(pair))bad('previous_execution_sources entry shape, checkout or duplicate pair');
    execCheckouts.add(e.source_checkout_sha);pairs.add(pair);
  }
  for(const d of cfg.natural_producers){
    if(Object.hasOwn(d,'previous_source_versions')&&(Object.hasOwn(d,'previous_source_blobs')||Object.hasOwn(d,'previous_job_name')))bad(`${d.workflow_path} mixes previous_source_versions with the legacy previous_source_blobs/previous_job_name`);
    const versions=d.previous_source_versions??[],paths=[...d.source_paths].sort().join('|'),seen=new Set([JSON.stringify(canonical(d.source_blobs))]);
    if(!Array.isArray(versions)||versions.length>caps.previous_source_versions)bad(`${d.workflow_path} previous_source_versions must hold at most ${caps.previous_source_versions}`);
    if(Object.keys(d.source_blobs).sort().join('|')!==paths||!d.source_paths.includes(d.workflow_path)||d.source_blobs[d.workflow_path]!==d.workflow_blob)bad(`${d.workflow_path} current source_blobs do not match source_paths`);
    for(const v of versions){
      const renamed=d.workflow_path==='.github/workflows/clued-work-admission.yml'&&d.job_id==='clued-work-admission'&&d.job_name==='kooyumi-work-admission'&&v.job_name==='clued-work-admission';
      const identity=JSON.stringify(canonical(v.source_blobs));
      if(Object.keys(v).sort().join('|')!=='job_name|source_blobs'||typeof v.job_name!=='string'||!v.job_name||v.job_name!==v.job_name.trim()||
        (v.job_name!==d.job_name&&!renamed)||Object.keys(v.source_blobs).sort().join('|')!==paths||Object.values(v.source_blobs).some(x=>!SHA1.test(x))||seen.has(identity))
        bad(`${d.workflow_path} previous_source_versions entry (job_name, source map or duplicate)`);
      seen.add(identity);
    }
  }
}

// Pure core. baseConfig is the registry on main, workingConfig the file being edited, read() the bytes of
// the files the registry pins, oldCheckout a commit on main whose tree holds baseConfig's pins.
export function reregister({baseConfig,workingConfig,read,oldCheckout}){
  if(!SHA1.test(oldCheckout??''))fail('R9_REREGISTER_CHECKOUT_INVALID','the old generation needs a 40-hex main commit');
  const base=baseConfig,work=workingConfig,next=structuredClone(work),changes=[],dropped=[];
  const branch=String(base.scope?.queue_ref??'').split(':').at(-1)||'main',pins=computePins(work,read),caps=R9_HISTORY_CAPS;
  const match=(a,b,keys)=>keys.every(k=>a[k]===b[k]);

  // admission_source -> previous_admission_sources. Admission sources are looked up by source_checkout_sha, so
  // every replaced generation keeps its own checkout even when its bytes equal another entry (revert A->B->A).
  const aKeys=ADMISSION_KINDS.map(k=>k+'_blob'),oldA=base.admission_source;
  Object.assign(next.admission_source,pins.admission);
  let pas=structuredClone(base.previous_admission_sources??[]);
  if(aKeys.some(k=>oldA[k]!==pins.admission[k])){
    changes.push('admission_source: '+aKeys.filter(k=>oldA[k]!==pins.admission[k]).join(', ')+' re-pinned');
    if(pas.some(e=>e.source_checkout_sha===oldCheckout))fail('R9_REREGISTER_CHECKOUT_REUSED',`previous_admission_sources already has ${oldCheckout}`);
    const r=appendRotating(pas,{...oldA,source_checkout_sha:oldCheckout,default_branch:branch},caps.previous_admission_sources);
    pas=r.list;for(const e of r.dropped)dropped.push({list:'previous_admission_sources',reason:'capacity',checkout:e.source_checkout_sha,script_blob:e.script_blob});
    changes.push(`previous_admission_sources: + ${oldCheckout.slice(0,12)}`);
  }
  if(Object.hasOwn(base,'previous_admission_sources')||pas.length)next.previous_admission_sources=pas;else delete next.previous_admission_sources;

  // execution_source -> previous_execution_sources. The loader refuses a history entry whose profile/role pair
  // equals the current one, so an entry that became current again leaves the history.
  const oldE=base.execution_source,newE=pins.execution,eKeys=Object.keys(R9_EXECUTION_FILES);
  next.execution_source={...work.execution_source,...newE};
  const hasExec=Object.hasOwn(base,'previous_execution_sources'),executionChanged=eKeys.some(k=>oldE[k]!==newE[k]);
  if(!hasExec&&executionChanged)fail('R9_REREGISTER_SCHEMA_MANUAL','the registry has no previous_execution_sources; adding it switches the loader to the v2 expectations, so do it by hand');
  if(hasExec){
    let pes=[];
    for(const e of base.previous_execution_sources){
      if(match(e,newE,eKeys))dropped.push({list:'previous_execution_sources',reason:'became the current generation',checkout:e.source_checkout_sha,profiles_sha256:e.profiles_sha256});
      else pes.push(structuredClone(e));
    }
    if(executionChanged){
      changes.push('execution_source: '+eKeys.filter(k=>oldE[k]!==newE[k]).join(', ')+' re-pinned');
      if(pes.some(e=>e.source_checkout_sha===oldCheckout))fail('R9_REREGISTER_CHECKOUT_REUSED',`previous_execution_sources already has ${oldCheckout}`);
      const r=appendRotating(pes,{source_checkout_sha:oldCheckout,profiles_sha256:oldE.profiles_sha256,role_specs_sha256:oldE.role_specs_sha256},caps.previous_execution_sources);
      pes=r.list;for(const e of r.dropped)dropped.push({list:'previous_execution_sources',reason:'capacity',checkout:e.source_checkout_sha,profiles_sha256:e.profiles_sha256});
      changes.push(`previous_execution_sources: + ${oldCheckout.slice(0,12)}`);
    }
    next.previous_execution_sources=pes;
  }

  // natural_producers -> previous_source_versions (same exclusion of the current map as the intake applies)
  next.natural_producers.forEach((d,i)=>{
    const key=`${d.workflow_path}#${d.job_id}`,b=base.natural_producers.find(x=>x.workflow_path===d.workflow_path&&x.job_id===d.job_id);
    if(!b)fail('R9_REREGISTER_PRODUCER_NEW',`${key} is not on main; register a new producer by hand`);
    if(b.source_blobs===null||typeof b.source_blobs!=='object'||Object.keys(b.source_blobs).sort().join('|')!==[...d.source_paths].sort().join('|'))
      fail('R9_REREGISTER_SOURCE_PATHS_CHANGED',`${key}: source_paths differs from main's pinned set; every history map must cover the same paths, so this needs a manual decision`);
    const source_blobs=pins.producers[i].source_blobs;
    d.source_blobs=source_blobs;d.workflow_blob=source_blobs[d.workflow_path];
    if(d.workflow_blob===undefined)fail('R9_REREGISTER_SOURCE_PATHS_CHANGED',`${key}: source_paths must contain the workflow itself`);
    const blobsChanged=!same(b.source_blobs,source_blobs),hasVersions=Object.hasOwn(b,'previous_source_versions');
    if(blobsChanged&&(Object.hasOwn(b,'previous_source_blobs')||Object.hasOwn(b,'previous_job_name')))
      fail('R9_REREGISTER_SCHEMA_MANUAL',`${key} still uses the legacy previous_source_blobs/previous_job_name history; convert it by hand`);
    if(!hasVersions&&!blobsChanged){delete d.previous_source_versions;return;}
    let versions=[];
    for(const v of b.previous_source_versions??[]){
      if(same(v.source_blobs,source_blobs))dropped.push({list:`${key} previous_source_versions`,reason:'became the current generation',job_name:v.job_name,workflow_blob:v.source_blobs[d.workflow_path]});
      else versions.push(structuredClone(v));
    }
    if(blobsChanged){
      changes.push(`${key}: ${Object.keys(source_blobs).filter(p=>b.source_blobs[p]!==source_blobs[p]).length} source file(s) re-pinned`);
      const r=appendRotating(versions,{job_name:b.job_name,source_blobs:b.source_blobs},caps.previous_source_versions);
      versions=r.list;for(const v of r.dropped)dropped.push({list:`${key} previous_source_versions`,reason:'capacity',job_name:v.job_name,workflow_blob:v.source_blobs[d.workflow_path]});
      changes.push(`${key} previous_source_versions: + ${b.job_name}`);
    }
    d.previous_source_versions=versions;
  });

  // publisher_role has no history
  const oldP=work.publisher_role;next.publisher_role={...work.publisher_role,...pins.publisher};
  if(oldP.workflow_blob!==pins.publisher.workflow_blob||oldP.workflow_source_sha256!==pins.publisher.workflow_source_sha256)changes.push('publisher_role: workflow_blob, workflow_source_sha256 re-pinned');

  assertHistoryInvariants(next);
  return {config:next,changes,dropped};
}

export const MANUAL_REVIEW=[
  'job_id, job_name, required_steps and source_paths of natural_producers and publisher_role (a renamed job or a new source file is not detected)',
  'admission_source paths, app_id and grammar; execution_source file paths',
  'scope, forward_epoch, clock, operation_coverage, minimum_clock_binding, bootstrap_clock_reader and every registration_status',
];

const git=(root,args,buffer=false)=>{const out=execFileSync('git',args,{cwd:root,maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});return buffer?out:out.toString('utf8').trim();};
const gitOk=(root,args)=>{try{execFileSync('git',args,{cwd:root,stdio:'ignore'});return true;}catch{return false;}};
// Refs that normally hold main; used to notice a --base that is behind what the branch already merged.
export function knownMainRefs(root){
  try{return git(root,['for-each-ref','--format=%(refname)','refs/heads/main','refs/remotes/*/main','refs/local-verify/github/main']).split('\n').filter(Boolean);}catch{return [];}
}

function parseArgs(argv){
  const o={write:false,base:'origin/main',oldCheckout:null,root:null,help:false};
  for(let i=0;i<argv.length;i+=1){
    const a=argv[i],value=()=>{if(i+1>=argv.length||argv[i+1].startsWith('-'))fail('R9_REREGISTER_USAGE',`${a} needs a value that does not start with "-"`);return argv[++i];};
    if(a==='--write')o.write=true;else if(a==='--check')o.write=false;else if(a==='--base')o.base=value();
    else if(a==='--old-checkout')o.oldCheckout=value();else if(a==='--root')o.root=value();else if(a==='--help'||a==='-h')o.help=true;
    else fail('R9_REREGISTER_USAGE',`unknown argument ${a}`);
  }
  return o;
}

export const USAGE=`Usage: ${R9_REREGISTER_COMMAND.replace(' --write','')} [--check | --write] [--base <ref>] [--old-checkout <sha>] [--root <dir>]
  --check          (default) report what is stale and exit 1; nothing is written
  --write          rewrite ${R9_REGISTRY_PATH}
  --base <ref>     the up to date main to rotate history from (default origin/main; after
                   "git fetch https://github.com/<owner>/<repo>.git main" use --base FETCH_HEAD)
  --old-checkout   the main commit that registered the generation being replaced
                   (default: the last first-parent commit of --base that touched the registry;
                   refused in a shallow clone, where that commit cannot be known)`;

// Everything except writing: the registry this checkout should contain, derived from main's registry.
export function plan(root,{base='origin/main',oldCheckout=null}={}){
  const baseSha=(()=>{try{return git(root,['rev-parse','--verify',`${base}^{commit}`]);}catch{fail('R9_REREGISTER_BASE_MISSING',`cannot resolve --base ${base}; fetch main first and pass --base FETCH_HEAD (or the ref you fetched)`);}})();
  if(!gitOk(root,['merge-base','--is-ancestor',baseSha,'HEAD']))fail('R9_REREGISTER_BASE_NOT_MERGED',`HEAD does not contain ${baseSha.slice(0,12)}; merge or rebase onto it first`);
  // A base older than a main commit this branch already contains would silently lose the generation registered in between.
  const head=git(root,['rev-parse','HEAD']),headMainRefs=[];
  const behind=(ref,sha)=>fail('R9_REREGISTER_BASE_BEHIND',`HEAD contains ${ref} (${sha.slice(0,12)}) which is newer than --base ${base} (${baseSha.slice(0,12)}); use the newer main as --base`);
  for(const ref of knownMainRefs(root)){
    const sha=(()=>{try{return git(root,['rev-parse','--verify',`${ref}^{commit}`]);}catch{return null;}})();
    if(sha&&sha!==baseSha&&gitOk(root,['merge-base','--is-ancestor',sha,'HEAD'])&&!gitOk(root,['merge-base','--is-ancestor',sha,baseSha])){
      if(sha!==head)behind(ref,sha);
      headMainRefs.push(ref);
    }
  }
  if(oldCheckout===null&&git(root,['rev-parse','--is-shallow-repository'])==='true')
    fail('R9_REREGISTER_SHALLOW','this is a shallow clone, so the commit that registered the current generation cannot be found; fetch full history or pass --old-checkout');
  const registered=oldCheckout??git(root,['rev-list','-1','--first-parent',baseSha,'--',R9_REGISTRY_PATH]);
  if(!SHA1.test(registered))fail('R9_REREGISTER_CHECKOUT_INVALID','could not determine the commit that registered the current generation; pass --old-checkout');
  if(!gitOk(root,['merge-base','--is-ancestor',registered,baseSha]))fail('R9_REREGISTER_CHECKOUT_INVALID',`${registered} is not on ${base}`);
  const blobAt=(rev)=>(p)=>git(root,['cat-file','blob',`${rev}:${p}`],true),atBase=blobAt(baseSha);
  if(!atBase(R9_REGISTRY_PATH).equals(blobAt(registered)(R9_REGISTRY_PATH)))fail('R9_REREGISTER_CHECKOUT_INVALID',`${registered.slice(0,12)} did not register the registry that ${base} holds`);
  const baseConfig=JSON.parse(atBase(R9_REGISTRY_PATH).toString('utf8'));
  if(!same(computePins(baseConfig,atBase),registeredPins(baseConfig)))fail('R9_REREGISTER_BASE_STALE',`${base} pins bytes that its own files do not have; fix main first`);
  // The history anchors the replaced generation at `registered`, so its pinned files must have the pinned bytes there too.
  if(registered!==baseSha&&!same(computePins(baseConfig,blobAt(registered)),registeredPins(baseConfig)))
    fail('R9_REREGISTER_CHECKOUT_INVALID',`the files pinned by ${base} do not have the pinned bytes at ${registered.slice(0,12)}`);
  const file=path.join(root,R9_REGISTRY_PATH),current=fs.readFileSync(file,'utf8'),workingConfig=JSON.parse(current);
  // The pins must be the bytes CI checks out. Git normalizes line endings, so a CRLF working file would pin a hash CI never sees.
  const pinned=new Set([R9_REGISTRY_PATH,...Object.values(R9_EXECUTION_FILES),workingConfig.publisher_role.workflow_path,
    ...ADMISSION_KINDS.map(k=>workingConfig.admission_source[k+'_path']),...workingConfig.natural_producers.flatMap(d=>Object.keys(d.source_blobs??{}))]);
  for(const p of pinned){
    const eol=git(root,['--literal-pathspecs','ls-files','--eol','--',p]);
    if(/^i\/(lf|none)\s+w\/(crlf|mixed)\b/.test(eol.trim()))fail('R9_REREGISTER_CRLF',`${p} has CRLF line endings in the working tree but LF in the index; convert it to LF before re-registering`);
  }
  const result=reregister({baseConfig,workingConfig,read:p=>fs.readFileSync(path.join(root,p)),oldCheckout:registered});
  const text=JSON.stringify(result.config,null,2)+'\n';
  // On a main push, origin/main already names HEAD while --base is event.before.
  // Allow only a proven no-op of that committed generation: its complete history
  // must re-derive unchanged from --base, and both registry and pinned bytes must
  // still match HEAD. Never rotate a working edit from an obsolete main base.
  if(headMainRefs.length&&(text!==current||!Buffer.from(current).equals(blobAt(head)(R9_REGISTRY_PATH))||
      !same(computePins(workingConfig,blobAt(head)),registeredPins(workingConfig))))behind(headMainRefs[0],head);
  return {baseSha,oldCheckout:registered,baseConfig,workingConfig,result,text,current,upToDate:text===current,file};
}

export async function main(argv,{log=console.log}={}){
  const o=parseArgs(argv);
  if(o.help){log(USAGE);return 0;}
  const root=path.resolve(o.root??git(process.cwd(),['rev-parse','--show-toplevel']));
  if(o.oldCheckout!==null&&!SHA1.test(o.oldCheckout))fail('R9_REREGISTER_CHECKOUT_INVALID','--old-checkout needs a 40-hex commit');
  const p=plan(root,{base:o.base,oldCheckout:o.oldCheckout});
  if(p.upToDate){log(`R9 registry is up to date with the files it pins (history rotated from ${p.baseSha.slice(0,12)}).`);return 0;}
  log(`R9 registry ${o.write?'re-registered':'is stale'} (base ${p.baseSha.slice(0,12)}, replaced generation registered at ${p.oldCheckout.slice(0,12)}):`);
  for(const c of p.result.changes)log('  '+c);
  if(p.result.dropped.length){
    log('  LEAVING THE HISTORY (observations made only by these generations stop authenticating):');
    for(const d of p.result.dropped)log('    '+JSON.stringify(d));
  }
  log('  Review by hand (never recomputed):');for(const m of MANUAL_REVIEW)log('    - '+m);
  if(!o.write){log(`Run: ${R9_REREGISTER_COMMAND}  (then review the diff and commit)`);return 1;}
  fs.writeFileSync(p.file,p.text);log(`wrote ${R9_REGISTRY_PATH}; review the diff, then run node --test scripts/ci/merge-admission-source-producer.test.mjs`);return 0;
}

const entry=(()=>{try{return fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url));}catch{return false;}})();
if(entry){
  try{process.exitCode=await main(process.argv.slice(2));}
  catch(error){console.error(error.message);process.exitCode=2;}
}
