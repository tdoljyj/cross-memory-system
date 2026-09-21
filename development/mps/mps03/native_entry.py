#!/usr/bin/env python3
from __future__ import annotations
import argparse, difflib, html, ipaddress, json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
try:
    from .client import GatewayClient
    from .common import strict_json_loads, strict_utf8_decode, ProtocolError, bounded_request_body, new_id, require_entry_access, require_secret_namespace, NATIVE_GATEWAY_PREFIX, NATIVE_ACCESS_PREFIX
except ImportError:
    from client import GatewayClient
    from common import strict_json_loads, strict_utf8_decode, ProtocolError, bounded_request_body, new_id, require_entry_access, require_secret_namespace, NATIVE_GATEWAY_PREFIX, NATIVE_ACCESS_PREFIX

class NativeHandler(BaseHTTPRequestHandler):
    client: GatewayClient = None  # type: ignore
    access_secret: str = ""
    server_version="CluedMPS03Native/1"
    def log_message(self,fmt,*args):
        if os.environ.get("MPS03_HTTP_LOG")=="1": super().log_message(fmt,*args)
    def _raw(self,max_bytes=None):
        if max_bytes is not None:
            return bounded_request_body(self,max_bytes,"FORM_TOO_LARGE","form exceeds the supported size")
        return bounded_request_body(self)
    def _body(self):
        value=strict_json_loads(strict_utf8_decode(self._raw() or b"{}"))
        if not isinstance(value,dict): raise ProtocolError("JSON_OBJECT_REQUIRED","request body must be a JSON object",400)
        return value
    def _form(self):
        try: return {k:v[-1] for k,v in parse_qs(strict_utf8_decode(self._raw(262144)),keep_blank_values=True,errors="strict").items()}
        except UnicodeDecodeError: raise ProtocolError("INVALID_UTF8","request body must be UTF-8",400) from None
    def _send_json(self,status,obj):
        b=(json.dumps(obj,ensure_ascii=False,separators=(",",":"))+"\n").encode(); self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Cache-Control","no-store"); self.send_header("Content-Length",str(len(b)));
        if status==401: self.send_header("WWW-Authenticate",'Basic realm="Clued Native"')
        self.end_headers(); self.wfile.write(b)
    def _send_html(self,status,markup):
        b=markup.encode(); self.send_response(status); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Cache-Control","no-store"); self.send_header("Content-Security-Policy","frame-ancestors 'none'"); self.send_header("X-Frame-Options","DENY"); self.send_header("Content-Length",str(len(b)));
        if status==401: self.send_header("WWW-Authenticate",'Basic realm="Clued Native"')
        self.end_headers(); self.wfile.write(b)
    def _forward(self,obj):
        return self._send_json(obj.get("http_status") or (409 if obj.get("ok") is False else 200),obj)
    def _authenticate(self):
        require_entry_access(self.headers.get("Authorization", ""), "NATIVE", self.access_secret)
    def _check_origin(self):
        origin=self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            raise ProtocolError("ENTRY_ORIGIN_DENIED","cross-origin write rejected",403)
    def _page(self,title,body):
        return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title><style>body{{font-family:system-ui,sans-serif;max-width:880px;margin:32px auto;padding:0 16px}}nav a{{margin-right:12px}}pre{{white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:8px}}form,details{{margin:12px 0;padding:12px;border:1px solid #ddd;border-radius:8px}}textarea{{width:100%;min-height:100px}}li{{margin:8px 0}}summary{{cursor:pointer}}.content{{white-space:pre-wrap}}</style></head><body><nav><a href="/">Objects</a></nav>{body}</body></html>'''
    def _technical(self,obj):
        payload=html.escape(json.dumps(obj,ensure_ascii=False,indent=2))
        return f'<details><summary>Technical details</summary><pre>{payload}</pre></details>'
    def _html_error(self,out):
        status=out.get("http_status") or 500
        if status==401:
            message=("Access is no longer available. Restore your Native credential, then return to the previous form and retry the exact same request."
                     if self.command=="POST" else "Access is no longer available. Check your Native credential and reload this page.")
        elif status==403: message="You do not have permission to open this page."
        elif status==404: message="This plan or page could not be found."
        elif status==409: message="This view is out of date. Reload it and review the latest plan."
        elif status>=500: message="Clued is temporarily unavailable. Reload this page to try again."
        else: message="Could not open this page. Reload it or return to plans."
        body=f'<h1>{html.escape(message)}</h1><p><a href="/">Back to plans</a></p>'+self._technical(out)
        return self._send_html(status,self._page("Could not open page",body))
    def _content(self,value,omit_title=False):
        if isinstance(value,dict):
            fields=''.join(f'<li><strong>{html.escape(str(k))}</strong>: {self._content(v)}</li>' for k,v in value.items() if not (omit_title and k=="title"))
            return '<ul>'+fields+'</ul>' if fields else '<p>No details yet.</p>'
        if isinstance(value,list):
            return '<ul>'+''.join('<li>'+self._content(v)+'</li>' for v in value)+'</ul>'
        if value is None: return '<span>None</span>'
        return '<span class="content">'+html.escape(str(value))+'</span>'
    def _result(self,out,success_text,object_id=""):
        message=success_text
        link=f'<p><a href="/object/{html.escape(object_id)}">Review plan</a></p>' if object_id else '<p><a href="/">Back to plans</a></p>'
        return self._page("Result",f'<h1>{html.escape(message)}</h1>'+link+self._technical(out))
    def _form_failure(self,out,fields,kind,object_id=""):
        status=out.get("http_status") or 500
        pending=fields.get("_recovery_pending")=="1"
        uncertain=status>=500 or pending
        if pending and status<500:
            message="This retry was rejected, but the original result is still unknown. Keep this exact request and try again after resolving the error."
        elif uncertain:
            message="We could not confirm the result. Retry this exact request to recover its original result."
        elif status==401:
            message="Access is no longer available. Check your Native credential before trying again."
        elif status==403:
            message="You do not have permission to make this change."
        elif out.get("error")=="IDEMPOTENCY_CONFLICT":
            message="This request key belongs to a different change. Review the plan before starting a new request."
        elif out.get("error") in ("STALE_CONTEXT_REQUIRES_REFRESH","CONFIRMATION_TARGET_CHANGED"):
            message="This plan changed. Review the latest suggestion before confirming again."
        else:
            message="This request was rejected. Review the details before trying again."
        if kind=="create":
            title=fields.get("title","Untitled")
            detail_name="body_json" if "body_json" in fields else "details"
            details=fields.get(detail_name,"")
            submitted=f'<h2>Submitted plan</h2><p><strong>Title:</strong> {html.escape(title)}</p><pre>{html.escape(details)}</pre>'
            if uncertain:
                action='<form method="post" action="/create">'+''.join(f'<input type="hidden" name="{name}" value="{html.escape(fields.get(name,""),quote=True)}">' for name in ("title",detail_name,"request_id"))+'<input type="hidden" name="_recovery_pending" value="1"><button>Retry this exact request</button></form>'
            else:
                action=f'<form method="post" action="/create"><label>Title <input name="title" value="{html.escape(title,quote=True)}" required></label><label><br>Plan details<textarea name="{detail_name}">{html.escape(details)}</textarea></label><input type="hidden" name="request_id" value="{new_id("req")}"><button>Edit and submit as a new request</button></form>'
            back='<p><a href="/">Back to plans</a></p>'
        else:
            submitted='<h2>Submitted suggestion</h2><p>Review the plan before making another change.</p>'
            if uncertain:
                action=f'<form method="post" action="/object/{html.escape(object_id,quote=True)}/confirm">'+''.join(f'<input type="hidden" name="{name}" value="{html.escape(fields.get(name,""),quote=True)}">' for name in ("proposal_id","state_stamp_json","request_id"))+'<input type="hidden" name="_recovery_pending" value="1"><button>Retry this exact confirmation</button></form>'
            else: action=''
            back=f'<p><a href="/object/{html.escape(object_id,quote=True)}/proposals">Review latest suggestions</a></p>'
        body=f'<h1>{html.escape(message)}</h1>'+submitted+action+back+self._technical(out)
        return self._send_html(status,self._page("Request result",body))
    def _obj_nav(self,oid):
        q=html.escape(oid); return f'<nav><a href="/object/{q}">Detail</a><a href="/object/{q}/proposals">Suggestions</a><a href="/object/{q}/history">History</a><a href="/object/{q}/connection">Connection & Context</a></nav>'
    def do_GET(self):
        try:
            p=urlparse(self.path).path
            if p=="/health": return self._send_json(200,{"ok":True,"entry":"NATIVE","session":bool(self.client.token)})
            self._authenticate()
            if p=="/api/objects": return self._forward(self.client.list_objects())
            parts=[x for x in p.split('/') if x]
            if len(parts)==3 and parts[:2]==["api","objects"]: return self._forward(self.client.read_object(parts[2]))
            if len(parts)==4 and parts[:2]==["api","objects"] and parts[3]=="proposals": return self._forward(self.client.proposals(parts[2]))
            if len(parts)==4 and parts[:2]==["api","objects"] and parts[3]=="history": return self._forward(self.client.history(parts[2]))
            if len(parts)==4 and parts[:2]==["api","objects"] and parts[3]=="connection":
                obj=self.client.read_object(parts[2])
                if not obj.get("ok"): return self._forward(obj)
                return self._forward({"ok":True,"entry":"NATIVE","gateway":self.client.base_url,"state_stamp":obj.get("state_stamp"),"revision_id":obj.get("revision_id"),"adoption_id":obj.get("adoption_id"),"context_pack_digest":obj.get("context_pack_digest")})
            if p=="/new":
                body=f'''<h1>Create a plan</h1><form method="post" action="/create"><label>Title <input name="title" required></label><label><br>Plan details<textarea name="details"></textarea></label><input type="hidden" name="request_id" value="{new_id('req')}"><button>Create</button></form>'''
                return self._send_html(200,self._page("Create a plan",body))
            if p=="/":
                listing=self.client.list_objects()
                if not listing.get("ok"): return self._html_error(listing)
                objs=listing.get("objects",[]); lis=''.join(f'<li><a href="/object/{html.escape(o["object_id"])}">{html.escape(o.get("title") or o["object_id"])}</a></li>' for o in objs)
                body=f'''<h1>Objects</h1><ul>{lis}</ul><h2>Create a plan</h2><form method="post" action="/create"><label>Title <input name="title" required></label><label><br>Plan details<textarea name="details"></textarea></label><input type="hidden" name="request_id" value="{new_id('req')}"><button>Create</button></form>'''
                return self._send_html(200,self._page("Clued Native",body))
            if len(parts)>=2 and parts[0]=="object":
                oid=parts[1]; nav=self._obj_nav(oid)
                if len(parts)==2:
                    o=self.client.read_object(oid)
                    if not o.get("ok"): return self._html_error(o)
                    title=o.get("body",{}).get("title") if isinstance(o.get("body"),dict) else None
                    body=nav+"<h1>"+html.escape(title or "Plan details")+"</h1><h2>Plan content</h2>"+self._content(o.get("body"),omit_title=True)+self._technical(o)
                    return self._send_html(200,self._page("Plan details",body))
                if len(parts)==3 and parts[2]=="proposals":
                    cur=self.client.read_object(oid)
                    if not cur.get("ok"): return self._html_error(cur)
                    proposal_result=self.client.proposals(oid)
                    if not proposal_result.get("ok"): return self._html_error(proposal_result)
                    props=proposal_result.get("proposals",[]); blocks=[]
                    for pr in props:
                        if pr.get("status")!="OPEN": continue
                        current=json.dumps(cur.get("body"),ensure_ascii=False,indent=2,sort_keys=True).splitlines()
                        proposed=json.dumps(pr.get("proposed_body"),ensure_ascii=False,indent=2,sort_keys=True).splitlines()
                        diff='\n'.join(difflib.unified_diff(current,proposed,fromfile='before',tofile='after',lineterm='')) or '(no content changes)'
                        confirm_form=('<p>Confirmation unavailable for this principal.</p>' if cur.get("state_stamp_action")=="read" else f'''<form method="post" action="/object/{html.escape(oid)}/confirm"><input type="hidden" name="proposal_id" value="{html.escape(pr["proposal_id"])}"><input type="hidden" name="state_stamp_json" value="{html.escape(json.dumps(cur.get("state_stamp"),ensure_ascii=False,separators=(',',':')),quote=True)}"><input type="hidden" name="request_id" value="{new_id('req')}"><button>Confirm this exact suggestion</button></form>''')
                        blocks.append(f'''<section><h3>Suggested change</h3><h4>Before</h4>{self._content(cur.get("body"))}<h4>After</h4>{self._content(pr.get("proposed_body"))}<h4>Difference</h4><pre>{html.escape(diff)}</pre>{confirm_form}{self._technical(pr)}</section>''')
                    body=nav+"<h1>Suggestions / diff / confirm</h1>"+(''.join(blocks) or '<p>No open suggestions.</p>'); return self._send_html(200,self._page("Suggestions",body))
                if len(parts)==3 and parts[2]=="history":
                    current=self.client.read_object(oid)
                    if not current.get("ok"): return self._html_error(current)
                    h=self.client.history(oid)
                    if not h.get("ok"): return self._html_error(h)
                    versions=''.join(f'<li><h2>Version {i}</h2>{self._content(row.get("body"))}{self._technical(row)}</li>' for i,row in enumerate(h.get("history",[]),1))
                    body=nav+"<h1>History</h1><ol>"+versions+"</ol>"+self._technical(h)
                    return self._send_html(200,self._page("History",body))
                if len(parts)==3 and parts[2]=="connection":
                    o=self.client.read_object(oid)
                    if not o.get("ok"): return self._html_error(o)
                    detail={"entry":"NATIVE","gateway":self.client.base_url,"revision_id":o.get("revision_id"),"adoption_id":o.get("adoption_id"),"state_stamp":o.get("state_stamp"),"context_pack_digest":o.get("context_pack_digest")}
                    body=nav+"<h1>Connection & context</h1><p>Connected to Clued. Your permissions are checked for each action.</p>"+self._technical(detail)
                    return self._send_html(200,self._page("Connection & context",body))
            if p.startswith("/api/"): self._send_json(404,{"ok":False,"error":"NOT_FOUND"})
            else: self._html_error({"ok":False,"error":"NOT_FOUND","http_status":404})
        except ProtocolError as e:
            if p=="/health" or p.startswith("/api/"): self._send_json(e.status,e.as_dict())
            else: self._html_error({**e.as_dict(),"http_status":e.status})
    def do_POST(self):
        try:
            p=urlparse(self.path).path
            parts=[x for x in p.split('/') if x]
            form_content=self.headers.get("Content-Type","").startswith("application/x-www-form-urlencoded")
            create_form=p=="/create" and form_content
            confirm_form=len(parts)==3 and parts[0]=="object" and parts[2]=="confirm" and form_content
            f=None
            self._authenticate(); self._check_origin()
            f=self._form() if create_form or confirm_form else None
            if create_form:
                try:
                    body=strict_json_loads(f["body_json"]) if "body_json" in f else {"details":f.get("details","")}
                    out=self.client.create_object(f.get("title","Untitled"),body,f.get("request_id",""))
                except ProtocolError as e: out={**e.as_dict(),"http_status":e.status}
                status=200 if out.get("ok") else out.get("http_status",409)
                if not out.get("ok"): return self._form_failure(out,f,"create")
                return self._send_html(status,self._result(out,"Plan created.",out.get("object_id", "")))
            if confirm_form:
                try:
                    stamp=strict_json_loads(f.get("state_stamp_json","{}"))
                    out=self.client.confirm(parts[1],f.get("proposal_id",""),stamp,f.get("request_id",""))
                except ProtocolError as e: out={**e.as_dict(),"http_status":e.status}
                status=200 if out.get("ok") else out.get("http_status",409)
                if not out.get("ok"): return self._form_failure(out,f,"confirm",parts[1])
                return self._send_html(status,self._result(out,"Suggestion confirmed.",parts[1]))
            b=self._body()
            if p=="/api/objects": return self._forward(self.client.create_object(b.get("title","Untitled"),b.get("body",{}),b.get("request_id","")))
            if len(parts)==4 and parts[:2]==["api","objects"] and parts[3]=="confirm": return self._forward(self.client.confirm(parts[2],b.get("proposal_id",""),b.get("state_stamp",{}),b.get("request_id","")))
            self._send_json(404,{"ok":False,"error":"NOT_FOUND"})
        except ProtocolError as e:
            if (create_form or confirm_form) and f is not None:
                self._form_failure({**e.as_dict(),"http_status":e.status},f,"create" if create_form else "confirm",parts[1] if confirm_form else "")
            elif create_form or confirm_form: self._html_error({**e.as_dict(),"http_status":e.status})
            else: self._send_json(e.status,e.as_dict())

def main(argv=None):
    ap=argparse.ArgumentParser(); ap.add_argument("--gateway",required=True); ap.add_argument("--host",default="127.0.0.1"); ap.add_argument("--port",type=int,required=True); args=ap.parse_args(argv)
    if args.host!="localhost" and not ipaddress.ip_address(args.host).is_loopback: raise RuntimeError("Native entry must bind to loopback")
    access_secret=os.environ.get("MPS03_NATIVE_ACCESS_SECRET","")
    entry_secret=os.environ.get("MPS03_NATIVE_ENTRY_SECRET","")
    require_secret_namespace(entry_secret,NATIVE_GATEWAY_PREFIX,"Native gateway secret")
    require_secret_namespace(access_secret,NATIVE_ACCESS_PREFIX,"Native caller access secret")
    c=GatewayClient(args.gateway,"NATIVE",entry_secret)
    last=None
    for _ in range(100):
        try:c.start_session(); last=None; break
        except Exception as e:last=e; time.sleep(0.05)
    if last is not None: raise last
    NativeHandler.client=c; NativeHandler.access_secret=access_secret; srv=ThreadingHTTPServer((args.host,args.port),NativeHandler); print(json.dumps({"ready":True,"entry":"NATIVE","host":args.host,"port":args.port,"gateway":args.gateway}),flush=True)
    try:srv.serve_forever()
    except KeyboardInterrupt:pass
    finally:srv.server_close()
if __name__=="__main__": main()
