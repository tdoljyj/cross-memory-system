#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
try:
    from .client import GatewayClient
    from .common import strict_json_loads, ProtocolError
except ImportError:
    from client import GatewayClient
    from common import strict_json_loads, ProtocolError

class AgentHandler(BaseHTTPRequestHandler):
    client: GatewayClient = None  # type: ignore
    server_version="CluedMPS03ThirdPartyAgentAdapter/1"
    def log_message(self,fmt,*args):
        if os.environ.get("MPS03_HTTP_LOG")=="1": super().log_message(fmt,*args)
    def _body(self):
        n=int(self.headers.get("Content-Length","0") or 0); raw=self.rfile.read(n) if n else b"{}"
        value=strict_json_loads(raw.decode())
        if not isinstance(value,dict): raise ProtocolError("JSON_OBJECT_REQUIRED","request body must be a JSON object",400)
        return value
    def _send(self,status,obj):
        b=(json.dumps(obj,ensure_ascii=False,separators=(",",":"))+"\n").encode(); self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        p=urlparse(self.path).path
        if p=="/health": return self._send(200,{"ok":True,"entry":"THIRD_PARTY_AGENT_HOST_ADAPTER","session":bool(self.client.token),"gate_pass_claimed":False})
        self._send(404,{"ok":False,"error":"NOT_FOUND"})
    def do_POST(self):
        try:
            p=urlparse(self.path).path; b=self._body()
            if p=="/agent/read": return self._send(200,self.client.read_object(b.get("object_id","")))
            if p=="/agent/propose":
                oid=b.get("object_id",""); observed=self.client.read_object(oid)
                if not observed.get("ok"): return self._send(200,observed)
                return self._send(200,self.client.propose(oid,b.get("proposed_body",{}),observed["state_stamp"]))
            if p=="/agent/continue": return self._send(200,self.client.read_object(b.get("object_id","")))
            self._send(404,{"ok":False,"error":"NOT_FOUND"})
        except ProtocolError as e:
            self._send(e.status,e.as_dict())

def main(argv=None):
    ap=argparse.ArgumentParser(); ap.add_argument("--gateway",required=True); ap.add_argument("--host",default="127.0.0.1"); ap.add_argument("--port",type=int,required=True); ap.add_argument("--entry-secret",required=True); args=ap.parse_args(argv)
    c=GatewayClient(args.gateway,"THIRD_PARTY_AGENT_HOST",args.entry_secret)
    last=None
    for _ in range(100):
        try:
            c.start_session(); last=None; break
        except Exception as e:
            last=e; time.sleep(0.05)
    if last is not None: raise last
    AgentHandler.client=c
    srv=ThreadingHTTPServer((args.host,args.port),AgentHandler); print(json.dumps({"ready":True,"entry":"THIRD_PARTY_AGENT_HOST_ADAPTER","host":args.host,"port":args.port,"gateway":args.gateway,"gate_pass_claimed":False}),flush=True)
    try:srv.serve_forever()
    except KeyboardInterrupt:pass
    finally:srv.server_close()
if __name__=="__main__": main()
