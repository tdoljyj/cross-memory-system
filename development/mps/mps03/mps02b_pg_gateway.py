#!/usr/bin/env python3
"""MPS-03 HTTP gateway bound to the existing MPS-02A/02B PostgreSQL primitives.

NON-PRODUCTION ONLY. This module deliberately reuses the exact durable primitives:
  mps_issue_context_pack
  mps_register_change_set
  mps_issue_mutation_intent
  mps_compute_request_fingerprint
  mps_commit_mutation

It does not reimplement Current/CAS/Receipt semantics in the entry adapters.
"""
from __future__ import annotations
import argparse, base64, ipaddress, json, os, re, secrets, shutil, subprocess, threading
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit, urlunsplit

try:
    from .common import ProtocolError, new_id, sha256_json, validate_create_content, normalize_request_id, require_secret_namespace, NATIVE_GATEWAY_PREFIX, AGENT_GATEWAY_PREFIX
    from .gateway_http import Handler
except ImportError:
    from common import ProtocolError, new_id, sha256_json, validate_create_content, normalize_request_id, require_secret_namespace, NATIVE_GATEWAY_PREFIX, AGENT_GATEWAY_PREFIX
    from gateway_http import Handler

try:
    from mps04.github_readonly import GitHubReadOnlyProvider, ProviderUnavailable
except ImportError:
    from development.mps.mps04.github_readonly import GitHubReadOnlyProvider, ProviderUnavailable

EXPECTED_NONPROD_TARGET = "clued-auth-test/uscrdifznmlvczcekqpw"
EXPECTED_PROJECT_REF = "uscrdifznmlvczcekqpw"
EXPECTED_PROVIDER_REPOSITORY = "tdoljyj/cross-memory-system"
EXPECTED_PROVIDER_REMOTE = "https://github.com/tdoljyj/cross-memory-system.git"
TRUSTED_PROVIDER_CONTEXT_MODE = "TRUSTED_CLEAN_GIT_HEAD"
MPS03_PROPOSAL_PURPOSE = "mps03_accept_agent_proposal"


def _assert_nonprod_dsn(dsn: str) -> None:
    """Bind the write-capable entry to the named Supabase project, not a label."""
    try:
        uri = urlsplit(dsn)
        host, port = uri.hostname, uri.port or 5432
        user = unquote(uri.username or "")
        options = parse_qsl(uri.query, keep_blank_values=True, strict_parsing=True)
    except (TypeError, ValueError) as error:
        raise RuntimeError("non-production database connection target rejected") from error
    if uri.scheme not in {"postgres", "postgresql"} or uri.fragment or not host or port != 5432:
        raise RuntimeError("non-production database connection target rejected")
    if unquote(uri.path) != "/postgres":
        raise RuntimeError("non-production database connection target rejected")
    if len({key for key, _ in options}) != len(options):
        raise RuntimeError("non-production database connection target rejected")
    settings = dict(options)
    if set(settings) - {"sslmode", "sslrootcert", "connect_timeout", "application_name"}:
        raise RuntimeError("non-production database connection target rejected")
    if settings.get("sslmode") != "verify-full":
        raise RuntimeError("non-production database connection requires sslmode=verify-full")
    direct = host == f"db.{EXPECTED_PROJECT_REF}.supabase.co" and user == "postgres"
    session_pooler = (
        re.fullmatch(r"aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com", host) is not None
        and user == f"postgres.{EXPECTED_PROJECT_REF}"
    )
    if not (direct or session_pooler):
        raise RuntimeError("non-production database connection target rejected")


def _assert_entry_bindings(native_principal: str, agent_principal: str,
                           native_secret: str, agent_secret: str) -> None:
    if (not native_principal or not agent_principal or native_principal == agent_principal):
        raise RuntimeError("Native and Agent principals must be distinct and nonempty")
    require_secret_namespace(native_secret,NATIVE_GATEWAY_PREFIX,"Native gateway secret")
    require_secret_namespace(agent_secret,AGENT_GATEWAY_PREFIX,"Agent gateway secret")


def _assert_loopback_host(host: str) -> None:
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise RuntimeError("MPS-03 gateway must bind to loopback")


def _trusted_provider_context(mode: str) -> tuple[list[dict[str, str]], str | None]:
    """Bind optional D-003 provider context to a verified clean Git exact head."""
    if not mode:
        return [], None
    if mode != TRUSTED_PROVIDER_CONTEXT_MODE:
        raise RuntimeError("unsupported provider context mode")
    if not shutil.which("git"):
        raise RuntimeError("git is required for trusted provider context")

    def git(*args: str) -> str:
        try:
            completed = subprocess.run(
                ["git", *args], text=True, capture_output=True, timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError("trusted provider context Git verification failed") from error
        if completed.returncode:
            raise RuntimeError("trusted provider context Git verification failed")
        return completed.stdout.strip()

    root = git("rev-parse", "--show-toplevel")
    head = git("rev-parse", "HEAD")
    remote = git("remote", "get-url", "origin")
    dirty = git("status", "--porcelain")
    try:
        same_root = os.path.samefile(root, os.getcwd())
    except OSError:
        same_root = False
    if not same_root:
        raise RuntimeError("trusted provider context requires the gateway working tree root")
    if remote != EXPECTED_PROVIDER_REMOTE:
        raise RuntimeError("trusted provider context repository rejected")
    if re.fullmatch(r"[0-9a-f]{40}", head) is None:
        raise RuntimeError("trusted provider context exact commit rejected")
    if dirty:
        raise RuntimeError("trusted provider context requires a clean worktree")
    evidence_refs = [{
        "evidence_type": "git_exact_head",
        "repository": EXPECTED_PROVIDER_REPOSITORY,
        "remote_url": EXPECTED_PROVIDER_REMOTE,
        "exact_commit": head,
        "verification": "gateway_startup_clean_worktree",
    }]
    return evidence_refs, head


def _b64(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("ascii")

def _t(name: str) -> str:
    return f"convert_from(decode(:'{name}','base64'),'UTF8')"

def _j(name: str) -> str:
    return f"({_t(name)})::jsonb"

class PgMPS02BStore:
    backend_name = "MPS02B_POSTGRES"
    def __init__(self, dsn: str, *, user_id: str, authority_domain: str,
                 native_principal: str, agent_principal: str,
                 native_secret: str, agent_secret: str,
                 target_id: str, allow_nonprod_write: str,
                 provider_context_mode: str = "", github_provider=None):
        if target_id != EXPECTED_NONPROD_TARGET:
            raise RuntimeError(f"target guard failed: expected {EXPECTED_NONPROD_TARGET}")
        if allow_nonprod_write != "MPS03_NONPROD_WRITE_APPROVED":
            raise RuntimeError("explicit non-production write guard not satisfied")
        _assert_nonprod_dsn(dsn)
        _assert_entry_bindings(native_principal,agent_principal,native_secret,agent_secret)
        if not shutil.which("psql"):
            raise RuntimeError("psql is required for mps02b_pg_gateway")
        self.dsn=dsn; self.user_id=user_id; self.authority_domain=authority_domain
        self.native_principal=native_principal; self.agent_principal=agent_principal
        self.native_secret=native_secret; self.agent_secret=agent_secret
        self.provider_evidence_refs,self.provider_exact_commit = _trusted_provider_context(provider_context_mode)
        self.github_provider = github_provider
        self.sessions={}; self._lock=threading.RLock()
        self._assert_primitives()

    def _psql(self, sql: str, variables: dict[str,str] | None=None) -> str:
        uri=urlsplit(self.dsn)
        password=unquote(uri.password or "")
        # Keep the connection password out of the process command line.
        authority=uri.netloc.rsplit("@",1)
        if len(authority)==2:
            user=authority[0].split(":",1)[0]
            uri=uri._replace(netloc=f"{user}@{authority[1]}")
        cmd=["psql",urlunsplit(uri),"-X","-A","-t","-q","-v","ON_ERROR_STOP=1"]
        for k,v in (variables or {}).items(): cmd += ["-v",f"{k}={_b64(v)}"]
        env=os.environ.copy()
        for key in ("PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGSERVICE", "PGPASSWORD"):
            env.pop(key, None)
        if password:
            env["PGPASSWORD"]=password
        env.setdefault("PGOPTIONS","-c client_min_messages=warning")
        try:
            p=subprocess.run(cmd,input=sql,text=True,capture_output=True,env=env,timeout=30)
        except subprocess.TimeoutExpired:
            raise ProtocolError("MPS02B_POSTGRES_TIMEOUT","database operation timed out",503) from None
        if p.returncode:
            err=(p.stderr or p.stdout).strip()
            mapping=[
                ("STALE_CONTEXT_REQUIRES_REFRESH",409), ("IDEMPOTENCY_CONFLICT",409),
                ("CONFIRMATION_TARGET_CHANGED",409), ("INTENT_IDENTITY_CONFLICT",409),
                ("MPS_AUTHORIZATION_DENIED",403), ("MPS_RESULT_READ_DENIED",403),
                ("OBJECT_NOT_FOUND",404),
                ("MPS_CONTEXT_BASIS_NOT_FOUND_OR_INCONSISTENT",404), ("MPS_INTENT_NOT_FOUND",404),
            ]
            for code,status in mapping:
                if code in err: raise ProtocolError(code,code,status)
            raise ProtocolError("MPS02B_POSTGRES_ERROR","MPS-02B database operation failed",500)
        lines=[x.strip() for x in p.stdout.splitlines() if x.strip()]
        return lines[-1] if lines else ""

    def _json(self, sql: str, variables: dict[str,str] | None=None) -> dict:
        raw=self._psql(sql,variables)
        if not raw: return {"ok":True}
        try:return json.loads(raw)
        except Exception: raise ProtocolError("MPS02B_INVALID_DB_RESPONSE","database did not return JSON",500) from None

    def _assert_primitives(self):
        sql="""
select jsonb_build_object(
 'ok',
 to_regprocedure('clued_private.mps_issue_context_pack(text,text,text,text,jsonb,text)') is not null
 and to_regprocedure('clued_private.mps_register_change_set(text,text,jsonb)') is not null
 and to_regprocedure('clued_private.mps_issue_mutation_intent(jsonb)') is not null
 and to_regprocedure('clued_private.mps_compute_request_fingerprint(jsonb,jsonb)') is not null
 and to_regprocedure('clued_private.mps_commit_mutation(text,text,text,jsonb)') is not null
)::text;
"""
        r=self._json(sql)
        if r.get("ok") is not True: raise RuntimeError("required MPS-02B primitives are not installed")
        if self.github_provider is not None:
            r=self._json("""
select jsonb_build_object(
 'ok',
 to_regprocedure('clued_private.mps_register_provider_observation(text,text,text,text,jsonb)') is not null
 and to_regprocedure('clued_private.mps_ignore_provider_observation(text,text,text,text)') is not null
 and to_regprocedure('clued_private.mps_adopt_provider_observation(text,text,text,text,jsonb)') is not null
)::text;
""")
            if r.get("ok") is not True:
                raise RuntimeError("required MPS-04 provider observation primitives are not installed")

    def create_session(self, entry_kind: str, entry_secret: str) -> dict:
        mapping={"NATIVE":(self.native_secret,self.native_principal),"THIRD_PARTY_AGENT_HOST":(self.agent_secret,self.agent_principal)}
        if entry_kind not in mapping: raise ProtocolError("ENTRY_KIND_REJECTED","unsupported entry kind",403)
        expected,principal=mapping[entry_kind]
        if not isinstance(entry_secret,str) or not secrets.compare_digest(entry_secret,expected):
            raise ProtocolError("ENTRY_AUTHENTICATION_FAILED","entry credential rejected",401)
        token=new_id("sess"); self.sessions[token]={"principal":principal,"entry_kind":entry_kind}
        return {"ok":True,"session_token":token,"principal":principal,"entry_kind":entry_kind}

    def _session(self,token):
        s=self.sessions.get(token)
        if not s: raise ProtocolError("SESSION_REQUIRED","valid session token required",401)
        return s
    def _require(self,s,action):
        allowed={self.native_principal:{"read","create","confirm","history"},self.agent_principal:{"read","propose","history"}}
        if action not in allowed.get(s["principal"],set()): raise ProtocolError("ACTION_NOT_AUTHORIZED",f"principal cannot {action}",403)

    def _provider_variables(self) -> dict[str, str]:
        return {
            "evidence_refs": json.dumps(
                self.provider_evidence_refs, ensure_ascii=False, separators=(",", ":"),
            ),
            "provider_commit": self.provider_exact_commit or "",
        }

    def _assert_object_owner(self, object_id: str) -> None:
        result=self._json(f"""
select jsonb_build_object('owned',exists(
 select 1 from clued_private.mps_objects o where o.object_id={_t('oid')} and o.user_id=({_t('uid')})::uuid
))::text;
""",{"oid":object_id,"uid":self.user_id})
        if result.get("owned") is not True:
            raise ProtocolError("OBJECT_NOT_FOUND","object not found",404)

    def _read_for(self, principal: str, object_id: str, action: str="read") -> dict:
        self._assert_object_owner(object_id)
        # The pack function is VOLATILE and uses a fresh inner snapshot. Reading
        # Current in the same outer SELECT can pair its stamp with an older body.
        issued=self._json(
            f"select clued_private.mps_issue_context_pack({_t('oid')},{_t('domain')},{_t('principal')},{_t('action')},{_j('evidence_refs')},nullif({_t('provider_commit')},''))::text;",
            {"oid":object_id,"domain":self.authority_domain,"principal":principal,
             "action":action,**self._provider_variables()},
        )
        pack=issued.get("context_pack") or {}
        if (pack.get("provider_exact_commit") != self.provider_exact_commit
                or pack.get("provenance_evidence_refs") != self.provider_evidence_refs):
            raise ProtocolError("MPS02B_INCONSISTENT_CONTEXT_READ","provider context is inconsistent",500)
        stamp=pack.get("composite_state_stamp") or {}
        revision=pack.get("exact_revision") or {}
        adoption=pack.get("adoption") or {}
        revision_id=revision.get("revision_id")
        revision_digest=revision.get("revision_digest")
        adoption_id=adoption.get("adoption_id")
        if (not issued.get("pack_digest") or pack.get("object_identity",{}).get("object_id") != object_id
                or stamp.get("object_id") != object_id or stamp.get("current_revision_id") != revision_id
                or stamp.get("current_adoption_id") != adoption_id or not revision_digest):
            raise ProtocolError("MPS02B_INCONSISTENT_CONTEXT_READ","context pack identity is inconsistent",500)
        # Revisions and adoptions are immutable. A later statement can safely
        # fetch the exact revision named by the pack even if Current advances.
        result=self._json(f"""
select jsonb_build_object('ok',true,'object_id',{_t('oid')},
 'title',coalesce(r.content->>'title','Untitled'),'revision_id',r.revision_id,
 'revision_digest',r.revision_digest,'adoption_id',a.adoption_id,'body',r.content)::text
from clued_private.mps_revisions r join clued_private.mps_adoptions a
 on a.object_id=r.object_id and a.revision_id=r.revision_id
where r.object_id={_t('oid')} and r.revision_id={_t('rid')}
 and r.revision_digest={_t('digest')} and a.adoption_id={_t('aid')};
""",{"oid":object_id,"rid":revision_id,"digest":revision_digest,"aid":adoption_id})
        if (result.get("revision_id") != revision_id or result.get("revision_digest") != revision_digest
                or result.get("adoption_id") != adoption_id or not isinstance(result.get("body"),dict)):
            raise ProtocolError("MPS02B_INCONSISTENT_CONTEXT_READ","exact revision is not available",500)
        raw_stamp=dict(stamp)
        digest=pack.get("state_stamp_digest")
        if not digest:
            raise ProtocolError("MPS02B_INCONSISTENT_CONTEXT_READ","context stamp digest is missing",500)
        raw_stamp["state_stamp_digest"]=digest
        result.update({"state_stamp":raw_stamp,"state_stamp_digest":digest,
                       "context_pack_digest":issued["pack_digest"],"context_pack":pack})
        return result

    def create_object(self, token: str, title: str, body: dict, request_id: str) -> dict:
        s=self._session(token); self._require(s,"create")
        request_id=normalize_request_id(request_id)
        content=validate_create_content(title,body)
        # The installed MPS-02B commit primitive requires an existing Object/Current.
        # Build that otherwise-invisible basis and the formal create MutationIntent in the
        # same transaction. The only durable request/outcome/Receipt commit is still
        # mps_commit_mutation; the adapter does not maintain a second idempotency store.
        sql=f"""
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'clued-mps-request:'||{_t('domain')}||':'||{_t('principal')}||':'||{_t('request_id')},0));
create temp table _mps03_create_input(
  authority_domain_id text, principal text, request_id text, user_id uuid,
  native_principal text, agent_principal text, content jsonb,
  evidence_refs jsonb, provider_commit text
) on commit drop;
insert into _mps03_create_input values(
  {_t('domain')},{_t('principal')},{_t('request_id')},({_t('uid')})::uuid,
  {_t('native')},{_t('agent')},{_j('content')},
  {_j('evidence_refs')},nullif({_t('provider_commit')},'')
);
create temp table _mps03_create_result(payload jsonb) on commit drop;
do $mps03$
declare
  v_in _mps03_create_input%rowtype;
  v_existing clued_private.mps_request_outcomes%rowtype;
  v_existing_intent jsonb;
  v_existing_stamp jsonb;
  v_existing_content jsonb;
  v_oid text;
  v_rid text;
  v_aid text;
  v_wf text;
  v_bind text;
  v_change_id text;
  v_pack jsonb;
  v_change jsonb;
  v_intent jsonb;
  v_stamp jsonb;
  v_fingerprint text;
  v_outcome jsonb;
begin
  select * into strict v_in from _mps03_create_input;
  select q.* into v_existing
    from clued_private.mps_request_outcomes q
   where q.authority_domain_id=v_in.authority_domain_id
     and q.stable_request_principal_id=v_in.principal
     and q.request_id=v_in.request_id;
  if found then
    if not exists(select 1 from clued_private.mps_objects o
                  where o.object_id=v_existing.object_id and o.user_id=v_in.user_id) then
      raise exception 'OBJECT_NOT_FOUND' using errcode='P0001';
    end if;
    select i.intent_body, c.state_stamp, ch.change_body->'content'
      into v_existing_intent, v_existing_stamp, v_existing_content
      from clued_private.mps_mutation_intents i
      join clued_private.mps_context_packs c
        on c.object_id=i.object_id and c.pack_digest=i.context_pack_digest
      join clued_private.mps_change_sets ch
        on ch.object_id=i.object_id and ch.change_id=i.proposal_or_change_id
       and ch.change_digest=i.proposal_or_change_digest
     where i.intent_id=v_existing.intent_id and i.operation='create';
    if not found or v_existing_content is distinct from v_in.content then
      insert into _mps03_create_result values(
        pg_catalog.jsonb_build_object('ok',false,'status','conflict','error','IDEMPOTENCY_CONFLICT'));
      return;
    end if;
    v_outcome:=clued_private.mps_commit_mutation(
      v_in.authority_domain_id,v_in.principal,v_in.request_id,
      pg_catalog.jsonb_build_object(
        'confirmation_intent',v_existing_intent,
        'composite_state_stamp',v_existing_stamp,
        'request_fingerprint',v_existing.request_fingerprint));
    insert into _mps03_create_result values(
      pg_catalog.jsonb_build_object('ok',v_outcome->>'status'='committed','object_id',v_existing.object_id) || v_outcome);
    return;
  end if;

  v_oid:=clued_private.mps_new_id('obj');
  v_rid:=clued_private.mps_new_id('rv');
  v_aid:=clued_private.mps_new_id('ad');
  v_wf:=clued_private.mps_new_id('wf');
  v_bind:=clued_private.mps_new_id('bind');
  insert into clued_private.mps_objects(object_id,user_id,object_type)
    values(v_oid,v_in.user_id,'personal_plan');
  insert into clued_private.mps_revisions(object_id,revision_id,revision_digest,content)
    values(
      v_oid,v_rid,
       clued_private.mps_json_v1_sha256('{{"_mps03_bootstrap":1}}'::jsonb),
       '{{"_mps03_bootstrap":1}}'::jsonb);
  insert into clued_private.mps_adoptions(object_id,adoption_id,revision_id,adoption_scope,adoption_purpose)
    values(v_oid,v_aid,v_rid,'object','mps03_create_bootstrap');
  insert into clued_private.mps_workflow_versions(
    object_id,workflow_instance_id,workflow_instance_version,workflow_binding_id,workflow_payload)
    values(v_oid,v_wf,1,v_bind,'{{"profile":"personal_simple","mps_stage":"MPS-03"}}'::jsonb);
  insert into clued_private.mps_state_heads(
    object_id,current_revision_id,current_adoption_id,workflow_instance_id,
    workflow_instance_version,workflow_binding_id,context_compilation_generation)
    values(v_oid,v_rid,v_aid,v_wf,1,v_bind,1);
  insert into clued_private.mps_authorization_states(
    authority_domain_id,stable_request_principal_id,object_id,action,
    authorization_generation,allowed,reason)
  values
    (v_in.authority_domain_id,v_in.native_principal,v_oid,'read',1,true,'MPS03 Native read'),
    (v_in.authority_domain_id,v_in.native_principal,v_oid,'create',1,true,'MPS03 Native create'),
    (v_in.authority_domain_id,v_in.native_principal,v_oid,'update',1,true,'MPS03 Native confirm'),
    (v_in.authority_domain_id,v_in.agent_principal,v_oid,'read',1,true,'MPS03 Agent read'),
    (v_in.authority_domain_id,v_in.agent_principal,v_oid,'propose',1,true,'MPS03 Agent propose');

  v_pack:=clued_private.mps_issue_context_pack(
    v_oid,v_in.authority_domain_id,v_in.principal,'create',
    v_in.evidence_refs,v_in.provider_commit);
  v_change_id:=clued_private.mps_new_id('chg');
  v_change:=clued_private.mps_register_change_set(
    v_oid,v_change_id,pg_catalog.jsonb_build_object('mode','REPLACE_JSON_V1','content',v_in.content));
  v_intent:=clued_private.mps_issue_mutation_intent(pg_catalog.jsonb_build_object(
    'context_pack_digest',v_pack->>'pack_digest','object_id',v_oid,'operation','create',
    'proposal_or_change_id',v_change->>'change_id','proposal_or_change_digest',v_change->>'change_digest',
    'target_revision',pg_catalog.jsonb_build_object(
      'mode','DERIVE_FROM_EXACT_CHANGE','change_id',v_change->>'change_id','change_digest',v_change->>'change_digest'),
    'adoption_scope','object','adoption_purpose','create'));
  v_stamp:=v_pack#>'{{context_pack,composite_state_stamp}}';
  v_fingerprint:=clued_private.mps_compute_request_fingerprint(v_intent,v_stamp);
  v_outcome:=clued_private.mps_commit_mutation(
    v_in.authority_domain_id,v_in.principal,v_in.request_id,
    pg_catalog.jsonb_build_object(
       'confirmation_intent',v_intent,'composite_state_stamp',v_stamp,'request_fingerprint',v_fingerprint));
  if v_outcome->>'status' is distinct from 'committed' then
    raise exception 'MPS03_CREATE_NOT_COMMITTED:%',coalesce(v_outcome->>'error','unknown') using errcode='P0001';
  end if;
  insert into _mps03_create_result values(
    pg_catalog.jsonb_build_object('ok',v_outcome->>'status'='committed','object_id',v_oid) || v_outcome);
end
$mps03$;
select payload::text from _mps03_create_result;
commit;
"""
        outcome=self._json(sql,{"uid":self.user_id,"content":json.dumps(content,ensure_ascii=False,separators=(",",":")),
            "domain":self.authority_domain,"principal":s["principal"],"request_id":request_id,
            "native":self.native_principal,"agent":self.agent_principal,
            **self._provider_variables()})
        if outcome.get("status") == "committed":
            return {"ok":True,**outcome,"revision_id":outcome.get("result_revision_id"),
                "adoption_id":outcome.get("result_adoption_id")}
        return outcome

    def read_object(self, token: str, object_id: str) -> dict:
        s=self._session(token); self._require(s,"read")
        result=self._read_for(s["principal"],object_id,"read")
        result["read_state_stamp"]=result["state_stamp"]
        next_action="propose" if s["entry_kind"]=="THIRD_PARTY_AGENT_HOST" else "update"
        try:
            action_result=self._read_for(s["principal"],object_id,next_action)
        except ProtocolError as error:
            if error.status == 403:
                result["state_stamp_action"]="read"
                return result
            raise
        def current_part(stamp):
            return {key:value for key,value in stamp.items()
                    if key not in {"authorization_generation","state_stamp_digest"}}
        if current_part(result["state_stamp"]) != current_part(action_result["state_stamp"]):
            raise ProtocolError("STALE_CONTEXT_REQUIRES_REFRESH","Current changed during read",409)
        for key in ("state_stamp","state_stamp_digest","context_pack_digest","context_pack"):
            result[key]=action_result[key]
        result["state_stamp_action"]=next_action
        return result

    def provider_observation(self, token: str, object_id: str) -> dict:
        # Reuse the canonical object read for Resource x Action and ownership checks.
        current = self.read_object(token, object_id)
        body = current.get("body")
        if not isinstance(body, dict) or body.get("repository") != EXPECTED_PROVIDER_REPOSITORY:
            raise ProtocolError("MPS04_PROVIDER_NOT_APPLICABLE", "object has no bound code repository", 404)
        adopted = body.get("adopted_exact_commit")
        if self.github_provider is None:
            raise ProtocolError("MPS04_PROVIDER_NOT_CONFIGURED", "provider observation is unavailable", 503)
        if self.github_provider.repository != EXPECTED_PROVIDER_REPOSITORY:
            raise ProtocolError("MPS04_PROVIDER_BINDING_MISMATCH", "provider repository binding differs", 503)
        try:
            observed = self.github_provider.observe(adopted)
        except ProviderUnavailable:
            raise ProtocolError("MPS04_PROVIDER_UNAVAILABLE", "provider observation is unavailable", 503) from None
        latest = self.read_object(token, object_id)
        if (latest.get("revision_id") != current.get("revision_id")
                or latest.get("adoption_id") != current.get("adoption_id")):
            raise ProtocolError("STALE_CONTEXT_REQUIRES_REFRESH", "Clued Current changed during provider observation", 409)
        registered=self._json(
            f"select clued_private.mps_register_provider_observation("
            f"{_t('oid')},{_t('domain')},{_t('reader')},{_t('native')},{_j('observation')})::text;",
            {"oid":object_id,"domain":self.authority_domain,"reader":self._session(token)["principal"],
             "native":self.native_principal,
             "observation":json.dumps(observed,ensure_ascii=False,separators=(",",":"))},
        )
        registered["object_id"] = object_id
        registered["clued_revision_id"] = current.get("revision_id")
        registered["clued_adoption_id"] = current.get("adoption_id")
        registered["clued_current_changed"] = False
        return registered

    def ignore_provider_observation(self, token: str, object_id: str,
                                    observation_id: str, request_id: str) -> dict:
        s=self._session(token); self._require(s,"confirm")
        request_id=normalize_request_id(request_id)
        self._assert_object_owner(object_id)
        outcome=self._json(
            f"select clued_private.mps_ignore_provider_observation("
            f"{_t('observation_id')},{_t('domain')},{_t('principal')},{_t('request_id')})::text;",
            {"observation_id":observation_id,"domain":self.authority_domain,
             "principal":s["principal"],"request_id":request_id},
        )
        if (outcome.get("observation_id") not in (None,observation_id)
                or outcome.get("object_id") not in (None,object_id)):
            raise ProtocolError("MPS02B_INCONSISTENT_CONTEXT_READ","observation identity is inconsistent",500)
        return outcome

    def adopt_provider_observation(self, token: str, object_id: str,
                                   observation_id: str, state_stamp: dict,
                                   request_id: str) -> dict:
        s=self._session(token); self._require(s,"confirm")
        request_id=normalize_request_id(request_id)
        if not isinstance(state_stamp,dict):
            raise ProtocolError("STATE_STAMP_REQUIRED","state_stamp must be an object",400)
        self._assert_object_owner(object_id)
        submitted_stamp={k:v for k,v in state_stamp.items() if k!="state_stamp_digest"}
        outcome=self._json(
            f"select clued_private.mps_adopt_provider_observation("
            f"{_t('observation_id')},{_t('domain')},{_t('principal')},"
            f"{_t('request_id')},{_j('stamp')})::text;",
            {"observation_id":observation_id,"domain":self.authority_domain,
             "principal":s["principal"],"request_id":request_id,
             "stamp":json.dumps(submitted_stamp,ensure_ascii=False,separators=(",",":"))},
        )
        if (outcome.get("observation_id") not in (None,observation_id)
                or outcome.get("object_id") not in (None,object_id)):
            raise ProtocolError("MPS02B_INCONSISTENT_CONTEXT_READ","observation identity is inconsistent",500)
        return outcome

    def list_objects(self, token: str) -> dict:
        s=self._session(token); self._require(s,"read")
        # Candidate enumeration is not authority. Every returned object must pass the
        # existing Resource × Action check inside mps_issue_context_pack.
        sql=f"""
select coalesce(jsonb_agg(o.object_id order by o.created_at),'[]'::jsonb)::text
from clued_private.mps_objects o where o.user_id=({_t('uid')})::uuid;
"""
        raw=self._psql(sql,{"uid":self.user_id}) or "[]"
        object_ids=json.loads(raw)
        visible=[]
        for oid in object_ids:
            try:
                current=self._read_for(s["principal"],oid,"read")
            except ProtocolError as e:
                # Enumeration is not authority. Omit objects that are no longer
                # readable or lack a complete Current instead of failing the page.
                if e.status in (403, 404):
                    continue
                raise
            visible.append({"object_id":oid,"title":current.get("title","Untitled"),"revision_id":current.get("revision_id"),"adoption_id":current.get("adoption_id")})
        return {"ok":True,"objects":visible}

    def create_proposal(self, token: str, object_id: str, proposed_body: dict, observed_state_stamp: dict) -> dict:
        s=self._session(token); self._require(s,"propose")
        if not isinstance(proposed_body,dict):
            raise ProtocolError("JSON_OBJECT_REQUIRED","proposed body must be a JSON object",400)
        if not isinstance(observed_state_stamp,dict):
            raise ProtocolError("OBSERVED_STATE_REQUIRED","Agent proposal must include an observed state object",400)
        observed_digest=observed_state_stamp.get("state_stamp_digest")
        if not observed_digest:
            raise ProtocolError("STATE_STAMP_DIGEST_REQUIRED","Agent proposal must bind the exact state it observed",400)
        self._assert_object_owner(object_id)
        observed_stamp={k:v for k,v in observed_state_stamp.items() if k!="state_stamp_digest"}
        sql=f"""
with cp as (
 select clued_private.mps_issue_context_pack({_t('oid')},{_t('domain')},{_t('principal')},'propose',
  {_j('evidence_refs')},nullif({_t('provider_commit')},'')) p
), guard as (
 select p from cp where p#>>'{{context_pack,state_stamp_digest}}'={_t('observed_digest')}
  and p#>'{{context_pack,composite_state_stamp}}'={_j('observed_stamp')}
), native_pack as (
 select clued_private.mps_issue_context_pack({_t('oid')},{_t('domain')},{_t('native')},'update',
  {_j('evidence_refs')},nullif({_t('provider_commit')},'')) p
 from guard
), aligned as (
 select guard.p agent_pack,native_pack.p write_pack from guard,native_pack
 where ((guard.p#>'{{context_pack,composite_state_stamp}}') - 'authorization_generation')
   = ((native_pack.p#>'{{context_pack,composite_state_stamp}}') - 'authorization_generation')
), prior as (
 select r.revision_id,r.revision_digest from clued_private.mps_revisions r
 where r.object_id={_t('oid')} and r.revision_digest=clued_private.mps_json_v1_sha256({_j('body')})
), desired as (
 select case when prior.revision_id is null then
  jsonb_build_object('mode','REPLACE_JSON_V1','content',{_j('body')})
 else jsonb_build_object('mode','ADOPT_PREMATERIALIZED_V1',
  'revision_id',prior.revision_id,'revision_digest',prior.revision_digest) end change_body,
  prior.revision_id,prior.revision_digest
 from aligned left join prior on true
), ch as (
 select clued_private.mps_register_change_set({_t('oid')},
  coalesce((select c.change_id from clued_private.mps_change_sets c
   where c.object_id={_t('oid')}
    and c.change_digest=clued_private.mps_json_v1_sha256(desired.change_body)),
   'chg_' || clued_private.mps_json_v1_sha256(desired.change_body)),
   desired.change_body) c from desired
), mi as (
 select clued_private.mps_issue_mutation_intent(jsonb_build_object(
  'context_pack_digest',aligned.write_pack->>'pack_digest','object_id',{_t('oid')},'operation','update',
  'proposal_or_change_id',ch.c->>'change_id','proposal_or_change_digest',ch.c->>'change_digest',
  'target_revision',case when desired.revision_id is null then
    jsonb_build_object('mode','DERIVE_FROM_EXACT_CHANGE','change_id',ch.c->>'change_id','change_digest',ch.c->>'change_digest')
   else jsonb_build_object('mode','PREMATERIALIZED','revision_id',desired.revision_id,'revision_digest',desired.revision_digest) end,
  'adoption_scope','object','adoption_purpose','{MPS03_PROPOSAL_PURPOSE}'
 )) i from aligned,ch,desired
)
select case when cp.p#>>'{{context_pack,state_stamp_digest}}' is distinct from {_t('observed_digest')}
 or cp.p#>'{{context_pack,composite_state_stamp}}' is distinct from {_j('observed_stamp')}
 or aligned.write_pack is null then
 jsonb_build_object('ok',false,'error','STALE_CONTEXT_REQUIRES_REFRESH',
  'current_state_stamp',(cp.p#>'{{context_pack,composite_state_stamp}}') || jsonb_build_object('state_stamp_digest',cp.p#>>'{{context_pack,state_stamp_digest}}'))
else
 jsonb_build_object('ok',true,'proposal_id',mi.i->>'intent_id','proposal_digest',mi.i->>'proposal_or_change_digest',
  'confirmation_intent',mi.i,'state_stamp',(cp.p#>'{{context_pack,composite_state_stamp}}') || jsonb_build_object('state_stamp_digest',cp.p#>>'{{context_pack,state_stamp_digest}}'),
  'state_stamp_digest',cp.p#>>'{{context_pack,state_stamp_digest}}',
  'proposal_context_pack_digest',cp.p->>'pack_digest','context_pack_digest',aligned.write_pack->>'pack_digest',
  'proposed_body',{_j('body')}) end::text from cp left join aligned on true left join mi on true;
"""
        return self._json(sql,{"oid":object_id,"domain":self.authority_domain,
            "principal":s["principal"],"native":self.native_principal,
            "observed_digest":observed_digest,
            "observed_stamp":json.dumps(observed_stamp,ensure_ascii=False,separators=(",",":")),
            "body":json.dumps(proposed_body,ensure_ascii=False,separators=(",",":")),
            **self._provider_variables()})

    def list_proposals(self, token: str, object_id: str) -> dict:
        s=self._session(token); self._require(s,"read")
        self._read_for(s["principal"],object_id,"read")
        sql=f"""
select jsonb_build_object('ok',true,'proposals',coalesce(jsonb_agg(jsonb_build_object(
 'proposal_id',i.intent_id,'status',case when ro.intent_id is null then 'OPEN' else 'ADOPTED' end,
 'proposal_digest',i.proposal_or_change_digest,'proposed_body',coalesce(c.change_body->'content',r.content),
 'state_stamp_digest',i.state_stamp_digest,'confirmation_intent',i.intent_body
) order by i.created_at),'[]'::jsonb))::text
from clued_private.mps_mutation_intents i
join clued_private.mps_context_packs p on p.object_id=i.object_id and p.pack_digest=i.context_pack_digest
join clued_private.mps_change_sets c on c.object_id=i.object_id and c.change_id=i.proposal_or_change_id and c.change_digest=i.proposal_or_change_digest
left join clued_private.mps_revisions r on r.object_id=i.object_id and r.revision_id=c.change_body->>'revision_id'
 and r.revision_digest=c.change_body->>'revision_digest'
left join clued_private.mps_request_outcomes ro on ro.intent_id=i.intent_id
where i.object_id={_t('oid')} and i.operation='update'
 and i.adoption_scope='object' and i.adoption_purpose='{MPS03_PROPOSAL_PURPOSE}'
 and ((i.target_revision->>'mode'='DERIVE_FROM_EXACT_CHANGE' and c.change_body->>'mode'='REPLACE_JSON_V1')
   or (i.target_revision->>'mode'='PREMATERIALIZED' and c.change_body->>'mode'='ADOPT_PREMATERIALIZED_V1' and r.revision_id is not null))
 and p.authority_domain_id={_t('domain')} and p.stable_request_principal_id={_t('native')}
 and p.action='update';
"""
        return self._json(sql,{"oid":object_id,"domain":self.authority_domain,"native":self.native_principal})

    def confirm_proposal(self, token: str, object_id: str, proposal_id: str, state_stamp: dict, request_id: str,
                         adoption_scope: str="object", adoption_purpose: str=MPS03_PROPOSAL_PURPOSE) -> dict:
        s=self._session(token); self._require(s,"confirm")
        request_id=normalize_request_id(request_id)
        if adoption_scope!="object" or adoption_purpose!=MPS03_PROPOSAL_PURPOSE:
            raise ProtocolError("CONFIRMATION_SCOPE_IMMUTABLE","confirmation scope and purpose are fixed by the proposal",400)
        if not isinstance(state_stamp,dict): raise ProtocolError("STATE_STAMP_REQUIRED","state_stamp must be an object")
        self._assert_object_owner(object_id)
        # Scope/purpose are already immutable inside the server-issued intent; caller cannot rewrite them here.
        submitted_stamp={k:v for k,v in state_stamp.items() if k!="state_stamp_digest"}
        sql=f"""
with i as (
 select i.intent_body from clued_private.mps_mutation_intents i
 join clued_private.mps_context_packs p on p.object_id=i.object_id and p.pack_digest=i.context_pack_digest
 join clued_private.mps_change_sets c on c.object_id=i.object_id and c.change_id=i.proposal_or_change_id and c.change_digest=i.proposal_or_change_digest
 where i.object_id={_t('oid')} and i.intent_id={_t('pid')} and i.operation='update'
  and i.adoption_scope='object' and i.adoption_purpose='{MPS03_PROPOSAL_PURPOSE}'
  and ((i.target_revision->>'mode'='DERIVE_FROM_EXACT_CHANGE' and c.change_body->>'mode'='REPLACE_JSON_V1')
    or (i.target_revision->>'mode'='PREMATERIALIZED' and c.change_body->>'mode'='ADOPT_PREMATERIALIZED_V1'))
  and p.authority_domain_id={_t('domain')} and p.stable_request_principal_id={_t('native')}
  and p.action='update'
), f as (
 select clued_private.mps_compute_request_fingerprint(i.intent_body,{_j('stamp')}) fp,i.intent_body from i
), o as (
 select clued_private.mps_commit_mutation({_t('domain')},{_t('principal')},{_t('request_id')},
 jsonb_build_object('confirmation_intent',f.intent_body,'composite_state_stamp',{_j('stamp')},'request_fingerprint',f.fp)) outcome from f
)
select coalesce((select o.outcome from o),jsonb_build_object('status','conflict','error','MPS_INTENT_NOT_FOUND'))::text;
"""
        outcome=self._json(sql,{"oid":object_id,"pid":proposal_id,"stamp":json.dumps(submitted_stamp,ensure_ascii=False,separators=(",",":")),"domain":self.authority_domain,"native":self.native_principal,"principal":s["principal"],"request_id":request_id})
        if outcome.get("status") == "committed":
            return {"ok":True,**outcome,"object_id":object_id,"revision_id":outcome.get("result_revision_id"),"adoption_id":outcome.get("result_adoption_id")}
        return {"ok":False,**outcome}

    def history(self, token: str, object_id: str) -> dict:
        s=self._session(token); self._require(s,"history")
        self._read_for(s["principal"],object_id,"read")
        sql=f"""
with h as (
 select coalesce(jsonb_agg(jsonb_build_object(
  'adoption_id',a.adoption_id,'revision_id',a.revision_id,'revision_digest',r.revision_digest,
  'scope',a.adoption_scope,'purpose',a.adoption_purpose,'body',r.content,'created_at',a.created_at
 ) order by a.created_at),'[]'::jsonb) history
 from clued_private.mps_adoptions a join clued_private.mps_revisions r
 on r.object_id=a.object_id and r.revision_id=a.revision_id
 where a.object_id={_t('oid')} and a.adoption_purpose <> 'mps03_create_bootstrap'
), receipts as (
 select coalesce(jsonb_agg(jsonb_build_object(
  'receipt_id',q.receipt_id,'stable_request_principal_id',q.stable_request_principal_id,
  'request_id',q.request_id,'request_fingerprint',q.request_fingerprint,
  'proposal_id',q.intent_id,'intent_id',q.intent_id,'operation',q.operation,
  'proposal_or_change_id',q.proposal_or_change_id,'result_revision_id',q.result_revision_id,
  'result_adoption_id',q.result_adoption_id,'adoption_scope',q.adoption_scope,
  'adoption_purpose',q.adoption_purpose,'outcome_digest',q.outcome_digest,
  'created_at',q.created_at
 ) order by q.created_at),'[]'::jsonb) receipts
 from clued_private.mps_receipts q
 where q.object_id={_t('oid')} and q.authority_domain_id={_t('domain')}
)
select jsonb_build_object('ok',true,'history',h.history,'receipts',receipts.receipts)::text
from h,receipts;
"""
        return self._json(sql,{"oid":object_id,"domain":self.authority_domain})

def main(argv=None):
    ap=argparse.ArgumentParser()
    ap.add_argument("--user-id",default=os.environ.get("MPS03_TEST_USER_ID"),required=os.environ.get("MPS03_TEST_USER_ID") is None)
    ap.add_argument("--authority-domain",default=os.environ.get("MPS03_AUTHORITY_DOMAIN","clued-mps03-nonprod"))
    ap.add_argument("--native-principal",default=os.environ.get("MPS03_NATIVE_PRINCIPAL","mps03-native-user"))
    ap.add_argument("--agent-principal",default=os.environ.get("MPS03_AGENT_PRINCIPAL","mps03-agent-host"))
    ap.add_argument("--target-id",default=os.environ.get("MPS03_TARGET_ID",EXPECTED_NONPROD_TARGET))
    ap.add_argument("--allow-nonprod-write",default=os.environ.get("MPS03_ALLOW_NONPROD_WRITE",""))
    ap.add_argument("--host",default="127.0.0.1"); ap.add_argument("--port",type=int,required=True)
    args=ap.parse_args(argv)
    _assert_loopback_host(args.host)
    github_mode=os.environ.get("MPS04_PROVIDER_MODE","")
    if github_mode not in ("","GITHUB_READ_ONLY"):
        raise RuntimeError("unsupported MPS-04 provider mode")
    if github_mode and not os.environ.get("MPS04_GITHUB_TOKEN",""):
        raise RuntimeError("MPS-04 private repository read-only token required")
    github_provider=(GitHubReadOnlyProvider(
        EXPECTED_PROVIDER_REPOSITORY,
        os.environ.get("MPS04_GITHUB_REF",""),
        os.environ.get("MPS04_GITHUB_TOKEN",""),
    ) if github_mode else None)
    Handler.store=PgMPS02BStore(os.environ.get("MPS03_DATABASE_URL",""),user_id=args.user_id,authority_domain=args.authority_domain,
        native_principal=args.native_principal,agent_principal=args.agent_principal,
        native_secret=os.environ.get("MPS03_NATIVE_ENTRY_SECRET",""),
        agent_secret=os.environ.get("MPS03_AGENT_ENTRY_SECRET",""),
        target_id=args.target_id,allow_nonprod_write=args.allow_nonprod_write,
        provider_context_mode=os.environ.get("MPS03_PROVIDER_CONTEXT_MODE",""),
        github_provider=github_provider)
    from http.server import ThreadingHTTPServer
    srv=ThreadingHTTPServer((args.host,args.port),Handler)
    print(json.dumps({"ready":True,"backend":"MPS02B_POSTGRES","target_id":args.target_id,"host":args.host,"port":args.port}),flush=True)
    try:srv.serve_forever()
    except KeyboardInterrupt:pass
    finally:srv.server_close()
if __name__=="__main__": main()
