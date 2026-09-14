#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const BASE_SHA='61e700ffd16dc754061676b5cca3ff76aa1ca2ba4eabf3573caac41b00d23db5';
const argv=process.argv.slice(2);
const repoIndex=argv.indexOf('--repo-root');
if(repoIndex>=0)assert.ok(fs.statSync(path.resolve(argv[repoIndex+1])).isDirectory());
const base=Buffer.from(fs.readFileSync(path.join(here,'reserve_gate.preimage.utf8.base64'),'utf8').trim(),'base64').toString('utf8');
const fragment=fs.readFileSync(path.join(here,'reserve_gate.seq102-inheritance.fragment.sql'),'utf8');
const full=fs.readFileSync(path.join(here,'reserve_gate.seq102-inheritance.full.template.sql'),'utf8');
const wrapper=fs.readFileSync(path.join(here,'reserve_gate.seq102-inheritance.cas-wrapper.template.sql'),'utf8');

const oldDeclaration="declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding; w record;\n c clued_control.execution_current; old clued_control.gate_attempts; r jsonb; g jsonb; start_time timestamptz; end_time timestamptz; seconds integer; budget clued_control.execution_events; allocation jsonb;";
const newDeclaration=oldDeclaration+"\n repoint clued_control.execution_events; correction_event clued_control.execution_events; root9_qualification_event clued_control.execution_events; inherited_budget jsonb; previous_binding jsonb; replacement_binding jsonb; correction_evidence_sha text;\n expected_p3_publication_uri constant text := '__P3_PUBLICATION_EVIDENCE_URI__'; expected_p3_publication_sha constant text := '__P3_PUBLICATION_EVIDENCE_SHA256__';\n expected_review_uri constant text := '__INDEPENDENT_REVIEW_URI__'; expected_review_sha constant text := '__INDEPENDENT_REVIEW_SHA256__'; expected_correction_evidence_sha constant text := '__CORRECTION_EVIDENCE_JSONB_SHA256__';";
const oldBlock=`allocation:=(budget.request->'body'->>'raw')::jsonb;
 if allocation->>'root_generation' is distinct from g->>'control_trust_root_generation'
 or allocation->>'profile_digest' is distinct from g->>'profile_digest' or allocation->>'controller_digest' is distinct from g->>'controller_digest'
 or allocation->>'scope_digest' is distinct from g->>'scope_digest' or allocation->>'runner_generation' is distinct from g->>'runner_generation'
 or allocation->>'credential_generation' is distinct from g->>'credential_generation' or allocation->>'session_generation' is distinct from g->>'session_generation'
 or seconds>(allocation->>'seconds')::integer or start_time<(allocation->>'not_before')::timestamptz
 or (g->>'expires_at')::timestamptz>(allocation->>'expires_at')::timestamptz
 then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;`;
const executable=fragment.slice(fragment.indexOf('previous_binding :=')).trimEnd();
const newBlock="allocation:=(budget.request->'body'->>'raw')::jsonb;\n"+executable;
const tests=[];
const test=(name,fn)=>{try{fn();tests.push({name,status:'PASS'});}catch(e){tests.push({name,status:'FAIL',error:e.message});}};

test('baseline-byte-count',()=>assert.equal(Buffer.byteLength(base),17692));
test('baseline-live-sha-pin',()=>assert.equal(sha(base),BASE_SHA));
test('baseline-self-contained-fixture-pin',()=>assert.equal(sha(base),BASE_SHA));
test('baseline-anchor-declaration-unique',()=>assert.equal(base.split(oldDeclaration).length,2));
test('baseline-anchor-block-unique',()=>assert.equal(base.split(oldBlock).length,2));
test('full-reverses-exactly-to-live',()=>assert.equal(full.replace(newDeclaration,()=>oldDeclaration).replace(newBlock,()=>oldBlock),base));
test('full-only-two-controlled-replacements',()=>assert.equal(base.replace(oldDeclaration,()=>newDeclaration).replace(oldBlock,()=>newBlock),full));
test('full-signature-pin',()=>assert.ok(full.startsWith('CREATE OR REPLACE FUNCTION clued_control.reserve_gate(p_raw text, p_sha text)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n')));
test('full-empty-search-path-pin',()=>assert.ok(full.includes(" SET search_path TO ''\n")));
test('full-timezone-pin',()=>assert.ok(full.includes(' SET "TimeZone" TO \'UTC\'\n')));
test('full-body-delimiters-pin',()=>{assert.equal((full.match(/AS \$function\$/g)||[]).length,1);assert.ok(full.endsWith('end $function$\n'));});
test('full-placeholder-counts',()=>{for(const x of ['__P3_PUBLICATION_EVIDENCE_URI__','__P3_PUBLICATION_EVIDENCE_SHA256__','__INDEPENDENT_REVIEW_URI__','__INDEPENDENT_REVIEW_SHA256__','__CORRECTION_EVIDENCE_JSONB_SHA256__'])assert.equal(full.split(x).length,2,x);});
test('full-seq102-request-keyset',()=>{assert.ok(full.includes("array['body','operation']::text[]"));assert.ok(full.includes("jsonb_object_keys(budget.request->'body')"));assert.ok(full.includes("array['raw','sha256']::text[]"));});
test('full-committed-transaction-chain',()=>{assert.ok(full.includes('correction_event.recording_transaction_id=pg_current_xact_id()'));assert.ok(full.includes('repoint.recording_transaction_id=pg_current_xact_id()'));assert.ok(full.includes('repoint.recording_transaction_id is distinct from correction_event.recording_transaction_id'));});
test('full-no-budget-refund-capacity-call',()=>assert.ok(!/reserve_execution_budget\s*\(|automatic_refund\s*[,)]\s*true|additional_allocation\s*[,)]\s*true/i.test(executable)));
test('wrapper-preimage-pin',()=>assert.ok(wrapper.includes(`before_hash is distinct from '${BASE_SHA}'`)));
test('wrapper-full-ddl-exactly-once',()=>assert.equal(wrapper.split(full).length,2));
test('wrapper-postimage-late-bound',()=>assert.equal(wrapper.split('__POST_PG_GET_FUNCTIONDEF_SHA256__').length,2));
test('wrapper-pre-catalog-token-late-bound',()=>assert.equal(wrapper.split('__PRE_CATALOG_JSONB_SHA256__').length,3));
test('wrapper-entire-catalog-except-source-pin',()=>assert.equal((wrapper.match(/to_jsonb\(p\)-'prosrc'/g)||[]).length,2));
test('wrapper-catalog-equality-pin',()=>assert.ok(wrapper.includes('after_catalog is distinct from before_catalog')));
test('wrapper-owner-and-acl-implicitly-pinned',()=>{assert.ok(wrapper.includes("to_jsonb(p)-'prosrc'"));assert.ok(wrapper.includes('aclexplode(coalesce(p.proacl'));});
test('wrapper-security-volatility-kind-config-pin',()=>{for(const x of ['not p.prosecdef',"p.provolatile<>'v'","p.prokind<>'f'",`array['search_path=""','TimeZone=UTC']::text[]`])assert.ok(wrapper.includes(x),x);});
test('wrapper-public-anon-authenticated-denied-service-role-allowed',()=>{assert.ok(wrapper.includes('a.grantee=0'));assert.equal((wrapper.match(/has_function_privilege\('anon'/g)||[]).length,2);assert.equal((wrapper.match(/has_function_privilege\('authenticated'/g)||[]).length,2);assert.equal((wrapper.match(/has_function_privilege\('service_role'/g)||[]).length,2);});
test('wrapper-one-function-replacement',()=>assert.equal((wrapper.match(/CREATE OR REPLACE FUNCTION clued_control[.]reserve_gate/g)||[]).length,1));
test('wrapper-no-transaction-control',()=>assert.ok(!/\b(begin\s*;|commit\s*;|rollback\s*;)\b/i.test(wrapper)));

const failed=tests.filter(x=>x.status==='FAIL');
const result={state:failed.length?'FAIL':'PASS',checks:tests.length,passed:tests.length-failed.length,failed,base_sha256:sha(base),fragment_sha256:sha(fragment),full_template_sha256:sha(full),cas_wrapper_template_sha256:sha(wrapper)};
console.log(JSON.stringify(result,null,2));
if(failed.length)process.exit(1);
