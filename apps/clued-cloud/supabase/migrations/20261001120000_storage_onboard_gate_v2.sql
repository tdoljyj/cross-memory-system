-- StorageNormalUse N0 gate v2 (Owner Decision ba02734a, 2026-10-01).
--
-- Self-service onboarding no longer requires storage_oauth_apps_v1
-- .execution_enabled. That switch gates storage write jobs; onboarding is an
-- Owner action on the native page that only creates the root, its tracks and
-- the connection. begin and activate now require read_enabled (plus, as
-- before, the allowlist or the verified opening onboard_open, and the Worker
-- flag CLUED_STORAGE_ONBOARD_V1). Nothing else changes.
--
-- Correction to the 20261001040000 header (lock order): on activate the OAuth
-- attempt row is locked inside storage_onboard_activate_v1, after the
-- per-owner onboard lock and the owner||root lock, not before them. The claim
-- path takes onboard row -> OAuth attempt row -> per-owner lock. Both paths
-- take the onboard row first, so they serialise on it and cannot deadlock.

do $migration$
declare body text; hits int;
  anchor constant text:=$a$if not (a.execution_enabled and a.read_enabled) then raise exception 'storage_onboard_unavailable' using errcode='42501'; end if;$a$;
  replacement constant text:=$r$if not a.read_enabled then raise exception 'storage_onboard_unavailable' using errcode='42501'; end if;$r$;
begin
  body:=pg_get_functiondef('public.clued_storage_onboard_v1(text,jsonb)'::regprocedure);
  hits:=(length(body)-length(replace(body,anchor,'')))/length(anchor);
  if hits<>2 then
    raise exception 'storage_onboard_gate_definition_mismatch: % of 2',hits;
  end if;
  execute replace(body,anchor,replacement);
end $migration$;
