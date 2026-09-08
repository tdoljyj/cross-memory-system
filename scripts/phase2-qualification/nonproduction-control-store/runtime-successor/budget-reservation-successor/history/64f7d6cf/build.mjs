// Fixed pre-GA reservation in existing events/current; no new tables or authority.
import fs from 'node:fs';
import crypto from 'node:crypto';
let sql=fs.readFileSync(new URL('../control-objects-successor/install.candidate.sql',import.meta.url),'utf8');
if(crypto.createHash('sha256').update(sql).digest('hex')!=='a242db8504f1cbd9c04ee8a22d8072e7b9ee0d6897433393e88c6e14a8e4ea27')throw Error('Exact predecessor changed');
const change=(a,b)=>{if(!sql.includes(a))throw Error('Missing fixed anchor');sql=sql.replace(a,()=>b);};
change(' active_ga_id text,',' active_ga_id text,\n pending_budget_sequence bigint check(pending_budget_sequence is null or pending_budget_sequence>0),');
change(' decision jsonb, receipt_id text unique, receipt_raw text, receipt_sha256 text,',' decision jsonb, receipt_id text unique, receipt_raw text, receipt_sha256 text,\n budget_sequence bigint not null unique,');
change(' or new.expires_at is distinct from old.expires_at or (old.revoked and not new.revoked)',
 ' or new.expires_at is distinct from old.expires_at or new.budget_sequence is distinct from old.budget_sequence or (old.revoked and not new.revoked)');
change('create function clued_control.reserve_gate(p_raw text,p_sha text)',`create function clued_control.reserve_execution_budget(p_raw text,p_sha text) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding;
 c clued_control.execution_current; previous clued_control.execution_events; r jsonb; v jsonb; next_sequence bigint; ref jsonb;
begin
 if p_raw is null or octet_length(p_raw)>16384 or not(p_raw is json object with unique keys)
 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'exact_budget_bytes_required'; end if;
 v:=p_raw::jsonb;
 if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from
 array['controller_digest','credential_generation','environment','evidence_bytes','expires_at','idempotency_key','not_before','profile_digest','purpose','root_generation','runner_generation','scope_digest','seconds','session_generation']::text[]
 or coalesce(v->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$'
 or v->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION' or v->>'environment' is distinct from 'ISOLATED_TEST'
 or v->'seconds' is distinct from '180'::jsonb or v->'evidence_bytes' is distinct from '134217728'::jsonb
 then raise exception 'fixed_budget_scope_required'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into b from clued_control.execution_binding where root_id=root;
 select * into c from clued_control.execution_current where root_id=root for update;
 if b.root_id is null or c.root_id is null then raise exception 'accepted_execution_binding_missing'; end if;
 select * into previous from clued_control.execution_events where root_id=root and idempotency_key=v->>'idempotency_key';
 if found then
  if previous.request->>'operation' is distinct from 'BUDGET_RESERVED' or previous.request->'body'->>'raw' is distinct from p_raw
  or previous.request->'body'->>'sha256' is distinct from p_sha then raise exception 'budget_idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','event',to_jsonb(previous),'authority_effect','NONE');
 end if;
 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or v->>'root_generation' is distinct from r->>'generation_id'
 or v->>'profile_digest' is distinct from b.profile_sha256 or v->>'controller_digest' is distinct from b.controller_sha256
 or v->>'scope_digest' is distinct from b.scope_sha256 or v->>'runner_generation' is distinct from c.runner_generation
 or v->>'credential_generation' is distinct from c.credential_generation or v->>'session_generation' is distinct from c.session_generation
 then raise exception 'budget_current_binding_mismatch'; end if;
 if (v->>'not_before') is null or (v->>'expires_at') is null or (v->>'not_before')::timestamptz>clock_timestamp()
 or (v->>'not_before')::timestamptz<(select not_before from clued_control.accepted_binding where root_id=root)
 or (v->>'expires_at')::timestamptz<=clock_timestamp()
 or (v->>'expires_at')::timestamptz>(select expires_at from clued_control.accepted_binding where root_id=root)
 then raise exception 'budget_window_invalid'; end if;
 if c.active_ga_id is not null or c.pending_budget_sequence is not null or c.charged_seconds<b.prior_seconds
 or c.charged_evidence_bytes<b.prior_evidence_bytes or c.charged_seconds+180>7200
 or c.charged_evidence_bytes+134217728>1073741824 then raise exception 'budget_or_pending_capacity_unavailable'; end if;
 next_sequence:=c.sequence+1;
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request)
 values(root,next_sequence,v->>'idempotency_key',jsonb_build_object('operation','BUDGET_RESERVED','body',jsonb_build_object('raw',p_raw,'sha256',p_sha)));
 update clued_control.execution_current set sequence=next_sequence,pending_budget_sequence=next_sequence,
 charged_seconds=charged_seconds+180,charged_evidence_bytes=charged_evidence_bytes+134217728 where root_id=root;
 ref:=jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'||next_sequence,'sha256',p_sha);
 return jsonb_build_object('status','BUDGET_RESERVED','budget_reservation_ref',ref,'sequence',next_sequence,
 'authority_effect','NONE','automatic_refund',false);
end $$;

create function clued_control.reserve_gate(p_raw text,p_sha text)`);
change(' c clued_control.execution_current; old clued_control.gate_attempts; r jsonb; g jsonb; start_time timestamptz; end_time timestamptz; seconds integer;',
 ' c clued_control.execution_current; old clued_control.gate_attempts; r jsonb; g jsonb; start_time timestamptz; end_time timestamptz; seconds integer; budget clued_control.execution_events; allocation jsonb;');
const oldBudget=` if seconds<1 or c.active_ga_id is not null or c.charged_seconds+seconds>7200
 or c.charged_evidence_bytes+134217728>1073741824 then raise exception 'budget_or_active_capacity_unavailable'; end if;`;
change(oldBudget,` if seconds<1 or c.active_ga_id is not null or c.pending_budget_sequence is null
 then raise exception 'actual_pending_budget_required'; end if;
 select * into budget from clued_control.execution_events where root_id=root and sequence=c.pending_budget_sequence;
 if not found or budget.recording_transaction_id=pg_current_xact_id() or budget.request->>'operation' is distinct from 'BUDGET_RESERVED'
 or g->'budget_reservation_ref'->>'uri' is distinct from 'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'||budget.sequence
 or g->'budget_reservation_ref'->>'sha256' is distinct from budget.request->'body'->>'sha256'
 then raise exception 'exact_prior_committed_budget_required'; end if;
 allocation:=(budget.request->'body'->>'raw')::jsonb;
 if allocation->>'root_generation' is distinct from g->>'control_trust_root_generation'
 or allocation->>'profile_digest' is distinct from g->>'profile_digest' or allocation->>'controller_digest' is distinct from g->>'controller_digest'
 or allocation->>'scope_digest' is distinct from g->>'scope_digest' or allocation->>'runner_generation' is distinct from g->>'runner_generation'
 or allocation->>'credential_generation' is distinct from g->>'credential_generation' or allocation->>'session_generation' is distinct from g->>'session_generation'
 or seconds>(allocation->>'seconds')::integer or start_time<(allocation->>'not_before')::timestamptz
 or (g->>'expires_at')::timestamptz>(allocation->>'expires_at')::timestamptz
 then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;`);
change('insert into clued_control.gate_attempts(root_id,ga_id,idempotency_key,ga_raw,ga_sha256,ga,phase,expires_at)',
 'insert into clued_control.gate_attempts(root_id,ga_id,idempotency_key,ga_raw,ga_sha256,ga,phase,expires_at,budget_sequence)');
change("values(root,g->>'gate_authorization_id',g->>'idempotency_key',p_raw,p_sha,g,'PENDING',end_time);",
 "values(root,g->>'gate_authorization_id',g->>'idempotency_key',p_raw,p_sha,g,'PENDING',end_time,budget.sequence);");
change(` update clued_control.execution_current set active_ga_id=g->>'gate_authorization_id',charged_seconds=charged_seconds+seconds,
 charged_evidence_bytes=charged_evidence_bytes+134217728 where root_id=root;`,
 ` update clued_control.execution_current set active_ga_id=g->>'gate_authorization_id',pending_budget_sequence=null where root_id=root;`);
sql+=`\nrevoke all on function clued_control.reserve_execution_budget(text,text) from public,anon,authenticated,service_role;
grant execute on function clued_control.reserve_execution_budget(text,text) to service_role;
`;
fs.writeFileSync(new URL('install.candidate.sql',import.meta.url),sql);
