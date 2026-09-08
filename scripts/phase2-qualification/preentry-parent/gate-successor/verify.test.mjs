import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {dir,readBundle,validate} from './verify.mjs';
test('two independent static builds produce identical bytes and exact typed/source bindings',()=>{
 const bytes=()=>Object.keys(readBundle()).map(n=>fs.readFileSync(path.join(dir,n)));
 execFileSync(process.execPath,['build.mjs'],{cwd:dir});const first=bytes();
 execFileSync(process.execPath,['build.mjs'],{cwd:dir});assert.deepEqual(bytes(),first);
 const result=validate(readBundle());assert.equal(result.applicable_test_definitions,19);assert.equal(result.gate_registered,false);assert.equal(result.tests_executed,0);
});
test('wrong Gate type/ID, scope, limits, circular stage, post-Entry case, oracle or digest cannot pass candidate verification',()=>{
 for(const mutate of [
  b=>b['GateDefinitionCandidate.json'].gate_id='G7A',
  b=>b['RegistrySuccessorCandidate.json'].addition.object_type='TestManifest',
  b=>b['GateDefinitionCandidate.json'].purpose='CORE_SLICE_A_IMPLEMENTATION',
  b=>b['GateDefinitionCandidate.json'].execution.model_calls=1,
  b=>b['GateDefinitionCandidate.json'].prerequisites.stage_receipts.push('R14'),
  b=>b['preentry-skill-qualification.json'].tests['PQUAL-18']={},
  b=>b['preentry-skill-qualification.json'].tests['PQUAL-01'].oracle.expected='PASS without observations',
  b=>b['RegistrySuccessorCandidate.json'].addition.content_digest='sha256:'+'0'.repeat(64)
 ]){const b=readBundle();mutate(b);assert.throws(()=>validate(b));}
});
