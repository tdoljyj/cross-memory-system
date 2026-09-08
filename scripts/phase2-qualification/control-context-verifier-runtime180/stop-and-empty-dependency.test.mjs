import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {checkStoppedObservation} from './grr.mjs';
import {fixedSeeds,encodeManifest} from './build-controller-manifest.mjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('original actual stopped inspect passes; wrong identity, active/untyped pid, zero and invalid finish dates reject',()=>{
 const raw=fs.readFileSync(new URL('../docker-engineering-observation/work/observation/main-after-stop.stdout',import.meta.url));
 assert.equal(raw.length,9091);
 assert.equal(sha(raw),'2481ef1f263a714083f51cfa4f213bf43f0df0a071ce54bf7de5b3c56b781f82');
 const [actual]=JSON.parse(raw),id=actual.Id;
 assert.equal(checkStoppedObservation(actual,id).state,'EXACT_STOP_FIELDS_CHECKED_NOT_AUTHORITY');
 for(const mutate of [x=>x.Id='a'.repeat(64),x=>x.State.Pid=1,x=>x.State.Pid='0',x=>x.State.Running=true,x=>x.State.Status='created',x=>x.State.FinishedAt='0001-01-01T00:00:00Z',x=>x.State.FinishedAt='2026-02-30T00:00:00Z',x=>x.State.FinishedAt='not a date',x=>x.State.FinishedAt=null]){
  const changed=structuredClone(actual);mutate(changed);assert.throws(()=>checkStoppedObservation(changed,id));
 }
});
test('actual empty urllib init is retained with its exact empty hash; empty implementation and false dependency hashes reject',()=>{
 const filename='C:/Users/Windows/AppData/Local/Programs/Python/Python312/Lib/urllib/__init__.py',bytes=fs.readFileSync(filename);
 assert.equal(bytes.length,0);
 const entries=fixedSeeds.map(path=>({path,role:'REPOSITORY_SOURCE',bytes:1,sha256:'a'.repeat(64)}));
 const dep={path:filename,role:'RUNTIME_DEPENDENCY',bytes:bytes.length,sha256:sha(bytes)};
 assert.equal(JSON.parse(encodeManifest([...entries,dep])).files.find(e=>e.path===filename).bytes,0);
 for(const mutate of [x=>x.sha256='a'.repeat(64),x=>x.role='REPOSITORY_SOURCE',x=>x.bytes=-1]){const changed=structuredClone(dep);mutate(changed);assert.throws(()=>encodeManifest([...entries,changed]));}
});
