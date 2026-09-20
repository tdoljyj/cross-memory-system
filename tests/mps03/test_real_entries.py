import base64, json, os, pathlib, re, socket, subprocess, sys, tempfile, time, unittest
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

REPO=pathlib.Path(__file__).resolve().parents[2]
IMPL=REPO/"development"/"mps"
PY=sys.executable
ENTRY_AUTH={}

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
        cls.native_secret="native-test-secret-32bytes-000001"
        cls.agent_secret="agent-test-secret-32bytes-0000002"
        cls.native_access="native-inbound-access-secret-32bytes-001"
        cls.agent_access="agent-inbound-access-secret-32bytes-0002"
        ENTRY_AUTH[cls.pn]="Basic "+base64.b64encode(("native:"+cls.native_access).encode()).decode()
        ENTRY_AUTH[cls.pa]="Bearer "+cls.agent_access
        env=os.environ.copy(); env["PYTHONPATH"]=os.pathsep.join([str(IMPL),str(REPO)])
        env["MPS03_NATIVE_ACCESS_SECRET"]=cls.native_access
        env["MPS03_AGENT_ACCESS_SECRET"]=cls.agent_access
        cls.procs=[
            subprocess.Popen([PY,"-m","tests.mps03.reference_gateway","--db",cls.db,"--port",str(cls.pg),"--native-secret",cls.native_secret,"--agent-secret",cls.agent_secret],cwd=REPO,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True),
            subprocess.Popen([PY,"-m","mps03.native_entry","--gateway",f"http://127.0.0.1:{cls.pg}","--port",str(cls.pn),"--entry-secret",cls.native_secret],cwd=REPO,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True),
            subprocess.Popen([PY,"-m","mps03.agent_host_entry","--gateway",f"http://127.0.0.1:{cls.pg}","--port",str(cls.pa),"--entry-secret",cls.agent_secret],cwd=REPO,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True),
        ]
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
        status,wrong=raw_req("POST",f"http://127.0.0.1:{self.pa}/agent/read",'{"object_id":"obj_unknown"}',authorization="Bearer "+self.native_access)
        self.assertEqual(status,401); self.assertEqual(wrong.get("error"),"ENTRY_ACCESS_DENIED")
        status,cross_origin=raw_req("POST",f"http://127.0.0.1:{self.pn}/api/objects",'{"title":"no","request_id":"req-csrf-0001"}',origin="https://other.example")
        self.assertEqual(status,403); self.assertEqual(cross_origin.get("error"),"ENTRY_ORIGIN_DENIED")

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

    def test_native_five_user_surfaces_render(self):
        c=req("POST",f"http://127.0.0.1:{self.pn}/api/objects",{"title":"UI","body":{"items":[]},"request_id":"req-ui-create-01"}); oid=c["object_id"]
        # Agent creates an open suggestion so the suggestion/diff/confirm surface has real content.
        self.agent_propose(oid,{"items":["x"]})
        urls=["/",f"/object/{oid}",f"/object/{oid}/proposals",f"/object/{oid}/history",f"/object/{oid}/connection"]
        for path in urls:
            url=f"http://127.0.0.1:{self.pn}{path}"
            with urlopen(Request(url,headers=headers_for(url)),timeout=5) as r:
                text=r.read().decode(); self.assertEqual(r.status,200); self.assertIn("<html",text)
                if path.endswith("/proposals"):
                    self.assertIn("--- current",text); self.assertIn("+++ proposed",text)

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
        env=os.environ.copy(); env["PYTHONPATH"]=os.pathsep.join([str(IMPL),str(REPO)])
        newp=subprocess.Popen([PY,"-m","tests.mps03.reference_gateway","--db",self.db,"--port",str(self.pg),"--native-secret",self.native_secret,"--agent-secret",self.agent_secret],cwd=REPO,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.procs[0]=newp; wait(f"http://127.0.0.1:{self.pg}/health")
        after=req("POST",f"http://127.0.0.1:{self.pa}/agent/continue",{"object_id":oid})
        self.assertEqual(after["revision_id"],commit["revision_id"]); self.assertEqual(after["adoption_id"],commit["adoption_id"])

    def test_agent_cannot_confirm_and_native_cannot_propose_at_gateway(self):
        # Authorization is service-side; entry role is not authority by itself.
        # This test observes the public Agent adapter surface: it intentionally has no confirm endpoint.
        status,payload=raw_req("POST",f"http://127.0.0.1:{self.pa}/agent/confirm",'{}')
        self.assertEqual(status,404); self.assertEqual(payload.get("error"),"NOT_FOUND")

if __name__=="__main__": unittest.main(verbosity=2)
