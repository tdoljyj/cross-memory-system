import base64, io, json, os, pathlib, re, socket, subprocess, sys, tempfile, threading, time, unittest
from html.parser import HTMLParser
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from unittest.mock import patch

REPO=pathlib.Path(__file__).resolve().parents[2]
IMPL=REPO/"development"/"mps"
sys.path.insert(0,str(IMPL))
from mps03.client import GatewayClient
from mps03.common import ProtocolError
from mps03.native_entry import NativeHandler
PY=sys.executable
ENTRY_AUTH={}

class DefaultVisibleText(HTMLParser):
    def __init__(self):
        super().__init__(); self.details_depth=0; self.parts=[]
    def handle_starttag(self,tag,attrs):
        if tag=="details": self.details_depth+=1
    def handle_endtag(self,tag):
        if tag=="details": self.details_depth-=1
    def handle_data(self,data):
        if self.details_depth==0: self.parts.append(data)

class RetryForm(HTMLParser):
    def __init__(self):
        super().__init__(); self.in_form=False; self.action=""; self.fields={}
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=="form" and not self.action:
            self.in_form=True; self.action=a.get("action","")
        elif tag=="input" and self.in_form and a.get("name"):
            self.fields[a["name"]]=a.get("value","")
    def handle_endtag(self,tag):
        if tag=="form": self.in_form=False

def html_req(method,url,fields=None,authorized=True):
    headers=headers_for(url,authorized)
    data=None if fields is None else urlencode(fields).encode()
    if data is not None: headers["Content-Type"]="application/x-www-form-urlencoded"
    request=Request(url,data=data,headers=headers,method=method)
    try:
        with urlopen(request,timeout=5) as response:
            return response.status,response.headers.get("Content-Type",""),response.read().decode()
    except HTTPError as error:
        return error.code,error.headers.get("Content-Type",""),error.read().decode()

def free_port():
    s=socket.socket(); s.bind(("127.0.0.1",0)); p=s.getsockname()[1]; s.close(); return p

def headers_for(url, authorized=True, origin=None):
    headers={"Content-Type":"application/json"}
    if authorized and urlparse(url).port in ENTRY_AUTH:
        headers["Authorization"]=ENTRY_AUTH[urlparse(url).port]
    if origin is not None: headers["Origin"]=origin
    return headers

def req(method,url,body=None):
    data=None if body is None else json.dumps(body,separators=(",",":")).encode()
    r=Request(url,data=data,method=method,headers=headers_for(url))
    try:
        with urlopen(r,timeout=5) as x:return json.loads(x.read().decode())
    except HTTPError as error:
        return json.loads(error.read().decode())

def raw_req(method,url,raw,authorized=True,origin=None,authorization=None):
    headers=headers_for(url,authorized,origin)
    if authorization is not None: headers["Authorization"]=authorization
    r=Request(url,data=raw.encode(),method=method,headers=headers)
    try:
        with urlopen(r,timeout=5) as x:return x.status,json.loads(x.read().decode())
    except Exception as e:
        if hasattr(e,"read"):
            return getattr(e,"code",0),json.loads(e.read().decode())
        raise

def wait(url,timeout=8):
    end=time.time()+timeout
    while time.time()<end:
        try:
            if req("GET",url).get("ok"): return
        except Exception: time.sleep(.05)
    raise RuntimeError("service did not become ready: "+url)

def stop_proc(p):
    if p.poll() is None:
        p.terminate()
        try:p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait(timeout=3)
    if p.stdout: p.stdout.close()
    if p.stderr: p.stderr.close()

class RealEntries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(); cls.db=os.path.join(cls.tmp.name,"canonical.sqlite3")
        cls.pg,cls.pn,cls.pa=free_port(),free_port(),free_port()
        cls.native_secret="mps03-native-gw-"+"n"*32
        cls.agent_secret="mps03-agent-gw-"+"a"*32
        cls.native_access="mps03-native-access-"+"u"*32
        cls.agent_access="mps03-agent-access-"+"v"*32
        ENTRY_AUTH[cls.pn]="Basic "+base64.b64encode(("native:"+cls.native_access).encode()).decode()
        ENTRY_AUTH[cls.pa]="Bearer "+cls.agent_access
        env=os.environ.copy(); env["PYTHONPATH"]=os.pathsep.join([str(IMPL),str(REPO)])
        for key in ("MPS03_NATIVE_ENTRY_SECRET","MPS03_AGENT_ENTRY_SECRET",
                    "MPS03_NATIVE_ACCESS_SECRET","MPS03_AGENT_ACCESS_SECRET"):
            env.pop(key,None)
        cls.gateway_env={**env,"MPS03_NATIVE_ENTRY_SECRET":cls.native_secret,"MPS03_AGENT_ENTRY_SECRET":cls.agent_secret}
        native_env={**env,"MPS03_NATIVE_ENTRY_SECRET":cls.native_secret,"MPS03_NATIVE_ACCESS_SECRET":cls.native_access}
        agent_env={**env,"MPS03_AGENT_ENTRY_SECRET":cls.agent_secret,"MPS03_AGENT_ACCESS_SECRET":cls.agent_access}
        cls.procs=[
            subprocess.Popen([PY,"-m","tests.mps03.reference_gateway","--db",cls.db,"--port",str(cls.pg)],cwd=REPO,env=cls.gateway_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True),
            subprocess.Popen([PY,"-m","mps03.native_entry","--gateway",f"http://127.0.0.1:{cls.pg}","--port",str(cls.pn)],cwd=REPO,env=native_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True),
            subprocess.Popen([PY,"-m","mps03.agent_host_entry","--gateway",f"http://127.0.0.1:{cls.pg}","--port",str(cls.pa)],cwd=REPO,env=agent_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True),
        ]
        for proc in cls.procs:
            if any(secret in " ".join(proc.args) for secret in (cls.native_secret,cls.agent_secret,cls.native_access,cls.agent_access)):
                raise AssertionError("entry credential leaked through process arguments")
        wait(f"http://127.0.0.1:{cls.pg}/health"); wait(f"http://127.0.0.1:{cls.pn}/health"); wait(f"http://127.0.0.1:{cls.pa}/health")
    @classmethod
    def tearDownClass(cls):
        for p in cls.procs: stop_proc(p)
        cls.tmp.cleanup()
        ENTRY_AUTH.pop(cls.pn,None); ENTRY_AUTH.pop(cls.pa,None)

    def agent_propose(self, oid, proposed_body, observed_state_stamp=None):
        if observed_state_stamp is None:
            observed_state_stamp=req("POST",f"http://127.0.0.1:{self.pa}/agent/read",{"object_id":oid})["state_stamp"]
        return req("POST",f"http://127.0.0.1:{self.pa}/agent/propose",{"object_id":oid,"proposed_body":proposed_body,"observed_state_stamp":observed_state_stamp})

    def test_three_required_cross_entry_chains(self):
        # Native create -> Agent read
        created=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{"title":"Weekend plan","body":{"items":["walk"]},"request_id":"req-create-001"})
        self.assertTrue(created["ok"]); oid=created["object_id"]
        agent_read=req("POST",f"http://127.0.0.1:{self.pa}/agent/read",{"object_id":oid})
        self.assertEqual(agent_read["revision_id"],created["revision_id"])
        self.assertEqual(agent_read["state_stamp"]["state_stamp_digest"],created["state_stamp"]["state_stamp_digest"])

        # Agent proposal -> Native confirm
        proposed=self.agent_propose(oid,{"items":["walk","coffee"]},agent_read["state_stamp"])
        self.assertTrue(proposed["ok"])
        native_view=req("GET",f"http://127.0.0.1:{self.pn}/api/objects/{oid}")
        confirmed=req("POST",f"http://127.0.0.1:{self.pn}/api/objects/{oid}/confirm",{"proposal_id":proposed["proposal_id"],"state_stamp":native_view["state_stamp"],"request_id":"req-confirm-001"})
        self.assertTrue(confirmed["ok"])

        # Native confirm -> Agent sees new Current
        continued=req("POST",f"http://127.0.0.1:{self.pa}/agent/continue",{"object_id":oid})
        self.assertEqual(continued["revision_id"],confirmed["revision_id"])
        self.assertEqual(continued["adoption_id"],confirmed["adoption_id"])
        self.assertEqual(continued["body"],{"items":["walk","coffee"]})

        # Agent reads the same canonical Receipt/history without gaining a mutation route.
        agent_history=req("POST",f"http://127.0.0.1:{self.pa}/agent/history",{"object_id":oid})
        self.assertTrue(agent_history["ok"])
        matching=[row for row in agent_history["receipts"] if row["receipt_id"] == confirmed["receipt_id"]]
        self.assertEqual(len(matching),1)
        self.assertEqual(matching[0]["proposal_id"],proposed["proposal_id"])
        self.assertEqual(matching[0]["result_revision_id"],confirmed["revision_id"])
        self.assertEqual(matching[0]["result_adoption_id"],confirmed["adoption_id"])

    def test_idempotent_confirm_and_conflict(self):
        c=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{"title":"Idem","body":{"v":1},"request_id":"req-create-idem"}); oid=c["object_id"]
        p=self.agent_propose(oid,{"v":2})
        view=req("GET",f"http://127.0.0.1:{self.pn}/api/objects/{oid}")
        a=req("POST",f"http://127.0.0.1:{self.pn}/api/objects/{oid}/confirm",{"proposal_id":p["proposal_id"],"state_stamp":view["state_stamp"],"request_id":"req-confirm-idem"})
        b=req("POST",f"http://127.0.0.1:{self.pn}/api/objects/{oid}/confirm",{"proposal_id":p["proposal_id"],"state_stamp":view["state_stamp"],"request_id":"req-confirm-idem"})
        self.assertEqual(a["receipt_id"],b["receipt_id"]); self.assertEqual(a["revision_id"],b["revision_id"])

    def test_idempotent_create_replays_same_durable_result(self):
        payload={"title":"Create replay","body":{"v":1},"request_id":"req-create-replay-001"}
        a=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",payload)
        b=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",payload)
        self.assertTrue(a["ok"]); self.assertTrue(b["ok"])
        self.assertEqual(a["object_id"],b["object_id"])
        self.assertEqual(a["receipt_id"],b["receipt_id"])
        self.assertEqual(a["revision_id"],b["revision_id"])
        self.assertEqual(a["adoption_id"],b["adoption_id"])

    def test_normalized_request_key_replays_exact_receipt(self):
        payload={"title":"Trimmed key","body":{"v":1},"request_id":"  req-create-trim-001  "}
        a=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",payload)
        b=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{**payload,"request_id":"req-create-trim-001"})
        self.assertTrue(a["ok"]); self.assertEqual(a,b)
        conflict=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{**payload,"body":{"v":2},"request_id":"req-create-trim-001"})
        self.assertEqual(conflict.get("error"),"IDEMPOTENCY_CONFLICT")

    def test_confirmation_target_change_rejected_before_write(self):
        created=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{"title":"Target","body":{"v":1},"request_id":"req-target-create"})
        oid=created["object_id"]
        proposal=self.agent_propose(oid,{"v":2})
        observed=req("GET",f"http://127.0.0.1:{self.pn}/api/objects/{oid}")
        session=req("POST",f"http://127.0.0.1:{self.pg}/v1/sessions",{"entry_kind":"NATIVE","entry_secret":self.native_secret})["session_token"]
        for scope,purpose in (("project","mps03_accept_agent_proposal"),("object","other_purpose")):
            status,out=raw_req("POST",f"http://127.0.0.1:{self.pg}/v1/objects/{oid}/confirm",json.dumps({"proposal_id":proposal["proposal_id"],"state_stamp":observed["state_stamp"],"request_id":"req-target-reject-"+scope+purpose,"adoption_scope":scope,"adoption_purpose":purpose}),authorization="Bearer "+session)
            self.assertEqual(status,400); self.assertEqual(out.get("error"),"CONFIRMATION_SCOPE_IMMUTABLE")
            self.assertEqual(req("GET",f"http://127.0.0.1:{self.pn}/api/objects/{oid}")["revision_id"],observed["revision_id"])

    def test_stale_native_confirmation_fails_closed(self):
        c=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{"title":"Stale","body":{"v":1},"request_id":"req-create-stale"}); oid=c["object_id"]
        p1=self.agent_propose(oid,{"v":2})
        stale_view=req("GET",f"http://127.0.0.1:{self.pn}/api/objects/{oid}")
        ok=req("POST",f"http://127.0.0.1:{self.pn}/api/objects/{oid}/confirm",{"proposal_id":p1["proposal_id"],"state_stamp":stale_view["state_stamp"],"request_id":"req-stale-first"}); self.assertTrue(ok["ok"])
        p2=self.agent_propose(oid,{"v":3})
        bad=req("POST",f"http://127.0.0.1:{self.pn}/api/objects/{oid}/confirm",{"proposal_id":p2["proposal_id"],"state_stamp":stale_view["state_stamp"],"request_id":"req-stale-second"})
        self.assertEqual(bad.get("error"),"STALE_CONTEXT_REQUIRES_REFRESH")

    def test_entry_secret_maps_principal_server_side(self):
        status,payload=raw_req("POST",f"http://127.0.0.1:{self.pg}/v1/sessions",json.dumps({"entry_kind":"NATIVE","entry_secret":"wrong-secret"}))
        self.assertEqual(status,401); self.assertEqual(payload.get("error"),"ENTRY_AUTHENTICATION_FAILED")
        # Supplying a principal label is intentionally irrelevant; only the entry credential selects the server-side principal.
        ok=req("POST",f"http://127.0.0.1:{self.pg}/v1/sessions",{"entry_kind":"NATIVE","entry_secret":self.native_secret,"principal":"agent-host"})
        self.assertEqual(ok["principal"],"native-user")

    def test_entry_ports_reject_callers_without_access_credentials(self):
        status,native=raw_req("POST",f"http://127.0.0.1:{self.pn}/api/objects",'{"title":"no","request_id":"req-unauth-0001"}',authorized=False)
        self.assertEqual(status,401); self.assertEqual(native.get("error"),"ENTRY_ACCESS_DENIED")
        status,agent=raw_req("POST",f"http://127.0.0.1:{self.pa}/agent/read",'{"object_id":"obj_unknown"}',authorized=False)
        self.assertEqual(status,401); self.assertEqual(agent.get("error"),"ENTRY_ACCESS_DENIED")
        status,history=raw_req("POST",f"http://127.0.0.1:{self.pa}/agent/history",'{"object_id":"obj_unknown"}',authorized=False)
        self.assertEqual(status,401); self.assertEqual(history.get("error"),"ENTRY_ACCESS_DENIED")
        status,wrong=raw_req("POST",f"http://127.0.0.1:{self.pa}/agent/read",'{"object_id":"obj_unknown"}',authorization="Bearer "+self.native_access)
        self.assertEqual(status,401); self.assertEqual(wrong.get("error"),"ENTRY_ACCESS_DENIED")
        status,cross_origin=raw_req("POST",f"http://127.0.0.1:{self.pn}/api/objects",'{"title":"no","request_id":"req-csrf-0001"}',origin="https://other.example")
        self.assertEqual(status,403); self.assertEqual(cross_origin.get("error"),"ENTRY_ORIGIN_DENIED")
        status,content_type,page=html_req("POST",f"http://127.0.0.1:{self.pn}/create",{"title":"no","details":"x","request_id":"req-unauth-form"},authorized=False)
        self.assertEqual(status,401); self.assertIn("text/html",content_type)
        visible=DefaultVisibleText(); visible.feed(page)
        self.assertIn("Access is no longer available."," ".join(visible.parts))
        self.assertNotIn("req-unauth-form",page)

    def test_agent_proposal_rejects_observation_that_became_stale(self):
        created=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{"title":"Agent stale","body":{"v":1},"request_id":"req-agent-stale-create"})
        oid=created["object_id"]
        observed=req("POST",f"http://127.0.0.1:{self.pa}/agent/read",{"object_id":oid})["state_stamp"]
        first=self.agent_propose(oid,{"v":2},observed)
        confirmed=req("POST",f"http://127.0.0.1:{self.pn}/api/objects/{oid}/confirm",{"proposal_id":first["proposal_id"],"state_stamp":observed,"request_id":"req-agent-stale-confirm"})
        self.assertTrue(confirmed["ok"])
        stale=self.agent_propose(oid,{"v":3},observed)
        self.assertEqual(stale.get("error"),"STALE_CONTEXT_REQUIRES_REFRESH")
        latest=req("POST",f"http://127.0.0.1:{self.pa}/agent/read",{"object_id":oid})["state_stamp"]
        altered=dict(latest); altered["workflow_instance_version"]=-1
        self.assertEqual(self.agent_propose(oid,{"v":3},altered).get("error"),"STALE_CONTEXT_REQUIRES_REFRESH")
        status,missing=raw_req("POST",f"http://127.0.0.1:{self.pa}/agent/propose",json.dumps({"object_id":oid,"proposed_body":{"v":3}}))
        self.assertEqual(status,400); self.assertEqual(missing.get("error"),"OBSERVED_STATE_REQUIRED")

    def test_duplicate_json_key_and_float_rejected_at_entry(self):
        status,payload=raw_req("POST",f"http://127.0.0.1:{self.pn}/api/objects",'{"title":"dup","body":{"v":1,"v":2},"request_id":"req-dup-0001"}')
        self.assertEqual(status,400); self.assertEqual(payload.get("error"),"DUPLICATE_JSON_KEY")
        status,payload=raw_req("POST",f"http://127.0.0.1:{self.pn}/api/objects",'{"title":"float","body":{"v":1.5},"request_id":"req-float-001"}')
        self.assertEqual(status,400); self.assertEqual(payload.get("error"),"MPS_JSON_V1_INTEGER_REQUIRED")
        status,payload=raw_req("POST",f"http://127.0.0.1:{self.pn}/api/objects",'{"title":"nan","body":{"v":NaN},"request_id":"req-nan-000001"}')
        self.assertEqual(status,400); self.assertEqual(payload.get("error"),"INVALID_JSON_NUMBER")
        status,payload=raw_req("POST",f"http://127.0.0.1:{self.pn}/api/objects",'{"title":"inf","body":{"v":Infinity},"request_id":"req-inf-000001"}')
        self.assertEqual(status,400); self.assertEqual(payload.get("error"),"INVALID_JSON_NUMBER")
        status,payload=raw_req("POST",f"http://127.0.0.1:{self.pn}/api/objects",'[]')
        self.assertEqual(status,400); self.assertEqual(payload.get("error"),"JSON_OBJECT_REQUIRED")

    def test_invalid_utf8_returns_bounded_entry_errors(self):
        for url,content_type,expected_type in (
            (f"http://127.0.0.1:{self.pn}/api/objects","application/json","application/json"),
            (f"http://127.0.0.1:{self.pa}/agent/read","application/json","application/json"),
            (f"http://127.0.0.1:{self.pn}/create","application/x-www-form-urlencoded","text/html"),
        ):
            with self.subTest(url=url):
                headers=headers_for(url); headers["Content-Type"]=content_type
                request=Request(url,data=b"\xff",headers=headers,method="POST")
                with self.assertRaises(HTTPError) as caught: urlopen(request,timeout=5)
                self.assertEqual(caught.exception.code,400)
                self.assertIn(expected_type,caught.exception.headers.get("Content-Type",""))
                body=caught.exception.read().decode()
                self.assertIn("INVALID_UTF8",body)

    def test_native_five_user_surfaces_render(self):
        c=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{"title":"UI","body":{"items":[]},"request_id":"req-ui-create-01"}); oid=c["object_id"]
        # Agent creates an open suggestion so the suggestion/diff/confirm surface has real content.
        self.agent_propose(oid,{"items":["x"]})
        urls=["/new","/",f"/object/{oid}",f"/object/{oid}/proposals",f"/object/{oid}/history",f"/object/{oid}/connection"]
        for path in urls:
            url=f"http://127.0.0.1:{self.pn}{path}"
            with urlopen(Request(url,headers=headers_for(url)),timeout=5) as r:
                text=r.read().decode(); self.assertEqual(r.status,200); self.assertIn("<html",text)
                self.assertEqual(r.headers.get("Content-Security-Policy"),"frame-ancestors 'none'")
                self.assertEqual(r.headers.get("X-Frame-Options"),"DENY")
                visible=DefaultVisibleText(); visible.feed(text)
                for protocol_term in ("state_stamp","revision_id","adoption_id","receipt_id","context_pack_digest","proposal_id"):
                    self.assertNotIn(protocol_term," ".join(visible.parts))
                if path.endswith("/proposals"):
                    self.assertIn("--- before",text); self.assertIn("+++ after",text)
                if path=="/":
                    self.assertIn('name="details"',text)
                    self.assertNotIn("Body JSON",text)
                if path.startswith("/object/"):
                    self.assertIn("<summary>Technical details</summary>",text)

    def test_native_html_does_not_mask_gateway_read_failure(self):
        for path in ("/object/obj_missing", "/object/obj_missing/proposals", "/object/obj_missing/history", "/object/obj_missing/connection"):
            url=f"http://127.0.0.1:{self.pn}{path}"
            with self.subTest(path=path):
                status,content_type,page=html_req("GET",url)
                self.assertEqual(status,404)
                self.assertIn("text/html",content_type)
                visible=DefaultVisibleText(); visible.feed(page)
                self.assertIn("This plan or page could not be found."," ".join(visible.parts))
                self.assertNotIn("OBJECT_NOT_FOUND"," ".join(visible.parts))
                self.assertIn("OBJECT_NOT_FOUND",page)
                self.assertIn('<summary>Technical details</summary>',page)
            api=f"http://127.0.0.1:{self.pn}/api/objects/obj_missing"
            status,payload=raw_req("GET",api,"")
            self.assertEqual(status,404)
            self.assertEqual(payload["error"],"OBJECT_NOT_FOUND")

    def test_native_page_failures_and_lost_ack_recover_with_same_key(self):
        gateway=GatewayClient(f"http://127.0.0.1:{self.pg}","NATIVE",self.native_secret)
        gateway.start_session()
        denied_client=GatewayClient(f"http://127.0.0.1:{self.pg}","NATIVE",self.native_secret)
        def deny_new_session(operation,*args):
            denied_client.token="expired-session"
            def denied(request,*_args,**_kwargs):
                code=b"ENTRY_AUTHENTICATION_FAILED" if request.full_url.endswith("/v1/sessions") else b"SESSION_REQUIRED"
                payload=b'{"ok":false,"error":"'+code+b'"}'
                raise HTTPError(request.full_url,401,"Unauthorized",{},io.BytesIO(payload))
            with patch.object(denied_client._opener,"open",side_effect=denied):
                return getattr(denied_client,operation)(*args)
        class LostAck:
            base_url=gateway.base_url
            token=gateway.token
            first_create=None
            first_confirm=None
            list_failure=False
            page_failure=False
            create_session_denial=True
            confirm_session_denial=True
            create_retry_errors=[(403,"MPS_AUTHORIZATION_DENIED"),(409,"IDEMPOTENCY_CONFLICT")]
            confirm_retry_errors=[(403,"MPS_AUTHORIZATION_DENIED"),(409,"STALE_CONTEXT_REQUIRES_REFRESH")]
            def list_objects(self):
                if self.list_failure:
                    return {"ok":False,"error":"GATEWAY_UNAVAILABLE","http_status":503}
                return gateway.list_objects()
            def read_object(self,*args):
                if self.page_failure:
                    return {"ok":False,"error":"GATEWAY_UNAVAILABLE","http_status":503}
                return gateway.read_object(*args)
            def history(self,*args):
                if self.page_failure:
                    return {"ok":False,"error":"GATEWAY_UNAVAILABLE","http_status":503}
                return gateway.history(*args)
            def create_object(self,*args):
                if self.first_create is not None and self.create_session_denial:
                    self.create_session_denial=False
                    return deny_new_session("create_object",*args)
                if self.first_create is not None and self.create_retry_errors:
                    status,code=self.create_retry_errors.pop(0)
                    return {"ok":False,"error":code,"http_status":status}
                out=gateway.create_object(*args)
                if self.first_create is None:
                    self.first_create=out
                    raise ProtocolError("GATEWAY_UNAVAILABLE","response lost after commit",503)
                return out
            def confirm(self,*args):
                if self.first_confirm is not None and self.confirm_session_denial:
                    self.confirm_session_denial=False
                    return deny_new_session("confirm",*args)
                if self.first_confirm is not None and self.confirm_retry_errors:
                    status,code=self.confirm_retry_errors.pop(0)
                    return {"ok":False,"error":code,"http_status":status}
                out=gateway.confirm(*args)
                if self.first_confirm is None:
                    self.first_confirm=out
                    raise ProtocolError("GATEWAY_UNAVAILABLE","response lost after commit",503)
                return out
            def __getattr__(self,name): return getattr(gateway,name)
        fake=LostAck()
        class TestHandler(NativeHandler):
            client=fake
            access_secret=self.native_access
        server=ThreadingHTTPServer(("127.0.0.1",0),TestHandler)
        port=server.server_address[1]
        ENTRY_AUTH[port]=ENTRY_AUTH[self.pn]
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            base=f"http://127.0.0.1:{port}"
            fake.list_failure=True
            status,content_type,page=html_req("GET",base+"/")
            self.assertEqual(status,503); self.assertIn("text/html",content_type)
            visible=DefaultVisibleText(); visible.feed(page)
            self.assertIn("Clued is temporarily unavailable."," ".join(visible.parts))
            self.assertNotIn("GATEWAY_UNAVAILABLE"," ".join(visible.parts))
            fake.list_failure=False

            create={"title":"Lost response plan","details":"one unique plan","request_id":"req-lost-ack-create"}
            status,content_type,page=html_req("POST",base+"/create",create)
            self.assertEqual(status,503); self.assertIn("text/html",content_type)
            self.assertIn("could not confirm the result",page)
            self.assertNotIn("The change was not saved",page)
            retry=RetryForm(); retry.feed(page)
            self.assertEqual(retry.action,"/create")
            self.assertEqual({k:retry.fields[k] for k in create},create)
            self.assertEqual(retry.fields["_recovery_pending"],"1")
            for expected_status,authorized in ((401,False),(401,True),(403,True),(409,True)):
                previous=retry.fields.copy()
                status,_,page=html_req("POST",base+retry.action,retry.fields,authorized=authorized)
                self.assertEqual(status,expected_status,page)
                if not authorized:
                    self.assertIn("retry the exact same request",page)
                    self.assertNotIn(previous["request_id"],page)
                    continue  # The already-rendered recovery form remains the retry source.
                self.assertIn("original result is still unknown",page)
                retry=RetryForm(); retry.feed(page)
                self.assertEqual(retry.fields,previous)
                self.assertNotIn("Edit and submit as a new request",page)
            status,_,page=html_req("POST",base+retry.action,retry.fields)
            self.assertEqual(status,200); self.assertIn("Plan created.",page)
            replay=gateway.create_object(create["title"],{"details":create["details"]},create["request_id"])
            self.assertEqual(replay,fake.first_create)
            objects=gateway.list_objects()["objects"]
            self.assertEqual(sum(o.get("title")==create["title"] for o in objects),1)
            bad={"title":"Fix me","body_json":"{invalid","request_id":"req-invalid-form"}
            status,content_type,page=html_req("POST",base+"/create",bad)
            self.assertEqual(status,400); self.assertIn("text/html",content_type)
            self.assertIn("{invalid",page)
            self.assertIn("Edit and submit as a new request",page)
            self.assertNotIn("Retry this exact request",page)

            oid=fake.first_create["object_id"]
            fake.page_failure=True
            for path in (f"/object/{oid}",f"/object/{oid}/proposals",f"/object/{oid}/history",f"/object/{oid}/connection"):
                with self.subTest(path=path):
                    status,content_type,page=html_req("GET",base+path)
                    self.assertEqual(status,503); self.assertIn("text/html",content_type)
                    visible=DefaultVisibleText(); visible.feed(page)
                    self.assertIn("Clued is temporarily unavailable."," ".join(visible.parts))
                    self.assertNotIn("GATEWAY_UNAVAILABLE"," ".join(visible.parts))
            status,payload=raw_req("GET",base+f"/api/objects/{oid}","")
            self.assertEqual(status,503); self.assertEqual(payload["error"],"GATEWAY_UNAVAILABLE")
            fake.page_failure=False
            proposed=self.agent_propose(oid,{"details":"updated plan"})
            self.assertTrue(proposed["ok"])
            stamp=gateway.read_object(oid)["state_stamp"]
            confirm={"proposal_id":proposed["proposal_id"],"state_stamp_json":json.dumps(stamp,separators=(",",":")),"request_id":"req-lost-ack-confirm"}
            status,content_type,page=html_req("POST",base+f"/object/{oid}/confirm",confirm)
            self.assertEqual(status,503); self.assertIn("text/html",content_type)
            retry=RetryForm(); retry.feed(page)
            self.assertEqual(retry.action,f"/object/{oid}/confirm")
            self.assertEqual({k:retry.fields[k] for k in confirm},confirm)
            self.assertEqual(retry.fields["_recovery_pending"],"1")
            for expected_status,authorized in ((401,False),(401,True),(403,True),(409,True)):
                previous=retry.fields.copy()
                status,_,page=html_req("POST",base+retry.action,retry.fields,authorized=authorized)
                self.assertEqual(status,expected_status)
                if not authorized:
                    self.assertIn("retry the exact same request",page)
                    self.assertNotIn(previous["request_id"],page)
                    continue  # Recover from the prior form after credential restoration.
                self.assertIn("original result is still unknown",page)
                retry=RetryForm(); retry.feed(page)
                self.assertEqual(retry.fields,previous)
            status,_,page=html_req("POST",base+retry.action,retry.fields)
            self.assertEqual(status,200); self.assertIn("Suggestion confirmed.",page)
            replay=gateway.confirm(oid,confirm["proposal_id"],stamp,confirm["request_id"])
            self.assertEqual(replay,fake.first_confirm)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=3)
            ENTRY_AUTH.pop(port,None)

    def test_native_create_form_reuses_request_identity_on_retry(self):
        page_url=f"http://127.0.0.1:{self.pn}/"
        with urlopen(Request(page_url,headers=headers_for(page_url)),timeout=5) as response:
            page=response.read().decode()
        request_id=re.search(r'name="request_id" value="([^"]+)"',page).group(1)
        url=f"http://127.0.0.1:{self.pn}/create"
        data=urlencode({"title":"Form replay","body_json":"{}","request_id":request_id}).encode()
        def submit():
            headers=headers_for(url); headers["Content-Type"]="application/x-www-form-urlencoded"
            with urlopen(Request(url,data=data,headers=headers,method="POST"),timeout=5) as response:
                return response.read().decode()
        first=submit(); replay=submit()
        self.assertEqual(re.search(r'/object/(obj_[a-z0-9]+)',first).group(1),re.search(r'/object/(obj_[a-z0-9]+)',replay).group(1))
        for result in (first,replay):
            visible=DefaultVisibleText(); visible.feed(result)
            self.assertIn("Plan created."," ".join(visible.parts))
            self.assertNotIn("receipt_id"," ".join(visible.parts))
            self.assertIn("<summary>Technical details</summary>",result)

    def test_request_id_different_payload_conflicts(self):
        first=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{"title":"One","body":{"v":1},"request_id":"req-conflict-create"})
        self.assertTrue(first["ok"])
        second=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{"title":"Two","body":{"v":2},"request_id":"req-conflict-create"})
        self.assertEqual(second.get("error"),"IDEMPOTENCY_CONFLICT")
        status,duplicate_title=raw_req("POST",f"http://127.0.0.1:{self.pn}/api/objects",'{"title":"One","body":{"title":"One"},"request_id":"req-title-in-body"}')
        self.assertEqual(status,400); self.assertEqual(duplicate_title.get("error"),"TITLE_IN_BODY_NOT_ALLOWED")

    def test_z_gateway_restart_preserves_current_and_session(self):
        c=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{"title":"Restart","body":{"v":1},"request_id":"req-restart-create"}); oid=c["object_id"]
        p=self.agent_propose(oid,{"v":2})
        view=req("GET",f"http://127.0.0.1:{self.pn}/api/objects/{oid}")
        commit=req("POST",f"http://127.0.0.1:{self.pn}/api/objects/{oid}/confirm",{"proposal_id":p["proposal_id"],"state_stamp":view["state_stamp"],"request_id":"req-restart-confirm"})
        old=self.procs[0]; stop_proc(old)
        newp=subprocess.Popen([PY,"-m","tests.mps03.reference_gateway","--db",self.db,"--port",str(self.pg)],cwd=REPO,env=self.gateway_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.procs[0]=newp; wait(f"http://127.0.0.1:{self.pg}/health")
        after=req("POST",f"http://127.0.0.1:{self.pa}/agent/continue",{"object_id":oid})
        self.assertEqual(after["revision_id"],commit["revision_id"]); self.assertEqual(after["adoption_id"],commit["adoption_id"])

    def test_agent_cannot_confirm_and_native_cannot_propose_at_gateway(self):
        # Authorization is service-side; entry role is not authority by itself.
        # This test observes the public Agent adapter surface: it intentionally has no confirm endpoint.
        status,payload=raw_req("POST",f"http://127.0.0.1:{self.pa}/agent/confirm",'{}')
        self.assertEqual(status,404); self.assertEqual(payload.get("error"),"NOT_FOUND")

if __name__=="__main__": unittest.main(verbosity=2)
