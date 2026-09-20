#!/usr/bin/env python3
from __future__ import annotations
import argparse, html, json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
try:
    from .client import GatewayClient
    from .common import strict_json_loads, ProtocolError, new_id
except ImportError:
    from client import GatewayClient
    from common import strict_json_loads, ProtocolError, new_id

class NativeHandler(BaseHTTPRequestHandler):
    client: GatewayClient = None  # type: ignore
    server_version="CluedMPS03Native/1"
    def log_message(self,fmt,*args):
        if os.environ.get("MPS03_HTTP_LOG")=="1": super().log_message(fmt,*args)
    def _raw(self):
        n=int(self.headers.get("Content-Length","0") or 0); return self.rfile.read(n) if n else b""
    def _body(self):
        value=strict_json_loads((self._raw() or b"{}").decode())
        if not isinstance(value,dict): raise ProtocolError("JSON_OBJECT_REQUIRED","request body must be a JSON object",400)
        return value
    def _form(self): return {k:v[-1] for k,v in parse_qs(self._raw().decode(),keep_blank_values=True).items()}
    def _send_json(self,status,obj):
        b=(json.dumps(obj,ensure_ascii=False,separators=(",",":"))+"\n").encode(); self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def _send_html(self,status,markup):
        b=markup.encode(); self.send_response(status); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def _page(self,title,body):
        return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title><style>body{{font-family:system-ui,sans-serif;max-width:880px;margin:32px auto;padding:0 16px}}nav a{{margin-right:12px}}pre{{white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:8px}}form{{margin:12px 0;padding:12px;border:1px solid #ddd;border-radius:8px}}textarea{{width:100%;min-height:100px}}</style></head><body><nav><a href="/">Objects</a></nav>{body}</body></html>'''
    def _obj_nav(self,oid):
        q=html.escape(oid); return f'<nav><a href="/object/{q}">Detail</a><a href="/object/{q}/proposals">Suggestions</a><a href="/object/{q}/history">History</a><a href="/object/{q}/connection">Connection & Context</a></nav>'
    def do_GET(self):
        try:
            p=urlparse(self.path).path
            if p=="/health": return self._send_json(200,{"ok":True,"entry":"NATIVE","session":bool(self.client.token)})
            if p=="/api/objects": return self._send_json(200,self.client.list_objects())
            parts=[x for x in p.split('/') if x]
            if len(parts)==3 and parts[:2]==["api","objects"]: return self._send_json(200,self.client.read_object(parts[2]))
            if len(parts)==4 and parts[:2]==["api","objects"] and parts[3]=="proposals": return self._send_json(200,self.client.proposals(parts[2]))
            if len(parts)==4 and parts[:2]==["api","objects"] and parts[3]=="history": return self._send_json(200,self.client.history(parts[2]))
            if len(parts)==4 and parts[:2]==["api","objects"] and parts[3]=="connection":
                obj=self.client.read_object(parts[2]); return self._send_json(200,{"ok":obj.get("ok",False),"entry":"NATIVE","gateway":self.client.base_url,"state_stamp":obj.get("state_stamp"),"revision_id":obj.get("revision_id"),"adoption_id":obj.get("adoption_id"),"context_pack_digest":obj.get("context_pack_digest")})
            if p=="/":
                objs=self.client.list_objects().get("objects",[]); lis=''.join(f'<li><a href="/object/{html.escape(o["object_id"])}">{html.escape(o.get("title") or o["object_id"])}</a></li>' for o in objs)
                body=f'''<h1>Objects</h1><ul>{lis}</ul><h2>Create</h2><form method="post" action="/create"><label>Title <input name="title" required></label><label><br>Body JSON<textarea name="body_json">{{"items":[]}}</textarea></label><button>Create</button></form>'''
                return self._send_html(200,self._page("Clued Native",body))
            if len(parts)>=2 and parts[0]=="object":
                oid=parts[1]; nav=self._obj_nav(oid)
                if len(parts)==2:
                    o=self.client.read_object(oid); body=nav+"<h1>Object detail</h1><pre>"+html.escape(json.dumps(o,ensure_ascii=False,indent=2))+"</pre>"; return self._send_html(200,self._page("Object detail",body))
                if len(parts)==3 and parts[2]=="proposals":
                    cur=self.client.read_object(oid); props=self.client.proposals(oid).get("proposals",[]); blocks=[]
                    for pr in props:
                        if pr.get("status")!="OPEN": continue
                        blocks.append(f'''<section><h3>{html.escape(pr["proposal_id"])}</h3><p>Current</p><pre>{html.escape(json.dumps(cur.get("body"),ensure_ascii=False,indent=2))}</pre><p>Proposed</p><pre>{html.escape(json.dumps(pr.get("proposed_body"),ensure_ascii=False,indent=2))}</pre><form method="post" action="/object/{html.escape(oid)}/confirm"><input type="hidden" name="proposal_id" value="{html.escape(pr["proposal_id"])}"><input type="hidden" name="state_stamp_json" value="{html.escape(json.dumps(cur.get("state_stamp"),ensure_ascii=False,separators=(',',':')),quote=True)}"><input type="hidden" name="request_id" value="{new_id('req')}"><button>Confirm this exact suggestion</button></form></section>''')
                    body=nav+"<h1>Suggestions / diff / confirm</h1>"+(''.join(blocks) or '<p>No open suggestions.</p>'); return self._send_html(200,self._page("Suggestions",body))
                if len(parts)==3 and parts[2]=="history":
                    h=self.client.history(oid); body=nav+"<h1>History</h1><pre>"+html.escape(json.dumps(h,ensure_ascii=False,indent=2))+"</pre>"; return self._send_html(200,self._page("History",body))
                if len(parts)==3 and parts[2]=="connection":
                    o=self.client.read_object(oid); detail={"entry":"NATIVE","gateway":self.client.base_url,"revision_id":o.get("revision_id"),"adoption_id":o.get("adoption_id"),"state_stamp":o.get("state_stamp"),"context_pack_digest":o.get("context_pack_digest")}; body=nav+"<h1>Connection & context</h1><pre>"+html.escape(json.dumps(detail,ensure_ascii=False,indent=2))+"</pre>"; return self._send_html(200,self._page("Connection & context",body))
            self._send_json(404,{"ok":False,"error":"NOT_FOUND"})
        except ProtocolError as e:self._send_json(e.status,e.as_dict())
    def do_POST(self):
        try:
            p=urlparse(self.path).path
            if p=="/create" and self.headers.get("Content-Type","").startswith("application/x-www-form-urlencoded"):
                f=self._form(); body=strict_json_loads(f.get("body_json","{}")); out=self.client.create_object(f.get("title","Untitled"),body,new_id("req")); return self._send_html(200,self._page("Created",f'<h1>Created</h1><pre>{html.escape(json.dumps(out,ensure_ascii=False,indent=2))}</pre><p><a href="/object/{html.escape(out.get("object_id",""))}">Open</a></p>'))
            parts=[x for x in p.split('/') if x]
            if len(parts)==3 and parts[0]=="object" and parts[2]=="confirm" and self.headers.get("Content-Type","").startswith("application/x-www-form-urlencoded"):
                f=self._form(); stamp=strict_json_loads(f.get("state_stamp_json","{}")); out=self.client.confirm(parts[1],f.get("proposal_id",""),stamp,f.get("request_id",new_id("req"))); return self._send_html(200,self._page("Confirmation result",self._obj_nav(parts[1])+f'<h1>Confirmation result</h1><pre>{html.escape(json.dumps(out,ensure_ascii=False,indent=2))}</pre>'))
            b=self._body()
            if p=="/api/objects": return self._send_json(200,self.client.create_object(b.get("title","Untitled"),b.get("body",{}),b.get("request_id","")))
            if len(parts)==4 and parts[:2]==["api","objects"] and parts[3]=="confirm": return self._send_json(200,self.client.confirm(parts[2],b.get("proposal_id",""),b.get("state_stamp",{}),b.get("request_id","")))
            self._send_json(404,{"ok":False,"error":"NOT_FOUND"})
        except ProtocolError as e:self._send_json(e.status,e.as_dict())

def main(argv=None):
    ap=argparse.ArgumentParser(); ap.add_argument("--gateway",required=True); ap.add_argument("--host",default="127.0.0.1"); ap.add_argument("--port",type=int,required=True); ap.add_argument("--entry-secret",required=True); args=ap.parse_args(argv)
    c=GatewayClient(args.gateway,"NATIVE",args.entry_secret)
    last=None
    for _ in range(100):
        try:c.start_session(); last=None; break
        except Exception as e:last=e; time.sleep(0.05)
    if last is not None: raise last
    NativeHandler.client=c; srv=ThreadingHTTPServer((args.host,args.port),NativeHandler); print(json.dumps({"ready":True,"entry":"NATIVE","host":args.host,"port":args.port,"gateway":args.gateway}),flush=True)
    try:srv.serve_forever()
    except KeyboardInterrupt:pass
    finally:srv.server_close()
if __name__=="__main__": main()
