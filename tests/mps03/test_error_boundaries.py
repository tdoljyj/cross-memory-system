import json
import pathlib
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

REPO=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/"development"))
from mps.mps03.client import GatewayClient
from mps.mps03.common import ProtocolError
from mps.mps03.gateway_http import Handler


class ErrorBoundaries(unittest.TestCase):
    def test_gateway_transport_failure_is_structured(self):
        client=GatewayClient("http://127.0.0.1:1","THIRD_PARTY_AGENT_HOST","agent-secret")
        client.token="session"
        with patch("mps.mps03.client.urlopen",side_effect=URLError("connection refused")):
            with self.assertRaises(ProtocolError) as caught:
                client.read_object("object-1")
        self.assertEqual(caught.exception.status,503)
        self.assertEqual(caught.exception.code,"GATEWAY_UNAVAILABLE")

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
