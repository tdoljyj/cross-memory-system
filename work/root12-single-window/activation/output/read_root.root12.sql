CREATE OR REPLACE FUNCTION clued_control.read_root(p_root_id text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
with x as (
 select a binding,h.sequence,h.generation_id,h.revoked,e.request->'body' generation_body,
        s.binding_id successor_binding_id,s.binding_sha256 successor_binding_sha256,
        s.not_before successor_not_before,s.expires_at successor_expires_at,
        se.sequence successor_registration_sequence
 from clued_control.accepted_binding a
 left join clued_control.current_head h using(root_id)
 left join clued_control.events e on e.root_id=h.root_id and e.sequence=h.sequence
 left join clued_control.successor_binding s on s.root_id=h.root_id and s.generation_id=h.generation_id
 left join clued_control.execution_events se on se.root_id=h.root_id
   and se.request->>'operation'='SUCCESSOR_BINDING_REGISTERED'
   and se.request->'body'->>'binding_id'=s.binding_id
 where a.root_id=p_root_id
)
select jsonb_build_object(
 'root_set_id',(x.binding).root_id,
 'metadata_binding_sha256',case when x.generation_id in ('ctrgen_308a1dfc185cff633892638581e0a34c','ctrgen_48100437d24e448ba01c542ebe1290da','ctrgen_c725e90a595c00a041754ede3b00f408','ctrgen_1cf79ef9a7ccc37800e8837ac8c10287')
   then x.successor_binding_sha256 else encode(sha256(convert_to(to_jsonb(x.binding)::text,'UTF8')),'hex') end,
 'state',case
   when x.generation_id='ctrgen_1cf79ef9a7ccc37800e8837ac8c10287'
        and x.sequence=12
        and x.successor_binding_id='sb_6aba4e3f3b33cabcb1171e10c70f40d2'
        and x.successor_registration_sequence=139
        and x.successor_not_before='2026-09-16T07:00:00Z'::timestamptz
        and x.successor_expires_at='2026-09-23T07:00:00Z'::timestamptz
        and x.generation_body->>'control_trust_root_generation'='ctrgen_1cf79ef9a7ccc37800e8837ac8c10287'
        and (x.generation_body->>'not_before')::timestamptz='2026-09-16T07:00:00Z'::timestamptz
        and (x.generation_body->>'expires_at')::timestamptz='2026-09-23T07:00:00Z'::timestamptz then
     case when statement_timestamp()<'2026-09-16T07:00:00Z'::timestamptz or statement_timestamp()>='2026-09-23T07:00:00Z'::timestamptz
          then 'EXPIRED_OR_NOT_YET_VALID' when coalesce(x.revoked,false) then 'REVOKED' else 'STORED_NO_GATE_AUTHORITY' end
   when x.generation_id='ctrgen_1cf79ef9a7ccc37800e8837ac8c10287' then 'EXPIRED_OR_NOT_YET_VALID'
   when x.generation_id='ctrgen_c725e90a595c00a041754ede3b00f408'
        and x.sequence=11
        and x.successor_binding_id='sb_873f7cf2f79fb3cb168138441e6fddbc'
        and x.successor_registration_sequence=132
        and x.successor_not_before='2026-09-16T04:00:00Z'::timestamptz
        and x.successor_expires_at='2026-09-23T04:00:00Z'::timestamptz
        and x.generation_body->>'control_trust_root_generation'='ctrgen_c725e90a595c00a041754ede3b00f408'
        and (x.generation_body->>'not_before')::timestamptz='2026-09-16T04:00:00Z'::timestamptz
        and (x.generation_body->>'expires_at')::timestamptz='2026-09-23T04:00:00Z'::timestamptz then
     case when statement_timestamp()<'2026-09-16T04:00:00Z'::timestamptz or statement_timestamp()>='2026-09-23T04:00:00Z'::timestamptz
          then 'EXPIRED_OR_NOT_YET_VALID' when coalesce(x.revoked,false) then 'REVOKED' else 'STORED_NO_GATE_AUTHORITY' end
   when x.generation_id='ctrgen_c725e90a595c00a041754ede3b00f408' then 'EXPIRED_OR_NOT_YET_VALID'
   when x.generation_id='ctrgen_48100437d24e448ba01c542ebe1290da'
        and x.sequence=10
        and x.successor_binding_id='sb_a39581761f6a4acba5d6216279ef5e88'
        and x.successor_registration_sequence=113
        and x.successor_not_before='2026-09-15T03:00:00Z'::timestamptz
        and x.successor_expires_at='2026-09-16T03:00:00Z'::timestamptz
        and x.generation_body->>'control_trust_root_generation'='ctrgen_48100437d24e448ba01c542ebe1290da'
        and (x.generation_body->>'not_before')::timestamptz='2026-09-15T03:00:00Z'::timestamptz
        and (x.generation_body->>'expires_at')::timestamptz='2026-09-16T03:00:00Z'::timestamptz then
     case when statement_timestamp()<'2026-09-15T03:00:00Z'::timestamptz or statement_timestamp()>='2026-09-16T03:00:00Z'::timestamptz
          then 'EXPIRED_OR_NOT_YET_VALID' when coalesce(x.revoked,false) then 'REVOKED' else 'STORED_NO_GATE_AUTHORITY' end
   when x.generation_id='ctrgen_48100437d24e448ba01c542ebe1290da' then 'EXPIRED_OR_NOT_YET_VALID'
   when x.generation_id='ctrgen_308a1dfc185cff633892638581e0a34c'
        and x.sequence=9
        and x.successor_binding_id='sb_201178b7a8111000d515f7f26a75a28b'
        and x.successor_registration_sequence=98
        and x.successor_not_before='2026-09-14T03:00:00Z'::timestamptz
        and x.successor_expires_at='2026-09-15T03:00:00Z'::timestamptz
        and x.generation_body->>'control_trust_root_generation'='ctrgen_308a1dfc185cff633892638581e0a34c'
        and (x.generation_body->>'not_before')::timestamptz='2026-09-14T03:00:00Z'::timestamptz
        and (x.generation_body->>'expires_at')::timestamptz='2026-09-15T03:00:00Z'::timestamptz then
     case when statement_timestamp()<'2026-09-14T03:00:00Z'::timestamptz
                or statement_timestamp()>='2026-09-15T03:00:00Z'::timestamptz
           then 'EXPIRED_OR_NOT_YET_VALID'
          when coalesce(x.revoked,false) then 'REVOKED' else 'STORED_NO_GATE_AUTHORITY' end
   when x.generation_id='ctrgen_308a1dfc185cff633892638581e0a34c'
     then 'EXPIRED_OR_NOT_YET_VALID'
   when statement_timestamp()<(x.binding).not_before or statement_timestamp()>=(x.binding).expires_at
     then 'EXPIRED_OR_NOT_YET_VALID'
   when coalesce(x.revoked,false) then 'REVOKED' else 'STORED_NO_GATE_AUTHORITY' end,
 'sequence',coalesce(x.sequence,0),'generation_id',x.generation_id,
 'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.sequence)
                    from clued_control.events e where e.root_id=(x.binding).root_id),'[]'::jsonb),
 'authority_effect','NONE')
from x
$function$;
