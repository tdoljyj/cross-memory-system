import json
import os
import pathlib
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

REPO=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/"development"))
from mps.mps03.client import GatewayClient
from mps.mps03.common import ProtocolError
from mps.mps03.gateway_http import Handler


class ErrorBoundaries(unittest.TestCase):
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
