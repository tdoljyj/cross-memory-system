-- ========================================================================================
-- STANDING BOUNDARY READ. Read-only. Run before the first step of a session and after the
-- last, and after every abort. Two runs that disagree mean something moved between them.
-- ========================================================================================
-- Project: uscrdifznmlvczcekqpw (clued-auth-test). The control plane is NOT in clued-prod.
--
-- Values measured 2026-09-12T23:5xZ, head 4e5459b, by the preparation session. Any drift
-- from the "expected before step 13" column is an ABORT for the whole sheet, not a retry.
--
--   events_rows                     5
--   exec_event_rows                 88
--   max_exec_sequence               88
--   gate_attempts                   14
--   control_objects                 23
--   head_generation                 ctrgen_e5df432221344996afc04b5638121d96   (root5)
--   root_sequence                   5
--   charged_seconds                 9906        (ceiling 10506)
--   charged_evidence_bytes          2201594803
--   active_ga_id                    NULL
--   pending_budget_sequence         NULL
--   series_f                        15          (cap: series_f>15 raises)
--   accepted_binding.expires_at     2026-09-13T07:05:16+00
--   accepted_binding.not_before     2026-09-12T07:05:16+00
--   metadata_binding_sha256         ee5d85faebda1878b3c676dfcc13ecd35d896e5f390907bce39e79bda83caba5
--   five_frozen_events_digest       45c6a2cbaf33bb27f6b4c136440d71d767943acfa9772867e219627759ca5bbc
--   reserve_gate prosrc             a011292416693ef7e44221868669937261c33848a3ff10882d0f4abd97c9ef2e
--   reserve_execution_budget prosrc df6087f9d19d99f023a9c789f0c9b34140e92bb82fc00a5dde1d69d9b1aa7d41
--   append_status_manifest prosrc   94a444b9174251e8f655ea3a04e160898464caf1f94977cbce1590aff726c615
--   effective_execution_binding     c721b056a771a3a019d1f0cee862408ba56afcbd4d683f45802e8f51c0580d16
--   execution_binding.controller     edf31377656e1a9a473d0095df72231c058266007e4fd4046e0a9b8c2d6a60d9 (base row)
--   effective controller_sha256      ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa (after 19 forwards)

with v as (select clued_control.read_execution() as x), root as (select x->'root' as r from v)
select
  clock_timestamp()                                                                as observed_at,
  current_database()                                                               as db,
  (select count(*) from clued_control.events)                                      as events_rows,
  (select count(*) from clued_control.execution_events)                            as exec_event_rows,
  (select max(sequence) from clued_control.execution_events)                       as max_exec_sequence,
  (select count(*) from clued_control.gate_attempts)                               as gate_attempts,
  (select count(*) from clued_control.control_objects)                             as control_objects,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='clued_control' and c.relkind in ('r','p'))                   as clued_control_tables,
  (select generation_id from clued_control.current_head)                           as head_generation,
  (r->>'sequence')                                                                 as root_sequence,
  jsonb_array_length(r->'events')                                                  as root_events_len,
  (r->>'metadata_binding_sha256')                                                  as metadata_binding_sha256,
  encode(sha256(convert_to((select jsonb_agg(e order by (e->>'sequence')::bigint)
     from jsonb_array_elements(r->'events') e
    where (e->>'sequence')::bigint <= 5)::text,'UTF8')),'hex')                     as five_frozen_events_digest,
  (select charged_seconds from clued_control.execution_current)                    as charged_seconds,
  (select charged_evidence_bytes from clued_control.execution_current)             as charged_evidence_bytes,
  (select sequence from clued_control.execution_current)                           as execution_sequence,
  (select active_ga_id from clued_control.execution_current)                       as active_ga_id,
  (select pending_budget_sequence from clued_control.execution_current)            as pending_budget_sequence,
  (select count(*) from clued_control.execution_events
    where sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') as series_f,
  (select not_before from clued_control.accepted_binding)                          as ab_not_before,
  (select expires_at  from clued_control.accepted_binding)                         as ab_expires_at,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_gate(text,text)'::regprocedure)              as prosrc_reserve_gate,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.reserve_execution_budget(text,text)'::regprocedure)  as prosrc_reserve_budget,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.append_status_manifest(text,text)'::regprocedure)    as prosrc_append_status,
  (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc
     where oid='clued_control.effective_execution_binding()'::regprocedure)        as prosrc_effective_binding,
  (select controller_sha256 from clued_control.execution_binding)                  as base_controller_sha256,
  (select x.controller_sha256 from clued_control.effective_execution_binding() x)  as effective_controller_sha256,
  (select x.qualification_sha256 from clued_control.effective_execution_binding() x) as effective_qualification_sha256
from root;
