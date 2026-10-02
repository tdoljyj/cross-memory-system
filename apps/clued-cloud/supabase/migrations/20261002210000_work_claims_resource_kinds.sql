-- Generic Work Claim v0.1, rollout step 1 (development/contracts/
-- execution-admission/GenericWorkClaim.v0.1.md §2, §7.2; Task e9a10dbb).
--
-- A write_set entry may now be a typed resource "kind:value" besides a bare
-- repository path. Only kinds registered in work_claim_resource_kinds are
-- accepted, so an Agent cannot declare a scope nobody checks. Overlap is
-- judged per kind: same kind compares values with the v1 path rules, a bare
-- path is compared with the path part of a repo: resource (conservatively,
-- whatever the repository), other kinds never overlap. Write sets made only
-- of bare paths are judged exactly as before. No door is wired here: Clued
-- write tools and the GitHub check behave as before.

create table clued_private.work_claim_resource_kinds (
  kind text primary key check (kind ~ '^[a-z][a-z0-9-]{0,31}$'),
  doors text[] not null check (cardinality(doors)>0),
  note text not null,
  registered_at timestamptz not null default now()
);
revoke all on clued_private.work_claim_resource_kinds from public,anon,authenticated,service_role;

-- "claim-conflict": two live claims on the resource conflict at claim time
-- (and the holder is visible to every Agent through resume). Doors that check
-- writes against claims are added to "doors" when they are wired.
insert into clued_private.work_claim_resource_kinds(kind,doors,note) values
  ('repo',array['claim-conflict'],'repo:<owner>/<name>/<repository path or glob>'),
  ('storage',array['claim-conflict'],'storage:<connection_id>/<path under the registered root>'),
  ('record',array['claim-conflict'],'record:<canonical record id>; records keep their own CAS (Decision 357fce4f)');

-- One normalized entry to {kind, value}; kind is null for a bare path.
create function clued_private.work_claim_resource_split(p_entry text) returns text[]
language sql immutable set search_path='' as $$
  select case when p_entry ~ '^[a-z][a-z0-9-]{0,31}:'
    then array[split_part(p_entry,':',1),substr(p_entry,strpos(p_entry,':')+1)]
    else array[null,p_entry] end
$$;

-- Paths: trimmed, no leading "./" or "/", no empty or ".." segments, sorted,
-- distinct. Globs keep "*" and "**". An entry that starts with "<kind>:" is a
-- typed resource: the kind is lower-cased and must be registered, the value
-- follows the path rules and may not be empty. Anything else raises.
-- Stable, not immutable: it reads the kind registry.
create or replace function clued_private.work_claim_normalize_paths(p_paths jsonb) returns text[]
language plpgsql stable set search_path='' as $$
declare v_raw text; v_path text; v_kind text; v_out text[]:='{}'::text[];
begin
  if p_paths is null or jsonb_typeof(p_paths)<>'array' then
    raise exception 'work_claim_write_set_invalid' using errcode='22023'; end if;
  for v_raw in select e#>>'{}' from jsonb_array_elements(p_paths) e loop
    if v_raw is null then raise exception 'work_claim_write_set_invalid' using errcode='22023'; end if;
    v_path:=btrim(v_raw);
    v_kind:=null;
    if v_path ~ '^[A-Za-z][A-Za-z0-9-]{0,31}:' then
      v_kind:=lower(split_part(v_path,':',1));
      v_path:=substr(v_path,strpos(v_path,':')+1);
      if not exists(select 1 from clued_private.work_claim_resource_kinds k where k.kind=v_kind) then
        raise exception 'work_claim_resource_kind_unknown' using errcode='22023',
          detail=v_kind; end if;
    end if;
    v_path:=regexp_replace(v_path,'^(\./)+','');
    v_path:=regexp_replace(v_path,'^/+','');
    v_path:=regexp_replace(v_path,'/{2,}','/','g');
    v_path:=regexp_replace(v_path,'/+$','');
    if v_path='' or char_length(v_path)>400 or v_path ~ '(^|/)\.\.(/|$)'
      or v_path ~ '[[:space:][:cntrl:]]' then
      raise exception 'work_claim_write_set_invalid' using errcode='22023'; end if;
    if v_kind is not null then
      v_path:=v_kind||':'||v_path;
      if char_length(v_path)>400 then
        raise exception 'work_claim_write_set_invalid' using errcode='22023'; end if;
    end if;
    if not (v_path=any(v_out)) then v_out:=v_out||v_path; end if;
  end loop;
  if cardinality(v_out)=0 then raise exception 'work_claim_write_set_invalid' using errcode='22023'; end if;
  select array_agg(x order by x) into v_out from unnest(v_out) x;
  return v_out;
end $$;

-- The v1 overlap of two sets of bare paths, unchanged (20261002050000).
create function clued_private.work_claim_bare_overlap(p_a text[],p_b text[]) returns text[]
language sql immutable set search_path='' as $$
  with covered as (
    select coalesce(array_agg(distinct x order by x),'{}'::text[]) v from (
      select a x from unnest(p_a) a where clued_private.work_claim_path_covered(a,p_b)
      union
      select b x from unnest(p_b) b where clued_private.work_claim_path_covered(b,p_a)
    ) o
  ), intersecting as (
    select coalesce(array_agg(distinct x order by x),'{}'::text[]) v from (
      select a x from unnest(p_a) a
        where exists(select 1 from unnest(p_b) b where clued_private.work_claim_globs_intersect(a,b))
      union
      select b x from unnest(p_b) b
        where exists(select 1 from unnest(p_a) a where clued_private.work_claim_globs_intersect(a,b))
    ) o
  )
  select case when cardinality(covered.v)>0 then covered.v else intersecting.v end
  from covered,intersecting
$$;

-- The path part of a repo: value "<owner>/<name>/<path>". When the owner or
-- name segment holds a wildcard, or no path follows, the resource may be
-- anything in some repository: "**".
create function clued_private.work_claim_repo_path(p_value text) returns text
language sql immutable set search_path='' as $$
  select case when split_part(p_value,'/',1) ~ '\*' or split_part(p_value,'/',2) ~ '\*'
      or split_part(p_value,'/',3)='' then '**'
    else substr(p_value,char_length(split_part(p_value,'/',1))+char_length(split_part(p_value,'/',2))+3) end
$$;

-- Two single resources overlap (GenericWorkClaim §2.3).
create function clued_private.work_claim_resources_intersect(p_a text,p_b text) returns boolean
language plpgsql immutable set search_path='' as $$
declare a text[]:=clued_private.work_claim_resource_split(p_a);
  b text[]:=clued_private.work_claim_resource_split(p_b); va text; vb text;
begin
  if a[1] is not distinct from b[1] then va:=a[2]; vb:=b[2];
  elsif a[1] is null and b[1]='repo' then va:=a[2]; vb:=clued_private.work_claim_repo_path(b[2]);
  elsif a[1]='repo' and b[1] is null then va:=clued_private.work_claim_repo_path(a[2]); vb:=b[2];
  else return false; end if;
  return va=vb or clued_private.work_claim_path_covered(va,array[vb])
    or clued_private.work_claim_path_covered(vb,array[va])
    or clued_private.work_claim_globs_intersect(va,vb);
end $$;

-- Two write sets overlap. Only bare paths on both sides: the v1 result,
-- unchanged. Otherwise every entry of either side that intersects some entry
-- of the other, sorted and distinct.
create or replace function clued_private.work_claim_paths_overlap(p_a text[],p_b text[]) returns text[]
language sql immutable set search_path='' as $$
  select case
    when not exists(select 1 from unnest(p_a) x where (clued_private.work_claim_resource_split(x))[1] is not null)
     and not exists(select 1 from unnest(p_b) x where (clued_private.work_claim_resource_split(x))[1] is not null)
    then clued_private.work_claim_bare_overlap(p_a,p_b)
    else (select coalesce(array_agg(distinct x order by x),'{}'::text[]) from (
      select a x from unnest(p_a) a
        where exists(select 1 from unnest(p_b) b where clued_private.work_claim_resources_intersect(a,b))
      union
      select b x from unnest(p_b) b
        where exists(select 1 from unnest(p_a) a where clued_private.work_claim_resources_intersect(a,b))
    ) o)
  end
$$;

-- Coverage for verify (changed paths ⊆ write_set) stays literal: a bare
-- changed path is covered only by bare entries, because the GitHub door does
-- not yet tell which repository a repo: resource names. Unchanged here.

revoke all on function
  clued_private.work_claim_resource_split(text),
  clued_private.work_claim_normalize_paths(jsonb),
  clued_private.work_claim_bare_overlap(text[],text[]),
  clued_private.work_claim_repo_path(text),
  clued_private.work_claim_resources_intersect(text,text),
  clued_private.work_claim_paths_overlap(text[],text[])
from public,anon,authenticated,service_role;
