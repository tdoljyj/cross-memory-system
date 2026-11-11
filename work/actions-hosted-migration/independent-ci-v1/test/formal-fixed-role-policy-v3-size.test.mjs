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

test('the real registered catalogue above 1 MiB passes its SHA and actual Git tree pin',async()=>{
  const bytes=await fs.readFile(new URL('../../../../'+CATALOGUE,import.meta.url));
  assert.equal(bytes.length,1055067);
  assert.equal(sha(bytes),'acae3e467ea30a93423fe2d6d2a5a90c38057777a2b4ec92b68553cd9405bbd2');
  const expected=execFileSync('git',['rev-parse','HEAD:'+CATALOGUE],{cwd:ROOT,encoding:'utf8'}).trim();
  let gitReads=0;
  await validateTrackedSourceBytes({path:CATALOGUE,sha256:sha(bytes)},bytes,async()=>{
    gitReads++;
    return execFileSync('git',['hash-object','--no-filters','--',CATALOGUE],{cwd:ROOT,encoding:'utf8'});
  },expected);
  assert.equal(gitReads,1);
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
