// Local Source candidate only. Locator facts are read from the admitted idle,
// never supplied by an early Source profile or a PR body's self-assertion.
import assert from 'node:assert/strict';
import {assertCanonicalGateFact} from './clued-handover-external-gate-evidence.mjs';
import {assertFixtureSelectionPolicy,assertCanonicalClaimMatch,assertRuntimeFixtureLocator,fixtureClaimDomains}
  from './clued-handover-external-journal.mjs';

export function assertFixturePull(profile,pr,locator){
  const policy=assertFixtureSelectionPolicy(profile), fact=locator.canonical_gate_fact;
  assertRuntimeFixtureLocator(profile,locator);
  assert.ok(Number.isSafeInteger(pr.number)&&pr.number>0,'FIXTURE_NATIVE_PR_NUMBER_REQUIRED');
  assert.equal(String(pr.number),locator.pr_number,'FIXTURE_PR_CHANGED');
  assert.equal(pr.state,policy.pr_state);assert.equal(pr.draft,policy.draft);assert.equal(pr.auto_merge,null);
  assert.equal(pr.head?.repo?.full_name,policy.repository);assert.equal(pr.base?.repo?.full_name,policy.repository);
  assert.equal(pr.base?.ref,policy.target_branch);assert.equal(pr.head?.ref,locator.branch);
  assert.equal(pr.head?.sha,locator.head_sha,'FIXTURE_HEAD_CHANGED');
  assert.equal(typeof pr.body,'string','FIXTURE_BODY_REQUIRED');
  for(const [name,value] of [['Claim',fact.canonical_claim_id],['Scope',fact.scope]]){
    const lines=pr.body.split(/\r?\n/).filter(line=>new RegExp('^\\s*Clued-Work-'+name+'\\s*:').test(line));
    assert.deepEqual(lines,['Clued-Work-'+name+': '+value],'FIXTURE_CANONICAL_TRAILER_MISMATCH:'+name);
  }
  assert.ok(Number.isSafeInteger(pr.changed_files)&&pr.changed_files>0&&pr.changed_files<100);
  return pr;
}

export async function resolveFixtureLocator({profile,idleGateFact,mainGateFact,api}){
  const policy=assertFixtureSelectionPolicy(profile);
  assertCanonicalGateFact(profile,idleGateFact,{fresh:true});
  assertCanonicalClaimMatch(profile,idleGateFact,mainGateFact);
  assert.equal(idleGateFact.workflow,profile.fixture_idle_workflow);
  assert.match(idleGateFact.ref,/^clued-handover-disposable-[A-Za-z0-9_.-]+$/);
  const root='/repos/'+policy.repository;
  const route=root+'/pulls?state=open&head='+encodeURIComponent(policy.repository.split('/')[0]+':'+idleGateFact.ref)
    +'&base=main&per_page=100&page=1';
  const prs=await api(route);
  assert.ok(Array.isArray(prs)&&prs.length<100,'FIXTURE_PR_LIST_INCOMPLETE');
  // The API's branch filter is verified again before selecting. A branch/head
  // drift cannot be hidden by selecting a different matching row.
  assert.equal(prs.length,1,'FIXTURE_PR_NOT_UNIQUE');
  const pr=prs[0],locator={schema:'clued.fixture-locator-from-admitted-idle/1',
    pr_number:String(pr.number),head_sha:idleGateFact.head_sha,branch:idleGateFact.ref,
    canonical_gate_fact:structuredClone(idleGateFact)};
  assertFixturePull(profile,pr,locator);
  const files=await api(root+'/pulls/'+locator.pr_number+'/files?per_page=100&page=1');
  assert.ok(Array.isArray(files)&&files.length<100,'FIXTURE_PATH_LIST_INCOMPLETE');
  assert.equal(files.length,pr.changed_files,'FIXTURE_PATH_LIST_INCOMPLETE');
  assert.deepEqual(files.map(file=>file.filename).sort(),[...profile.fixture_paths].sort(),'FIXTURE_PATHS_CHANGED');
  return locator;
}

// Shared Source publication reads the real PR's Canonical trailers. At the
// existing synthetic-only PG boundary, validate that real reference first,
// then map only publication_begin to its independently fixed PG identity.
export function fixturePublicationInput(profile,fixture,input){
  const domains=fixtureClaimDomains(profile,fixture);
  assert.equal(input.action,'publication_begin','CLAIM_DOMAIN_PROJECTION_ACTION');
  assert.equal(input.claim_id,domains.canonical_claim_id,'PUBLICATION_CANONICAL_CLAIM_MISMATCH');
  assert.equal(input.scope,domains.canonical_scope,'PUBLICATION_CANONICAL_SCOPE_MISMATCH');
  assert.equal(input.pr_ref,profile.repository+'#'+profile.pr_number);
  assert.equal(input.head_sha,profile.head_sha);assert.equal(input.target_branch,profile.target_branch);
  return {...structuredClone(input),claim_id:domains.synthetic_claim_id,scope:domains.synthetic_scope};
}
