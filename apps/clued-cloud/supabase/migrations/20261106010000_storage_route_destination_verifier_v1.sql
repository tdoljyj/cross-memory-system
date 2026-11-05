-- storage_route_destination_v1 (20261031080000, Drive alignment item 3, Owner
-- Decision f382c494) finds the caller's storage client Binding by comparing
-- the stored token_hash with the caller's proof directly. Since
-- 20261008210000_credential_verifier_v1 the column holds the verifier of that
-- proof, so the comparison never matches: no root is found, nothing is placed
-- in 90_待归类, and a new file written where the layout does not allow it is
-- refused instead (Clued Task e21ff6fd). Compare with the verifier, as
-- storage_connection_path_v1 and every other caller of a stored credential do.
-- Placement has never run in production, so this makes Decision f382c494 live
-- there for the first time; releasing it takes an Owner Grant.
-- Only that comparison changes; the definition must be the one 20261031080000
-- created, or the migration stops.
do $migration$
declare
  body text := pg_catalog.pg_get_functiondef('clued_private.storage_route_destination_v1(text,uuid,text)'::regprocedure);
  anchor constant text := 'where b.token_hash=p_hash and b.revoked_at is null;';
  rewritten constant text := 'where b.token_hash=clued_private.credential_verifier_v1(p_hash) and b.revoked_at is null;';
  hits int;
begin
  -- A second run finds the comparison already rewritten.
  if strpos(body, anchor) = 0 and strpos(body, rewritten) > 0 then return; end if;
  hits := (length(body) - length(replace(body, anchor, ''))) / length(anchor);
  -- No anchor and no rewrite (hits = 0) means some other definition: stop too.
  if hits <> 1 then
    raise exception 'storage_route_verifier_definition_mismatch' using detail = format('%s of 1 comparison', hits);
  end if;
  execute replace(body, anchor, rewritten);
end $migration$;

-- As 20261008210000 step 5: afterwards nothing compares a stored credential
-- with a raw parameter. The two issuer functions compare issuer hashes and are
-- the only expected matches; to_regprocedure lets either be absent.
do $guard$
declare
  hits text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into hits
    from pg_catalog.pg_proc p
   where p.pronamespace in ('public'::regnamespace, 'clued_private'::regnamespace)
     and p.prokind = 'f'
     and p.oid is distinct from pg_catalog.to_regprocedure('clued_private.authorization_issuer_v12(text,text)')
     and p.oid is distinct from pg_catalog.to_regprocedure('clued_private.ii_priv_authorization_issuer_v12(text,text)')
     and pg_catalog.pg_get_functiondef(p.oid) ~
       '(?<![\w.])(?<!set )(?:\w+\.)?(?:token_hash|old_token_hash|old_reader_hash|old_writer_hash|authority_token_hash)\s*(?:=|<>|is distinct from|is not distinct from)\s*(?:p_\w+|h|reader_hash|writer_hash)(?!\w)';
  if hits is not null then
    raise exception 'credential_verifier_raw_comparison' using detail = hits;
  end if;
end
$guard$;
