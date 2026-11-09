import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPRPaths, planPRWriteSet } from './clued-pr-write-set.mjs';

const repository='o/r',head='a'.repeat(40),base='b'.repeat(40);
const pr=(extra={})=>({number:7,state:'open',changed_files:2,head:{sha:head},base:{sha:base,ref:'main',repo:{full_name:repository}},...extra});
const files=[{filename:'src/new.py',previous_filename:'src/old.py',status:'renamed'},
  {filename:'config/clued-components.json',status:'modified'}];
const fixture=(rows=files,before=pr(),after=before)=>{let reads=0;return {repository,prNumber:7,
  readPR:async()=>structuredClone(reads++?after:before),readPage:async()=>structuredClone(rows)};};

test('real file packet retains rename sides, deletes and mechanical resources',async()=>{
  const packet=await collectPRPaths(fixture());
  assert.deepEqual(packet.paths,['config/clued-components.json','src/new.py','src/old.py']);
  assert.deepEqual(packet.files,files);
  assert.equal(packet.fileCount,2);assert.equal(packet.headSha,head);assert.equal(packet.baseSha,base);
  assert.equal(packet.complete,true);
});

test('complete pages use actual file count rather than path count after renames',async()=>{
  const rows=Array.from({length:101},(_,i)=>({filename:`files/${i}.py`,status:'removed'}));
  const pages=[];
  const packet=await collectPRPaths({...fixture([],pr({changed_files:101})),readPage:async n=>{pages.push(n);return rows.slice((n-1)*100,n*100);}});
  assert.deepEqual(pages,[1,2]);assert.equal(packet.fileCount,101);assert.equal(packet.paths.length,101);
});

test('short, duplicate, oversized or malformed file packets are rejected',async()=>{
  for(const rows of [[files[0]],[files[0],files[0]],Array(101).fill(files[0]),
    [{filename:'../outside',status:'modified'},files[0]],
    [{filename:'src/new.py',status:'renamed'},files[1]],
    [{filename:'src/a.py',status:'unknown'},files[1]]])
    await assert.rejects(collectPRPaths(fixture(rows)));
});

test('head, base, repository, target, lifecycle and count movement reject the plan',async()=>{
  for(const after of [pr({head:{sha:'c'.repeat(40)}}),pr({base:{sha:'c'.repeat(40),ref:'main',repo:{full_name:repository}}}),
    pr({base:{sha:base,ref:'other',repo:{full_name:repository}}}),
    pr({base:{sha:base,ref:'main',repo:{full_name:'other/repo'}}}),pr({state:'closed'}),pr({changed_files:3})])
    await assert.rejects(collectPRPaths(fixture(files,pr(),after)),/pr_subject_changed/);
});

test('the existing Source subject check still applies on both reads',async()=>{
  let checks=0;
  await collectPRPaths({...fixture(),subjectCheck:p=>{checks++;return p.head.sha===head;}});
  assert.equal(checks,2);
  await assert.rejects(collectPRPaths({...fixture(),subjectCheck:()=>false}),/pr_subject_changed/);
});

test('bounded pagination never guesses a truncated completion',async()=>{
  const page=Array.from({length:100},(_,i)=>({filename:`x/${i}`,status:'added'}));
  await assert.rejects(collectPRPaths({...fixture(page,pr({changed_files:101})),maxPages:1}),/pr_files_page_limit/);
});

test('read-only plan preserves other PR, edit and execution resources',async()=>{
  const packet=await collectPRPaths(fixture());
  const claim={claim_id:'claim',task_id:'task',context_key:'global',fence:2,execution_epoch:3,lease_version:4,
    write_set:['src/**','other/pr.py','execution/active.py','record:original']};
  const plan=planPRWriteSet({claim,packet,plannedTargets:['planned/edit.py']});
  assert.deepEqual(plan.write_set,['config/clued-components.json','execution/active.py','other/pr.py','planned/edit.py','record:original','src/**']);
  assert.equal(plan.requires_renewal,true);assert.equal(plan.read_only,true);
  assert.equal(Object.hasOwn(plan,'execution_authorized'),false);
  assert.equal(Object.hasOwn(plan,'lease_key'),false);
  assert.equal(claim.write_set.length,4);
});

test('covered paths do not request a renewal or silently narrow a broad claim',async()=>{
  const packet=await collectPRPaths(fixture());
  const plan=planPRWriteSet({claim:{write_set:['**']},packet});
  assert.equal(plan.requires_renewal,false);assert.deepEqual(plan.write_set,['**']);
});

test('Native tail /** covers the directory resource itself without a renewal',async()=>{
  for(const [pattern,target] of [['src/**','src'],['src*/**','src1'],['**/src*/**','a/src1']]){
    const packet=await collectPRPaths(fixture([{filename:target,status:'modified'}],pr({changed_files:1})));
    const plan=planPRWriteSet({claim:{write_set:[pattern]},packet});
    assert.equal(plan.requires_renewal,false);assert.deepEqual(plan.write_set,[pattern]);
  }
});

test('GitHub repository identity is canonical regardless of display case',async()=>{
  const packet=await collectPRPaths(fixture(files,pr({base:{sha:base,ref:'main',repo:{full_name:'O/R'}}})));
  assert.equal(packet.repository,'o/r');
});

test('unknown packet, path escapes or unrepresentable new resources never produce a guessed glob',async()=>{
  const packet=await collectPRPaths(fixture());
  for(const bad of [{...packet,complete:false},{...packet,paths:['../outside']},{...packet,paths:['file with space.py']}])
    assert.throws(()=>planPRWriteSet({claim:{write_set:['other.py']},packet:bad}));
});
