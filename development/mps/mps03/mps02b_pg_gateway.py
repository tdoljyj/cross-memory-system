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
import argparse, base64, json, os, shutil, subprocess, threading
from typing import Any

try:
    from .common import ProtocolError, new_id, sha256_json, validate_create_content
    from .gateway_http import Handler
except ImportError:
    from common import ProtocolError, new_id, sha256_json, validate_create_content
    from gateway_http import Handler

EXPECTED_NONPROD_TARGET = "clued-auth-test/uscrdifznmlvczcekqpw"


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
                 target_id: str, allow_nonprod_write: str):
        if target_id != EXPECTED_NONPROD_TARGET:
            raise RuntimeError(f"target guard failed: expected {EXPECTED_NONPROD_TARGET}")
        if allow_nonprod_write != "MPS03_NONPROD_WRITE_APPROVED":
            raise RuntimeError("explicit non-production write guard not satisfied")
        if not shutil.which("psql"):
            raise RuntimeError("psql is required for mps02b_pg_gateway")
        self.dsn=dsn; self.user_id=user_id; self.authority_domain=authority_domain
        self.native_principal=native_principal; self.agent_principal=agent_principal
        self.native_secret=native_secret; self.agent_secret=agent_secret
        self.sessions={}; self._lock=threading.RLock()
        self._assert_primitives()

    def _psql(self, sql: str, variables: dict[str,str] | None=None) -> str:
        cmd=["psql",self.dsn,"-X","-A","-t","-q","-v","ON_ERROR_STOP=1"]
        for k,v in (variables or {}).items(): cmd += ["-v",f"{k}={_b64(v)}"]
        env=os.environ.copy(); env.setdefault("PGOPTIONS","-c client_min_messages=warning")
        p=subprocess.run(cmd,input=sql,text=True,capture_output=True,env=env,timeout=30)
        if p.returncode:
            err=(p.stderr or p.stdout).strip()
            mapping=[
                ("STALE_CONTEXT_REQUIRES_REFRESH",409), ("IDEMPOTENCY_CONFLICT",409),
                ("CONFIRMATION_TARGET_CHANGED",409), ("INTENT_IDENTITY_CONFLICT",409),
                ("MPS_AUTHORIZATION_DENIED",403), ("MPS_RESULT_READ_DENIED",403),
                ("MPS_CONTEXT_BASIS_NOT_FOUND_OR_INCONSISTENT",404), ("MPS_INTENT_NOT_FOUND",404),
            ]
            for code,status in mapping:
                if code in err: raise ProtocolError(code,code,status,{"postgres":err[-1000:]})
            raise ProtocolError("MPS02B_POSTGRES_ERROR","MPS-02B database operation failed",500,{"postgres":err[-1500:]})
        lines=[x.strip() for x in p.stdout.splitlines() if x.strip()]
        return lines[-1] if lines else ""

    def _json(self, sql: str, variables: dict[str,str] | None=None) -> dict:
        raw=self._psql(sql,variables)
        if not raw: return {"ok":True}
        try:return json.loads(raw)
        except Exception as e: raise ProtocolError("MPS02B_INVALID_DB_RESPONSE","database did not return JSON",500,{"raw":raw[-1000:],"reason":str(e)})

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

    def create_session(self, entry_kind: str, entry_secret: str) -> dict:
        mapping={"NATIVE":(self.native_secret,self.native_principal),"THIRD_PARTY_AGENT_HOST":(self.agent_secret,self.agent_principal)}
        if entry_kind not in mapping: raise ProtocolError("ENTRY_KIND_REJECTED","unsupported entry kind",403)
        expected,principal=mapping[entry_kind]
        if not entry_secret or entry_secret != expected: raise ProtocolError("ENTRY_AUTHENTICATION_FAILED","entry credential rejected",401)
        token=new_id("sess"); self.sessions[token]={"principal":principal,"entry_kind":entry_kind}
        return {"ok":True,"session_token":token,"principal":principal,"entry_kind":entry_kind}

    def _session(self,token):
        s=self.sessions.get(token)
        if not s: raise ProtocolError("SESSION_REQUIRED","valid session token required",401)
        return s
    def _require(self,s,action):
        allowed={self.native_principal:{"read","create","confirm","history"},self.agent_principal:{"read","propose","history"}}
        if action not in allowed.get(s["principal"],set()): raise ProtocolError("ACTION_NOT_AUTHORIZED",f"principal cannot {action}",403)

    def _read_for(self, principal: str, object_id: str, action: str="read") -> dict:
        sql=f"""
with p as (
 select clued_private.mps_issue_context_pack({_t('oid')},{_t('domain')},{_t('principal')},{_t('action')},'[]'::jsonb,null) as pack
), h as (
 select s.current_revision_id,s.current_adoption_id,r.revision_digest,r.content
 from clued_private.mps_state_heads s join clued_private.mps_revisions r
 on r.object_id=s.object_id and r.revision_id=s.current_revision_id
 where s.object_id={_t('oid')}
)
select jsonb_build_object('ok',true,'object_id',{_t('oid')},'title',coalesce(h.content->>'title','Untitled'),
 'revision_id',h.current_revision_id,'revision_digest',h.revision_digest,'adoption_id',h.current_adoption_id,
 'body',h.content,'state_stamp',p.pack#>'{{context_pack,composite_state_stamp}}',
 'context_pack_digest',p.pack->>'pack_digest','context_pack',p.pack->'context_pack')::text from p,h;
"""
        r=self._json(sql,{"oid":object_id,"domain":self.authority_domain,"principal":principal,"action":action})
        if not r: raise ProtocolError("OBJECT_NOT_FOUND","object not found",404)
        raw_stamp=dict(r.get("state_stamp") or {})
        digest=(r.get("context_pack") or {}).get("state_stamp_digest") or sha256_json(raw_stamp)
        raw_stamp["state_stamp_digest"]=digest
        r["state_stamp"]=raw_stamp
        r["state_stamp_digest"]=digest
        return r

    def create_object(self, token: str, title: str, body: dict, request_id: str) -> dict:
        s=self._session(token); self._require(s,"create")
        if not request_id or len(request_id)<8: raise ProtocolError("REQUEST_ID_REQUIRED","request_id is required")
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
  native_principal text, agent_principal text, content jsonb
) on commit drop;
insert into _mps03_create_input values(
  {_t('domain')},{_t('principal')},{_t('request_id')},({_t('uid')})::uuid,
  {_t('native')},{_t('agent')},{_j('content')}
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
    v_oid,v_in.authority_domain_id,v_in.principal,'create','[]'::jsonb,null);
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
            "native":self.native_principal,"agent":self.agent_principal})
        if outcome.get("status") == "committed":
            return {"ok":True,**outcome,"revision_id":outcome.get("result_revision_id"),
                "adoption_id":outcome.get("result_adoption_id")}
        return outcome

    def read_object(self, token: str, object_id: str) -> dict:
        s=self._session(token); self._require(s,"read"); return self._read_for(s["principal"],object_id,"read")

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
                if e.status == 403:
                    continue
                raise
            visible.append({"object_id":oid,"title":current.get("title","Untitled"),"revision_id":current.get("revision_id"),"adoption_id":current.get("adoption_id")})
        return {"ok":True,"objects":visible}

    def create_proposal(self, token: str, object_id: str, proposed_body: dict, observed_state_stamp: dict) -> dict:
        s=self._session(token); self._require(s,"propose")
        if not isinstance(observed_state_stamp,dict):
            raise ProtocolError("OBSERVED_STATE_REQUIRED","Agent proposal must include an observed state object",400)
        observed_digest=observed_state_stamp.get("state_stamp_digest")
        if not observed_digest:
            raise ProtocolError("STATE_STAMP_DIGEST_REQUIRED","Agent proposal must bind the exact state it observed",400)
        observed_stamp={k:v for k,v in observed_state_stamp.items() if k!="state_stamp_digest"}
        change_id=new_id("chg")
        change_body={"mode":"REPLACE_JSON_V1","content":proposed_body}
        sql=f"""
with cp as (
 select clued_private.mps_issue_context_pack({_t('oid')},{_t('domain')},{_t('principal')},'propose','[]'::jsonb,null) p
), guard as (
 select p from cp where p#>>'{{context_pack,state_stamp_digest}}'={_t('observed_digest')}
  and p#>'{{context_pack,composite_state_stamp}}'={_j('observed_stamp')}
), ch as (
 select clued_private.mps_register_change_set({_t('oid')},{_t('change_id')},{_j('change_body')}) c from guard
), mi as (
 select clued_private.mps_issue_mutation_intent(jsonb_build_object(
  'context_pack_digest',guard.p->>'pack_digest','object_id',{_t('oid')},'operation','update',
  'proposal_or_change_id',ch.c->>'change_id','proposal_or_change_digest',ch.c->>'change_digest',
  'target_revision',jsonb_build_object('mode','DERIVE_FROM_EXACT_CHANGE','change_id',ch.c->>'change_id','change_digest',ch.c->>'change_digest'),
  'adoption_scope','object','adoption_purpose','accept_proposal'
 )) i from guard,ch
)
select case when cp.p#>>'{{context_pack,state_stamp_digest}}' is distinct from {_t('observed_digest')}
 or cp.p#>'{{context_pack,composite_state_stamp}}' is distinct from {_j('observed_stamp')} then
 jsonb_build_object('ok',false,'error','STALE_CONTEXT_REQUIRES_REFRESH',
  'current_state_stamp',(cp.p#>'{{context_pack,composite_state_stamp}}') || jsonb_build_object('state_stamp_digest',cp.p#>>'{{context_pack,state_stamp_digest}}'))
else
 jsonb_build_object('ok',true,'proposal_id',mi.i->>'intent_id','proposal_digest',mi.i->>'proposal_or_change_digest',
  'confirmation_intent',mi.i,'state_stamp',(cp.p#>'{{context_pack,composite_state_stamp}}') || jsonb_build_object('state_stamp_digest',cp.p#>>'{{context_pack,state_stamp_digest}}'),
  'state_stamp_digest',cp.p#>>'{{context_pack,state_stamp_digest}}','context_pack_digest',cp.p->>'pack_digest',
  'proposed_body',{_j('body')}) end::text from cp left join mi on true;
"""
        return self._json(sql,{"oid":object_id,"domain":self.authority_domain,"principal":s["principal"],"observed_digest":observed_digest,"observed_stamp":json.dumps(observed_stamp,ensure_ascii=False,separators=(",",":")),"change_id":change_id,"change_body":json.dumps(change_body,ensure_ascii=False,separators=(",",":")),"body":json.dumps(proposed_body,ensure_ascii=False,separators=(",",":"))})

    def list_proposals(self, token: str, object_id: str) -> dict:
        s=self._session(token); self._require(s,"read")
        self._read_for(s["principal"],object_id,"read")
        sql=f"""
select jsonb_build_object('ok',true,'proposals',coalesce(jsonb_agg(jsonb_build_object(
 'proposal_id',i.intent_id,'status',case when ro.intent_id is null then 'OPEN' else 'ADOPTED' end,
 'proposal_digest',i.proposal_or_change_digest,'proposed_body',c.change_body->'content',
 'state_stamp_digest',i.state_stamp_digest,'confirmation_intent',i.intent_body
) order by i.created_at),'[]'::jsonb))::text
from clued_private.mps_mutation_intents i
join clued_private.mps_change_sets c on c.object_id=i.object_id and c.change_id=i.proposal_or_change_id and c.change_digest=i.proposal_or_change_digest
left join clued_private.mps_request_outcomes ro on ro.intent_id=i.intent_id
where i.object_id={_t('oid')};
"""
        return self._json(sql,{"oid":object_id})

    def confirm_proposal(self, token: str, object_id: str, proposal_id: str, state_stamp: dict, request_id: str,
                         adoption_scope: str="object", adoption_purpose: str="accept_proposal") -> dict:
        s=self._session(token); self._require(s,"confirm")
        if not request_id or len(request_id)<8: raise ProtocolError("REQUEST_ID_REQUIRED","request_id is required")
        # Scope/purpose are already immutable inside the server-issued intent; caller cannot rewrite them here.
        submitted_stamp={k:v for k,v in state_stamp.items() if k!="state_stamp_digest"}
        sql=f"""
with i as (
 select intent_body from clued_private.mps_mutation_intents where object_id={_t('oid')} and intent_id={_t('pid')}
), f as (
 select clued_private.mps_compute_request_fingerprint(i.intent_body,{_j('stamp')}) fp,i.intent_body from i
), o as (
 select clued_private.mps_commit_mutation({_t('domain')},{_t('principal')},{_t('request_id')},
 jsonb_build_object('confirmation_intent',f.intent_body,'composite_state_stamp',{_j('stamp')},'request_fingerprint',f.fp)) outcome from f
)
select coalesce(o.outcome,jsonb_build_object('status','conflict','error','MPS_INTENT_NOT_FOUND'))::text from o;
"""
        outcome=self._json(sql,{"oid":object_id,"pid":proposal_id,"stamp":json.dumps(submitted_stamp,ensure_ascii=False,separators=(",",":")),"domain":self.authority_domain,"principal":s["principal"],"request_id":request_id})
        if outcome.get("status") == "committed":
            return {"ok":True,**outcome,"object_id":object_id,"revision_id":outcome.get("result_revision_id"),"adoption_id":outcome.get("result_adoption_id")}
        return {"ok":False,**outcome}

    def history(self, token: str, object_id: str) -> dict:
        s=self._session(token); self._require(s,"history")
        self._read_for(s["principal"],object_id,"read")
        sql=f"""
select jsonb_build_object('ok',true,'history',coalesce(jsonb_agg(jsonb_build_object(
 'adoption_id',a.adoption_id,'revision_id',a.revision_id,'revision_digest',r.revision_digest,
 'scope',a.adoption_scope,'purpose',a.adoption_purpose,'body',r.content,'created_at',a.created_at
) order by a.created_at),'[]'::jsonb))::text
from clued_private.mps_adoptions a join clued_private.mps_revisions r
on r.object_id=a.object_id and r.revision_id=a.revision_id
where a.object_id={_t('oid')} and a.adoption_purpose <> 'mps03_create_bootstrap';
"""
        return self._json(sql,{"oid":object_id})

def main(argv=None):
    ap=argparse.ArgumentParser()
    ap.add_argument("--dsn",default=os.environ.get("MPS03_DATABASE_URL"),required=os.environ.get("MPS03_DATABASE_URL") is None)
    ap.add_argument("--user-id",default=os.environ.get("MPS03_TEST_USER_ID"),required=os.environ.get("MPS03_TEST_USER_ID") is None)
    ap.add_argument("--authority-domain",default=os.environ.get("MPS03_AUTHORITY_DOMAIN","clued-mps03-nonprod"))
    ap.add_argument("--native-principal",default=os.environ.get("MPS03_NATIVE_PRINCIPAL","mps03-native-user"))
    ap.add_argument("--agent-principal",default=os.environ.get("MPS03_AGENT_PRINCIPAL","mps03-agent-host"))
    ap.add_argument("--native-secret",default=os.environ.get("MPS03_NATIVE_ENTRY_SECRET"),required=os.environ.get("MPS03_NATIVE_ENTRY_SECRET") is None)
    ap.add_argument("--agent-secret",default=os.environ.get("MPS03_AGENT_ENTRY_SECRET"),required=os.environ.get("MPS03_AGENT_ENTRY_SECRET") is None)
    ap.add_argument("--target-id",default=os.environ.get("MPS03_TARGET_ID",EXPECTED_NONPROD_TARGET))
    ap.add_argument("--allow-nonprod-write",default=os.environ.get("MPS03_ALLOW_NONPROD_WRITE",""))
    ap.add_argument("--host",default="127.0.0.1"); ap.add_argument("--port",type=int,required=True)
    args=ap.parse_args(argv)
    Handler.store=PgMPS02BStore(args.dsn,user_id=args.user_id,authority_domain=args.authority_domain,
        native_principal=args.native_principal,agent_principal=args.agent_principal,native_secret=args.native_secret,
        agent_secret=args.agent_secret,target_id=args.target_id,allow_nonprod_write=args.allow_nonprod_write)
    from http.server import ThreadingHTTPServer
    srv=ThreadingHTTPServer((args.host,args.port),Handler)
    print(json.dumps({"ready":True,"backend":"MPS02B_POSTGRES","target_id":args.target_id,"host":args.host,"port":args.port}),flush=True)
    try:srv.serve_forever()
    except KeyboardInterrupt:pass
    finally:srv.server_close()
if __name__=="__main__": main()
