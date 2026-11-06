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
// Capacities enforced by the runtime consumers: the loader (previous_execution_sources),
// merge-admission-natural-intake.mjs (previous_source_versions) and the sealed registry
// design (previous_admission_sources). Tests tie each value to its consumer.
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

// Whether `live` (oldest first) is `sealed` with oldest entries dropped and newer ones appended.
// `sealed` are the generations of an immutable earlier registry; entries equal to `current`
// are exempt because re-registration removes a history entry that became the current one.
export function sealedWindowAgrees(sealed,live,current=()=>false){
  const S=sealed.filter(e=>!current(e)),at=live.length?S.findIndex(e=>same(e,live[0])):-1;
  if(at<0)return !live.some(e=>S.some(s=>same(s,e)));
  const tail=S.slice(at);
  return live.length>=tail.length&&tail.every((e,i)=>same(e,live[i]));
}

// Pins read from bytes: read(path) -> Buffer|string. Paths come from `cfg`.
export function computePins(cfg,read){
  const blob=p=>{let b;try{b=read(p);}catch(error){fail('R9_REREGISTER_FILE_MISSING',`${p} (${error.message})`);}return gitBlobSha(b);};
  const admission=Object.fromEntries(ADMISSION_KINDS.map(k=>[k+'_blob',blob(cfg.admission_source[k+'_path'])]));
  const execution=Object.fromEntries(Object.entries(R9_EXECUTION_FILES).map(([k,p])=>[k,sha256Hex(read(p))]));
  const producers=cfg.natural_producers.map(d=>{
    const source_blobs=Object.fromEntries(Object.keys(d.source_blobs).map(p=>[p,blob(p)]));
    return {workflow_path:d.workflow_path,job_id:d.job_id,source_blobs};
  });
  const wf=read(cfg.publisher_role.workflow_path);
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
  const base=baseConfig,work=workingConfig,next=structuredClone(work),changes=[],dropped=[],kept=[];
  const branch=String(base.scope?.queue_ref??'').split(':').at(-1)||'main',pins=computePins(work,read),caps=R9_HISTORY_CAPS;
  const same40=(a,b,keys)=>keys.every(k=>a[k]===b[k]);

  // admission_source -> previous_admission_sources
  const aKeys=ADMISSION_KINDS.map(k=>k+'_blob'),oldA=base.admission_source;
  Object.assign(next.admission_source,pins.admission);
  let pas=(base.previous_admission_sources??[]).filter(e=>!same40(e,pins.admission,aKeys));
  if(aKeys.some(k=>oldA[k]!==pins.admission[k])){
    changes.push('admission_source: '+aKeys.filter(k=>oldA[k]!==pins.admission[k]).join(', ')+' re-pinned');
    if(pas.some(e=>same40(e,oldA,aKeys)))kept.push('previous_admission_sources already retains the replaced generation');
    else{
      if(pas.some(e=>e.source_checkout_sha===oldCheckout))fail('R9_REREGISTER_CHECKOUT_REUSED',`previous_admission_sources already has ${oldCheckout}`);
      const r=appendRotating(pas,{...oldA,source_checkout_sha:oldCheckout,default_branch:branch},caps.previous_admission_sources);
      pas=r.list;for(const e of r.dropped)dropped.push({list:'previous_admission_sources',checkout:e.source_checkout_sha,script_blob:e.script_blob});
      changes.push(`previous_admission_sources: + ${oldCheckout.slice(0,12)}`);
    }
  }
  next.previous_admission_sources=pas;

  // execution_source -> previous_execution_sources
  const oldE=base.execution_source,newE=pins.execution,eKeys=Object.keys(R9_EXECUTION_FILES);
  next.execution_source={...work.execution_source,...newE};
  let pes=(base.previous_execution_sources??[]).filter(e=>!same40(e,newE,eKeys));
  if(eKeys.some(k=>oldE[k]!==newE[k])){
    changes.push('execution_source: '+eKeys.filter(k=>oldE[k]!==newE[k]).join(', ')+' re-pinned');
    if(pes.some(e=>same40(e,oldE,eKeys)))kept.push('previous_execution_sources already retains the replaced generation');
    else{
      if(pes.some(e=>e.source_checkout_sha===oldCheckout))fail('R9_REREGISTER_CHECKOUT_REUSED',`previous_execution_sources already has ${oldCheckout}`);
      const r=appendRotating(pes,{source_checkout_sha:oldCheckout,profiles_sha256:oldE.profiles_sha256,role_specs_sha256:oldE.role_specs_sha256},caps.previous_execution_sources);
      pes=r.list;for(const e of r.dropped)dropped.push({list:'previous_execution_sources',checkout:e.source_checkout_sha,profiles_sha256:e.profiles_sha256});
      changes.push(`previous_execution_sources: + ${oldCheckout.slice(0,12)}`);
    }
  }
  next.previous_execution_sources=pes;

  // natural_producers -> previous_source_versions
  next.natural_producers.forEach((d,i)=>{
    const key=`${d.workflow_path}#${d.job_id}`,b=base.natural_producers.find(x=>x.workflow_path===d.workflow_path&&x.job_id===d.job_id);
    if(!b)fail('R9_REREGISTER_PRODUCER_NEW',`${key} is not on main; register a new producer by hand`);
    if(Object.keys(b.source_blobs).sort().join('|')!==[...d.source_paths].sort().join('|'))
      fail('R9_REREGISTER_SOURCE_PATHS_CHANGED',`${key}: source_paths differs from main's pinned set; every history map must cover the same paths, so this needs a manual decision`);
    const source_blobs=pins.producers[i].source_blobs;
    d.source_blobs=source_blobs;d.workflow_blob=source_blobs[d.workflow_path];
    if(d.workflow_blob===undefined)fail('R9_REREGISTER_SOURCE_PATHS_CHANGED',`${key}: source_paths must contain the workflow itself`);
    let versions=(b.previous_source_versions??[]).filter(v=>!same(v.source_blobs,source_blobs));
    if(!same(b.source_blobs,source_blobs)){
      const changed=Object.keys(source_blobs).filter(p=>b.source_blobs[p]!==source_blobs[p]);
      changes.push(`${key}: ${changed.length} source file(s) re-pinned`);
      if(versions.some(v=>same(v.source_blobs,b.source_blobs)))kept.push(`${key} already retains the replaced generation`);
      else{
        const r=appendRotating(versions,{job_name:b.job_name,source_blobs:b.source_blobs},caps.previous_source_versions);
        versions=r.list;for(const v of r.dropped)dropped.push({list:`${key} previous_source_versions`,job_name:v.job_name,workflow_blob:v.source_blobs[d.workflow_path]});
        changes.push(`${key} previous_source_versions: + ${b.job_name}`);
      }
    }
    d.previous_source_versions=versions;
  });

  // publisher_role has no history
  const oldP=work.publisher_role;next.publisher_role={...work.publisher_role,...pins.publisher};
  if(oldP.workflow_blob!==pins.publisher.workflow_blob||oldP.workflow_source_sha256!==pins.publisher.workflow_source_sha256)changes.push('publisher_role: workflow_blob, workflow_source_sha256 re-pinned');

  assertHistoryInvariants(next);
  return {config:next,changes,dropped,kept};
}

export const MANUAL_REVIEW=[
  'job_id, job_name, required_steps and source_paths of natural_producers and publisher_role (a renamed job or a new source file is not detected)',
  'admission_source paths, app_id and grammar; execution_source file paths',
  'scope, forward_epoch, clock, operation_coverage, minimum_clock_binding, bootstrap_clock_reader and every registration_status',
];

const git=(root,args,buffer=false)=>{const out=execFileSync('git',args,{cwd:root,maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});return buffer?out:out.toString('utf8').trim();};
const gitOk=(root,args)=>{try{execFileSync('git',args,{cwd:root,stdio:'ignore'});return true;}catch{return false;}};

function parseArgs(argv){
  const o={write:false,base:'origin/main',oldCheckout:null,root:null,help:false};
  for(let i=0;i<argv.length;i+=1){
    const a=argv[i],value=()=>{if(i+1>=argv.length||argv[i+1].startsWith('--'))fail('R9_REREGISTER_USAGE',`${a} needs a value`);return argv[++i];};
    if(a==='--write')o.write=true;else if(a==='--check')o.write=false;else if(a==='--base')o.base=value();
    else if(a==='--old-checkout')o.oldCheckout=value();else if(a==='--root')o.root=value();else if(a==='--help'||a==='-h')o.help=true;
    else fail('R9_REREGISTER_USAGE',`unknown argument ${a}`);
  }
  return o;
}

export const USAGE=`Usage: ${R9_REREGISTER_COMMAND.replace(' --write','')} [--write] [--base <ref>] [--old-checkout <sha>] [--root <dir>]
  (default)        report what is stale and exit 1; nothing is written
  --write          rewrite ${R9_REGISTRY_PATH}
  --base <ref>     the up to date main to rotate history from (default origin/main; after
                   "git fetch https://github.com/<owner>/<repo>.git main" use --base FETCH_HEAD)
  --old-checkout   the main commit that registered the generation being replaced
                   (default: the last first-parent commit of --base that touched the registry)`;

export async function main(argv,{log=console.log}={}){
  const o=parseArgs(argv);
  if(o.help){log(USAGE);return 0;}
  const root=path.resolve(o.root??git(process.cwd(),['rev-parse','--show-toplevel']));
  const baseSha=(()=>{try{return git(root,['rev-parse','--verify',`${o.base}^{commit}`]);}catch{fail('R9_REREGISTER_BASE_MISSING',`cannot resolve --base ${o.base}; fetch main first and pass --base FETCH_HEAD (or the ref you fetched)`);}})();
  if(!gitOk(root,['merge-base','--is-ancestor',baseSha,'HEAD']))fail('R9_REREGISTER_BASE_NOT_MERGED',`HEAD does not contain ${baseSha.slice(0,12)}; merge or rebase onto it first`);
  const oldCheckout=o.oldCheckout??git(root,['log','-1','--first-parent','--format=%H',baseSha,'--',R9_REGISTRY_PATH]);
  if(!SHA1.test(oldCheckout))fail('R9_REREGISTER_CHECKOUT_INVALID','could not determine the commit that registered the current generation; pass --old-checkout');
  if(!gitOk(root,['merge-base','--is-ancestor',oldCheckout,baseSha]))fail('R9_REREGISTER_CHECKOUT_INVALID',`${oldCheckout} is not on ${o.base}`);
  const atBase=p=>git(root,['show',`${baseSha}:${p}`],true);
  if(!atBase(R9_REGISTRY_PATH).equals(git(root,['show',`${oldCheckout}:${R9_REGISTRY_PATH}`],true)))fail('R9_REREGISTER_CHECKOUT_INVALID',`${oldCheckout.slice(0,12)} did not register the registry that ${o.base} holds`);
  const baseConfig=JSON.parse(atBase(R9_REGISTRY_PATH).toString('utf8'));
  if(!same(computePins(baseConfig,atBase),registeredPins(baseConfig)))fail('R9_REREGISTER_BASE_STALE',`${o.base} pins bytes that its own files do not have; fix main first`);
  const file=path.join(root,R9_REGISTRY_PATH),current=fs.readFileSync(file,'utf8'),workingConfig=JSON.parse(current);
  const result=reregister({baseConfig,workingConfig,read:p=>fs.readFileSync(path.join(root,p)),oldCheckout});
  const text=JSON.stringify(result.config,null,2)+'\n';
  if(text===current){log(`R9 registry is up to date with the files it pins (history rotated from ${baseSha.slice(0,12)}).`);return 0;}
  log(`R9 registry ${o.write?'re-registered':'is stale'} (base ${baseSha.slice(0,12)}, replaced generation registered at ${oldCheckout.slice(0,12)}):`);
  for(const c of result.changes)log('  '+c);
  for(const k of result.kept)log('  note: '+k);
  if(result.dropped.length){
    log('  DROPPED (capacity reached; observations made only by these generations stop authenticating):');
    for(const d of result.dropped)log('    '+JSON.stringify(d));
  }
  log('  Review by hand (never recomputed):');for(const m of MANUAL_REVIEW)log('    - '+m);
  if(!o.write){log(`Run: ${R9_REREGISTER_COMMAND}  (then review the diff and commit)`);return 1;}
  fs.writeFileSync(file,text);log(`wrote ${R9_REGISTRY_PATH}; review the diff, then run node --test scripts/ci/merge-admission-source-producer.test.mjs`);return 0;
}

const entry=(()=>{try{return fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url));}catch{return false;}})();
if(entry){
  try{process.exitCode=await main(process.argv.slice(2));}
  catch(error){console.error(error.message);process.exitCode=2;}
}
