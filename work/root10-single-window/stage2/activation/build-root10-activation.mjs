#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const die = m => { throw new Error(m); };
const read = p => fs.readFileSync(path.resolve(p), 'utf8');
const json = p => JSON.parse(read(p));
const q = s => String(s).replaceAll("'", "''");
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const exactKeys = (o, keys, label) => {
  const got = Object.keys(o).sort().join(',');
  const want = [...keys].sort().join(',');
  if (got !== want) die(`${label}: exact keys required; got ${got}`);
};
const ordered = value => Array.isArray(value)
  ? value.map(ordered)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]))
    : value;
const sameJson = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const canonicalDigest = value => sha(JSON.stringify(ordered(value))+'\n');
const digestFile = p => { const raw = read(p); return { raw, sha256: sha(raw) }; };
const assertHex = (v, label) => { if (!/^[0-9a-f]{64}$/.test(v || '')) die(`${label}: sha256 required`); };
const assertFunction = (sql, name) => {
  if (!new RegExp(`CREATE OR REPLACE FUNCTION\\s+clued_control\\.${name}\\s*\\(`, 'i').test(sql)) die(`${name}: wrong function source`);
  if (!/SECURITY DEFINER/i.test(sql) || !/SET search_path TO ''/i.test(sql) || !/SET "TimeZone" TO 'UTC'/i.test(sql)) die(`${name}: security metadata missing`);
  const creates = (sql.match(/CREATE OR REPLACE FUNCTION/gi) || []).length;
  const closes = (sql.match(/\$function\$/g) || []).length;
  if (creates !== 1 || closes !== 2) die(`${name}: expected one definition and one closed $function$ pair`);
};

const [materialsPath, outArg = '--stdout'] = process.argv.slice(2);
if (!materialsPath) die('usage: node build-root10-activation.mjs MATERIALS.json [--stdout|OUTDIR]');
const m = json(materialsPath);
const intent = json(m.intent_path);
const live = json(m.live_preimage_path);
const catalog = json(m.live_function_catalog_path);
const constraints = json(m.live_constraints_path);

const ROOT = 'ctr_414bd3c724264a83894b0c55cf2ab878';
const ROOT9 = 'ctrgen_308a1dfc185cff633892638581e0a34c';
const EXPECT = {
  root_sequence: 9, execution_sequence: 112, registration_sequence: 113,
  prepared_sequence: 114, qualified_sequence: 115, repoint_sequence: 116,
  budget_sequence: 117, attempts: 17, budgets_after_44: 10, forwards_after_44: 17,
};
if (intent.root_id !== ROOT || intent.predecessor_generation !== ROOT9 || intent.generation_ordinal !== 10) die('intent: root/generation predecessor mismatch');
if (intent.old_charged_seconds !== 11106 || intent.old_charged_evidence_bytes !== 2470030259 || intent.new_budget_seconds !== 600 || intent.new_budget_evidence_bytes !== 134217728) die('intent: exact old/new charge mismatch');
if (intent.cumulative_seconds_cap !== 11706 || intent.cumulative_evidence_bytes_cap !== 2604247987 || intent.cumulative_allocation_cap !== 11) die('intent: exact one-time cap mismatch');
if (intent.max_new_budgets !== 1 || intent.max_new_ga !== 1 || intent.automatic_retry || intent.successor_ga || intent.refund || intent.reset_counters || intent.budget_reassignment) die('intent: forbidden continuation semantics');

const root = digestFile(m.root10_signed_path); const ro = JSON.parse(root.raw);
const status = digestFile(m.status29_signed_path); const so = JSON.parse(status.raw);
const qual = digestFile(m.controller_qualification_path); const qo = JSON.parse(qual.raw);
const runtime = digestFile(m.runtime_acceptance_path); const ao = JSON.parse(runtime.raw);
const prep = digestFile(m.prepared_evidence_path); const po = JSON.parse(prep.raw);
const qev = digestFile(m.qualified_evidence_path); const eo = JSON.parse(qev.raw);
const contract = digestFile(m.root10_controller_contract_path); const co = JSON.parse(contract.raw);
for (const [v,n] of [[m.predecessor_root_sha256,'predecessor_root_sha256'],[m.root9_binding_sha256,'root9_binding_sha256'],[m.status_schema_sha256,'status_schema_sha256'],[m.ga6_blocked_receipt_sha256,'ga6_blocked_receipt_sha256']]) assertHex(v,n);
if (root.sha256 !== m.root10_full_sha256) die('root10 full-byte sha mismatch');
if (status.sha256 !== m.status29_full_sha256) die('status29 full-byte sha mismatch');
if (qual.sha256 !== m.controller_qualification_sha256 || runtime.sha256 !== m.runtime_acceptance_sha256) die('qualification/runtime full-byte sha mismatch');
if (ro.object_type !== 'ControlTrustRootSet' || ro.root_set_id !== ROOT || ro.control_trust_root_generation !== intent.generation_id || ro.generation_ordinal !== 10 || ro.status !== 'REGISTERED') die('root10 identity mismatch');
if (ro.predecessor?.generation_id !== ROOT9 || ro.predecessor?.sha256 !== m.predecessor_root_sha256) die('root10 predecessor mismatch');
if (Date.parse(ro.not_before) !== Date.parse(intent.not_before) || Date.parse(ro.expires_at) !== Date.parse(intent.expires_at)) die('root10 window mismatch');
if (ro.purpose!=='SKILL_COEXISTENCE_QUALIFICATION' || ro.audience!=='urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw' || Date.parse(ro.revocation?.as_of)!==Date.parse(intent.not_before) || Date.parse(ro.revocation?.expires_at)!==Date.parse(intent.expires_at)) die('root10 purpose/audience/revocation mismatch');
if (ro.scope?.project_ref !== 'uscrdifznmlvczcekqpw' || ro.scope?.repository !== 'tdoljyj/cross-memory-system' || ro.scope?.environment !== 'ISOLATED_TEST' || ro.scope?.model_budget !== 0 || ro.scope?.paid_budget !== 0) die('root10 scope mismatch');
if (ro.algorithm_config?.digest_algorithm!=='SHA-256' || ro.algorithm_config?.signature_verification!=='GITHUB_API_VERIFIED_OWNER_MERGE' || JSON.stringify(ro.algorithm_config?.signed_payload_excluded_fields)!=='["signature_binding"]') die('root10 algorithm/signing contract mismatch');
const issuers=ro.issuer_bindings;
if (!Array.isArray(issuers) || issuers.length!==3 || [...new Set(issuers.map(x=>x.purpose))].sort().join(',')!=='GATE_AUTHORIZATION,GATE_RESULT,STATUS' || issuers.some(x=>x.subject_id!=='tdoljyj'||x.signing_service!=='web-flow'||x.audience!==ro.audience||!/^https:\/\/api[.]github[.]com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/[0-9a-f]{40}$/.test(x.qualification_ref?.uri||'')||!/^[0-9a-f]{64}$/.test(x.qualification_ref?.sha256||''))) die('root10 exact three issuer bindings required');
if (!/^[0-9a-f]{64}$/.test(ro.owner_approval_ref?.sha256||'') || !/^[0-9a-f]{64}$/.test(ro.independent_acceptance_ref?.sha256||'')) die('root10 approval/independent acceptance refs missing');
if (!/^[0-9a-f]{40}$/.test(ro.signature_binding?.owner_merge_commit||'') || !/^[0-9a-f]{64}$/.test(ro.signature_binding?.signed_object_sha256||'') || !/^[0-9a-f]{64}$/.test(ro.signature_binding?.signature_evidence_ref?.sha256||'')) die('root10 owner signature absent');
const rootSigningPayload=structuredClone(ro); delete rootSigningPayload.signature_binding;
if (ro.signature_binding.signed_object_sha256!==canonicalDigest(rootSigningPayload)) die('root10 signed payload digest mismatch');
if (so.object_type !== 'StatusManifest' || so.status_manifest_id !== intent.status_manifest_id || so.generation !== intent.status_generation || so.control_trust_root_generation !== intent.generation_id || so.schema_digest !== m.status_schema_sha256 || so.issuer_purpose !== 'STATUS' || so.audience !== 'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw' || Date.parse(so.expires_at) !== Date.parse(intent.expires_at)) die('status29 scope/schema mismatch');
if (!so.signature_binding?.owner_merge_commit || !/^[0-9a-f]{40}$/.test(so.signature_binding.owner_merge_commit)) die('status29 owner signature absent');
const statusSigningPayload=structuredClone(so); delete statusSigningPayload.signature_binding;
const statusSignedPayloadSha=canonicalDigest(statusSigningPayload);
if (so.signature_binding?.signed_object_sha256!==statusSignedPayloadSha) die('status29 signed payload digest mismatch');
const statusIssuer=ro.issuer_bindings?.find(x=>x.purpose==='STATUS')?.qualification_ref;
if (!statusIssuer || !sameJson(so.issuer_ref,statusIssuer)) die('status29 issuer binding mismatch');
if (so.observations?.root_set_id!==ROOT || so.observations?.root_generation!==intent.generation_id || so.observations?.profile_digest!==intent.profile_sha256 || so.observations?.scope_digest!==intent.scope_sha256 || so.observations?.gate_digest!==intent.gate_sha256 || so.observations?.controller_digest!==m.controller_sha256) die('status29 exact observations mismatch');
if (![intent.profile_sha256,intent.scope_sha256,intent.gate_sha256,m.controller_sha256].every(x=>so.source_digests?.includes(x))) die('status29 fixed source digests missing');
if (qo.controller_digest !== m.controller_sha256 || ao.controller_digest !== m.controller_sha256) die('controller digest mismatch');
if (qo.scope_digest !== intent.scope_sha256 || ao.scope_digest !== intent.scope_sha256) die('qualification/runtime scope mismatch');
if (Date.parse(qo.not_before) !== Date.parse(intent.not_before) || Date.parse(qo.expires_at) !== Date.parse(intent.expires_at) || Date.parse(ao.not_before) !== Date.parse(intent.not_before) || Date.parse(ao.expires_at) !== Date.parse(intent.expires_at)) die('qualification/runtime window mismatch');
if (qo.state!=='ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION' || qo.independent_reviewer!=='/root' || qo.environment!=='ISOLATED_TEST' || qo.purpose!=='SKILL_COEXISTENCE_QUALIFICATION' || qo.independent_of_tested_skill!==true || qo.forbidden_stage_dependencies_excluded!==true) die('controller qualification admission mismatch');
if (ao.state!=='ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME' || ao.independent_reviewer!=='/root' || ao.accepted_subject?.root_id!==ROOT || ao.accepted_subject?.project_ref!=='uscrdifznmlvczcekqpw' || ao.accepted_subject?.gate?.gate_id!==m.gate_id || ao.accepted_subject?.gate?.definition_version!==m.gate_version || ao.accepted_subject?.gate?.content_digest!==intent.gate_sha256) die('runtime acceptance admission mismatch');
if (contract.sha256 !== m.root10_controller_contract_sha256 || co.root_id !== ROOT || co.generation_id !== intent.generation_id || co.baseline?.execution_sequence !== 112 || co.postbaseline?.budget_sequence !== 117 || co.invariants?.repair_refs !== 0 || co.baseline?.series_forward_count !== 17 || co.caps?.forwards !== 19) die('final Root10 controller contract mismatch');
const h110=co.baseline.historical_preimage110, closure=co.baseline.closure;
if (!/^[0-9a-f]{64}$/.test(co.baseline.root_events_sha256||'') || !/^[0-9a-f]{64}$/.test(h110?.execution_events_sha256||'') || !/^[0-9a-f]{64}$/.test(h110?.other_attempts_sha256||'')) die('final Root10 historical preimage digests missing');
if (!Array.isArray(h110.attempt_ids) || h110.attempt_ids.length!==17 || new Set(h110.attempt_ids).size!==17 || !h110.attempt_ids.includes(m.ga6_id) || h110.attempt_ids.some(x=>!/^ga_[A-Za-z0-9_.-]{1,128}$/.test(x))) die('exact 17 baseline attempt IDs required');
if (closure?.ga_id!==m.ga6_id || closure?.ga_sha256!==m.ga6_sha256 || closure?.budget_sequence!==102 || closure?.decision_sequence!==111 || closure?.signing_sequence!==112 || closure?.receipt_sha256!==m.ga6_blocked_receipt_sha256
 || closure?.decision_idempotency_key!=='root9_ga6_single_window_close_decision_111' || closure?.signing_idempotency_key!=='root9_ga6_single_window_close_signing_112'
 || closure?.termination_mode!=='EXPIRED_PREDISPATCH_NOT_STARTED_BLOCKED_ROOT9_SUCCESSOR_GA6' || closure?.receipt_id!=='grr_root9_exact_pair_ga6_blocked_20260915'
 || [closure?.decision_sha256,closure?.evidence_index_sha256,closure?.observation_sha256].some(x=>!/^[0-9a-f]{64}$/.test(x||''))) die('exact semantic GA6 closure contract mismatch');
const attemptIdsSql=h110.attempt_ids.map(x=>`'${q(x)}'`).join(',');
if (ro.history?.prefix_sequence !== 9 || ro.history?.prefix_digest !== co.baseline?.root_events_sha256 || ro.history?.minimum_accepted_generation !== intent.generation_id) die('root10 exact history prefix mismatch');
const nonemptyRepairRefs = o => o && typeof o === 'object' && Object.entries(o).some(([k,v]) => ((k==='required_repair_refs'||k==='repair_refs') && (!Array.isArray(v)||v.length!==0)) || nonemptyRepairRefs(v));
if (nonemptyRepairRefs(qo) || nonemptyRepairRefs(ao) || nonemptyRepairRefs(eo)) die('Root10 carries repair refs; Root9 repairs are historical only');
if (po.controller_sha256 !== m.controller_sha256 || po.qualification_sha256 !== qual.sha256) die('prepared evidence mismatch');
const fixedGa = ao.accepted_subject?.expected_ga;
const fixedGaRequired = ['gate_id','profile_ref','purpose','environment','repository_ref','artifact_refs','host_runtime_config_digest','upstream_gate_result_receipt_refs','release_risk_manifest_digest','actor_ref','subject_ref','binding_ref','scope_ref','issuer_ref','authority_source_ref','audience','issuer_purpose','schema_digest','control_trust_root_generation','allowed_read_set','allowed_write_set','forbidden_actions','credential_scope','stop_policy_digest','rollback_point_ref','evidence_sink_ref','controller_digest','candidate_skill_digest','mechanism_digest','plan_digest','fixtures_digest','stage_receipt_refs','revocation_epoch_vector','scope_digest','profile_digest','dominant_role','source_ref','controller_qualification_ref'];
if (!fixedGa || fixedGaRequired.some(k=>!Object.hasOwn(fixedGa,k))) die('runtime acceptance lacks complete fixed GA admission fields');
exactKeys(fixedGa,fixedGaRequired,'runtime accepted exact 38 fixed GA fields');
if (nonemptyRepairRefs(fixedGa)) die('fixed GA contract carries Root10 repairs');
const fixedGaRaw = JSON.stringify(fixedGa);
const lateBoundGaRequired = ['gate_authorization_id','authorization_status','status_manifest_ref','issued_at','expires_at','deadline','budget_reservation_ref','target_revision','runner_generation','credential_generation','session_generation','idempotency_key','signature'];
const allGaKeys = [...fixedGaRequired,...lateBoundGaRequired].sort();
if (allGaKeys.length!==51 || new Set(allGaKeys).size!==51) die('exact original 51-field GateAuthorization split required');
const allGaKeysSql = allGaKeys.map(k=>`'${q(k)}'`).join(',');
const late=ao.accepted_subject?.late_bound_fields;
if (!late || Object.keys(late).sort().join(',')!=='budget_reservation_ref,status_manifest_ref,target_revision'
 || late.budget_reservation_ref?.resolver!=='CURRENT_EXACT_EXECUTION_BUDGET_EVENT_V1' || late.budget_reservation_ref?.maximum_seconds!==600 || late.budget_reservation_ref?.maximum_evidence_bytes!==134217728
 || late.status_manifest_ref?.resolver!=='STORED_STATUS_FROM_EXACT_OWNER_SIGNED_PAYLOAD_V1' || late.status_manifest_ref?.signed_payload_sha256!==statusSignedPayloadSha
 || late.target_revision?.resolver!=='ACTUAL_RUNTIME_AND_SOURCE_MANIFEST_OWNER_MERGE_V1') die('runtime exact late-bound policy/status payload mismatch');

const currentReadRoot = read(m.current_read_root_sql_path);
const currentBudget = read(m.current_reserve_budget_sql_path);
const currentGate = read(m.current_reserve_gate_sql_path);
assertFunction(currentReadRoot, 'read_root'); assertFunction(currentBudget, 'reserve_execution_budget'); assertFunction(currentGate, 'reserve_gate');
if (sha(currentReadRoot) !== m.current_read_root_file_sha256 || sha(currentBudget) !== m.current_reserve_budget_file_sha256 || sha(currentGate) !== m.current_reserve_gate_file_sha256) die('current function file pin mismatch');
const catText = JSON.stringify(catalog);
for (const h of [m.current_read_root_catalog_sha256,m.current_reserve_budget_catalog_sha256,m.current_reserve_gate_catalog_sha256]) { assertHex(h,'catalog function digest'); if (!catText.includes(h)) die(`catalog does not contain ${h}`); }
const catFn = name => { const rows=catalog.filter(x=>x.proname===name); if(rows.length!==1) die(`catalog function missing/overloaded: ${name}`); return rows[0]; };
const criticalFunctions = [
 ['read_root','clued_control.read_root(text)'],['reserve_execution_budget','clued_control.reserve_execution_budget(text,text)'],
 ['reserve_gate','clued_control.reserve_gate(text,text)'],['append_status_manifest','clued_control.append_status_manifest(text,text)'],
 ['transition_successor_binding','clued_control.transition_successor_binding(jsonb)'],['effective_execution_binding','clued_control.effective_execution_binding()'],
 ['effective_execution_window','clued_control.effective_execution_window()']
].map(([name,signature])=>({name,signature,...catFn(name)}));
const functionPreflight = criticalFunctions.map(f=>`
 select encode(sha256(convert_to(pg_get_functiondef(to_regprocedure('${f.signature}')),'UTF8')),'hex') into d;
 if d is distinct from '${f.sha256}' then raise exception 'critical function changed: ${f.name}'; end if;
 if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('${f.signature}') and p.proowner='postgres'::regrole and p.prosecdef
   and p.provolatile='${f.provolatile}' and p.proconfig @> array['search_path=""','TimeZone=UTC']::text[]
   and p.proacl::text='${q(f.proacl)}')
 then raise exception 'critical function security changed: ${f.name}'; end if;`).join('');
const unchangedFunctionPostflight = criticalFunctions.filter(f=>!['read_root','reserve_execution_budget','reserve_gate'].includes(f.name)).map(f=>`
 select encode(sha256(convert_to(pg_get_functiondef(to_regprocedure('${f.signature}')),'UTF8')),'hex') into d;
 if d is distinct from '${f.sha256}' then raise exception 'unchanged critical function changed during activation: ${f.name}'; end if;
 if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('${f.signature}') and p.proowner='postgres'::regrole and p.prosecdef
   and p.provolatile='${f.provolatile}' and p.proconfig @> array['search_path=""','TimeZone=UTC']::text[] and p.proacl::text='${q(f.proacl)}')
 then raise exception 'unchanged critical function security changed during activation: ${f.name}'; end if;`).join('');

const BINDING_KEYS = ['binding_id','root_id','predecessor_generation_id','generation_id','not_before','expires_at','budget_sequence_floor','controller_sha256','qualification_sha256','profile_sha256','scope_sha256','gate_id','gate_version','gate_sha256','status_schema_sha256'];
const binding = {
  binding_id:intent.binding_id, root_id:ROOT, predecessor_generation_id:ROOT9, generation_id:intent.generation_id,
  not_before:intent.not_before, expires_at:intent.expires_at, budget_sequence_floor:EXPECT.budget_sequence,
  controller_sha256:m.controller_sha256, qualification_sha256:qual.sha256, profile_sha256:intent.profile_sha256,
  scope_sha256:intent.scope_sha256, gate_id:m.gate_id, gate_version:m.gate_version, gate_sha256:intent.gate_sha256,
  status_schema_sha256:m.status_schema_sha256,
};
exactKeys(binding,BINDING_KEYS,'binding');
const bindingRaw = JSON.stringify(binding); const bindingSha = sha(bindingRaw);
const budget = {
  controller_digest:m.controller_sha256, credential_generation:live.execution.current.credential_generation,
  environment:'ISOLATED_TEST', evidence_bytes:134217728, expires_at:intent.expires_at,
  idempotency_key:intent.budget_idempotency_key, not_before:intent.not_before, profile_digest:intent.profile_sha256,
  purpose:'SKILL_COEXISTENCE_QUALIFICATION', root_generation:intent.generation_id,
  runner_generation:live.execution.current.runner_generation, scope_digest:intent.scope_sha256,
  seconds:600, session_generation:live.execution.current.session_generation,
};
const budgetRaw = JSON.stringify(budget)+'\n'; const budgetSha = sha(budgetRaw);
const registeredEventRequest = {operation:'SUCCESSOR_BINDING_REGISTERED',body:{binding_id:intent.binding_id,binding_sha256:bindingSha,generation_id:intent.generation_id}};
const preparedEventRequest = {operation:'SUCCESSOR_BINDING_PREPARED',binding_id:intent.binding_id,evidence:po,expected_sequence:113,idempotency_key:m.activation_idempotency_key+'_prepared'};
const qualifiedEventRequest = {operation:'SUCCESSOR_BINDING_QUALIFIED',binding_id:intent.binding_id,evidence:eo,expected_sequence:114,idempotency_key:m.activation_idempotency_key+'_qualified'};

const gateFn = `CREATE OR REPLACE FUNCTION clued_control.reserve_gate(p_raw text, p_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' SET "TimeZone" TO 'UTC'
AS $function$
declare
 root constant text:='${ROOT}'; gen constant text:='${intent.generation_id}';
 b clued_control.execution_binding; w record; c clued_control.execution_current; old clued_control.gate_attempts;
 r jsonb; g jsonb; series_view jsonb; series_old jsonb;
 fixed_ga jsonb:=convert_from(decode('${b64(fixedGaRaw)}','base64'),'UTF8')::jsonb;
 fixed_root jsonb:=convert_from(decode('${b64(JSON.stringify(ro))}','base64'),'UTF8')::jsonb;
 fixed_registered_event jsonb:=convert_from(decode('${b64(JSON.stringify(registeredEventRequest))}','base64'),'UTF8')::jsonb;
 fixed_prepared_event jsonb:=convert_from(decode('${b64(JSON.stringify(preparedEventRequest))}','base64'),'UTF8')::jsonb;
 fixed_qualified_event jsonb:=convert_from(decode('${b64(JSON.stringify(qualifiedEventRequest))}','base64'),'UTF8')::jsonb;
 start_time timestamptz; end_time timestamptz; budget clued_control.execution_events; allocation jsonb;
begin
 if p_raw is null or octet_length(p_raw)>65536 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'invalid_exact_ga_bytes'; end if;
 if not (p_raw is json object with unique keys) then raise exception 'invalid_unique_ga_object'; end if;
 g:=p_raw::jsonb;
 if jsonb_typeof(g)<>'object' or coalesce(g->>'gate_authorization_id','') !~ '^ga_[A-Za-z0-9_.-]{1,128}$'
 or coalesce(g->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'invalid_ga_identity'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 select * into b from clued_control.effective_execution_binding(); select * into w from clued_control.effective_execution_window() where root_id=root;
 if b.root_id is null or c.root_id is null then raise exception 'accepted_execution_binding_missing'; end if;
 select * into old from clued_control.gate_attempts where root_id=root and idempotency_key=g->>'idempotency_key';
 if found then
  if old.ga_raw is distinct from p_raw or old.ga_sha256 is distinct from p_sha then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','attempt',to_jsonb(old),'authority_effect','NONE');
 end if;
 -- Retain the predecessor's immutable-prefix checks. Root10 adds one exact
 -- registration event; it does not rewrite any Root9 or earlier history.
 series_view:=clued_control.read_execution();
 if jsonb_typeof(series_view->'events') is distinct from 'array'
 or jsonb_typeof(series_view->'attempts') is distinct from 'array'
 or series_view->'current' is distinct from to_jsonb(c)
 or jsonb_array_length(series_view->'events')<>117
 or exists(select 1 from jsonb_array_elements(series_view->'events') with ordinality t(e,n)
      where e->>'root_id' is distinct from root or (e->>'sequence')::bigint is distinct from n)
 then raise exception 'series_complete_contiguous_history_required'; end if;
 if encode(sha256(convert_to((select jsonb_agg(e order by (e->>'sequence')::bigint)
      from jsonb_array_elements(series_view->'root'->'events') e where (e->>'sequence')::bigint<=6)::text,'UTF8')),'hex')
      is distinct from 'd34490fc17bf86e062fe28c1164193c735a49550d904e9ff2cd6b7167f766f43'
 or encode(sha256(convert_to((select jsonb_agg(e order by (e->>'sequence')::bigint)
      from jsonb_array_elements(series_view->'root'->'events') e where (e->>'sequence')::bigint<=8)::text,'UTF8')),'hex')
      is distinct from '48be880b2a66a396b388fce96e2429de9ce7394449b9cf21ff2250e299ad2e21'
 or jsonb_array_length(series_view->'root'->'events')<>10
 or not exists(select 1 from jsonb_array_elements(series_view->'root'->'events') e
      where (e->>'sequence')::bigint=9 and e->'request'->>'kind'='GENERATION_REGISTERED'
      and e->'request'->>'root_set_id'=root and e->'request'->>'expected_sequence'='8'
      and e->'request'->>'generation_id'='${ROOT9}' and e->'request'->>'predecessor_generation_id'='ctrgen_b060bc520329398936e461af6a477f94'
      and e->'request'->>'idempotency_key'='root9_successor_atomic_install_v1_root'
      and e->'request'->>'metadata_binding_sha256'='5a43eb7f5afe213c83a829599e2c69de4d58365a7b8124f3ccb335b7601654a0'
      and e->'request'->'body'->>'control_trust_root_generation'='${ROOT9}'
      and e->'request'->'body'->'predecessor'->>'generation_id'='ctrgen_b060bc520329398936e461af6a477f94'
      and e->'request'->'body'->'predecessor'->>'sha256'='cafe4ed82c21cc3fc4a9e009afe6a29017be6834f60150d81f3c77d6897dd0ce'
      and e->'request'->'body'->'history'->>'prefix_sequence'='8'
      and e->'request'->'body'->'history'->>'prefix_digest'='bf0660f3afe7de7e9506e642fdf7ecd15b61de97775b62c3a7d6e5c98f0b1a75')
 or not exists(select 1 from jsonb_array_elements(series_view->'root'->'events') e
      where (e->>'sequence')::bigint=10 and e->'request'->>'kind'='GENERATION_REGISTERED'
      and e->'request'->>'root_set_id'=root and e->'request'->>'expected_sequence'='9'
      and e->'request'->>'generation_id'=gen and e->'request'->>'predecessor_generation_id'='${ROOT9}'
      and e->'request'->>'idempotency_key'='${q(m.activation_idempotency_key)}_root'
      and e->'request'->>'metadata_binding_sha256'='${m.root9_binding_sha256}'
      and e->'request'->'body'=fixed_root
      and e->'request'->'body'->>'control_trust_root_generation'=gen
      and e->'request'->'body'->'history'->>'prefix_sequence'='9'
      and e->'request'->'body'->'history'->>'prefix_digest'='${co.baseline.root_events_sha256}')
 then raise exception 'series_full_original_root_changed'; end if;
 select jsonb_agg(e order by n) into series_old
   from jsonb_array_elements(series_view->'events') with ordinality t(e,n) where n<=44;
 if encode(sha256(convert_to(series_old::text,'UTF8')),'hex')
      is distinct from '7f28f748c5ca671b9813232aebcd131c0ba1713469d530f1548c423505951bc2'
 then raise exception 'series_original_44_events_changed'; end if;
 select jsonb_agg(a order by a->>'ga_id') into series_old
   from jsonb_array_elements(series_view->'attempts') a
  where a->>'ga_id'=any(array['ga_165dc2e72b62414a8023e726d8114f28','ga_18ce0e28e92f448c967fae1c92de7100','ga_6de636122e9c4fb782c0dc12fd223a9b','ga_87882f42d0b4460f8430d73239386c35','ga_a7a420f7de4a4037b9dcb5cd7dae796e','ga_c5041817c641487f827cc4ed5e0fc9ad']::text[]);
 if encode(sha256(convert_to(series_old::text,'UTF8')),'hex')
      is distinct from 'b5ed3460a9447b8240155129c8901a1a3ec78c6ac980ed8c4fa3e4eb0997116c'
 then raise exception 'series_original_six_attempts_changed'; end if;
 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or r->>'generation_id' is distinct from gen
 or w.is_successor is distinct from true or w.generation_id is distinct from gen or w.budget_sequence_floor is distinct from 117
 or w.not_before is distinct from '${intent.not_before}'::timestamptz or w.expires_at is distinct from '${intent.expires_at}'::timestamptz
 or b.root_id is distinct from root or b.profile_sha256 is distinct from '${intent.profile_sha256}'
 or b.controller_sha256 is distinct from '${m.controller_sha256}' or b.qualification_sha256 is distinct from '${qual.sha256}'
 or b.runtime_acceptance_sha256 is distinct from '${runtime.sha256}' or b.scope_sha256 is distinct from '${intent.scope_sha256}'
 or b.gate_id is distinct from '${q(m.gate_id)}' or b.gate_version is distinct from '${q(m.gate_version)}' or b.gate_sha256 is distinct from '${intent.gate_sha256}'
 or c.sequence is distinct from 117 or c.pending_budget_sequence is distinct from 117 or c.active_ga_id is not null
 or c.charged_seconds is distinct from 11706 or c.charged_evidence_bytes is distinct from 2604247987
 or (select count(*) from clued_control.events where root_id=root)<>10
 or (select count(*) from clued_control.execution_events where root_id=root)<>117
 or (select count(*) from clued_control.gate_attempts where root_id=root)<>17
 or (select array_agg(ga_id order by ga_id) from clued_control.gate_attempts where root_id=root) is distinct from (select array_agg(x order by x) from unnest(array[${attemptIdsSql}]::text[]) x)
 or exists(select 1 from clued_control.gate_attempts where root_id=root and phase not in ('FAIL','BLOCKED','STALE'))
 or exists(select 1 from clued_control.gate_attempts where root_id=root and ga->>'control_trust_root_generation'=gen)
 or (select count(*) from clued_control.execution_events where root_id=root and request->>'operation'='BUDGET_RESERVED')<>17
 or (select count(*) from clued_control.execution_events where root_id=root and sequence>44 and request->>'operation'='BUDGET_RESERVED')<>11
 or (select count(*) from clued_control.execution_events where root_id=root and sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED')<>17
 or (select count(*) from (
      select distinct a.budget_sequence from clued_control.gate_attempts a where a.root_id=root and a.budget_sequence>44
      union
      select distinct (e.request->'body'->>'budget_sequence')::bigint from clued_control.execution_events e
       where e.root_id=root and e.request->>'operation' in ('BUDGET_OWNER_FORFEITED_UNCONSUMED','BUDGET_EXPIRED_UNCONSUMED')) accounted)<>10
 or not exists(select 1 from clued_control.execution_events e where e.root_id=root and e.request->>'operation' in ('BUDGET_OWNER_FORFEITED_UNCONSUMED','BUDGET_EXPIRED_UNCONSUMED')
      and e.request->'body'->>'budget_sequence'='91' and e.request->'body'->'attempt_created'='false'::jsonb)
 or not exists(select 1 from clued_control.execution_events e where e.root_id=root and e.sequence=111
      and e.idempotency_key='${q(closure.decision_idempotency_key)}'
      and (select array_agg(k order by k) from jsonb_object_keys(e.request) k)=array['body','expected_sequence','ga_id','idempotency_key','operation']::text[]
      and e.request->>'operation'='DECISION_RESERVED' and e.request->>'ga_id'='${q(m.ga6_id)}'
      and e.request->>'idempotency_key'='${q(closure.decision_idempotency_key)}' and e.request->'expected_sequence'='110'::jsonb
      and (select array_agg(k order by k) from jsonb_object_keys(e.request->'body') k)=array['decision_raw','decision_sha256','evidence_index_raw','evidence_index_sha256','not_started_evidence_raw','not_started_evidence_ref','result','termination_mode']::text[]
      and e.request->'body'->>'result'='BLOCKED' and e.request->'body'->>'termination_mode'='${q(closure.termination_mode)}'
      and e.request->'body'->>'decision_sha256'='${closure.decision_sha256}'
      and encode(sha256(convert_to(e.request->'body'->>'decision_raw','UTF8')),'hex')='${closure.decision_sha256}'
      and e.request->'body'->>'evidence_index_sha256'='${closure.evidence_index_sha256}'
      and encode(sha256(convert_to(e.request->'body'->>'evidence_index_raw','UTF8')),'hex')='${closure.evidence_index_sha256}'
      and encode(sha256(convert_to(e.request->'body'->>'not_started_evidence_raw','UTF8')),'hex')='${closure.observation_sha256}'
      and e.request->'body'->'not_started_evidence_ref'=jsonb_build_object('uri','urn:clued:execution-evidence:${ROOT}:${closure.observation_sha256}','sha256','${closure.observation_sha256}'))
 or not exists(select 1 from clued_control.execution_events e where e.root_id=root and e.sequence=112
      and e.idempotency_key='${q(closure.signing_idempotency_key)}'
      and (select array_agg(k order by k) from jsonb_object_keys(e.request) k)=array['body','expected_sequence','ga_id','idempotency_key','operation']::text[]
      and e.request->>'operation'='SIGNING' and e.request->>'ga_id'='${q(m.ga6_id)}'
      and e.request->>'idempotency_key'='${q(closure.signing_idempotency_key)}' and e.request->'expected_sequence'='111'::jsonb
      and e.request->'body'=jsonb_build_object('decision_sha256','${closure.decision_sha256}'))
 or not exists(select 1 from clued_control.execution_events where root_id=root and sequence=113
      and idempotency_key='${q(m.activation_idempotency_key)}_registered' and request=fixed_registered_event)
 or not exists(select 1 from clued_control.execution_events where root_id=root and sequence=114
      and idempotency_key='${q(m.activation_idempotency_key)}_prepared' and request=fixed_prepared_event)
 or not exists(select 1 from clued_control.execution_events where root_id=root and sequence=115
      and idempotency_key='${q(m.activation_idempotency_key)}_qualified' and request=fixed_qualified_event)
 or not exists(select 1 from clued_control.execution_events e where e.root_id=root and e.sequence=116
      and e.idempotency_key='${q(m.activation_idempotency_key)}_activated'
      and e.request->>'operation'='EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED'
      and e.request->'body'->>'binding_id'='${intent.binding_id}'
      and e.request->'body'->>'new_runtime_acceptance_sha256'='${runtime.sha256}'
      and e.request->'body'->>'acceptance_sha256'='${runtime.sha256}'
      and encode(sha256(convert_to(e.request->'body'->>'acceptance_raw','UTF8')),'hex')='${runtime.sha256}'
      and e.request->'body'->'qualified_evidence'=fixed_qualified_event->'evidence'
      and e.request->'body'->>'previous_binding_sha256'=encode(sha256(convert_to((e.request->'body'->'previous_binding')::text,'UTF8')),'hex')
      and e.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((e.request->'body'->'new_binding')::text,'UTF8')),'hex'))
 or not exists(select 1 from clued_control.execution_events where root_id=root and sequence=117 and request->>'operation'='BUDGET_RESERVED')
 or exists(select 1 from clued_control.execution_events e where e.root_id=root and e.request->>'operation'='BUDGET_RESERVED' and (
      e.request->'body'->>'raw' is null or e.request->'body'->>'sha256' is distinct from encode(sha256(convert_to(e.request->'body'->>'raw','UTF8')),'hex')
      or not (e.request->'body'->>'raw' is json object with unique keys)
      or (e.request->'body'->>'raw')::jsonb->'seconds' is distinct from '600'::jsonb
      or (e.request->'body'->>'raw')::jsonb->'evidence_bytes' is distinct from '134217728'::jsonb
      or (e.request->'body'->>'raw')::jsonb->>'environment' is distinct from 'ISOLATED_TEST'
      or (e.request->'body'->>'raw')::jsonb->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
      or (e.sequence>=117 and ((e.request->'body'->>'raw')::jsonb->>'root_generation' is distinct from gen
           or ((e.request->'body'->>'raw')::jsonb->>'expires_at')::timestamptz is distinct from w.expires_at))
      or (e.sequence>=98 and e.sequence<117 and ((e.request->'body'->>'raw')::jsonb->>'root_generation' is distinct from '${ROOT9}'
           or ((e.request->'body'->>'raw')::jsonb->>'expires_at')::timestamptz is distinct from '2026-09-15T03:00:00Z'::timestamptz))
      or (e.sequence>=89 and e.sequence<98 and ((e.request->'body'->>'raw')::jsonb->>'root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198'
           or ((e.request->'body'->>'raw')::jsonb->>'expires_at')::timestamptz is distinct from '2026-09-14T05:45:14Z'::timestamptz))
      or (e.sequence>=64 and e.sequence<89 and ((e.request->'body'->>'raw')::jsonb->>'root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96'
           or ((e.request->'body'->>'raw')::jsonb->>'expires_at')::timestamptz is distinct from '2026-09-11T10:21:05Z'::timestamptz))
      or (e.sequence>=59 and e.sequence<64 and ((e.request->'body'->>'raw')::jsonb->>'root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
           or ((e.request->'body'->>'raw')::jsonb->>'expires_at')::timestamptz is distinct from '2026-09-11T10:21:05Z'::timestamptz))
      or (e.sequence>44 and e.sequence<59 and ((e.request->'body'->>'raw')::jsonb->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
           or ((e.request->'body'->>'raw')::jsonb->>'expires_at')::timestamptz is distinct from '2026-09-10T10:13:16Z'::timestamptz))))
 or exists(select 1 from clued_control.gate_attempts a where a.root_id=root and (
      a.ga_raw is null or a.ga_sha256 is distinct from encode(sha256(convert_to(a.ga_raw,'UTF8')),'hex') or a.ga is distinct from a.ga_raw::jsonb
      or a.receipt_raw is null or a.receipt_sha256 is distinct from encode(sha256(convert_to(a.receipt_raw,'UTF8')),'hex')
      or a.receipt_raw::jsonb->>'result' is distinct from a.phase or a.receipt_raw::jsonb->>'gate_authorization_id' is distinct from a.ga_id
      or a.receipt_raw::jsonb->>'gate_authorization_sha256' is distinct from a.ga_sha256
      or a.ga->>'gate_authorization_id' is distinct from a.ga_id
      or a.ga->>'issued_at' is null or a.ga->>'deadline' is null
      or (a.ga->>'deadline')::timestamptz-(a.ga->>'issued_at')::timestamptz>interval '600 seconds'
      or (a.budget_sequence>=98 and a.budget_sequence<117 and (a.ga->>'control_trust_root_generation' is distinct from '${ROOT9}'
           or a.receipt_raw::jsonb->>'control_trust_root_generation' is distinct from '${ROOT9}'
           or (a.ga->>'deadline')::timestamptz>'2026-09-15T03:00:00Z'::timestamptz))
      or (a.budget_sequence>=89 and a.budget_sequence<98 and (a.ga->>'control_trust_root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198'
           or a.receipt_raw::jsonb->>'control_trust_root_generation' is distinct from 'ctrgen_26769cc7109ced40bc4016b2af678198'
           or (a.ga->>'deadline')::timestamptz>'2026-09-14T05:45:14Z'::timestamptz))
      or (a.budget_sequence>=64 and a.budget_sequence<89 and (a.ga->>'control_trust_root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96'
           or a.receipt_raw::jsonb->>'control_trust_root_generation' is distinct from 'ctrgen_e5df432221344996afc04b5638121d96'
           or (a.ga->>'deadline')::timestamptz>'2026-09-11T10:21:05Z'::timestamptz))
      or (a.budget_sequence>=59 and a.budget_sequence<64 and (a.ga->>'control_trust_root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
           or a.receipt_raw::jsonb->>'control_trust_root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
           or (a.ga->>'deadline')::timestamptz>'2026-09-11T10:21:05Z'::timestamptz))
      or (a.budget_sequence>=44 and a.budget_sequence<59 and (a.ga->>'control_trust_root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
           or a.receipt_raw::jsonb->>'control_trust_root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
           or (a.ga->>'deadline')::timestamptz>'2026-09-10T10:13:16Z'::timestamptz))
      or not exists(select 1 from clued_control.execution_events e where e.root_id=root and e.sequence=a.budget_sequence and e.request->>'operation'='BUDGET_RESERVED')
      or (a.budget_sequence<>102 and (select count(*) from clued_control.gate_attempts x where x.root_id=root and x.budget_sequence=a.budget_sequence)<>1)))
 or (select count(*) from clued_control.gate_attempts where root_id=root and budget_sequence=102)<>3
 or not exists(select 1 from clued_control.gate_attempts where root_id=root and ga_id='${q(m.ga6_id)}' and ga_sha256='${m.ga6_sha256}'
      and phase='BLOCKED' and budget_sequence=102 and sequence=2 and container_id is null and not revoked
      and receipt_id='${q(closure.receipt_id)}' and receipt_sha256='${m.ga6_blocked_receipt_sha256}'
      and receipt_sha256=encode(sha256(convert_to(receipt_raw,'UTF8')),'hex')
      and decision->>'decision_sha256'='${closure.decision_sha256}' and decision->>'evidence_index_sha256'='${closure.evidence_index_sha256}')
 then raise exception 'root10_exact_single_ga_preimage_required'; end if;
 if g->>'control_trust_root_generation' is distinct from gen or g->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
 or g->>'environment' is distinct from 'ISOLATED_TEST' or g->>'authorization_status' is distinct from 'AUTHORIZED'
 or g->>'profile_digest' is distinct from b.profile_sha256 or g->>'controller_digest' is distinct from b.controller_sha256
 or g->>'scope_digest' is distinct from b.scope_sha256 or g->>'gate_id' is distinct from b.gate_id
 or g->'gate_definition_ref'->>'definition_version' is distinct from b.gate_version
 or g->'gate_definition_ref'->>'content_digest' is distinct from b.gate_sha256
 or g->'controller_qualification_ref'->>'sha256' is distinct from b.qualification_sha256
 or g->>'runner_generation' is distinct from c.runner_generation or g->>'credential_generation' is distinct from c.credential_generation
 or g->>'session_generation' is distinct from c.session_generation
 or exists(select 1 from jsonb_path_query(g,'strict $.**.repair_refs') x where jsonb_typeof(x)<>'array' or x<>'[]'::jsonb)
 or exists(select 1 from jsonb_path_query(g,'strict $.**.required_repair_refs') x where jsonb_typeof(x)<>'array' or x<>'[]'::jsonb)
 then raise exception 'root10_exact_accepted_scope_or_zero_repairs_required'; end if;
 -- The trusted host performs full accepted JSON Schema and Owner/issuer
 -- cryptographic verification before this call. SQL independently pins every
 -- non-late-bound GateAdmission field accepted by that same RuntimeAcceptance.
 if (select array_agg(k order by k) from jsonb_object_keys(g) k) is distinct from array[${allGaKeysSql}]::text[]
 or exists(select 1 from jsonb_each(fixed_ga) f where g->f.key is distinct from f.value)
 or coalesce(g->>'target_revision','') !~ '^[0-9a-f]{40}$'
 or jsonb_typeof(g->'signature') is distinct from 'string' or coalesce(g->>'signature','')=''
 or jsonb_typeof(g->'budget_reservation_ref') is distinct from 'object'
 or jsonb_typeof(g->'status_manifest_ref') is distinct from 'object'
 then raise exception 'root10_complete_fixed_and_late_bound_ga_contract_required'; end if;
 if not exists(select 1 from clued_control.control_objects co where co.root_id=root and co.uri=g->'status_manifest_ref'->>'uri' and co.sha256=g->'status_manifest_ref'->>'sha256' and co.generation=29)
 then raise exception 'exact_stored_status29_required'; end if;
 start_time:=(g->>'issued_at')::timestamptz; end_time:=(g->>'deadline')::timestamptz;
 if start_time is null or end_time is null or (g->>'expires_at') is null or start_time>clock_timestamp() or start_time<w.not_before
 or end_time is distinct from (g->>'expires_at')::timestamptz or end_time<=clock_timestamp() or end_time>w.expires_at
 or end_time-start_time is distinct from interval '600 seconds' then raise exception 'root10_exact_600_second_ga_window_required'; end if;
 select * into budget from clued_control.execution_events where root_id=root and sequence=117;
 if not found or budget.recording_transaction_id=pg_current_xact_id() or budget.idempotency_key is distinct from '${q(intent.budget_idempotency_key)}'
 or budget.request is distinct from jsonb_build_object('operation','BUDGET_RESERVED','body',jsonb_build_object('raw','${q(budgetRaw)}','sha256','${budgetSha}'))
 or g->'budget_reservation_ref' is distinct from jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:117','sha256','${budgetSha}')
 then raise exception 'root10_exact_prior_committed_budget117_required'; end if;
 allocation:=(budget.request->'body'->>'raw')::jsonb;
 if allocation is distinct from '${q(budgetRaw)}'::jsonb or allocation->>'root_generation' is distinct from gen
 or allocation->>'profile_digest' is distinct from g->>'profile_digest' or allocation->>'controller_digest' is distinct from g->>'controller_digest'
 or allocation->>'scope_digest' is distinct from g->>'scope_digest' or allocation->>'runner_generation' is distinct from g->>'runner_generation'
 or allocation->>'credential_generation' is distinct from g->>'credential_generation' or allocation->>'session_generation' is distinct from g->>'session_generation'
 or start_time<(allocation->>'not_before')::timestamptz or end_time>(allocation->>'expires_at')::timestamptz
 then raise exception 'root10_budget_consumption_binding_mismatch'; end if;
 insert into clued_control.gate_attempts(root_id,ga_id,idempotency_key,ga_raw,ga_sha256,ga,phase,expires_at,budget_sequence)
 values(root,g->>'gate_authorization_id',g->>'idempotency_key',p_raw,p_sha,g,'PENDING',end_time,117);
 update clued_control.execution_current set active_ga_id=g->>'gate_authorization_id',pending_budget_sequence=null
 where root_id=root and sequence=117 and active_ga_id is null and pending_budget_sequence=117 and charged_seconds=11706 and charged_evidence_bytes=2604247987;
 if not found then raise exception 'root10_one_ga_final_cas'; end if;
 return jsonb_build_object('status','RESERVED','ga_id',g->>'gate_authorization_id','authority_effect','NONE');
end $function$
`;
assertFunction(gateFn,'reserve_gate');

const root9MetaCase = "case when x.generation_id='ctrgen_308a1dfc185cff633892638581e0a34c'\n   then x.successor_binding_sha256 else";
if ((currentReadRoot.split(root9MetaCase).length - 1) !== 1) die('read_root metadata anchor count != 1');
let nextReadRoot = currentReadRoot.replace(root9MetaCase, () => `case when x.generation_id in ('${ROOT9}','${intent.generation_id}')\n   then x.successor_binding_sha256 else`);
const stateAnchor = ` 'state',case\n   when x.generation_id='${ROOT9}'`;
if ((nextReadRoot.split(stateAnchor).length - 1) !== 1) die('read_root state anchor count != 1');
const root10Branch = ` 'state',case\n   when x.generation_id='${intent.generation_id}'\n        and x.sequence=10\n        and x.successor_binding_id='${intent.binding_id}'\n        and x.successor_registration_sequence=${EXPECT.registration_sequence}\n        and x.successor_not_before='${intent.not_before}'::timestamptz\n        and x.successor_expires_at='${intent.expires_at}'::timestamptz\n        and x.generation_body->>'control_trust_root_generation'='${intent.generation_id}'\n        and (x.generation_body->>'not_before')::timestamptz='${intent.not_before}'::timestamptz\n        and (x.generation_body->>'expires_at')::timestamptz='${intent.expires_at}'::timestamptz then\n     case when statement_timestamp()<'${intent.not_before}'::timestamptz or statement_timestamp()>='${intent.expires_at}'::timestamptz\n          then 'EXPIRED_OR_NOT_YET_VALID' when coalesce(x.revoked,false) then 'REVOKED' else 'STORED_NO_GATE_AUTHORITY' end\n   when x.generation_id='${intent.generation_id}' then 'EXPIRED_OR_NOT_YET_VALID'\n   when x.generation_id='${ROOT9}'`;
nextReadRoot = nextReadRoot.replace(stateAnchor, () => root10Branch);
assertFunction(nextReadRoot,'read_root');

const budgetFn = `CREATE OR REPLACE FUNCTION clued_control.reserve_execution_budget(p_raw text, p_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' SET "TimeZone" TO 'UTC'
AS $function$
declare
 root constant text:='${ROOT}'; v jsonb; c clued_control.execution_current; b clued_control.execution_binding; w record;
 previous clued_control.execution_events; next_sequence bigint; ref jsonb; r jsonb;
begin
 if p_raw is null or p_raw is distinct from '${q(budgetRaw)}' or p_sha is distinct from '${budgetSha}'
 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') or not(p_raw is json object with unique keys)
 then raise exception 'root10_exact_one_budget_bytes_required'; end if;
 v:=p_raw::jsonb;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into c from clued_control.execution_current where root_id=root for update;
 select * into previous from clued_control.execution_events where root_id=root and idempotency_key='${q(intent.budget_idempotency_key)}';
 if found then
  if previous.sequence<>${EXPECT.budget_sequence} or previous.request is distinct from jsonb_build_object('operation','BUDGET_RESERVED','body',jsonb_build_object('raw',p_raw,'sha256',p_sha)) then raise exception 'root10_budget_idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','event',to_jsonb(previous),'authority_effect','NONE');
 end if;
 select * into b from clued_control.effective_execution_binding(); select * into w from clued_control.effective_execution_window() where root_id=root;
 r:=clued_control.read_root(root);
 if c.sequence<>${EXPECT.repoint_sequence} or c.active_ga_id is not null or c.pending_budget_sequence is not null
 or c.charged_seconds<>${intent.old_charged_seconds} or c.charged_evidence_bytes<>${intent.old_charged_evidence_bytes}
 or r->>'state'<>'STORED_NO_GATE_AUTHORITY' or r->>'generation_id'<>'${intent.generation_id}'
 or w.generation_id<>'${intent.generation_id}' or w.budget_sequence_floor<>${EXPECT.budget_sequence}
 or b.controller_sha256<>'${m.controller_sha256}' or b.qualification_sha256<>'${qual.sha256}' or b.runtime_acceptance_sha256<>'${runtime.sha256}'
 or b.profile_sha256<>'${intent.profile_sha256}' or b.scope_sha256<>'${intent.scope_sha256}' or b.gate_sha256<>'${intent.gate_sha256}'
 or (select count(*) from clued_control.events where root_id=root)<>10
 or (select count(*) from clued_control.execution_events where root_id=root)<>${EXPECT.repoint_sequence}
 or (select count(*) from clued_control.gate_attempts where root_id=root)<>${EXPECT.attempts}
 or exists(select 1 from clued_control.gate_attempts where root_id=root and phase not in ('FAIL','BLOCKED','STALE'))
 or (select count(*) from clued_control.execution_events where root_id=root and sequence>44 and request->>'operation'='BUDGET_RESERVED')<>${EXPECT.budgets_after_44}
 or (select count(*) from clued_control.execution_events where root_id=root and sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED')<>${EXPECT.forwards_after_44}
 or not exists(select 1 from clued_control.gate_attempts where root_id=root and ga_id='${q(m.ga6_id)}' and ga_sha256='${m.ga6_sha256}' and phase='BLOCKED' and budget_sequence=102 and container_id is null and receipt_sha256='${m.ga6_blocked_receipt_sha256}')
 or exists(select 1 from clued_control.execution_events where root_id=root and sequence=${EXPECT.budget_sequence})
 or clock_timestamp()<'${intent.not_before}'::timestamptz or clock_timestamp()+interval '600 seconds'>='${intent.expires_at}'::timestamptz
 then raise exception 'root10_exact_prebudget_postimage_required'; end if;
 next_sequence:=c.sequence+1;
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request)
 values(root,next_sequence,'${q(intent.budget_idempotency_key)}',jsonb_build_object('operation','BUDGET_RESERVED','body',jsonb_build_object('raw',p_raw,'sha256',p_sha)));
 update clued_control.execution_current set sequence=next_sequence,pending_budget_sequence=next_sequence,
 charged_seconds=charged_seconds+600,charged_evidence_bytes=charged_evidence_bytes+134217728
 where root_id=root and sequence=${EXPECT.repoint_sequence} and active_ga_id is null and pending_budget_sequence is null
 and charged_seconds=${intent.old_charged_seconds} and charged_evidence_bytes=${intent.old_charged_evidence_bytes};
 if not found then raise exception 'root10_budget_final_cas'; end if;
 ref:=jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'||next_sequence,'sha256',p_sha);
 return jsonb_build_object('status','BUDGET_RESERVED','budget_reservation_ref',ref,'sequence',next_sequence,'authority_effect','NONE','automatic_refund',false);
end $function$
`;
assertFunction(budgetFn,'reserve_execution_budget');

const req = {
  schema_version:'root10-activation-request/1', root_registration:{kind:'GENERATION_REGISTERED',root_set_id:ROOT,generation_id:intent.generation_id,predecessor_generation_id:ROOT9,expected_sequence:9,idempotency_key:m.activation_idempotency_key+'_root',metadata_binding_sha256:m.root9_binding_sha256,body:ro},
  binding_raw:bindingRaw,binding_sha256:bindingSha,status_raw:status.raw,status_sha256:status.sha256,
  prepared_evidence:po,qualified_evidence:eo,runtime_acceptance_raw:runtime.raw,runtime_acceptance_sha256:runtime.sha256,
  budget_raw:budgetRaw,budget_sha256:budgetSha,
};
const reqJson = JSON.stringify(req);

const findConstraint = (rel,name) => { const rows=constraints.filter(x=>x.nspname==='clued_control'&&x.relname===rel&&x.conname===name); if(rows.length!==1) die(`exact constraint missing/duplicate: ${rel}.${name}`); return {name:rows[0].conname,def:rows[0].definition}; };
const preBudgetDef = findConstraint('execution_current','execution_current_charged_seconds_check');
const preEvidenceDef = findConstraint('execution_current','execution_current_charged_evidence_bytes_check');
if (![preBudgetDef.name,preEvidenceDef.name].every(x=>/^[a-z_][a-z0-9_]*$/.test(x))) die('unsafe constraint identifier');
const liftCap = (def, oldCap, newCap, label) => {
  if (!/^CHECK \(.+\)$/s.test(def) || (def.match(new RegExp(`\\b${oldCap}\\b`,'g'))||[]).length !== 1) die(`${label}: exact old cap must occur once`);
  return def.replace(new RegExp(`\\b${oldCap}\\b`), () => String(newCap));
};
const newBudgetDef = liftCap(preBudgetDef.def,11106,intent.cumulative_seconds_cap,'seconds constraint');
const newEvidenceDef = liftCap(preEvidenceDef.def,2470030259,intent.cumulative_evidence_bytes_cap,'evidence constraint');
const oldPred = findConstraint('successor_binding','successor_binding_predecessor_generation_id_check').def;
const oldFloor = findConstraint('successor_binding','successor_binding_budget_sequence_floor_check').def;

const sql = `-- ROOT10 EXACT SINGLE-WINDOW ACTIVATION. One transaction; fail closed; no GA issuance.
begin;
set local lock_timeout='5s'; set local statement_timeout='60s';
do $pre$
declare h clued_control.current_head; c clued_control.execution_current; d text;
begin
 select * into h from clued_control.current_head where root_id='${ROOT}' for update;
 select * into c from clued_control.execution_current where root_id='${ROOT}' for update;
 lock table clued_control.successor_binding in access exclusive mode;
 if h.sequence<>9 or h.generation_id<>'${ROOT9}' or h.revoked or c.sequence<>112 or c.active_ga_id is not null or c.pending_budget_sequence is not null
 or c.charged_seconds<>${intent.old_charged_seconds} or c.charged_evidence_bytes<>${intent.old_charged_evidence_bytes}
 or (select count(*) from clued_control.events where root_id=h.root_id)<>9 or (select count(*) from clued_control.execution_events where root_id=h.root_id)<>112
 or (select count(*) from clued_control.gate_attempts where root_id=h.root_id)<>17
 or not exists(select 1 from clued_control.gate_attempts where root_id=h.root_id and ga_id='${q(m.ga6_id)}' and ga_sha256='${m.ga6_sha256}' and phase='BLOCKED' and budget_sequence=102 and container_id is null and receipt_sha256='${m.ga6_blocked_receipt_sha256}')
 then raise exception 'ROOT10_ACTIVATION_STALE_PREIMAGE'; end if;
 select pg_get_constraintdef(oid,false) into d from pg_constraint where conrelid='clued_control.successor_binding'::regclass and conname='successor_binding_budget_sequence_floor_check'; if d is distinct from '${q(oldFloor)}' then raise exception 'successor floor constraint changed'; end if;
 select pg_get_constraintdef(oid,false) into d from pg_constraint where conrelid='clued_control.successor_binding'::regclass and conname='successor_binding_predecessor_generation_id_check'; if d is distinct from '${q(oldPred)}' then raise exception 'successor predecessor constraint changed'; end if;
 select pg_get_constraintdef(oid,false) into d from pg_constraint where conrelid='clued_control.execution_current'::regclass and conname='${q(preBudgetDef.name)}'; if d is distinct from '${q(preBudgetDef.def)}' then raise exception 'seconds cap constraint changed'; end if;
 select pg_get_constraintdef(oid,false) into d from pg_constraint where conrelid='clued_control.execution_current'::regclass and conname='${q(preEvidenceDef.name)}'; if d is distinct from '${q(preEvidenceDef.def)}' then raise exception 'evidence cap constraint changed'; end if;
 ${functionPreflight}
end $pre$;

alter table clued_control.successor_binding drop constraint successor_binding_budget_sequence_floor_check,
 add constraint successor_binding_budget_sequence_floor_check check (budget_sequence_floor=98 or (generation_id='${intent.generation_id}' and budget_sequence_floor=117));
alter table clued_control.successor_binding drop constraint successor_binding_predecessor_generation_id_check,
 add constraint successor_binding_predecessor_generation_id_check check (
 predecessor_generation_id='ctrgen_26769cc7109ced40bc4016b2af678198' or
 (generation_id='${ROOT9}' and predecessor_generation_id='ctrgen_b060bc520329398936e461af6a477f94') or
 (generation_id='${intent.generation_id}' and predecessor_generation_id='${ROOT9}'));
alter table clued_control.execution_current drop constraint "${q(preBudgetDef.name)}",
 add constraint "${q(preBudgetDef.name)}" ${newBudgetDef};
alter table clued_control.execution_current drop constraint "${q(preEvidenceDef.name)}",
 add constraint "${q(preEvidenceDef.name)}" ${newEvidenceDef};

${nextReadRoot.trimEnd()};
${budgetFn.trimEnd()};
${gateFn.trimEnd()};
revoke all on function clued_control.read_root(text) from public,anon,authenticated;
grant execute on function clued_control.read_root(text) to service_role;
revoke all on function clued_control.reserve_execution_budget(text,text) from public,anon,authenticated;
grant execute on function clued_control.reserve_execution_budget(text,text) to service_role;
revoke all on function clued_control.reserve_gate(text,text) from public,anon,authenticated;
grant execute on function clued_control.reserve_gate(text,text) to service_role;

do $activate$
declare p jsonb:=convert_from(decode('${b64(reqJson)}','base64'),'UTF8')::jsonb; reg jsonb:=p->'root_registration'; rb jsonb:=(p->>'binding_raw')::jsonb;
 h clued_control.current_head; c clued_control.execution_current; result jsonb; oldb jsonb; newb jsonb; repoint jsonb;
begin
 if p->>'binding_sha256'<>encode(sha256(convert_to(p->>'binding_raw','UTF8')),'hex') or p->>'status_sha256'<>encode(sha256(convert_to(p->>'status_raw','UTF8')),'hex')
 or p->>'runtime_acceptance_sha256'<>encode(sha256(convert_to(p->>'runtime_acceptance_raw','UTF8')),'hex') or p->>'budget_sha256'<>encode(sha256(convert_to(p->>'budget_raw','UTF8')),'hex')
 then raise exception 'root10 embedded byte digest mismatch'; end if;
 select to_jsonb(b) into oldb from clued_control.effective_execution_binding() b;
 newb:=oldb||jsonb_build_object('controller_sha256','${m.controller_sha256}','qualification_sha256','${qual.sha256}','runtime_acceptance_sha256','${runtime.sha256}');
 insert into clued_control.events(root_id,sequence,idempotency_key,request) values('${ROOT}',10,reg->>'idempotency_key',reg);
 update clued_control.current_head set sequence=10,generation_id='${intent.generation_id}' where root_id='${ROOT}' and sequence=9 and generation_id='${ROOT9}' and not revoked; if not found then raise exception 'root10 root append CAS'; end if;
 insert into clued_control.successor_binding(binding_id,root_id,predecessor_generation_id,generation_id,not_before,expires_at,budget_sequence_floor,controller_sha256,qualification_sha256,profile_sha256,scope_sha256,gate_id,gate_version,gate_sha256,status_schema_sha256,registration_body,binding_sha256)
 values('${intent.binding_id}','${ROOT}','${ROOT9}','${intent.generation_id}','${intent.not_before}','${intent.expires_at}',117,'${m.controller_sha256}','${qual.sha256}','${intent.profile_sha256}','${intent.scope_sha256}','${q(m.gate_id)}','${q(m.gate_version)}','${intent.gate_sha256}','${m.status_schema_sha256}',reg,p->>'binding_sha256');
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request) values('${ROOT}',113,'${q(m.activation_idempotency_key)}_registered',jsonb_build_object('operation','SUCCESSOR_BINDING_REGISTERED','body',jsonb_build_object('binding_id','${intent.binding_id}','binding_sha256',p->>'binding_sha256','generation_id','${intent.generation_id}')));
 update clued_control.execution_current set sequence=113 where root_id='${ROOT}' and sequence=112 and active_ga_id is null and pending_budget_sequence is null; if not found then raise exception 'root10 registration CAS'; end if;
 result:=clued_control.transition_successor_binding(jsonb_build_object('operation','SUCCESSOR_BINDING_PREPARED','binding_id','${intent.binding_id}','evidence',p->'prepared_evidence','expected_sequence',113,'idempotency_key','${q(m.activation_idempotency_key)}_prepared')); if result->>'status'<>'PREPARED' then raise exception 'root10 prepare failed'; end if;
 result:=clued_control.append_status_manifest(p->>'status_raw',p->>'status_sha256'); if result->>'status'<>'STORED_NO_AUTHORITY' then raise exception 'root10 status failed'; end if;
 result:=clued_control.transition_successor_binding(jsonb_build_object('operation','SUCCESSOR_BINDING_QUALIFIED','binding_id','${intent.binding_id}','evidence',p->'qualified_evidence','expected_sequence',114,'idempotency_key','${q(m.activation_idempotency_key)}_qualified')); if result->>'status'<>'QUALIFIED' then raise exception 'root10 qualify failed'; end if;
 repoint:=jsonb_build_object('operation','EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED','body',jsonb_build_object('binding_id','${intent.binding_id}','previous_binding',oldb,'previous_binding_sha256',encode(sha256(convert_to(oldb::text,'UTF8')),'hex'),'new_binding',newb,'new_binding_sha256',encode(sha256(convert_to(newb::text,'UTF8')),'hex'),'old_runtime_acceptance_sha256',oldb->>'runtime_acceptance_sha256','new_runtime_acceptance_sha256','${runtime.sha256}','acceptance_raw',p->>'runtime_acceptance_raw','acceptance_sha256','${runtime.sha256}','acceptance_publication_ref',p->'qualified_evidence'->'acceptance_publication_ref','qualified_evidence',p->'qualified_evidence'));
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request) values('${ROOT}',116,'${q(m.activation_idempotency_key)}_activated',repoint);
 update clued_control.execution_current set sequence=116 where root_id='${ROOT}' and sequence=115 and active_ga_id is null and pending_budget_sequence is null and charged_seconds=${intent.old_charged_seconds} and charged_evidence_bytes=${intent.old_charged_evidence_bytes}; if not found then raise exception 'root10 repoint CAS'; end if;
 result:=clued_control.reserve_execution_budget(p->>'budget_raw',p->>'budget_sha256'); if result->>'status'<>'BUDGET_RESERVED' or result->>'sequence'<>'117' then raise exception 'root10 budget failed'; end if;
end $activate$;

do $post$
declare h clued_control.current_head; c clued_control.execution_current; r jsonb; d text;
begin select * into h from clued_control.current_head where root_id='${ROOT}' for update; select * into c from clued_control.execution_current where root_id='${ROOT}' for update; r:=clued_control.read_root('${ROOT}');
 if h.sequence<>10 or h.generation_id<>'${intent.generation_id}' or h.revoked or c.sequence<>117 or c.pending_budget_sequence<>117 or c.active_ga_id is not null
 or c.charged_seconds<>11706 or c.charged_evidence_bytes<>2604247987 or r->>'generation_id'<>'${intent.generation_id}' or r->>'state'<>'STORED_NO_GATE_AUTHORITY'
 or (select count(*) from clued_control.events where root_id=h.root_id)<>10 or (select count(*) from clued_control.execution_events where root_id=h.root_id)<>117
 or (select count(*) from clued_control.gate_attempts where root_id=h.root_id)<>17 or exists(select 1 from clued_control.gate_attempts where root_id=h.root_id and phase not in ('FAIL','BLOCKED','STALE'))
 or (select count(*) from clued_control.execution_events where root_id=h.root_id and sequence>44 and request->>'operation'='BUDGET_RESERVED')<>11
 or (select count(*) from clued_control.successor_binding where root_id=h.root_id)<>3
 or not exists(select 1 from pg_proc p where p.oid=to_regprocedure('clued_control.read_root(text)') and p.proowner='postgres'::regrole and p.prosecdef and p.provolatile='s' and p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' and p.proconfig @> array['search_path=""','TimeZone=UTC']::text[] and position('${intent.generation_id}' in pg_get_functiondef(p.oid))>0)
 or not exists(select 1 from pg_proc p where p.oid=to_regprocedure('clued_control.reserve_execution_budget(text,text)') and p.proowner='postgres'::regrole and p.prosecdef and p.provolatile='v' and p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' and p.proconfig @> array['search_path=""','TimeZone=UTC']::text[] and position('${budgetSha}' in pg_get_functiondef(p.oid))>0)
 or not exists(select 1 from pg_proc p where p.oid=to_regprocedure('clued_control.reserve_gate(text,text)') and p.proowner='postgres'::regrole and p.prosecdef and p.provolatile='v' and p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' and p.proconfig @> array['search_path=""','TimeZone=UTC']::text[] and position('${intent.generation_id}' in pg_get_functiondef(p.oid))>0 and position('${budgetSha}' in pg_get_functiondef(p.oid))>0)
 then raise exception 'ROOT10_ACTIVATION_POSTIMAGE_FAILED'; end if;
 ${unchangedFunctionPostflight}
end $post$;
select jsonb_build_object(
 'root_sequence',h.sequence,'root_generation',h.generation_id,'root_revoked',h.revoked,
 'execution_sequence',c.sequence,'active_ga_id',c.active_ga_id,'pending_budget_sequence',c.pending_budget_sequence,
 'charged_seconds',c.charged_seconds,'charged_evidence_bytes',c.charged_evidence_bytes,
 'root_event_count',(select count(*) from clued_control.events e where e.root_id=h.root_id),
 'execution_event_count',(select count(*) from clued_control.execution_events e where e.root_id=h.root_id),
 'attempt_count',(select count(*) from clued_control.gate_attempts a where a.root_id=h.root_id),
 'function_sha256',jsonb_build_object(
   'read_root',encode(sha256(convert_to(pg_get_functiondef(to_regprocedure('clued_control.read_root(text)')),'UTF8')),'hex'),
   'reserve_execution_budget',encode(sha256(convert_to(pg_get_functiondef(to_regprocedure('clued_control.reserve_execution_budget(text,text)')),'UTF8')),'hex'),
   'reserve_gate',encode(sha256(convert_to(pg_get_functiondef(to_regprocedure('clued_control.reserve_gate(text,text)')),'UTF8')),'hex')))
from clued_control.current_head h join clued_control.execution_current c using(root_id)
where h.root_id='${ROOT}';
commit;
`;

const commitMatches = sql.match(/\ncommit;\s*$/g) || [];
if (commitMatches.length !== 1) die('apply SQL must have exactly one terminal commit');
const fullRollback = sql.replace(/\ncommit;\s*$/, () => '\nrollback;\n');

const preflight = `begin; set local statement_timeout='60s'; do $p$ declare h clued_control.current_head; c clued_control.execution_current; begin
select * into h from clued_control.current_head where root_id='${ROOT}' for update; select * into c from clued_control.execution_current where root_id='${ROOT}' for update;
if h.sequence<>9 or h.generation_id<>'${ROOT9}' or c.sequence<>112 or c.active_ga_id is not null or c.pending_budget_sequence is not null or c.charged_seconds<>11106 or c.charged_evidence_bytes<>2470030259
or (select count(*) from clued_control.execution_events where root_id=h.root_id)<>112 or (select count(*) from clued_control.gate_attempts where root_id=h.root_id)<>17
or not exists(select 1 from clued_control.gate_attempts where root_id=h.root_id and ga_id='${q(m.ga6_id)}' and phase='BLOCKED' and receipt_sha256='${m.ga6_blocked_receipt_sha256}')
then raise exception 'ROOT10_PREFLIGHT_NOT_READY'; end if; end $p$; rollback;`;
const readback = `select clued_control.read_root('${ROOT}') root, clued_control.read_execution() execution;`;
const negatives = {schema_version:'root10-reserve-gate-negative-fixtures/1',run_after_activation_before_final_ga:true,authority_effect:'NONE',fixtures:[
 {id:'N01_CHANGED_BYTES_SAME_IDEMPOTENCY',expected_error:'idempotency_conflict',mutation:'same idempotency key with different GA bytes'},
 {id:'N02_SECOND_ROOT10_GA',expected_error:'root10_exact_single_ga_preimage_required',mutation:'new GA id/idempotency after first reservation'},
 {id:'N03_NONEMPTY_REPAIR_REFS',expected_error:'root10_exact_accepted_scope_or_zero_repairs_required',mutation:'one repair_refs entry'},
 {id:'N04_FIXED_SCHEMA_ISSUER_RISK_PROFILE_VECTOR_SOURCE_DRIFT',expected_error_one_of:['root10_exact_accepted_scope_or_zero_repairs_required','root10_complete_fixed_and_late_bound_ga_contract_required'],mutation:'change each fixed field one at a time'},
 {id:'N05_STATUS_NOT_GENERATION29',expected_error:'exact_stored_status29_required',mutation:'status ref points at a different stored generation'},
 {id:'N06_BUDGET_NOT117_OR_RAW_NO_LF',expected_error:'root10_exact_prior_committed_budget117_required',mutation:'budget reference/hash/raw bytes differ'},
 {id:'N07_NOT_EXACT_600_SECONDS',expected_error:'root10_exact_600_second_ga_window_required',mutation:'599 or 601 second interval'},
 {id:'N08_HISTORICAL_ATTEMPT_OR_RECEIPT_DRIFT',expected_error_one_of:['series_original_six_attempts_changed','root10_exact_single_ga_preimage_required'],mutation:'attempt id/raw/receipt/result/budget binding differs'},
 {id:'N09_CONTAINER_OR_ACTIVE_PHASE_PREEXISTS',expected_error:'root10_exact_single_ga_preimage_required',mutation:'active Root10 GA or nonterminal historical phase exists'},
 {id:'N10_EXACT_RESPONSE_LOSS_REPLAY',expected_status:'DUPLICATE',mutation:'same exact raw and hash after successful reserve'},
 {id:'N11_ROOT_OR_EXECUTION_IMMUTABLE_PREFIX_DRIFT',expected_error_one_of:['series_full_original_root_changed','series_original_44_events_changed'],mutation:'change one Root<=8 or execution<=44 request field'},
 {id:'N12_HISTORICAL_BUDGET_GENERATION_OR_EXPIRY_DRIFT',expected_error:'root10_exact_single_ga_preimage_required',mutation:'change one post-44 budget root_generation or historical expires_at'},
 {id:'N13_GA6_CLOSURE_111_112_BYTES_DRIFT',expected_error:'root10_exact_single_ga_preimage_required',mutation:'change a decision/evidence/observation raw byte, idempotency key, termination mode, or signing decision hash'},
 {id:'N14_EXACT_51_FIELD_SCHEMA_SHAPE_MISSING_OR_EXTRA',expected_error:'root10_complete_fixed_and_late_bound_ga_contract_required',also_expected_rejection_layer:'trusted host schema/runtime-acceptance verifier before reserve_gate',mutation:'remove any required field or add any field outside the original 51-field schema'},
 {id:'N15_CONTAINER_PHASE_MACHINE_DRIFT',expected_rejection_layer:'unchanged pinned execution_transition',mutation:'CREATED/RUNNING/STOPPED with missing or mismatched container_id, or dispatch from a nonmatching phase'}
]};
const manifest = {schema_version:'root10-activation-build/1',authority_effect:'NONE',execute:false,sequences:EXPECT,files:{},pins:{root10_full_sha256:root.sha256,status29_full_sha256:status.sha256,controller_sha256:m.controller_sha256,qualification_sha256:qual.sha256,runtime_acceptance_sha256:runtime.sha256,binding_sha256:bindingSha,budget_sha256:budgetSha}};
const files = [
 ['root10-activation.preimage-only.sql',preflight],['root10-activation.full-rollback.sql',fullRollback],['read_root.root10.sql',nextReadRoot.trimEnd()+';\n'],['reserve_execution_budget.root10-one-shot.sql',budgetFn.trimEnd()+';\n'],['reserve_gate.root10-one-ga.sql',gateFn.trimEnd()+';\n'],['reserve_gate.actual-negative-fixtures.json',JSON.stringify(negatives,null,2)+'\n'],['root10-activation.apply-once.sql',sql],['root10-activation.readback.sql',readback]
].map(([name,content])=>({name,content,sha256:sha(content)}));
for (const f of files) manifest.files[f.name]=f.sha256;
files.push({name:'root10-activation.build.json',content:JSON.stringify(manifest,null,2)+'\n',sha256:''}); files.at(-1).sha256=sha(files.at(-1).content);
const result={ok:true,write_performed:outArg!=='--stdout',files};
if(outArg==='--stdout') process.stdout.write(JSON.stringify(result)); else { const out=path.resolve(outArg); fs.mkdirSync(out,{recursive:true}); for(const f of files) fs.writeFileSync(path.join(out,f.name),f.content,'utf8'); process.stdout.write(JSON.stringify({ok:true,outdir:out,files:files.map(({name,sha256})=>({name,sha256}))},null,2)+'\n'); }
