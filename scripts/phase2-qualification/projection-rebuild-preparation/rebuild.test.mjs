import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {buildSnapshot,validateSnapshot,sha256,canonicalJson} from '../../../apps/clued-cloud/scripts/two-level-snapshot.mjs';

const epoch='2026-09-08T00:00:00.000Z';
function source(){
 const records=['alpha','beta'].map((id,i)=>({id:'synthetic_rebuild_'+id,record_schema_version:1,record_type:'task',lifecycle_status:'active',scope:'global',title:'Inspect '+id,content:'Synthetic offline inspection '+id,type_fields:{execution_bucket:'now'},relations:{depends_on:[],supersedes:[],related_records:[]},source_refs:[],source_unavailable_reason:'Synthetic offline fixture only; no online source receipt',authority:'observed',confidence_reason:'Synthetic fixture, not real authority',version:i+1,recorded_at:epoch,updated_at:epoch,receipt_id:null,content_hash:sha256('Synthetic offline inspection '+id)}));
 return {schema_version:1,canonical_version:'synthetic_rebuild_cv_1',source_verification:'bundle_only',views_complete:true,owner_ref:'owner_synthetic_rebuild',projects:[],records,events:[],evidence:[],referenced_receipts:[],legacy_projects:[],legacy_records:[],legacy_events:[],legacy_evidence:[],excluded_evidence_counts:{unlinked:0}};
}
async function hashes(root){
 const out={};
 async function walk(at=''){
  for(const e of await fs.readdir(path.join(root,at),{withFileTypes:true})){const relative=path.posix.join(at,e.name);if(e.isDirectory())await walk(relative);else if(e.isFile())out[relative]=sha256(await fs.readFile(path.join(root,relative)));else throw Error('Unexpected link/non-file in controlled fixture');}
 }
 await walk();return out;
}
test('actual derived-view deletion is rejected; existing builder rebuilds from independent unchanged offline source',{timeout:30000},async()=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'clued-projection-rebuild-'));
 const trace=[];const event=(action,fields={})=>trace.push({action,utc:new Date().toISOString(),...fields});
 try{
  const input=path.join(parent,'source.json'),first=path.join(parent,'first'),rebuilt=path.join(parent,'rebuilt');
  const inputBytes=Buffer.from(JSON.stringify(source(),null,2)+'\n');await fs.writeFile(input,inputBytes,{flag:'wx'});
  const sourceDigest=sha256(inputBytes),options={buildEpoch:epoch,migrationRunId:'synthetic_rebuild_fixed_run'};
  event('READ_INDEPENDENT_SOURCE',{sha256:sha256(await fs.readFile(input))});
  const one=await buildSnapshot({...options,source:JSON.parse(await fs.readFile(input,'utf8')),outputDirectory:first});
  await validateSnapshot(first);const before=await hashes(first);
  assert.equal(one.manifest.source_verification,'bundle_only');assert.equal(one.manifest.baseline_claim,'historical_offline');
  const relative='memory/global/task.md',target=path.resolve(first,relative);
  assert.equal(path.relative(first,target).replaceAll('\\','/'),relative);assert.equal((await fs.lstat(target)).isSymbolicLink(),false);
  const originalViewHash=sha256(await fs.readFile(target));assert.equal(before[relative],originalViewHash);
  event('FIRST_BUILD_VALIDATED',{snapshot_version:one.manifest.snapshot_version,file_count:Object.keys(before).length,derived_view_sha256:originalViewHash});
  await fs.unlink(target);event('ONLY_DERIVED_VIEW_REMOVED',{relative_path:relative});
  await assert.rejects(fs.access(target),e=>e.code==='ENOENT');
  await assert.rejects(validateSnapshot(first),/Manifest file inventory does not match/);event('DAMAGED_SNAPSHOT_REJECTED',{reason:'Manifest file inventory does not match the snapshot.'});
  const surviving=await hashes(first);assert.deepEqual(surviving,Object.fromEntries(Object.entries(before).filter(([k])=>k!==relative)));
  assert.equal(sha256(await fs.readFile(input)),sourceDigest);
  // The existing generator forbids overwriting an existing snapshot, even a damaged one.
  await assert.rejects(buildSnapshot({...options,source:JSON.parse(await fs.readFile(input,'utf8')),outputDirectory:first}),/output already exists/);
  const freshBytes=await fs.readFile(input);assert.equal(sha256(freshBytes),sourceDigest);
  event('REREAD_INDEPENDENT_SOURCE_FOR_FRESH_BUILD',{sha256:sha256(freshBytes)});
  const two=await buildSnapshot({...options,source:JSON.parse(freshBytes),outputDirectory:rebuilt});
  await validateSnapshot(rebuilt);const after=await hashes(rebuilt);assert.deepEqual(after,before);
  assert.equal(two.manifest.snapshot_version,one.manifest.snapshot_version);
  const objects=['alpha','beta'];
  for(const id of objects){const object=JSON.parse(await fs.readFile(path.join(rebuilt,'memory/objects/records/synthetic_rebuild_'+id+'.json'),'utf8'));assert.equal(object.data.lifecycle_status,'active');assert.equal(object.data.title,'Inspect '+id);}
  assert.equal(sha256(await fs.readFile(path.join(rebuilt,relative))),originalViewHash);
  assert.equal(sha256(await fs.readFile(input)),sourceDigest);
  // Old damaged directory stays damaged: the reconstruction is not a cache copy into it.
  await assert.rejects(fs.access(target),e=>e.code==='ENOENT');
  event('REBUILT_SNAPSHOT_FULLY_VERIFIED',{snapshot_version:two.manifest.snapshot_version,file_count:Object.keys(after).length,all_file_hashes_sha256:sha256(canonicalJson(after)),derived_view_sha256:after[relative]});
  const observation={state:'ACTUAL_LOCAL_FILESYSTEM_REBUILD_VERIFIED_OFFLINE_ONLY',source_sha256:sourceDigest,source_verification:'bundle_only',baseline_claim:'historical_offline',deleted_relative_path:relative,original_source_and_surviving_files_unchanged:true,rebuilt_all_file_hashes_equal:true,original_damaged_directory_not_restored:true,source_receipts:[],real_rebuild_receipt_issued:false,publisher_called:false,formal_pointer_touched:false,formal_slice_slots_executed:0,trace};
  if(process.env.CLUED_REBUILD_WRITE_OBSERVATION==='1')await fs.writeFile(new URL('Observation.json',import.meta.url),JSON.stringify(observation,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({state:observation.state,source_sha256:sourceDigest,trace_events:trace.length,files_verified:Object.keys(after).length,receipt_issued:false}));
 }finally{
  const target=path.resolve(parent);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-projection-rebuild-'))throw Error('Unsafe synthetic cleanup target');
  await fs.rm(target,{recursive:true,force:true});
 }
});
