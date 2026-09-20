from __future__ import annotations
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
try:
    from .common import ProtocolError
except ImportError:
    from common import ProtocolError

class GatewayClient:
    def __init__(self, base_url: str, entry_kind: str, entry_secret: str):
        self.base_url=base_url.rstrip('/'); self.entry_kind=entry_kind; self.entry_secret=entry_secret; self.token=None
    def start_session(self):
        r=self._request("POST","/v1/sessions",{"entry_kind":self.entry_kind,"entry_secret":self.entry_secret},auth=False); self.token=r["session_token"]; return r
    def _request(self,method,path,body=None,auth=True,_retried_session=False):
        data=None if body is None else json.dumps(body,ensure_ascii=False,separators=(",",":")).encode()
        headers={"Content-Type":"application/json"}
        if auth:
            if not self.token: self.start_session()
            headers["Authorization"]="Bearer "+self.token
        req=Request(self.base_url+path,data=data,headers=headers,method=method)
        try:
            with urlopen(req,timeout=10) as r:
                payload=json.loads(r.read().decode())
                if not isinstance(payload,dict): raise ValueError("gateway response is not an object")
                return payload
        except HTTPError as e:
            try:
                payload=json.loads(e.read().decode())
                if not isinstance(payload,dict): raise ValueError("gateway response is not an object")
            except (ValueError,UnicodeError):
                raise ProtocolError("GATEWAY_INVALID_RESPONSE","gateway returned an invalid response",502) from None
            payload["http_status"]=e.code
            if auth and e.code==401 and payload.get("error")=="SESSION_REQUIRED" and not _retried_session:
                self.token=None; self.start_session(); return self._request(method,path,body,auth=True,_retried_session=True)
            return payload
        except (URLError,TimeoutError,OSError):
            raise ProtocolError("GATEWAY_UNAVAILABLE","gateway is unavailable",503) from None
        except (ValueError,UnicodeError):
            raise ProtocolError("GATEWAY_INVALID_RESPONSE","gateway returned an invalid response",502) from None
    def list_objects(self): return self._request("GET","/v1/objects")
    def create_object(self,title,body,request_id): return self._request("POST","/v1/objects",{"title":title,"body":body,"request_id":request_id})
    def read_object(self,oid): return self._request("GET",f"/v1/objects/{oid}")
    def proposals(self,oid): return self._request("GET",f"/v1/objects/{oid}/proposals")
    def propose(self,oid,body,stamp): return self._request("POST",f"/v1/objects/{oid}/proposals",{"proposed_body":body,"observed_state_stamp":stamp})
    def confirm(self,oid,pid,stamp,request_id): return self._request("POST",f"/v1/objects/{oid}/confirm",{"proposal_id":pid,"state_stamp":stamp,"request_id":request_id})
    def history(self,oid): return self._request("GET",f"/v1/objects/{oid}/history")
