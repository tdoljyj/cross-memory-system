# 迁移 03：存入修正版 Status（generation 31）、追加第 137 号重指向事件、换掉 reserve_gate。
#
# reserve_gate 不重新生成，而是从活化套件已产出的那一份**逐处改**，每处都断言出现次数——
# 这样除了下面明确列出的几项，其余字节与已经在生产库里跑过负向探针的那一份完全相同。
#
# 不动预算、不动计数器、不签 GA、不启动时钟。
import json, hashlib, pathlib, base64, collections

REPO = pathlib.Path(r'C:/Users/17531/.dsh/projects/cross-memory-system')
OUT = REPO / 'work/root11-single-window'
LIVE = pathlib.Path(r'C:/Users/17531/root10-snapshot-20260916/gen11-live')
GATE = OUT / 'activation/output/reserve_gate.root11-one-ga.sql'
DEST = LIVE / 'migration-03'
DEST.mkdir(parents=True, exist_ok=True)

sha = lambda b: hashlib.sha256(b).hexdigest()
ROOT = 'ctr_414bd3c724264a83894b0c55cf2ab878'
BINDING_ID = 'sb_873f7cf2f79fb3cb168138441e6fddbc'
IDEM = 'root11_status_v2_acceptance_repoint_20260916'

OLD_ACC = '171f8e32f79c0f071e8d0986d5ec8307154ecb9b346e998f3c356c4ea660d192'
signed_status_raw = (LIVE / 'Root11SignedStatus.v2.json').read_text(encoding='utf-8')
acceptance_raw = (OUT / 'RuntimeAcceptance.root11.json').read_text(encoding='utf-8')
NEW_ACC = sha(acceptance_raw.encode())
acceptance = json.loads(acceptance_raw, object_pairs_hook=collections.OrderedDict)
status = json.loads(signed_status_raw)
assert status['generation'] == 31 and NEW_ACC != OLD_ACC

FIXED_KEYS = ['gate_id', 'profile_ref', 'purpose', 'environment', 'repository_ref', 'artifact_refs',
              'host_runtime_config_digest', 'upstream_gate_result_receipt_refs', 'release_risk_manifest_digest',
              'actor_ref', 'subject_ref', 'binding_ref', 'scope_ref', 'issuer_ref', 'authority_source_ref',
              'audience', 'issuer_purpose', 'schema_digest', 'control_trust_root_generation', 'allowed_read_set',
              'allowed_write_set', 'forbidden_actions', 'credential_scope', 'stop_policy_digest',
              'rollback_point_ref', 'evidence_sink_ref', 'controller_digest', 'candidate_skill_digest',
              'mechanism_digest', 'plan_digest', 'fixtures_digest', 'stage_receipt_refs',
              'revocation_epoch_vector', 'scope_digest', 'profile_digest', 'dominant_role', 'source_ref',
              'controller_qualification_ref']
ega = acceptance['accepted_subject']['expected_ga']
assert sorted(ega) == sorted(FIXED_KEYS)
fixed_ga_b64 = base64.b64encode(json.dumps(ega, separators=(',', ':'), ensure_ascii=False).encode()).decode()

gate = GATE.read_text(encoding='utf-8')
edits = []


def sub(old, new, label, count=1):
    global gate
    n = gate.count(old)
    assert n == count, 'expected %d, found %d: %s' % (count, n, label)
    gate = gate.replace(old, new)
    edits.append(label)


# 1. 头部序号：136 -> 137（预算序号本身仍是 136）
sub(" or jsonb_array_length(series_view->'events')<>136",
    " or jsonb_array_length(series_view->'events')<>137", 'series length')
sub(" or c.sequence is distinct from 136 or c.pending_budget_sequence is distinct from 136 or c.active_ga_id is not null",
    " or c.sequence is distinct from 137 or c.pending_budget_sequence is distinct from 136 or c.active_ga_id is not null",
    'current head sequence')
sub(" or (select count(*) from clued_control.execution_events where root_id=root)<>136",
    " or (select count(*) from clued_control.execution_events where root_id=root)<>137", 'execution event count')
sub(" where root_id=root and sequence=136 and active_ga_id is null and pending_budget_sequence=136",
    " where root_id=root and sequence=137 and active_ga_id is null and pending_budget_sequence=136",
    'final CAS')

# 2. 绑定里的验收摘要
sub(" or b.runtime_acceptance_sha256 is distinct from '" + OLD_ACC + "'",
    " or b.runtime_acceptance_sha256 is distinct from '" + NEW_ACC + "'", 'binding acceptance digest')

# 3. 存储的 Status 代次
sub("and co.sha256=g->'status_manifest_ref'->>'sha256' and co.generation=30)",
    "and co.sha256=g->'status_manifest_ref'->>'sha256' and co.generation=31)", 'stored status generation')

# 4. 已验收的固定 GA 字段（资格引用换成 blob 形式）
old_b64 = gate.split("fixed_ga jsonb:=convert_from(decode('", 1)[1].split("'", 1)[0]
assert old_b64 != fixed_ga_b64, 'expected_ga 应当变了'
sub("fixed_ga jsonb:=convert_from(decode('" + old_b64 + "'",
    "fixed_ga jsonb:=convert_from(decode('" + fixed_ga_b64 + "'", 'accepted fixed GA fields')

# 5. 新增第 137 号重指向事件的钉死值（第 135 号那条保持原样，它是历史）
sub(" or not exists(select 1 from clued_control.execution_events where root_id=root and sequence=136 and request->>'operation'='BUDGET_RESERVED')",
    " or not exists(select 1 from clued_control.execution_events where root_id=root and sequence=136 and request->>'operation'='BUDGET_RESERVED')\n"
    " or not exists(select 1 from clued_control.execution_events e where e.root_id=root and e.sequence=137\n"
    "      and e.idempotency_key='" + IDEM + "'\n"
    "      and e.request->>'operation'='EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED'\n"
    "      and e.request->'body'->>'binding_id'='" + BINDING_ID + "'\n"
    "      and e.request->'body'->>'old_runtime_acceptance_sha256'='" + OLD_ACC + "'\n"
    "      and e.request->'body'->>'new_runtime_acceptance_sha256'='" + NEW_ACC + "'\n"
    "      and e.request->'body'->>'acceptance_sha256'='" + NEW_ACC + "'\n"
    "      and encode(sha256(convert_to(e.request->'body'->>'acceptance_raw','UTF8')),'hex')='" + NEW_ACC + "'\n"
    "      and e.request->'body'->>'previous_binding_sha256'=encode(sha256(convert_to((e.request->'body'->'previous_binding')::text,'UTF8')),'hex')\n"
    "      and e.request->'body'->>'new_binding_sha256'=encode(sha256(convert_to((e.request->'body'->'new_binding')::text,'UTF8')),'hex'))",
    'event 137 pin')

q = lambda s: s.replace("'", "''")
body = """-- ROOT11 STATUS V2 + ACCEPTANCE REPOINT. One transaction; fail closed.
-- No budget, no GA, no counter change, no clock.
begin;
set local lock_timeout='5s'; set local statement_timeout='60s';
do $pre$
declare h clued_control.current_head; c clued_control.execution_current; b clued_control.execution_binding; d text;
begin
 select * into h from clued_control.current_head where root_id='{ROOT}' for update;
 select * into c from clued_control.execution_current where root_id='{ROOT}' for update;
 select * into b from clued_control.effective_execution_binding();
 if h.sequence<>11 or h.generation_id<>'{GEN}' or h.revoked
 or c.sequence<>136 or c.pending_budget_sequence<>136 or c.active_ga_id is not null
 or c.charged_seconds<>12306 or c.charged_evidence_bytes<>2738465715
 or (select count(*) from clued_control.execution_events where root_id=c.root_id)<>136
 or (select count(*) from clued_control.gate_attempts where root_id=c.root_id)<>18
 or exists(select 1 from clued_control.gate_attempts where root_id=c.root_id and phase not in ('FAIL','BLOCKED','STALE'))
 or b.runtime_acceptance_sha256<>'{OLD_ACC}' or b.controller_sha256<>'{CONTROLLER}' or b.qualification_sha256<>'{QUAL}'
 or exists(select 1 from clued_control.control_objects where generation=31)
 then raise exception 'ROOT11_REPOINT_STALE_PREIMAGE'; end if;
 select encode(sha256(convert_to(pg_get_functiondef(to_regprocedure('clued_control.reserve_gate(text,text)')),'UTF8')),'hex') into d;
 if d is distinct from '{GATE_NOW}' then raise exception 'reserve_gate changed since activation'; end if;
end $pre$;

do $apply$
declare
 raw_status text:=convert_from(decode('{STATUS_B64}','base64'),'UTF8');
 raw_acc text:=convert_from(decode('{ACC_B64}','base64'),'UTF8');
 c clued_control.execution_current; oldb jsonb; newb jsonb; repoint jsonb; result jsonb;
begin
 result:=clued_control.append_status_manifest(raw_status,encode(sha256(convert_to(raw_status,'UTF8')),'hex'));
 if result->>'status' not in ('STORED_NO_AUTHORITY','DUPLICATE') then raise exception 'root11 status append failed'; end if;
 select to_jsonb(b) into oldb from clued_control.effective_execution_binding() b;
 newb:=oldb||jsonb_build_object('runtime_acceptance_sha256','{NEW_ACC}');
 repoint:=jsonb_build_object('operation','EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED','body',jsonb_build_object(
   'binding_id','{BINDING_ID}',
   'previous_binding',oldb,'previous_binding_sha256',encode(sha256(convert_to(oldb::text,'UTF8')),'hex'),
   'new_binding',newb,'new_binding_sha256',encode(sha256(convert_to(newb::text,'UTF8')),'hex'),
   'old_runtime_acceptance_sha256',oldb->>'runtime_acceptance_sha256',
   'new_runtime_acceptance_sha256','{NEW_ACC}',
   'acceptance_raw',raw_acc,'acceptance_sha256','{NEW_ACC}',
   'status_manifest_ref',jsonb_build_object('uri','control://status-manifests/{STATUS_ID}','sha256',encode(sha256(convert_to(raw_status,'UTF8')),'hex')),
   'reason','Status30 source_refs named the generation 10 controller qualification; this generation binds {QUAL}.'));
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request)
 values('{ROOT}',137,'{IDEM}',repoint);
 update clued_control.execution_current set sequence=137
  where root_id='{ROOT}' and sequence=136 and active_ga_id is null and pending_budget_sequence=136
    and charged_seconds=12306 and charged_evidence_bytes=2738465715;
 if not found then raise exception 'root11 repoint CAS'; end if;
end $apply$;

{GATE}

revoke all on function clued_control.reserve_gate(text,text) from public,anon,authenticated;
grant execute on function clued_control.reserve_gate(text,text) to service_role;

do $post$
declare c clued_control.execution_current; b clued_control.execution_binding; d text;
begin
 select * into c from clued_control.execution_current where root_id='{ROOT}' for update;
 select * into b from clued_control.effective_execution_binding();
 if c.sequence<>137 or c.pending_budget_sequence<>136 or c.active_ga_id is not null
 or c.charged_seconds<>12306 or c.charged_evidence_bytes<>2738465715
 or (select count(*) from clued_control.execution_events where root_id=c.root_id)<>137
 or (select count(*) from clued_control.gate_attempts where root_id=c.root_id)<>18
 or b.runtime_acceptance_sha256<>'{NEW_ACC}' or b.controller_sha256<>'{CONTROLLER}' or b.qualification_sha256<>'{QUAL}'
 or (select count(*) from clued_control.control_objects where generation=31)<>1
 or (select count(*) from clued_control.control_objects where generation=30)<>1
 then raise exception 'ROOT11_REPOINT_POSTIMAGE_FAILED'; end if;
end $post$;
select jsonb_build_object('execution_sequence',c.sequence,'pending_budget_sequence',c.pending_budget_sequence,
 'active_ga_id',c.active_ga_id,'charged_seconds',c.charged_seconds,'charged_evidence_bytes',c.charged_evidence_bytes,
 'runtime_acceptance',(select b.runtime_acceptance_sha256 from clued_control.effective_execution_binding() b),
 'status_generations',(select jsonb_agg(generation order by generation) from clued_control.control_objects),
 'reserve_gate',encode(sha256(convert_to(pg_get_functiondef(to_regprocedure('clued_control.reserve_gate(text,text)')),'UTF8')),'hex'))
from clued_control.execution_current c where c.root_id='{ROOT}';
commit;
"""

GATE_NOW = 'a1170551f4465994338661dadad367cf929d01c665b4da111dfb039cb9a2538d'
sql = (body
       .replace('{ROOT}', ROOT)
       .replace('{GEN}', 'ctrgen_c725e90a595c00a041754ede3b00f408')
       .replace('{OLD_ACC}', OLD_ACC).replace('{NEW_ACC}', NEW_ACC)
       .replace('{CONTROLLER}', 'fc6ca1759ef68a958564bd2d9fc16aab23297c2db30ac7581b4ec6227977c91f')
       .replace('{QUAL}', 'cc385768f9e04269d69b211a23fb08f4463215afa5c919649f42e17c7d58cbe9')
       .replace('{GATE_NOW}', GATE_NOW)
       .replace('{STATUS_B64}', base64.b64encode(signed_status_raw.encode()).decode())
       .replace('{ACC_B64}', base64.b64encode(acceptance_raw.encode()).decode())
       .replace('{STATUS_ID}', status['status_manifest_id'])
       .replace('{BINDING_ID}', BINDING_ID).replace('{IDEM}', IDEM)
       .replace('{GATE}', gate.rstrip().rstrip(';') + ';'))

assert sql.count('\ncommit;\n') == 1
(DEST / 'root11-repoint.apply-once.sql').write_text(sql, encoding='utf-8', newline='\n')
(DEST / 'root11-repoint.full-rollback.sql').write_text(sql.replace('\ncommit;\n', '\nrollback;\n'),
                                                       encoding='utf-8', newline='\n')
(DEST / 'reserve_gate.root11-repointed.sql').write_text(gate.rstrip() + '\n', encoding='utf-8', newline='\n')

print(json.dumps({'edits': edits, 'new_acceptance': NEW_ACC, 'status_generation': status['generation'],
                  'apply_sha256': sha(sql.encode()), 'bytes': len(sql)}, indent=1, ensure_ascii=False))
