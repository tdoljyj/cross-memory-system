// Planned scripts/ci/ source entry. Pure local validation: no secret, PG or network.
import assert from 'node:assert/strict';
export const COMPONENT_VERSION = "1.0.2";
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {platformDescriptor} from './clued-handover-external-bootstrap.mjs';
import {assertIdleSelectionPolicy,assertFixtureSelectionPolicy,assertEarlyFixtureLocators} from './clued-handover-external-journal.mjs';

export const SOURCE_FLOOR='2ed3bf2a2985858153e472481f41cef5e4fcd818';
export const REQUIRED_FILES=Object.freeze([
  'scripts/ci/clued-handover-external-driver.mjs',
  'scripts/ci/clued-handover-external-provider.mjs',
  'scripts/ci/clued-handover-external-source-check.mjs',
  'scripts/ci/clued-handover-external-catalog.mjs',
  'scripts/ci/clued-handover-external-catalog-identities.mjs',
  'scripts/ci/clued-handover-external-register.mjs',
  'scripts/ci/clued-handover-external-journal.mjs',
  'scripts/ci/clued-handover-external-gate-evidence.mjs',
  'scripts/ci/clued-handover-external-fixture-locator.mjs',
  'scripts/ci/clued-gated-proof-runtime.mjs',
  'scripts/ci/clued-handover-external-bootstrap.mjs',
  'scripts/ci/clued-handover-external-pg-transport.mjs',
  'scripts/ci/clued-handover-external-pg-transport.test.mjs',
  'scripts/ci/resources/supabase-official-prod-ca-2021.crt',
  '.github/workflows/clued-handover-external-qualification.yml',
  '.github/workflows/clued-handover-disposable-idle.yml',
  '.github/workflows/clued-work-admission.yml',
  '.github/workflows/clued-work-admission-dispatch.yml',
  '.github/workflows/clued-native617-admission-dispatch.yml',
  'config/clued-handover-external-profile.json',
  'config/clued-handover-external-catalog.json',
  'scripts/ci/clued-handover-external-source-pins.json',
  'scripts/ci/fixtures/clued-handover-operator-registration.sql',
  'apps/clued-cloud/tests/handover-external-ci.test.mjs',
  'apps/clued-cloud/package.json','apps/clued-cloud/package-lock.json',
  'apps/clued-cloud/tests/raw-binding-grants-fixture.mjs',
  'apps/clued-cloud/tests/worker-gateway-caller-fixture.mjs',
]);
// Frozen minimum from the accepted 22-path carrier and observed inherited fee/model
// files. This supplements the real immutable-tree enumeration, never substitutes
// the review diff for the complete executable subject or authorizes execution.
export const EXECUTION_FLOOR=Object.freeze([
  ".gitattributes",
  ".github/actions/ci-temporary-storage/coverage.json",
  ".github/workflows/clued-handover-disposable-idle.yml",
  ".github/workflows/clued-handover-external-qualification.yml",
  ".github/workflows/clued-merge-slot-ci.yml",
  ".github/workflows/clued-work-admission-dispatch.yml",
  "apps/clued-cloud/tests/ci-proof-profiles.test.mjs",
  "apps/clued-cloud/worker/generated/components.ts",
  "config/clued-components.json",
  "config/clued-handover-external-catalog.json",
  "config/clued-handover-external-profile.json",
  "scripts/ci/ci-usage-report.mjs",
  "scripts/ci/ci-usage-report.test.mjs",
  "scripts/ci/clued-gated-proof-profiles.json",
  "scripts/ci/clued-gated-proof-role-specs.json",
  "scripts/ci/clued-gated-proof-runtime.mjs",
  "scripts/ci/clued-gated-proof-runtime.test.mjs",
  "scripts/ci/clued-handover-external-source-pins.json",
  "scripts/ci/clued-reader-budget-cache.test.mjs",
  "scripts/ci/clued-work-admission.mjs",
  "scripts/ci/clued-work-admission.test.mjs",
  "scripts/ci/fixtures/clued-handover-operator-registration.sql",
  "scripts/ci/merge-admission-r9-collector.mjs",
  "scripts/ci/merge-admission-r9-collector.test.mjs",
  "scripts/model-program/development_clued_currentness.cjs",
  "scripts/model-program/development_completion_entry.py",
  "scripts/model-program/development_currentness_channel.py",
  "scripts/model-program/development_host_bridge.cjs",
  "scripts/model-program/development_request_host.cjs",
  "scripts/model-program/observed_completion_execution.py",
  "scripts/runner/README.md",
  "scripts/runner/clued-runner-job-started.mjs",
  "scripts/runner/clued-runner-job-started.test.mjs",
  "scripts/runner/qualify-work-handover.mjs",
  "scripts/runner/qualify-work-handover.test.mjs",
  "tests/test_development_completion_entry.py",
  "tests/test_model_development_clued_currentness.cjs",
  "tests/test_model_development_currentness_channel.py",
  "tests/test_model_development_host_bridge.cjs",
  "tests/test_model_development_request_host.cjs",
  "tests/test_model_observed_completion_execution.py"
]);
export const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function acceptedGateSourcePins(verified){
  const paths=['scripts/ci/clued-work-admission.mjs',
    'scripts/ci/clued-gated-proof-runtime.mjs',
    '.github/workflows/clued-work-admission-dispatch.yml',
    '.github/workflows/clued-handover-disposable-idle.yml',
    '.github/workflows/clued-handover-external-qualification.yml'];
  return Object.fromEntries(paths.map(file=>{const hash=verified.acceptance.files[file];
    assert.match(hash,/^[0-9a-f]{64}$/,'ACCEPTED_GATE_SOURCE_HASH_MISSING:'+file);return [file,hash];}));
}
const git=(root,args)=>execFileSync('git',args,{cwd:root,maxBuffer:32*1024*1024});
function include(file){
  return EXECUTION_FLOOR.includes(file)||REQUIRED_FILES.includes(file)||file.startsWith('scripts/')||
    file.startsWith('apps/clued-cloud/supabase/migrations/')||
    file.startsWith('.github/actions/ci-temporary-storage/')||
    file.endsWith('/.npmrc')||file==='.npmrc'||file==='.gitattributes'||file==='.gitmodules'||
    file==='package.json'||file==='package-lock.json'||
    (file.startsWith('config/')&&file.endsWith('.json')&&file!=='config/clued-handover-external-acceptance.json');
}
export function executionPaths(root,commit){
  const files=git(root,['ls-tree','-r','--name-only',commit]).toString('utf8').trim().split('\n').filter(include).sort();
  for(const required of new Set([...REQUIRED_FILES,...EXECUTION_FLOOR]))assert.ok(files.includes(required),'EXECUTABLE_MISSING:'+required);
  return files;
}
export function candidateCheck(root){
  const paths=executionPaths(root,'HEAD');
  const profile=JSON.parse(fs.readFileSync(path.join(root,'config/clued-handover-external-profile.json'),'utf8'));
  assert.equal(profile.fixture_mode,'continuous','RECOVERY_UNSUPPORTED');
  assertEarlyFixtureLocators(profile);assertFixtureSelectionPolicy(profile,{unqualified:profile.qualified===false});
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
  assertEarlyFixtureLocators(profile);
  assertIdleSelectionPolicy(profile);
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
