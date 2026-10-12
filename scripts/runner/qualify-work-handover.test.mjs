import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {verifyWindowsProtection,verifyPosixProtection} from './qualify-work-handover.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const repository=path.resolve(directory,'../..');
const probe=path.join(directory,'qualify-work-handover.mjs');
const configuration=path.join(repository,'apps/clued-cloud/app/supabase-public-config.ts');
const execute=args=>spawnSync(process.execPath,[probe,...args,'--public-config',configuration],
  {encoding:'utf8',timeout:20000});

test('exact-source simulation preserves six verdicts and never certifies live qualification',()=>{
  const result=execute(['--candidate','--hook',path.join(directory,'clued-runner-job-started.mjs')]);
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.boundary,'source_candidate');
  assert.equal(report.protection_verified,false);
  assert.equal(report.cases.length,6);
  assert.ok(report.cases.every(x=>x.outcome==='pass'));
  for(const key of ['live_pr_qualified','live_dispatch_qualified','external_revocation_qualified','activation_authorized'])
    assert.equal(report[key],false);
});
test('Windows current protection refuses writable principals, writable runner, non-admin owner or unavailable data',()=>{
  const safe={schema:'clued.windows-hook-protection/1',runner_is_administrator:false,
    targets:Array.from({length:4},()=>({owner_is_administrator:true,runner_owns_target:false,untrusted_write_aces:0,runner_write_aces:0}))};
  assert.equal(verifyWindowsProtection(safe).verified,true);
  for(const targetIndex of [0,1,2,3]){
    for(const [field,value] of [['owner_is_administrator',false],['runner_owns_target',true],['untrusted_write_aces',1],['runner_write_aces',1]]){
      const changed=structuredClone(safe);changed.targets[targetIndex][field]=value;
      assert.throws(()=>verifyWindowsProtection(changed));
    }
  }
  assert.throws(()=>verifyWindowsProtection({...safe,runner_is_administrator:true}));
  for(const unavailable of [null,{}, {...safe,targets:[]}, {...safe,targets:[{} ,{}]}])
    assert.throws(()=>verifyWindowsProtection(unavailable));
});
test('POSIX protection refuses real or effective root and writable code or ancestors',()=>{
  const safe={runner_uid:1001,runner_euid:1001,targets:[{uid:0,mode:0o644},{uid:0,mode:0o755},{uid:0,mode:0o755},{uid:0,mode:0o755}]};
  assert.equal(verifyPosixProtection(safe).verified,true);
  for(const field of ['runner_uid','runner_euid'])
    for(const value of [0,undefined,null,-1,NaN])
      assert.throws(()=>verifyPosixProtection({...safe,[field]:value}));
  for(const targetIndex of [0,1,2,3]){
    for(const [field,value] of [['uid',1001],['mode',0o775],['mode',0o777],['mode',undefined]]){
      const changed=structuredClone(safe);changed.targets[targetIndex][field]=value;
      assert.throws(()=>verifyPosixProtection(changed));
    }
  }
});
test('an accepted repository copy cannot pretend to be the protected installed path',()=>{
  const result=execute(['--hook',path.join(directory,'clued-runner-job-started.mjs')]);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/protected installed path/);
});
test('unaccepted code is rejected before import and cannot run a supplied program',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'clued-handover-qualification-'));
  try{
    const supplied=path.join(temporary,'unaccepted.mjs');
    fs.writeFileSync(supplied,'process.stdout.write("UNSAFE_PROGRAM_EXECUTED");');
    const result=execute(['--candidate','--hook',supplied]);
    assert.notEqual(result.status,0);
    assert.equal(result.stdout.includes('UNSAFE_PROGRAM_EXECUTED'),false);
    assert.match(result.stderr,/accepted exact source/);
  }finally{
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(temporary,{recursive:true});
  }
});
