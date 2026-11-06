import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {
  R9_HISTORY_CAPS,R9_REGISTRY_PATH,R9_REREGISTER_COMMAND,appendRotating,assertHistoryInvariants,computePins,gitBlobSha,main,registeredPins,reregister,sealedWindowAgrees,
} from './merge-admission-r9-reregister.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const hex=n=>n.toString(16).repeat(40).slice(0,40);

// ---- a small synthetic registry whose every pin can be moved ----
const FILES={
  'a/script.mjs':'s','a/wf.yml':'w','a/re.yml':'r','a/policy.json':'{"p":1}',
  'scripts/ci/clued-gated-proof-profiles.json':'{"p":1}','scripts/ci/clued-gated-proof-role-specs.json':'{"r":1}',
  'p/wf.yml':'pw','p/src.mjs':'ps','pub/wf.yml':'pub',
};
const filesAt=(n)=>new Map(Object.entries(FILES).map(([k,v])=>[k,`${v}@${n}`]));
const readFrom=(files)=>(p)=>{if(!files.has(p))throw Error('ENOENT '+p);return Buffer.from(files.get(p));};
function configFor(files,extra={}){
  const read=readFrom(files),b=p=>gitBlobSha(read(p)),sha=p=>sha256(read(p));
  return {
    schema:'clued.r9-runtime-source-selection/1',repository:'o/r',scope:{project_id:'0597aa60-9b98-4da6-a4ab-63d7705b632f',queue_ref:'merge:o/r:main'},
    admission_source:{grammar:'g/1',app_id:1,script_path:'a/script.mjs',script_blob:b('a/script.mjs'),workflow_path:'a/wf.yml',workflow_blob:b('a/wf.yml'),
      reverify_workflow_path:'a/re.yml',reverify_workflow_blob:b('a/re.yml'),policy_path:'a/policy.json',policy_blob:b('a/policy.json')},
    previous_admission_sources:[],
    execution_source:{profiles_sha256:sha('scripts/ci/clued-gated-proof-profiles.json'),role_specs_sha256:sha('scripts/ci/clued-gated-proof-role-specs.json')},
    previous_execution_sources:[],
    natural_producers:[{registration_status:'registered',workflow_path:'p/wf.yml',workflow_blob:b('p/wf.yml'),job_id:'build',job_name:'build',
      source_paths:['p/wf.yml','p/src.mjs'],source_blobs:{'p/wf.yml':b('p/wf.yml'),'p/src.mjs':b('p/src.mjs')},required_steps:{Build:1},previous_source_versions:[]}],
    publisher_role:{registration_status:'registered',workflow_path:'pub/wf.yml',workflow_blob:b('pub/wf.yml'),workflow_source_sha256:sha('pub/wf.yml'),job_id:'report',job_name:'report'},
    ...extra,
  };
}

test('appendRotating keeps the newest entries and reports what it dropped', () => {
  assert.deepEqual(appendRotating([1,2],3,4),{list:[1,2,3],dropped:[]});
  assert.deepEqual(appendRotating([1,2,3,4],5,4),{list:[2,3,4,5],dropped:[1]});
  assert.deepEqual(appendRotating([1,2,3,4,5],6,4),{list:[3,4,5,6],dropped:[1,2]});
  assert.deepEqual(appendRotating([],1,4),{list:[1],dropped:[]});
});

test('sealedWindowAgrees accepts appended/rotated histories and refuses edits to the retained part', () => {
  const sealed=['a','b','c','d'];
  assert.equal(sealedWindowAgrees(sealed,['a','b','c','d']),true,'unchanged');
  assert.equal(sealedWindowAgrees(sealed,['b','c','d','e']),true,'one rotation');
  assert.equal(sealedWindowAgrees(sealed,['d','e','f','g']),true,'three rotations');
  assert.equal(sealedWindowAgrees(sealed,['e','f','g','h']),true,'all sealed entries rotated out');
  assert.equal(sealedWindowAgrees(sealed,['a','b','c','x']),false,'retained tail replaced');
  assert.equal(sealedWindowAgrees(sealed,['x','b','c','d']),false,'oldest replaced while the rest is sealed');
  assert.equal(sealedWindowAgrees(sealed,['b','c']),false,'retained entries lost');
  assert.equal(sealedWindowAgrees(sealed,['b','x','d','e']),false,'hole inside the retained part');
  assert.equal(sealedWindowAgrees(sealed,['c','d','e'],()=>false),true);
  assert.equal(sealedWindowAgrees(sealed,['a','b','d'],e=>e==='c'),true,'an entry that became current is exempt');
  assert.equal(sealedWindowAgrees(sealed,[]),true);
  assert.equal(sealedWindowAgrees([{k:1,v:2}],[{v:2,k:1}]),true,'key order is irrelevant');
});

test('re-registering the real registry against its own bytes changes nothing (formatting included)', () => {
  const file=path.join(repo,R9_REGISTRY_PATH),text=fs.readFileSync(file,'utf8'),cfg=JSON.parse(text);
  const read=(p)=>fs.readFileSync(path.join(repo,p));
  const r=reregister({baseConfig:cfg,workingConfig:cfg,read,oldCheckout:hex(15)});
  assert.deepEqual(r.changes,[]);assert.deepEqual(r.dropped,[]);
  assert.equal(JSON.stringify(r.config,null,2)+'\n',text);
  assert.deepEqual(computePins(cfg,read),registeredPins(cfg));
  assertHistoryInvariants(cfg);
});

test('a change to every pinned kind pushes one generation into each history and re-pins the current values', () => {
  const base=configFor(filesAt(0)),next=filesAt(1);
  const r=reregister({baseConfig:base,workingConfig:base,read:readFrom(next),oldCheckout:hex(1)});
  const c=r.config,b=(p)=>gitBlobSha(next.get(p));
  assert.equal(c.admission_source.script_blob,b('a/script.mjs'));
  assert.equal(c.admission_source.policy_blob,b('a/policy.json'));
  assert.deepEqual(c.previous_admission_sources,[{...base.admission_source,source_checkout_sha:hex(1),default_branch:'main'}]);
  assert.deepEqual(c.execution_source,{profiles_sha256:sha256(next.get('scripts/ci/clued-gated-proof-profiles.json')),role_specs_sha256:sha256(next.get('scripts/ci/clued-gated-proof-role-specs.json'))});
  assert.deepEqual(c.previous_execution_sources,[{source_checkout_sha:hex(1),...base.execution_source}]);
  const d=c.natural_producers[0];
  assert.equal(d.workflow_blob,b('p/wf.yml'));assert.deepEqual(d.source_blobs,{'p/wf.yml':b('p/wf.yml'),'p/src.mjs':b('p/src.mjs')});
  assert.deepEqual(d.previous_source_versions,[{job_name:'build',source_blobs:base.natural_producers[0].source_blobs}]);
  assert.equal(c.publisher_role.workflow_blob,b('pub/wf.yml'));assert.equal(c.publisher_role.workflow_source_sha256,sha256(next.get('pub/wf.yml')));
  assert.equal(r.dropped.length,0);
  // Idempotent: the result is already what the helper would write.
  const again=reregister({baseConfig:base,workingConfig:c,read:readFrom(next),oldCheckout:hex(1)});
  assert.deepEqual(again.config,c);
});

test('only the kinds that changed gain a history entry', () => {
  const base=configFor(filesAt(0)),next=filesAt(0);next.set('p/src.mjs','changed');
  const r=reregister({baseConfig:base,workingConfig:base,read:readFrom(next),oldCheckout:hex(2)});
  assert.deepEqual(r.config.previous_admission_sources,[]);assert.deepEqual(r.config.previous_execution_sources,[]);
  assert.equal(r.config.natural_producers[0].previous_source_versions.length,1);
  assert.equal(r.config.natural_producers[0].workflow_blob,base.natural_producers[0].workflow_blob);
  assert.deepEqual(r.config.admission_source,base.admission_source);
  assert.equal(r.changes.length,2);
});

test('history is bounded: the oldest generation is dropped, reported, and the result stays valid', () => {
  let cfg=configFor(filesAt(0));const dropped=[];
  for(let n=1;n<=R9_HISTORY_CAPS.previous_source_versions+3;n+=1){
    const r=reregister({baseConfig:cfg,workingConfig:cfg,read:readFrom(filesAt(n)),oldCheckout:hex(n)});
    dropped.push(...r.dropped);cfg=r.config;assertHistoryInvariants(cfg);
    assert.ok(cfg.previous_admission_sources.length<=R9_HISTORY_CAPS.previous_admission_sources);
    assert.ok(cfg.previous_execution_sources.length<=R9_HISTORY_CAPS.previous_execution_sources);
    assert.ok(cfg.natural_producers[0].previous_source_versions.length<=R9_HISTORY_CAPS.previous_source_versions);
  }
  const N=R9_HISTORY_CAPS.previous_source_versions+3;
  // The replaced generation of step n is registered at hex(n); the newest ones are kept, oldest first.
  assert.deepEqual(cfg.previous_admission_sources.map(e=>e.source_checkout_sha),Array.from({length:R9_HISTORY_CAPS.previous_admission_sources},(_,i)=>hex(N-R9_HISTORY_CAPS.previous_admission_sources+1+i)));
  assert.deepEqual(cfg.previous_execution_sources.map(e=>e.source_checkout_sha),Array.from({length:R9_HISTORY_CAPS.previous_execution_sources},(_,i)=>hex(N-R9_HISTORY_CAPS.previous_execution_sources+1+i)));
  assert.equal(cfg.natural_producers[0].previous_source_versions.length,R9_HISTORY_CAPS.previous_source_versions);
  assert.equal(cfg.admission_source.script_blob,gitBlobSha(`s@${N}`));
  assert.ok(dropped.some(d=>d.list==='previous_admission_sources'&&d.checkout===hex(1)),'the very first generation was dropped first');
  assert.ok(dropped.every(d=>typeof d.list==='string'));
});

test('going back to a retained generation removes it from the history instead of duplicating the current one', () => {
  const a=filesAt(0),b=filesAt(1);
  const first=reregister({baseConfig:configFor(a),workingConfig:configFor(a),read:readFrom(b),oldCheckout:hex(1)}).config;
  const back=reregister({baseConfig:first,workingConfig:first,read:readFrom(a),oldCheckout:hex(2)});
  assertHistoryInvariants(back.config);
  assert.deepEqual(back.config.admission_source,configFor(a).admission_source);
  assert.ok(back.config.previous_admission_sources.every(e=>e.script_blob!==back.config.admission_source.script_blob));
  assert.ok(back.config.previous_execution_sources.every(e=>e.profiles_sha256!==back.config.execution_source.profiles_sha256));
  assert.equal(back.config.previous_admission_sources.at(-1).source_checkout_sha,hex(2));
});

test('an already retained generation is not added twice', () => {
  const a=filesAt(0),b=filesAt(1),c=filesAt(2);
  const one=reregister({baseConfig:configFor(a),workingConfig:configFor(a),read:readFrom(b),oldCheckout:hex(1)}).config;
  // B was retained when A came back; moving on to C with B as base replaces B by its own successor only once.
  const two=reregister({baseConfig:one,workingConfig:one,read:readFrom(c),oldCheckout:hex(2)});
  const identities=two.config.natural_producers[0].previous_source_versions.map(v=>JSON.stringify(v.source_blobs));
  assert.equal(new Set(identities).size,identities.length);
  assertHistoryInvariants(two.config);
});

test('fields the helper does not own are kept from the working copy', () => {
  const base=configFor(filesAt(0)),work=structuredClone(base);
  work.natural_producers[0].required_steps={Build:1,Extra:1};work.publisher_role.job_name='report-renamed';work.registration_status='registered';work.scope.extra='x';
  const r=reregister({baseConfig:base,workingConfig:work,read:readFrom(filesAt(1)),oldCheckout:hex(1)});
  assert.deepEqual(r.config.natural_producers[0].required_steps,{Build:1,Extra:1});
  assert.equal(r.config.publisher_role.job_name,'report-renamed');assert.equal(r.config.scope.extra,'x');
});

test('refuses what needs a human: reused checkout, changed source paths, a new producer, a missing file, a bad checkout', () => {
  const base=configFor(filesAt(0)),read=readFrom(filesAt(1));
  const withHistory=reregister({baseConfig:base,workingConfig:base,read,oldCheckout:hex(1)}).config;
  assert.throws(()=>reregister({baseConfig:withHistory,workingConfig:withHistory,read:readFrom(filesAt(2)),oldCheckout:hex(1)}),/R9_REREGISTER_CHECKOUT_REUSED/);
  const widened=structuredClone(base);widened.natural_producers[0].source_paths.push('p/extra.mjs');widened.natural_producers[0].source_blobs['p/extra.mjs']='1'.repeat(40);
  const files=filesAt(1);files.set('p/extra.mjs','x');
  assert.throws(()=>reregister({baseConfig:base,workingConfig:widened,read:readFrom(files),oldCheckout:hex(1)}),/R9_REREGISTER_SOURCE_PATHS_CHANGED/);
  const added=structuredClone(base);added.natural_producers.push({...structuredClone(base.natural_producers[0]),job_id:'other'});
  assert.throws(()=>reregister({baseConfig:base,workingConfig:added,read,oldCheckout:hex(1)}),/R9_REREGISTER_PRODUCER_NEW/);
  const missing=filesAt(1);missing.delete('p/src.mjs');
  assert.throws(()=>reregister({baseConfig:base,workingConfig:base,read:readFrom(missing),oldCheckout:hex(1)}),/R9_REREGISTER_FILE_MISSING: p\/src\.mjs/);
  for(const bad of [undefined,'abc','g'.repeat(40),'A'.repeat(40)])assert.throws(()=>reregister({baseConfig:base,workingConfig:base,read,oldCheckout:bad}),/R9_REREGISTER_CHECKOUT_INVALID/);
  const renamed=structuredClone(base);renamed.natural_producers[0].job_name='renamed';
  assert.throws(()=>reregister({baseConfig:withHistory,workingConfig:renamed,read:readFrom(filesAt(2)),oldCheckout:hex(2)}),/R9_HISTORY_INVALID/,
    'a renamed job whose history keeps the old name is something the runtime would refuse');
});

test('history invariants match what the runtime consumers refuse', () => {
  const ok=reregister({baseConfig:configFor(filesAt(0)),workingConfig:configFor(filesAt(0)),read:readFrom(filesAt(1)),oldCheckout:hex(1)}).config;
  assertHistoryInvariants(ok);
  const mutate=(fn)=>{const c=structuredClone(ok);fn(c);return c;};
  const cases={
    'admission over capacity':c=>{c.previous_admission_sources=Array.from({length:R9_HISTORY_CAPS.previous_admission_sources+1},(_,i)=>({...c.previous_admission_sources[0],source_checkout_sha:hex(i+3)}));},
    'admission duplicate checkout':c=>{c.previous_admission_sources.push({...c.previous_admission_sources[0]});},
    'admission extra key':c=>{c.previous_admission_sources[0].source_authenticated=true;},
    'execution over capacity':c=>{c.previous_execution_sources=Array.from({length:R9_HISTORY_CAPS.previous_execution_sources+1},(_,i)=>({source_checkout_sha:hex(i+3),profiles_sha256:String(i).repeat(64),role_specs_sha256:'b'.repeat(64)}));},
    'execution equals current pair':c=>{c.previous_execution_sources[0]={...c.previous_execution_sources[0],...c.execution_source};},
    'execution duplicate pair':c=>{c.previous_execution_sources.push({...c.previous_execution_sources[0],source_checkout_sha:hex(9)});},
    'execution bad checkout':c=>{c.previous_execution_sources[0].source_checkout_sha='g'.repeat(40);},
    'versions over capacity':c=>{c.natural_producers[0].previous_source_versions=Array.from({length:R9_HISTORY_CAPS.previous_source_versions+1},(_,i)=>({job_name:'build',source_blobs:{'p/wf.yml':String(i).repeat(40),'p/src.mjs':'e'.repeat(40)}}));},
    'versions duplicate current':c=>{c.natural_producers[0].previous_source_versions.push({job_name:'build',source_blobs:{...c.natural_producers[0].source_blobs}});},
    'versions missing path':c=>{delete c.natural_producers[0].previous_source_versions[0].source_blobs['p/src.mjs'];},
    'versions unknown job name':c=>{c.natural_producers[0].previous_source_versions[0].job_name='other';},
    'versions extra field':c=>{c.natural_producers[0].previous_source_versions[0].x=1;},
    'current map mismatch':c=>{c.natural_producers[0].workflow_blob='1'.repeat(40);},
  };
  for(const [label,fn] of Object.entries(cases))assert.throws(()=>assertHistoryInvariants(mutate(fn)),/R9_HISTORY_INVALID/,label);
});

// ---- the command line, in a throw-away git repository ----
function gitIn(dir,...args){return execFileSync('git',args,{cwd:dir,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.com',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.com'}}).trim();}
function writeTree(dir,files){for(const [p,v] of files){const f=path.join(dir,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,v);}}
async function cli(dir,...args){const lines=[];const code=await main(['--root',dir,...args],{log:l=>lines.push(l)});return {code,out:lines.join('\n')};}

test('command line: reports, writes, and is idempotent against main-derived history', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r9-reregister-'));
  try{
    gitIn(dir,'init','-q','-b','main');
    const gen0=filesAt(0);writeTree(dir,gen0);
    fs.mkdirSync(path.join(dir,'scripts/ci'),{recursive:true});
    fs.writeFileSync(path.join(dir,R9_REGISTRY_PATH),JSON.stringify(configFor(gen0),null,2)+'\n');
    gitIn(dir,'add','-A');gitIn(dir,'commit','-q','-m','register generation 0');
    const registered=gitIn(dir,'rev-parse','HEAD');
    let r=await cli(dir,'--base','HEAD');assert.equal(r.code,0,r.out);assert.match(r.out,/up to date/);

    writeTree(dir,new Map([['a/script.mjs','a new admission script'],['p/src.mjs','a new source']]));
    r=await cli(dir,'--base','HEAD');
    assert.equal(r.code,1);assert.match(r.out,/is stale/);assert.match(r.out,new RegExp('replaced generation registered at '+registered.slice(0,12)));
    assert.match(r.out,/previous_admission_sources: \+/);assert.ok(r.out.includes(R9_REREGISTER_COMMAND));assert.match(r.out,/Review by hand/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,R9_REGISTRY_PATH),'utf8')).admission_source.script_blob,gitBlobSha('s@0'),'report mode writes nothing');

    r=await cli(dir,'--base','HEAD','--write');assert.equal(r.code,0,r.out);assert.match(r.out,/re-registered/);
    const written=JSON.parse(fs.readFileSync(path.join(dir,R9_REGISTRY_PATH),'utf8'));
    assert.equal(written.admission_source.script_blob,gitBlobSha('a new admission script'));
    assert.deepEqual(written.previous_admission_sources.map(e=>e.source_checkout_sha),[registered]);
    assert.equal(written.natural_producers[0].previous_source_versions.length,1);
    assert.deepEqual(written.previous_execution_sources,[],'unchanged kinds are not rotated');
    const bytes=fs.readFileSync(path.join(dir,R9_REGISTRY_PATH),'utf8');
    r=await cli(dir,'--base','HEAD');assert.equal(r.code,0,r.out);
    r=await cli(dir,'--base','HEAD','--write');assert.equal(r.code,0);assert.equal(fs.readFileSync(path.join(dir,R9_REGISTRY_PATH),'utf8'),bytes,'a second run changes nothing');

    // Several local re-pins before merging are still ONE generation from main's point of view.
    writeTree(dir,new Map([['a/script.mjs','yet another admission script']]));
    r=await cli(dir,'--base','HEAD','--write');assert.equal(r.code,0,r.out);
    const again=JSON.parse(fs.readFileSync(path.join(dir,R9_REGISTRY_PATH),'utf8'));
    assert.deepEqual(again.previous_admission_sources.map(e=>e.source_checkout_sha),[registered]);
    assert.equal(again.previous_admission_sources[0].script_blob,gitBlobSha('s@0'));

    // Errors are explicit.
    await assert.rejects(cli(dir,'--base','no-such-ref'),/R9_REREGISTER_BASE_MISSING/);
    await assert.rejects(cli(dir,'--base','HEAD','--old-checkout','nothex'),/R9_REREGISTER_CHECKOUT_INVALID/);
    await assert.rejects(cli(dir,'--bogus'),/R9_REREGISTER_USAGE/);
    await assert.rejects(cli(dir,'--base'),/R9_REREGISTER_USAGE/);

    // A main whose own files disagree with its registry cannot be rotated from.
    writeTree(dir,new Map([['a/script.mjs','changed without re-registering']]));
    gitIn(dir,'add','-A');gitIn(dir,'commit','-q','-m','stale main');
    await assert.rejects(cli(dir,'--base','HEAD'),/R9_REREGISTER_BASE_STALE|R9_REREGISTER_CHECKOUT_INVALID/);
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('command line: --help and bad arguments behave when run as a script', () => {
  const script=path.join(here,'merge-admission-r9-reregister.mjs');
  const help=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8'});
  assert.equal(help.status,0);assert.match(help.stdout,/--write/);assert.match(help.stdout,/--base/);
  const bad=spawnSync(process.execPath,[script,'--nope'],{encoding:'utf8'});
  assert.equal(bad.status,2);assert.match(bad.stderr,/R9_REREGISTER_USAGE/);
});
