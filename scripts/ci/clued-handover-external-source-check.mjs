// Planned scripts/ci/ source entry. Pure local validation: no secret, PG or network.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {platformDescriptor} from './clued-handover-external-bootstrap.mjs';

export const SOURCE_FLOOR='2ed3bf2a2985858153e472481f41cef5e4fcd818';
export const REQUIRED_FILES=Object.freeze([
  'scripts/ci/clued-handover-external-driver.mjs',
  'scripts/ci/clued-handover-external-provider.mjs',
  'scripts/ci/clued-handover-external-source-check.mjs',
  'scripts/ci/clued-handover-external-catalog.mjs',
  'scripts/ci/clued-handover-external-catalog-identities.mjs',
  'scripts/ci/clued-handover-external-register.mjs',
  'scripts/ci/clued-handover-external-journal.mjs',
  'scripts/ci/clued-handover-external-bootstrap.mjs',
  '.github/workflows/clued-handover-external-qualification.yml',
  '.github/workflows/clued-handover-disposable-idle.yml',
  '.github/workflows/clued-work-admission.yml',
  '.github/workflows/clued-work-admission-dispatch.yml',
  'config/clued-handover-external-profile.json',
  'config/clued-handover-external-catalog.json',
  'scripts/ci/clued-handover-external-source-pins.json',
  'scripts/ci/fixtures/clued-handover-operator-registration.sql',
  'apps/clued-cloud/package.json','apps/clued-cloud/package-lock.json',
  'apps/clued-cloud/tests/raw-binding-grants-fixture.mjs',
  'apps/clued-cloud/tests/worker-gateway-caller-fixture.mjs',
]);
export const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const git=(root,args)=>execFileSync('git',args,{cwd:root,maxBuffer:32*1024*1024});
function include(file){
  return REQUIRED_FILES.includes(file)||file.startsWith('scripts/')||
    file.startsWith('apps/clued-cloud/supabase/migrations/')||
    file.startsWith('.github/actions/ci-temporary-storage/')||
    file.endsWith('/.npmrc')||file==='.npmrc'||file==='.gitattributes'||file==='.gitmodules'||
    file==='package.json'||file==='package-lock.json'||
    (file.startsWith('config/')&&file.endsWith('.json')&&file!=='config/clued-handover-external-acceptance.json');
}
export function executionPaths(root,commit){
  const files=git(root,['ls-tree','-r','--name-only',commit]).toString('utf8').trim().split('\n').filter(include).sort();
  for(const required of REQUIRED_FILES)assert.ok(files.includes(required),'EXECUTABLE_MISSING:'+required);
  return files;
}
export function candidateCheck(root){
  const paths=executionPaths(root,'HEAD');
  const profile=JSON.parse(fs.readFileSync(path.join(root,'config/clued-handover-external-profile.json'),'utf8'));
  assert.equal(profile.fixture_mode,'continuous','RECOVERY_UNSUPPORTED');
  for(const file of paths){
    assert.ok(!fs.lstatSync(path.join(root,file)).isSymbolicLink(),'SYMLINK_EXECUTABLE:'+file);
    const actual=fs.readFileSync(path.join(root,file));
    const stored=git(root,['show','HEAD:'+file]);
    assert.ok(actual.equals(stored),'DIRTY_EXECUTABLE:'+file);
  }
  return {status:'CANDIDATE_SOURCE_ONLY',accepted:false,external_effects_started:false,
    secrets_read:false,network_calls:0,pg_calls:0,file_count:paths.length,
    source_commit:git(root,['rev-parse','HEAD']).toString('utf8').trim()};
}
export function acceptedSourceCheck(root,env=process.env){
  assert.equal(env.GITHUB_ACTIONS,'true');
  assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch');
  const event=JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
  assert.equal(env.GITHUB_REF,'refs/heads/'+event.repository.default_branch);
  assert.equal(env.GITHUB_REPOSITORY,'tdoljyj/cross-memory-system');
  const head=git(root,['rev-parse','HEAD']).toString('utf8').trim();
  assert.equal(head,env.GITHUB_SHA,'CURRENT_DEFAULT_SOURCE_REQUIRED');
  const bytes=fs.readFileSync(path.join(root,'config/clued-handover-external-acceptance.json'));
  assert.match(env.CLUED_HANDOVER_ACCEPTANCE_SHA256??'',/^[0-9a-f]{64}$/);
  assert.equal(sha(bytes),env.CLUED_HANDOVER_ACCEPTANCE_SHA256,'INDEPENDENT_ACCEPTANCE_BYTES_CHANGED');
  const accepted=JSON.parse(bytes);
  assert.equal(accepted.schema,'clued.external-qualification-independent-acceptance/1');
  assert.equal(accepted.status,'accepted');
  assert.match(accepted.independent_acceptance_receipt,/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(accepted.repository,env.GITHUB_REPOSITORY);
  assert.equal(accepted.task_id,'6176fdcc-c5b0-46c9-9769-d5e0bc0ce4f8');
  assert.match(accepted.source_commit,/^[0-9a-f]{40}$/);
  assert.ok(Date.parse(accepted.valid_until)>Date.now(),'ACCEPTANCE_EXPIRED');
  // Acceptance object is committed AFTER the separately reviewed subject.
  // It is intentionally excluded from its own executable set: no self SHA.
  git(root,['merge-base','--is-ancestor',accepted.source_commit,head]);
  git(root,['merge-base','--is-ancestor',SOURCE_FLOOR,accepted.source_commit]);
  const subject=executionPaths(root,accepted.source_commit);
  const current=executionPaths(root,head);
  assert.deepEqual(current,subject,'EXECUTABLE_SET_CHANGED');
  assert.deepEqual(Object.keys(accepted.files).sort(),subject,'ACCEPTANCE_EXECUTABLE_SET_INCOMPLETE');
  for(const file of subject){
    assert.ok(!fs.lstatSync(path.join(root,file)).isSymbolicLink(),'SYMLINK_EXECUTABLE:'+file);
    assert.match(accepted.files[file],/^[0-9a-f]{64}$/);
    const actual=fs.readFileSync(path.join(root,file));
    const approved=git(root,['show',accepted.source_commit+':'+file]);
    assert.equal(sha(approved),accepted.files[file],'ACCEPTED_SUBJECT_BYTES_MISMATCH:'+file);
    assert.ok(actual.equals(approved),'EXECUTABLE_BYTES_CHANGED:'+file);
  }
  const profileBytes=fs.readFileSync(path.join(root,'config/clued-handover-external-profile.json'));
  const profile=JSON.parse(profileBytes);
  assert.equal(profile.fixture_mode,'continuous','RECOVERY_UNSUPPORTED');
  assert.equal(sha(profileBytes),accepted.profile_sha256);
  assert.equal(profile.qualified,true);
  assert.equal(profile.runtime_authority,'exact-owner-source-approval');
  platformDescriptor(profile);
  if(profile.accepted_profile_source_commit!==undefined){
    assert.match(profile.accepted_profile_source_commit,/^[0-9a-f]{40}$/);
    assert.equal(profile.accepted_profile_source_commit,accepted.source_commit);
  }
  return {profile,acceptance:accepted,source_commit:head,accepted_source_commit:accepted.source_commit,
    acceptance_sha256:sha(bytes),profile_sha256:sha(profileBytes),execution_file_count:subject.length,
    status:'EXACT_ACCEPTED_EXECUTABLE_BYTES',secrets_read:false,external_effects_started:false};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const root=process.env.GITHUB_WORKSPACE??process.cwd();
  try{
    const result=process.argv.includes('--candidate-check')?candidateCheck(root):acceptedSourceCheck(root);
    console.log(JSON.stringify({...result,profile:undefined,acceptance:undefined}));
  }catch(error){console.error('SOURCE_VALIDATION_FAILED:'+error.name);process.exitCode=1;}
}
