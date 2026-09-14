#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const fragmentPath=path.join(here,'reserve_gate.seq102-inheritance.fragment.sql');
const BASE_SHA='61e700ffd16dc754061676b5cca3ff76aa1ca2ba4eabf3573caac41b00d23db5';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const die=s=>{throw new Error(s);};
const argv=process.argv.slice(2);
const get=name=>{const i=argv.indexOf(name);return i<0?null:argv[i+1]??die(`${name} needs a value`);};
const repoRoot=get('--repo-root');
if(repoRoot)assert.ok(fs.statSync(path.resolve(repoRoot)).isDirectory(),'--repo-root must be a directory');

function liveDefinition(){
  const definition=Buffer.from(fs.readFileSync(path.join(here,'reserve_gate.preimage.utf8.base64'),'utf8').trim(),'base64').toString('utf8');
  assert.equal(Buffer.byteLength(definition),17692);
  assert.equal(sha(definition),BASE_SHA);
  return definition;
}

const declaration="declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding; w record;\n c clued_control.execution_current; old clued_control.gate_attempts; r jsonb; g jsonb; start_time timestamptz; end_time timestamptz; seconds integer; budget clued_control.execution_events; allocation jsonb;";
const declarationWithBranch=declaration+"\n repoint clued_control.execution_events; correction_event clued_control.execution_events; root9_qualification_event clued_control.execution_events; inherited_budget jsonb; previous_binding jsonb; replacement_binding jsonb; correction_evidence_sha text;\n expected_p3_publication_uri constant text := '__P3_PUBLICATION_EVIDENCE_URI__'; expected_p3_publication_sha constant text := '__P3_PUBLICATION_EVIDENCE_SHA256__';\n expected_review_uri constant text := '__INDEPENDENT_REVIEW_URI__'; expected_review_sha constant text := '__INDEPENDENT_REVIEW_SHA256__'; expected_correction_evidence_sha constant text := '__CORRECTION_EVIDENCE_JSONB_SHA256__';";
const oldBlock=`allocation:=(budget.request->'body'->>'raw')::jsonb;
 if allocation->>'root_generation' is distinct from g->>'control_trust_root_generation'
 or allocation->>'profile_digest' is distinct from g->>'profile_digest' or allocation->>'controller_digest' is distinct from g->>'controller_digest'
 or allocation->>'scope_digest' is distinct from g->>'scope_digest' or allocation->>'runner_generation' is distinct from g->>'runner_generation'
 or allocation->>'credential_generation' is distinct from g->>'credential_generation' or allocation->>'session_generation' is distinct from g->>'session_generation'
 or seconds>(allocation->>'seconds')::integer or start_time<(allocation->>'not_before')::timestamptz
 or (g->>'expires_at')::timestamptz>(allocation->>'expires_at')::timestamptz
 then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;`;

const base=liveDefinition();
assert.equal(base.split(declaration).length,2,'base declaration anchor not unique');
assert.equal(base.split(oldBlock).length,2,'base allocation block anchor not unique');
const fragment=fs.readFileSync(fragmentPath,'utf8');
const branchStart=fragment.indexOf('previous_binding :=');
assert.ok(branchStart>0,'fragment executable body missing');
const executable=fragment.slice(branchStart).trimEnd();
// Use replacement callbacks: the SQL includes regex end anchors (`$'`) that
// JavaScript String.replace would otherwise interpret as replacement tokens.
const fullTemplate=base.replace(declaration,()=>declarationWithBranch).replace(oldBlock,()=>"allocation:=(budget.request->'body'->>'raw')::jsonb;\n"+executable);
assert.notEqual(fullTemplate,base);
assert.equal(fullTemplate.endsWith('\n'),true);
fs.writeFileSync(path.join(here,'reserve_gate.seq102-inheritance.full.template.sql'),fullTemplate);

const vals={
 '__P3_PUBLICATION_EVIDENCE_URI__':get('--p3-publication-uri'),
 '__P3_PUBLICATION_EVIDENCE_SHA256__':get('--p3-publication-sha256'),
 '__INDEPENDENT_REVIEW_URI__':get('--review-uri'),
 '__INDEPENDENT_REVIEW_SHA256__':get('--review-sha256'),
 '__CORRECTION_EVIDENCE_JSONB_SHA256__':get('--correction-evidence-sha256')
};
const supplied=Object.values(vals).filter(Boolean).length;
if(supplied!==0&&supplied!==5)die('supply all five sealing values or none');
const preCatalogSha=get('--pre-catalog-sha256');
if((supplied===5)!==Boolean(preCatalogSha))die('--pre-catalog-sha256 is required exactly when sealing');
if(preCatalogSha)assert.match(preCatalogSha,/^[0-9a-f]{64}$/);

function wrapper(definition,expectedPostHash,expectedPreCatalogHash){
 return `-- Embed this DO block inside the already-authorized P3 transaction.
-- It performs no CAS and consumes no budget; it only fail-closed replaces reserve_gate.
do $reserve_gate_catalog_guard$
declare
 before_catalog jsonb; after_catalog jsonb; before_hash text; after_hash text;
begin
 select to_jsonb(p)-'prosrc', encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')
   into strict before_catalog,before_hash from pg_proc p
  where p.oid='clued_control.reserve_gate(text,text)'::regprocedure;
 if before_hash is distinct from '${BASE_SHA}' then raise exception 'reserve_gate_preimage_mismatch'; end if;
 if encode(sha256(convert_to(before_catalog::text,'UTF8')),'hex') is distinct from '${expectedPreCatalogHash}'
 then raise exception 'reserve_gate_pre_catalog_token_mismatch'; end if;
 if (select not p.prosecdef or p.provolatile<>'v' or p.prokind<>'f'
            or p.proconfig is distinct from array['search_path=""','TimeZone=UTC']::text[]
       from pg_proc p where p.oid='clued_control.reserve_gate(text,text)'::regprocedure)
 then raise exception 'reserve_gate_catalog_precondition_mismatch'; end if;
 if exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
              and a.grantee=0 and a.privilege_type='EXECUTE')
    or has_function_privilege('anon','clued_control.reserve_gate(text,text)','EXECUTE')
    or has_function_privilege('authenticated','clued_control.reserve_gate(text,text)','EXECUTE')
    or not has_function_privilege('service_role','clued_control.reserve_gate(text,text)','EXECUTE')
 then raise exception 'reserve_gate_acl_precondition_mismatch'; end if;
 execute $reserve_gate_ddl$${definition}$reserve_gate_ddl$;
 select to_jsonb(p)-'prosrc', encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')
   into strict after_catalog,after_hash from pg_proc p
  where p.oid='clued_control.reserve_gate(text,text)'::regprocedure;
 if after_catalog is distinct from before_catalog then raise exception 'reserve_gate_catalog_changed'; end if;
 if encode(sha256(convert_to(after_catalog::text,'UTF8')),'hex') is distinct from '${expectedPreCatalogHash}'
 then raise exception 'reserve_gate_post_catalog_token_mismatch'; end if;
 if after_hash is distinct from '${expectedPostHash}' then raise exception 'reserve_gate_postimage_mismatch'; end if;
 if exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            where p.oid='clued_control.reserve_gate(text,text)'::regprocedure
              and a.grantee=0 and a.privilege_type='EXECUTE')
    or has_function_privilege('anon','clued_control.reserve_gate(text,text)','EXECUTE')
    or has_function_privilege('authenticated','clued_control.reserve_gate(text,text)','EXECUTE')
    or not has_function_privilege('service_role','clued_control.reserve_gate(text,text)','EXECUTE')
 then raise exception 'reserve_gate_acl_postcondition_mismatch'; end if;
end
$reserve_gate_catalog_guard$;
`;
}

const templateHash=sha(fullTemplate);
fs.writeFileSync(path.join(here,'reserve_gate.seq102-inheritance.cas-wrapper.template.sql'),wrapper(fullTemplate,'__POST_PG_GET_FUNCTIONDEF_SHA256__','__PRE_CATALOG_JSONB_SHA256__'));
if(supplied===5){
 let sealed=fullTemplate;
 for(const [placeholder,value] of Object.entries(vals)){
   if(placeholder.endsWith('_URI__'))assert.match(value,/^https:\/\/api[.]github[.]com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[0-9a-f]{40}$/);
   else assert.match(value,/^[0-9a-f]{64}$/);
   assert.equal(sealed.split(placeholder).length,2,`${placeholder} not unique`);
   sealed=sealed.replace(placeholder,()=>value);
 }
 const postHash=sha(sealed);
 fs.writeFileSync(path.join(here,'reserve_gate.seq102-inheritance.full.sql'),sealed);
 fs.writeFileSync(path.join(here,'reserve_gate.seq102-inheritance.cas-execute.sql'),wrapper(sealed,postHash,preCatalogSha));
 fs.writeFileSync(path.join(here,'RESERVE_GATE_EXPECTED_PG_GET_FUNCTIONDEF_SHA256.txt'),postHash+'\n');
 console.log(JSON.stringify({state:'PASS',sealed:true,base_sha256:BASE_SHA,pre_catalog_sha256:preCatalogSha,full_sha256:postHash,cas_wrapper_sha256:sha(wrapper(sealed,postHash,preCatalogSha))},null,2));
}else{
 console.log(JSON.stringify({state:'PASS',sealed:false,base_sha256:BASE_SHA,full_template_sha256:templateHash,note:'post pg_get_functiondef SHA is late-bound until all five publication/review/evidence values are supplied'},null,2));
}
