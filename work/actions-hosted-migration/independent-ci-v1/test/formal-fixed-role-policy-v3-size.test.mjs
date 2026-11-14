import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateTrackedSourceBytes} from '../worker/formal-fixed-role-policy-v3/policy.mjs';

const ROOT=fileURLToPath(new URL('../../../../',import.meta.url));
const CATALOGUE='scripts/ci/clued-gated-proof-profiles.json';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const gitBlob=bytes=>createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
const refused={code:'ACTUAL_TRACKED_SOURCE_BYTES_CHANGED'};
async function verify(path,bytes,{hash=sha(bytes),actual=gitBlob(bytes),expected=gitBlob(bytes)}={}){
  let gitReads=0;
  const result=validateTrackedSourceBytes({path,sha256:hash},bytes,async()=>{gitReads++;return actual+'\n';},expected);
  return {result,reads:()=>gitReads};
}

// The registered catalogue was above 1 MiB until nine deleted workflows left it (main 4a3e0485 is the last such
// catalogue); its exact Git object still exercises the bound, and the current catalogue passes the same check.
test('the last registered catalogue above 1 MiB and the current one pass their SHA and actual Git tree pin',async()=>{
  const LAST='2a59cc0fee3ea1d62b6e2a18dea41b835184f28f';
  const last=execFileSync('git',['cat-file','blob',LAST],{cwd:ROOT,maxBuffer:8*1024*1024});
  assert.equal(last.length,1062190);
  assert.equal(sha(last),'6b3c0b511a65a47dc83478d9d8caa3bda5e50f7804fbdaf34b6dc892b689561e');
  let gitReads=0;
  await validateTrackedSourceBytes({path:CATALOGUE,sha256:sha(last)},last,async()=>{gitReads++;return gitBlob(last)+'
';},LAST);
  assert.equal(gitReads,1);
  const bytes=await fs.readFile(new URL('../../../../'+CATALOGUE,import.meta.url));
  const expected=execFileSync('git',['rev-parse','HEAD:'+CATALOGUE],{cwd:ROOT,encoding:'utf8'}).trim();
  await validateTrackedSourceBytes({path:CATALOGUE,sha256:sha(bytes)},bytes,async()=>{
    gitReads++;
    return execFileSync('git',['hash-object','--no-filters','--',CATALOGUE],{cwd:ROOT,encoding:'utf8'});
  },expected);
  assert.equal(gitReads,2);
});

test('only the exact catalogue path allows the 2 MiB inclusive bound',async()=>{
  const atLimit=await verify(CATALOGUE,Buffer.alloc(2097152,32));
  await atLimit.result;assert.equal(atLimit.reads(),1);
  const overLimit=await verify(CATALOGUE,Buffer.alloc(2097153,32));
  await assert.rejects(overLimit.result,refused);assert.equal(overLimit.reads(),0);
  for(const path of ['scripts/ci/other.json','scripts/ci/clued-gated-proof-profiles.json.extra','other/clued-gated-proof-profiles.json']){
    const ordinary=await verify(path,Buffer.alloc(1048576,32));
    await ordinary.result;assert.equal(ordinary.reads(),1,path);
    const oversized=await verify(path,Buffer.alloc(1048577,32));
    await assert.rejects(oversized.result,refused);assert.equal(oversized.reads(),0,path);
  }
});

test('the expanded catalogue still rejects changed hashes and Git objects',async()=>{
  const bytes=Buffer.alloc(1048577,32);
  const wrongHash=await verify(CATALOGUE,bytes,{hash:'0'.repeat(64)});
  await assert.rejects(wrongHash.result,refused);assert.equal(wrongHash.reads(),0);
  const wrongObject=await verify(CATALOGUE,bytes,{actual:'0'.repeat(40)});
  await assert.rejects(wrongObject.result,refused);assert.equal(wrongObject.reads(),1);
  const missingTree=await verify(CATALOGUE,bytes,{expected:null});
  await assert.rejects(missingTree.result,refused);assert.equal(missingTree.reads(),1);
});
