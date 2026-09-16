-- 迁移 04：把第 11 代那次已分配、从未消耗的预算按不退款记为放弃。
--
-- 为什么需要
--   生产库 pending_budget_sequence 仍停在 136。第 11 代因 EXACT_ROOT10_PURPOSE_QUALIFICATION
--   永远签不出 GA，这次分配也就永远不会被消耗。而第 12 代的合同校验要求
--   baseline.pending_budget_sequence 为 null，所以必须先把它记掉。
--
-- 做什么
--   追加一条与预算 91 号同形的 BUDGET_OWNER_FORFEITED_UNCONSUMED 事件，
--   把 pending_budget_sequence 置空。
--
-- 不做什么
--   **不退款**。charged_seconds / charged_evidence_bytes 保持 12306 / 2738465715，
--   那 600 秒与 128 MiB 是这次错误的代价，如实记为已消耗。
--   不动任何 attempt、不改任何既有事件、不签 GA、不启动时钟。
begin;
set local lock_timeout='5s'; set local statement_timeout='60s';

do $pre$
declare h clued_control.current_head; c clued_control.execution_current; b clued_control.execution_events;
begin
  select * into h from clued_control.current_head where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for update;
  select * into c from clued_control.execution_current where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for update;
  select * into b from clued_control.execution_events
   where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and sequence=136;
  if h.sequence<>11 or h.generation_id<>'ctrgen_c725e90a595c00a041754ede3b00f408' or h.revoked
     or c.sequence<>137 or c.pending_budget_sequence<>136 or c.active_ga_id is not null
     or c.charged_seconds<>12306 or c.charged_evidence_bytes<>2738465715
     or (select count(*) from clued_control.execution_events where root_id=c.root_id)<>137
     or (select count(*) from clued_control.gate_attempts where root_id=c.root_id)<>18
     or exists(select 1 from clued_control.gate_attempts where root_id=c.root_id and phase not in ('FAIL','BLOCKED','STALE'))
     or b.request->>'operation'<>'BUDGET_RESERVED'
     or b.idempotency_key<>'root11_single_window_budget_20260916'
     -- 这次分配确实从未被任何 attempt 消耗
     or exists(select 1 from clued_control.gate_attempts where root_id=c.root_id and budget_sequence=136)
  then raise exception 'ROOT12_FORFEIT_STALE_PREIMAGE'; end if;
end $pre$;

do $apply$
declare c clued_control.execution_current; b clued_control.execution_events; body jsonb;
begin
  select * into c from clued_control.execution_current where root_id='ctr_414bd3c724264a83894b0c55cf2ab878';
  select * into b from clued_control.execution_events
   where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and sequence=136;
  body := jsonb_build_object(
    'disposition','OWNER_FORFEITURE_NO_REFUND',
    'attempt_created',false,
    'budget_sequence',136,
    'allocation_expires_at',(b.request->'body'->>'raw')::jsonb->>'expires_at',
    'charged_seconds_preserved',c.charged_seconds,
    'charged_evidence_bytes_preserved',c.charged_evidence_bytes,
    'reason','Generation 11 could never issue a GA: its registered root event names generation 10 issuer qualifications, which EXACT_ROOT10_PURPOSE_QUALIFICATION rejects on generation, window and caps. The allocation is recorded as spent, not refunded.');
  insert into clued_control.execution_events(root_id,sequence,idempotency_key,request)
  values('ctr_414bd3c724264a83894b0c55cf2ab878',138,'root11_budget_forfeited_unconsumed_20260916',
    jsonb_build_object('operation','BUDGET_OWNER_FORFEITED_UNCONSUMED',
      'expected_sequence',137,'idempotency_key','root11_budget_forfeited_unconsumed_20260916','body',body));
  update clued_control.execution_current set sequence=138, pending_budget_sequence=null
   where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and sequence=137 and pending_budget_sequence=136
     and active_ga_id is null and charged_seconds=12306 and charged_evidence_bytes=2738465715;
  if not found then raise exception 'root12 forfeit CAS'; end if;
end $apply$;

do $post$
declare c clued_control.execution_current;
begin
  select * into c from clued_control.execution_current where root_id='ctr_414bd3c724264a83894b0c55cf2ab878';
  if c.sequence<>138 or c.pending_budget_sequence is not null or c.active_ga_id is not null
     or c.charged_seconds<>12306 or c.charged_evidence_bytes<>2738465715
     or (select count(*) from clued_control.execution_events where root_id=c.root_id)<>138
     or (select count(*) from clued_control.gate_attempts where root_id=c.root_id)<>18
     or (select count(*) from clued_control.execution_events where root_id=c.root_id
          and request->>'operation'='BUDGET_OWNER_FORFEITED_UNCONSUMED')<>2
  then raise exception 'ROOT12_FORFEIT_POSTIMAGE_FAILED'; end if;
end $post$;

select jsonb_build_object('execution_sequence',c.sequence,'pending_budget_sequence',c.pending_budget_sequence,
 'active_ga_id',c.active_ga_id,'charged_seconds',c.charged_seconds,'charged_evidence_bytes',c.charged_evidence_bytes,
 'forfeits',(select jsonb_agg(e.request->'body'->'budget_sequence' order by e.sequence)
   from clued_control.execution_events e where e.root_id=c.root_id
     and e.request->>'operation' in ('BUDGET_OWNER_FORFEITED_UNCONSUMED','BUDGET_EXPIRED_UNCONSUMED')))
from clued_control.execution_current c where c.root_id='ctr_414bd3c724264a83894b0c55cf2ab878';
commit;
