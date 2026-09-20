#!/usr/bin/env python3
from __future__ import annotations
import base64, json, os, pathlib, socket, subprocess, sys, tempfile, time
from urllib.parse import urlparse
from urllib.request import Request, urlopen
REPO=pathlib.Path(__file__).resolve().parents[2]; IMPL=REPO/'development'/'mps'; PY=sys.executable

def port():
    s=socket.socket(); s.bind(('127.0.0.1',0)); p=s.getsockname()[1]; s.close(); return p

ENTRY_AUTH={}
def call(method,url,body=None):
    headers={'Content-Type':'application/json'}
    if urlparse(url).port in ENTRY_AUTH: headers['Authorization']=ENTRY_AUTH[urlparse(url).port]
    data=None if body is None else json.dumps(body,separators=(',',':')).encode(); req=Request(url,data=data,method=method,headers=headers)
    with urlopen(req,timeout=5) as r:return json.loads(r.read().decode())

def wait(url):
    for _ in range(160):
        try:
            if call('GET',url).get('ok'):return
        except Exception:time.sleep(.05)
    raise RuntimeError('not ready '+url)

def stop(p):
    if p.poll() is None:
        p.terminate()
        try:p.wait(timeout=3)
        except subprocess.TimeoutExpired:p.kill(); p.wait(timeout=3)
    if p.stdout:p.stdout.close()
    if p.stderr:p.stderr.close()

def main():
    pg,pn,pa=port(),port(),port(); ns='native-evidence-secret-not-recorded'; ag='agent-evidence-secret-not-recorded'; env=os.environ.copy(); env['PYTHONPATH']=os.pathsep.join([str(IMPL),str(REPO)])
    native_access='native-evidence-inbound-access-secret-0001'; agent_access='agent-evidence-inbound-access-secret-0002'
    env['MPS03_NATIVE_ACCESS_SECRET']=native_access; env['MPS03_AGENT_ACCESS_SECRET']=agent_access
    ENTRY_AUTH[pn]='Basic '+base64.b64encode(('native:'+native_access).encode()).decode()
    ENTRY_AUTH[pa]='Bearer '+agent_access
    with tempfile.TemporaryDirectory() as td:
        db=str(pathlib.Path(td)/'canonical.sqlite3')
        ps=[
          subprocess.Popen([PY,'-m','tests.mps03.reference_gateway','--db',db,'--port',str(pg),'--native-secret',ns,'--agent-secret',ag],cwd=REPO,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True),
          subprocess.Popen([PY,'-m','mps03.native_entry','--gateway',f'http://127.0.0.1:{pg}','--port',str(pn),'--entry-secret',ns],cwd=REPO,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True),
          subprocess.Popen([PY,'-m','mps03.agent_host_entry','--gateway',f'http://127.0.0.1:{pg}','--port',str(pa),'--entry-secret',ag],cwd=REPO,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True),
        ]
        try:
            wait(f'http://127.0.0.1:{pg}/health'); wait(f'http://127.0.0.1:{pn}/health'); wait(f'http://127.0.0.1:{pa}/health')
            created=call('POST',f'http://127.0.0.1:{pn}/api/objects',{'title':'Evidence plan','body':{'items':['walk']},'request_id':'evidence-create-0001'}); oid=created['object_id']
            read=call('POST',f'http://127.0.0.1:{pa}/agent/read',{'object_id':oid})
            prop=call('POST',f'http://127.0.0.1:{pa}/agent/propose',{'object_id':oid,'proposed_body':{'items':['walk','coffee']},'observed_state_stamp':read['state_stamp']})
            view=call('GET',f'http://127.0.0.1:{pn}/api/objects/{oid}')
            commit=call('POST',f'http://127.0.0.1:{pn}/api/objects/{oid}/confirm',{'proposal_id':prop['proposal_id'],'state_stamp':view['state_stamp'],'request_id':'evidence-confirm-0001'})
            continued=call('POST',f'http://127.0.0.1:{pa}/agent/continue',{'object_id':oid})
            evidence={
              'schema':'clued.mps03.cross-entry-evidence.v1','captured_at_ns':time.time_ns(),
              'qualification':'implementation-candidate-local-reference-backend','g5_real_third_party_host_pass_claimed':False,
              'processes':{'canonical_gateway_pid':ps[0].pid,'native_entry_pid':ps[1].pid,'agent_host_adapter_pid':ps[2].pid,'all_distinct':len({p.pid for p in ps})==3},
              'chain_1_native_create_agent_read':{'object_id':oid,'native_revision_id':created['revision_id'],'agent_revision_id':read['revision_id'],'same_revision':created['revision_id']==read['revision_id'],'same_adoption':created['adoption_id']==read['adoption_id']},
              'chain_2_agent_proposal_native_confirm':{'proposal_id':prop['proposal_id'],'proposal_digest':prop['proposal_digest'],'receipt_id':commit['receipt_id'],'committed_revision_id':commit['revision_id'],'committed_adoption_id':commit['adoption_id'],'ok':commit['ok'] is True},
              'chain_3_native_confirm_agent_continue':{'native_revision_id':commit['revision_id'],'agent_revision_id':continued['revision_id'],'native_adoption_id':commit['adoption_id'],'agent_adoption_id':continued['adoption_id'],'same_revision':commit['revision_id']==continued['revision_id'],'same_adoption':commit['adoption_id']==continued['adoption_id'],'body':continued['body']},
            }
            evidence['all_required_local_chains_pass']=all([evidence['processes']['all_distinct'],evidence['chain_1_native_create_agent_read']['same_revision'],evidence['chain_1_native_create_agent_read']['same_adoption'],evidence['chain_2_agent_proposal_native_confirm']['ok'],evidence['chain_3_native_confirm_agent_continue']['same_revision'],evidence['chain_3_native_confirm_agent_continue']['same_adoption']])
            print(json.dumps(evidence,ensure_ascii=False,indent=2)); return 0 if evidence['all_required_local_chains_pass'] else 1
        finally:
            for p in ps:stop(p)
if __name__=='__main__':raise SystemExit(main())
