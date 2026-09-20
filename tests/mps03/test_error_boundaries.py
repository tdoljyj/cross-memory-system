import base64
import json
import os
import pathlib
import sys
import threading
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

REPO=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/"development"))
from mps.mps03.client import GatewayClient
from mps.mps03.common import ProtocolError
from mps.mps03.gateway_http import Handler
from mps.mps03.native_entry import NativeHandler
from mps.mps03.agent_host_entry import AgentHandler


class ErrorBoundaries(unittest.TestCase):
    def test_denied_gateway_session_is_bounded_for_agent_and_bad_lengths(self):
        class DeniedSessions(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                body=b'{"ok":false,"error":"ENTRY_AUTHENTICATION_FAILED"}'
                self.send_response(401)
                self.send_header("Content-Type","application/json")
                self.send_header("Content-Length",str(len(body)))
                self.end_headers(); self.wfile.write(body)
        denied=ThreadingHTTPServer(("127.0.0.1",0),DeniedSessions)
        denied_thread=threading.Thread(target=denied.serve_forever,daemon=True); denied_thread.start()
        client=GatewayClient(f"http://127.0.0.1:{denied.server_port}","THIRD_PARTY_AGENT_HOST","agent-gateway-secret")
        access="mps03-agent-access-"+"x"*32
        class AgentTestHandler(AgentHandler):
            access_secret=access
        AgentTestHandler.client=client
        agent=ThreadingHTTPServer(("127.0.0.1",0),AgentTestHandler)
        agent_thread=threading.Thread(target=agent.serve_forever,daemon=True); agent_thread.start()
        class GatewayTestHandler(Handler):
            store=object()
        gateway=ThreadingHTTPServer(("127.0.0.1",0),GatewayTestHandler)
        gateway_thread=threading.Thread(target=gateway.serve_forever,daemon=True); gateway_thread.start()
        try:
            with self.assertRaises(ProtocolError) as caught: client.start_session()
            self.assertEqual(caught.exception.status,401)
            self.assertEqual(caught.exception.code,"ENTRY_AUTHENTICATION_FAILED")
            request=Request(f"http://127.0.0.1:{agent.server_port}/agent/read",data=b'{"object_id":"x"}',headers={"Authorization":"Bearer "+access,"Content-Type":"application/json"},method="POST")
            with self.assertRaises(HTTPError) as caught: urlopen(request,timeout=5)
            self.assertEqual(caught.exception.code,401)
            self.assertEqual(json.loads(caught.exception.read())["error"],"ENTRY_AUTHENTICATION_FAILED")
            for port,path,headers in (
                (agent.server_port,"/agent/read",{"Authorization":"Bearer "+access}),
                (gateway.server_port,"/v1/sessions",{}),
            ):
                for length in ("invalid","-1"):
                    with self.subTest(port=port,length=length):
                        conn=HTTPConnection("127.0.0.1",port,timeout=5)
                        conn.putrequest("POST",path)
                        conn.putheader("Content-Length",length)
                        for name,value in headers.items(): conn.putheader(name,value)
                        conn.endheaders()
                        response=conn.getresponse()
                        self.assertEqual(response.status,400)
                        self.assertEqual(json.loads(response.read())["error"],"INVALID_CONTENT_LENGTH")
                        conn.close()
        finally:
            for server,thread in ((agent,agent_thread),(gateway,gateway_thread),(denied,denied_thread)):
                server.shutdown(); server.server_close(); thread.join(timeout=5)

    def test_store_conflict_is_http_409_for_gateway_native_form_and_api(self):
        class ConflictStore:
            def create_session(self,*args): return {"ok":True,"session_token":"test-session","principal":"native-user"}
            def create_object(self,*args): return {"ok":False,"status":"conflict","error":"IDEMPOTENCY_CONFLICT"}
        class ConflictHandler(Handler):
            store=ConflictStore()
        gateway=ThreadingHTTPServer(("127.0.0.1",0),ConflictHandler)
        gateway_thread=threading.Thread(target=gateway.serve_forever,daemon=True); gateway_thread.start()
        invalid=Request(f"http://127.0.0.1:{gateway.server_port}/v1/sessions",data=b"\xff",headers={"Content-Type":"application/json"},method="POST")
        with self.assertRaises(HTTPError) as caught: urlopen(invalid,timeout=5)
        self.assertEqual(caught.exception.code,400)
        self.assertEqual(json.loads(caught.exception.read())["error"],"INVALID_UTF8")
        client=GatewayClient(f"http://127.0.0.1:{gateway.server_port}","NATIVE","test-gateway-secret")
        client.start_session()
        self.assertEqual(client.create_object("title",{},"req-conflict")["http_status"],409)
        access="mps03-native-access-"+"x"*32
        class NativeTestHandler(NativeHandler):
            access_secret=access
        NativeTestHandler.client=client
        native=ThreadingHTTPServer(("127.0.0.1",0),NativeTestHandler)
        native_thread=threading.Thread(target=native.serve_forever,daemon=True); native_thread.start()
        try:
            base=f"http://127.0.0.1:{native.server_port}"
            auth="Basic "+base64.b64encode(("native:"+access).encode()).decode()
            form=Request(base+"/create",data=urlencode({"title":"title","details":"x","request_id":"req-conflict"}).encode(),headers={"Content-Type":"application/x-www-form-urlencoded","Authorization":auth},method="POST")
            with self.assertRaises(HTTPError) as caught: urlopen(form,timeout=5)
            self.assertEqual(caught.exception.code,409)
            page=caught.exception.read().decode()
            self.assertIn("This request key belongs to a different change",page)
            self.assertNotIn("We could not confirm the result",page)
            self.assertIn("Edit and submit as a new request",page)
            api=Request(base+"/api/objects",data=json.dumps({"title":"title","body":{},"request_id":"req-conflict"}).encode(),headers={"Content-Type":"application/json","Authorization":auth},method="POST")
            with self.assertRaises(HTTPError) as caught: urlopen(api,timeout=5)
            self.assertEqual(caught.exception.code,409)
            self.assertEqual(json.loads(caught.exception.read())["error"],"IDEMPOTENCY_CONFLICT")
        finally:
            native.shutdown(); native.server_close(); native_thread.join(timeout=5)
            gateway.shutdown(); gateway.server_close(); gateway_thread.join(timeout=5)

    def test_gateway_url_rejects_non_loopback_or_embedded_credentials(self):
        for url in ("https://example.test:443","http://example.test:8080",
                    "http://user:secret@127.0.0.1:8080","http://127.0.0.1:8080/path",
                    "http://127.0.0.1:8080/?token=secret"):
            with self.subTest(url=url), self.assertRaisesRegex(RuntimeError,"loopback"):
                GatewayClient(url,"NATIVE","test-secret")
        GatewayClient("http://127.0.0.1:8080","NATIVE","test-secret")
    def test_gateway_transport_failure_is_structured(self):
        client=GatewayClient("http://127.0.0.1:1","THIRD_PARTY_AGENT_HOST","agent-secret")
        client.token="session"
        with patch.object(client._opener,"open",side_effect=URLError("connection refused")):
            with self.assertRaises(ProtocolError) as caught:
                client.read_object("object-1")
        self.assertEqual(caught.exception.status,503)
        self.assertEqual(caught.exception.code,"GATEWAY_UNAVAILABLE")

    def test_gateway_entry_secret_never_uses_ambient_http_proxy(self):
        class LocalGateway(BaseHTTPRequestHandler):
            called=False
            def log_message(self,*args): pass
            def do_POST(self):
                LocalGateway.called=True
                body=b'{"session_token":"local-session"}'
                self.send_response(200)
                self.send_header("Content-Length",str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server=ThreadingHTTPServer(("127.0.0.1",0),LocalGateway)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ,{"HTTP_PROXY":"http://127.0.0.1:1","http_proxy":"http://127.0.0.1:1",
                                        "ALL_PROXY":"http://127.0.0.1:1","all_proxy":"http://127.0.0.1:1",
                                        "NO_PROXY":"","no_proxy":""}):
                client=GatewayClient(f"http://127.0.0.1:{server.server_port}","NATIVE","gateway-secret")
                self.assertEqual(client.start_session()["session_token"],"local-session")
            self.assertTrue(LocalGateway.called)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_gateway_redirect_never_forwards_session_token(self):
        class Sink(BaseHTTPRequestHandler):
            called=False
            def log_message(self,*args): pass
            def do_GET(self):
                Sink.called=True
                self.send_response(200)
                self.end_headers()
        sink=ThreadingHTTPServer(("127.0.0.1",0),Sink)
        class RedirectingGateway(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location",f"http://127.0.0.1:{sink.server_port}/capture")
                self.end_headers()
        gateway=ThreadingHTTPServer(("127.0.0.1",0),RedirectingGateway)
        threads=[]
        for server in (sink,gateway):
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start(); threads.append(thread)
        try:
            client=GatewayClient(f"http://127.0.0.1:{gateway.server_port}","NATIVE","gateway-secret")
            client.token="private-session-token"
            with self.assertRaises(ProtocolError): client.list_objects()
            self.assertFalse(Sink.called)
        finally:
            for server,thread in zip((sink,gateway),threads):
                server.shutdown(); server.server_close(); thread.join(timeout=5)

    def test_unexpected_gateway_exception_is_redacted(self):
        class FailingHandler(Handler):
            def _dispatch(self):
                raise RuntimeError("postgresql://user:private-password@host/db")

        server=ThreadingHTTPServer(("127.0.0.1",0),FailingHandler)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            with self.assertRaises(HTTPError) as caught:
                urlopen(f"http://127.0.0.1:{server.server_port}/v1/objects",timeout=5)
            body=caught.exception.read().decode()
            self.assertEqual(caught.exception.code,500)
            self.assertEqual(json.loads(body)["error"],"INTERNAL_ERROR")
            self.assertNotIn("private-password",body)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
