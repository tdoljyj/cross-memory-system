"""Request v2 projection regressions; public Core inputs, no new data/model calls."""
import base64
import builtins
import copy
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import sys
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts/model-program"
FIXTURE_ROOT = ROOT / "tests/fixtures/model-stage-admission/core-adapter-e76"
# Verbatim immutable f14 request schema bytes, used when sparse checkout omits it.
# This is an existing v2 test Source copy, not a new registered schema.
REQUEST_SCHEMA_RAW = base64.b64decode("eyIkaWQiOiJ1cm46Y2x1ZWQ6c2NoZW1hOm1vZGVsLWludm9jYXRpb24tcmVxdWVzdDp2MiIsIiRzY2hlbWEiOiJodHRwczovL2pzb24tc2NoZW1hLm9yZy9kcmFmdC8yMDIwLTEyL3NjaGVtYSIsImFkZGl0aW9uYWxQcm9wZXJ0aWVzIjpmYWxzZSwiYWxsT2YiOlt7ImlmIjp7InByb3BlcnRpZXMiOnsidHJhaW5pbmdfbW9kZSI6eyJub3QiOnsiY29uc3QiOiJub25lIn19fSwicmVxdWlyZWQiOlsidHJhaW5pbmdfbW9kZSJdfSwidGhlbiI6eyJwcm9wZXJ0aWVzIjp7InRyYWluaW5nX29wdF9pbl9yZWNlaXB0X3JlZiI6eyJtYXhMZW5ndGgiOjUxMiwibWluTGVuZ3RoIjoxLCJ0eXBlIjoic3RyaW5nIn19fX1dLCJwcm9wZXJ0aWVzIjp7ImFkYXB0ZXJfdmVyc2lvbiI6eyJwYXR0ZXJuIjoiXltBLVphLXowLTldW0EtWmEtejAtOS5fOi1dezAsMjU1fSQiLCJ0eXBlIjoic3RyaW5nIn0sImF0dGVtcHRfaWQiOnsicGF0dGVybiI6Il5bQS1aYS16MC05XVtBLVphLXowLTkuXzotXXswLDI1NX0kIiwidHlwZSI6InN0cmluZyJ9LCJiaW5kaW5nX3JlZiI6eyJwYXR0ZXJuIjoiXnNoYTI1NjpbMC05YS1mXXs2NH0kIiwidHlwZSI6InN0cmluZyJ9LCJidWRnZXRzIjp7ImFkZGl0aW9uYWxQcm9wZXJ0aWVzIjpmYWxzZSwicHJvcGVydGllcyI6eyJjdXJyZW5jeSI6eyJwYXR0ZXJuIjoiXltBLVpdezN9JCIsInR5cGUiOiJzdHJpbmcifSwiY3VycmVuY3lfZXhwb25lbnQiOnsibWF4aW11bSI6OSwibWluaW11bSI6MCwidHlwZSI6ImludGVnZXIifSwiY3VycmVuY3lfcHJvZmlsZV9kaWdlc3QiOnsicGF0dGVybiI6Il5zaGEyNTY6WzAtOWEtZl17NjR9JCIsInR5cGUiOiJzdHJpbmcifSwibWF4X2F0dGVtcHRzIjp7Im1pbmltdW0iOjEsInR5cGUiOiJpbnRlZ2VyIn0sIm1heF9jb25jdXJyZW50X3JlcXVlc3RzIjp7Im1pbmltdW0iOjEsInR5cGUiOiJpbnRlZ2VyIn0sIm1heF9jb3N0X21pbm9yX3VuaXRzIjp7Im1pbmltdW0iOjAsInR5cGUiOiJpbnRlZ2VyIn0sIm1heF9lbGFwc2VkX21zIjp7Im1pbmltdW0iOjEsInR5cGUiOiJpbnRlZ2VyIn0sIm1heF9pbnB1dF9ieXRlcyI6eyJtaW5pbXVtIjoxLCJ0eXBlIjoiaW50ZWdlciJ9LCJtYXhfaW5wdXRfdG9rZW5zIjp7Im1pbmltdW0iOjAsInR5cGUiOiJpbnRlZ2VyIn0sIm1heF9vdXRwdXRfdG9rZW5zIjp7Im1pbmltdW0iOjAsInR5cGUiOiJpbnRlZ2VyIn0sIm1heF9yZXF1ZXN0X2NvdW50Ijp7Im1pbmltdW0iOjEsInR5cGUiOiJpbnRlZ2VyIn0sIm1heF9yZXNwb25zZV9ieXRlcyI6eyJtaW5pbXVtIjoxLCJ0eXBlIjoiaW50ZWdlciJ9LCJwYXJzZV9idWRnZXRfbXMiOnsibWluaW11bSI6MCwidHlwZSI6ImludGVnZXIifSwicGVyc2lzdGVuY2VfYnVkZ2V0X21zIjp7Im1pbmltdW0iOjAsInR5cGUiOiJpbnRlZ2VyIn0sInNjcnViX3dhbGxfY2xvY2tfYnVkZ2V0X21zIjp7Im1pbmltdW0iOjAsInR5cGUiOiJpbnRlZ2VyIn0sInZhbGlkYXRpb25fYnVkZ2V0X21zIjp7Im1pbmltdW0iOjAsInR5cGUiOiJpbnRlZ2VyIn19LCJyZXF1aXJlZCI6WyJjdXJyZW5jeSIsImN1cnJlbmN5X2V4cG9uZW50IiwiY3VycmVuY3lfcHJvZmlsZV9kaWdlc3QiLCJtYXhfYXR0ZW1wdHMiLCJtYXhfY29uY3VycmVudF9yZXF1ZXN0cyIsIm1heF9jb3N0X21pbm9yX3VuaXRzIiwibWF4X2VsYXBzZWRfbXMiLCJtYXhfaW5wdXRfYnl0ZXMiLCJtYXhfaW5wdXRfdG9rZW5zIiwibWF4X291dHB1dF90b2tlbnMiLCJtYXhfcmVxdWVzdF9jb3VudCIsIm1heF9yZXNwb25zZV9ieXRlcyIsInBhcnNlX2J1ZGdldF9tcyIsInBlcnNpc3RlbmNlX2J1ZGdldF9tcyIsInNjcnViX3dhbGxfY2xvY2tfYnVkZ2V0X21zIiwidmFsaWRhdGlvbl9idWRnZXRfbXMiXSwidHlwZSI6Im9iamVjdCJ9LCJjYXBhYmlsaXR5Ijp7ImVudW0iOlsic3RydWN0dXJlZF9nZW5lcmF0ZSIsImV4dHJhY3QiLCJjbGFzc2lmeSIsInN1bW1hcml6ZSJdLCJ0eXBlIjoic3RyaW5nIn0sImNvbnRleHRfc2xpY2VfcmVmIjp7Im1heExlbmd0aCI6NTEyLCJtaW5MZW5ndGgiOjEsInR5cGUiOiJzdHJpbmcifSwiY29ycmVsYXRpb25faWQiOnsicGF0dGVybiI6Il5bQS1aYS16MC05XVtBLVphLXowLTkuXzotXXswLDI1NX0kIiwidHlwZSI6InN0cmluZyJ9LCJkYXRhX2NsYXNzaWZpY2F0aW9uIjp7ImVudW0iOlsicHVibGljIiwiaW50ZXJuYWwiLCJwcml2YXRlIiwic2Vuc2l0aXZlIiwic2VjcmV0X3Byb2hpYml0ZWQiXSwidHlwZSI6InN0cmluZyJ9LCJkZWFkbGluZSI6eyJmb3JtYXQiOiJkYXRlLXRpbWUiLCJ0eXBlIjoic3RyaW5nIn0sImV2YWxfc2V0X2RpZ2VzdCI6eyJwYXR0ZXJuIjoiXnNoYTI1NjpbMC05YS1mXXs2NH0kIiwidHlwZSI6InN0cmluZyJ9LCJpZGVtcG90ZW5jeV9rZXkiOnsicGF0dGVybiI6Il5zaGEyNTY6WzAtOWEtZl17NjR9JCIsInR5cGUiOiJzdHJpbmcifSwiaW5wdXRfZGlnZXN0Ijp7InBhdHRlcm4iOiJec2hhMjU2OlswLTlhLWZdezY0fSQiLCJ0eXBlIjoic3RyaW5nIn0sImludm9jYXRpb25faWQiOnsicGF0dGVybiI6Il5bQS1aYS16MC05XVtBLVphLXowLTkuXzotXXswLDI1NX0kIiwidHlwZSI6InN0cmluZyJ9LCJsZWFzZV9oYXJkX3N0b3AiOnsiZm9ybWF0IjoiZGF0ZS10aW1lIiwidHlwZSI6InN0cmluZyJ9LCJtb2RlbF9yZXZpc2lvbiI6eyJwYXR0ZXJuIjoiXltBLVphLXowLTldW0EtWmEtejAtOS5fOi1dezAsMjU1fSQiLCJ0eXBlIjoic3RyaW5nIn0sIm9iamVjdF90eXBlIjp7ImNvbnN0IjoiTW9kZWxJbnZvY2F0aW9uUmVxdWVzdCJ9LCJvdXRwdXRfc2NoZW1hX2RpZ2VzdCI6eyJwYXR0ZXJuIjoiXnNoYTI1NjpbMC05YS1mXXs2NH0kIiwidHlwZSI6InN0cmluZyJ9LCJwb2xpY3lfc25hcHNob3RfZGlnZXN0Ijp7InBhdHRlcm4iOiJec2hhMjU2OlswLTlhLWZdezY0fSQiLCJ0eXBlIjoic3RyaW5nIn0sInByb2plY3RfcmVmIjp7InBhdHRlcm4iOiJec2hhMjU2OlswLTlhLWZdezY0fSQiLCJ0eXBlIjoic3RyaW5nIn0sInByb3ZpZGVyX2lkIjp7InBhdHRlcm4iOiJeW0EtWmEtejAtOV1bQS1aYS16MC05Ll86LV17MCwyNTV9JCIsInR5cGUiOiJzdHJpbmcifSwicHJvdmlkZXJfcXVhbGlmaWNhdGlvbl9yZWYiOnsicGF0dGVybiI6Il5zaGEyNTY6WzAtOWEtZl17NjR9JCIsInR5cGUiOiJzdHJpbmcifSwicHJvdmlkZXJfdHlwZSI6eyJlbnVtIjpbIkhvc3RlZCIsIkxvY2FsIiwiRW50ZXJwcmlzZSIsIlRlc3QiXSwidHlwZSI6InN0cmluZyJ9LCJwdXJwb3NlIjp7Im1heExlbmd0aCI6MjU2LCJtaW5MZW5ndGgiOjEsInR5cGUiOiJzdHJpbmcifSwicmVnaW9uIjp7Im1heExlbmd0aCI6MTI4LCJtaW5MZW5ndGgiOjEsInR5cGUiOiJzdHJpbmcifSwicmV0ZW50aW9uX21vZGUiOnsibWF4TGVuZ3RoIjoxMjgsIm1pbkxlbmd0aCI6MSwidHlwZSI6InN0cmluZyJ9LCJzY2hlbWFfdmVyc2lvbiI6eyJjb25zdCI6IjIuMCJ9LCJzY29wZV9kaWdlc3QiOnsicGF0dGVybiI6Il5zaGEyNTY6WzAtOWEtZl17NjR9JCIsInR5cGUiOiJzdHJpbmcifSwic2VjdXJpdHlfcHJvZmlsZV9pZCI6eyJwYXR0ZXJuIjoiXltBLVphLXowLTldW0EtWmEtejAtOS5fOi1dezAsMjU1fSQiLCJ0eXBlIjoic3RyaW5nIn0sInN0ZXBfZGVhZGxpbmUiOnsiZm9ybWF0IjoiZGF0ZS10aW1lIiwidHlwZSI6InN0cmluZyJ9LCJzdWJqZWN0X3JlZiI6eyJwYXR0ZXJuIjoiXnNoYTI1NjpbMC05YS1mXXs2NH0kIiwidHlwZSI6InN0cmluZyJ9LCJ0ZW1wbGF0ZV9oYXNoIjp7InBhdHRlcm4iOiJec2hhMjU2OlswLTlhLWZdezY0fSQiLCJ0eXBlIjoic3RyaW5nIn0sInRyYWluaW5nX21vZGUiOnsicGF0dGVybiI6Il5bYS16XVthLXowLTlfLV17MCw2M30kIiwidHlwZSI6InN0cmluZyJ9LCJ0cmFpbmluZ19vcHRfaW5fcmVjZWlwdF9yZWYiOnsibWF4TGVuZ3RoIjo1MTIsIm1pbkxlbmd0aCI6MSwidHlwZSI6WyJzdHJpbmciLCJudWxsIl19fSwicmVxdWlyZWQiOlsiYWRhcHRlcl92ZXJzaW9uIiwiYXR0ZW1wdF9pZCIsImJpbmRpbmdfcmVmIiwiYnVkZ2V0cyIsImNhcGFiaWxpdHkiLCJjb250ZXh0X3NsaWNlX3JlZiIsImNvcnJlbGF0aW9uX2lkIiwiZGF0YV9jbGFzc2lmaWNhdGlvbiIsImRlYWRsaW5lIiwiZXZhbF9zZXRfZGlnZXN0IiwiaWRlbXBvdGVuY3lfa2V5IiwiaW5wdXRfZGlnZXN0IiwiaW52b2NhdGlvbl9pZCIsImxlYXNlX2hhcmRfc3RvcCIsIm1vZGVsX3JldmlzaW9uIiwib2JqZWN0X3R5cGUiLCJvdXRwdXRfc2NoZW1hX2RpZ2VzdCIsInBvbGljeV9zbmFwc2hvdF9kaWdlc3QiLCJwcm9qZWN0X3JlZiIsInByb3ZpZGVyX2lkIiwicHJvdmlkZXJfcXVhbGlmaWNhdGlvbl9yZWYiLCJwcm92aWRlcl90eXBlIiwicHVycG9zZSIsInJlZ2lvbiIsInJldGVudGlvbl9tb2RlIiwic2NoZW1hX3ZlcnNpb24iLCJzY29wZV9kaWdlc3QiLCJzZWN1cml0eV9wcm9maWxlX2lkIiwic3RlcF9kZWFkbGluZSIsInN1YmplY3RfcmVmIiwidGVtcGxhdGVfaGFzaCIsInRyYWluaW5nX21vZGUiLCJ0cmFpbmluZ19vcHRfaW5fcmVjZWlwdF9yZWYiXSwidGl0bGUiOiJNb2RlbEludm9jYXRpb25SZXF1ZXN0IiwidHlwZSI6Im9iamVjdCIsIngtY2x1ZWQtY29tcGF0aWJpbGl0eSI6Im9wdGlvbmFsLXByb3ZpZGVyLXBvcnQiLCJ4LWNsdWVkLWNvdmVyYWdlLWtpbmQiOiJTQ0hFTUFfU1VQUE9SVF9PTkxZX05PVF9FWEVDVVRJT05fRVZJREVOQ0UiLCJ4LWNsdWVkLWRlZmluaXRpb24tdmVyc2lvbiI6IjIuMC4wLWxvY2FsLXJjLXYxNS1tb2RlbCIsIngtY2x1ZWQtZmllbGQtb3JpZ2luIjp7ImRlcml2ZWRfYmluZGluZyI6WyJhZGFwdGVyX3ZlcnNpb24iLCJidWRnZXRzLm1heF9jb25jdXJyZW50X3JlcXVlc3RzIiwiYnVkZ2V0cy5tYXhfZWxhcHNlZF9tcyIsImJ1ZGdldHMubWF4X2lucHV0X2J5dGVzIiwiYnVkZ2V0cy5tYXhfcmVxdWVzdF9jb3VudCIsImJ1ZGdldHMucGFyc2VfYnVkZ2V0X21zIiwiYnVkZ2V0cy5wZXJzaXN0ZW5jZV9idWRnZXRfbXMiLCJidWRnZXRzLnNjcnViX3dhbGxfY2xvY2tfYnVkZ2V0X21zIiwiYnVkZ2V0cy52YWxpZGF0aW9uX2J1ZGdldF9tcyIsImNvcnJlbGF0aW9uX2lkIiwiZGF0YV9jbGFzc2lmaWNhdGlvbiIsImV2YWxfc2V0X2RpZ2VzdCIsImxlYXNlX2hhcmRfc3RvcCIsInByb3ZpZGVyX2lkIiwicHJvdmlkZXJfdHlwZSIsInJlZ2lvbiIsInJldGVudGlvbl9tb2RlIiwic2VjdXJpdHlfcHJvZmlsZV9pZCIsInN0ZXBfZGVhZGxpbmUiLCJ0cmFpbmluZ19tb2RlIiwidHJhaW5pbmdfb3B0X2luX3JlY2VpcHRfcmVmIl0sImV4cGxpY2l0X3YzXzMiOlsiYXR0ZW1wdF9pZCIsImJpbmRpbmdfcmVmIiwiYnVkZ2V0cy5jdXJyZW5jeSIsImJ1ZGdldHMuY3VycmVuY3lfZXhwb25lbnQiLCJidWRnZXRzLmN1cnJlbmN5X3Byb2ZpbGVfZGlnZXN0IiwiYnVkZ2V0cy5tYXhfYXR0ZW1wdHMiLCJidWRnZXRzLm1heF9jb3N0X21pbm9yX3VuaXRzIiwiYnVkZ2V0cy5tYXhfaW5wdXRfdG9rZW5zIiwiYnVkZ2V0cy5tYXhfb3V0cHV0X3Rva2VucyIsImJ1ZGdldHMubWF4X3Jlc3BvbnNlX2J5dGVzIiwiY2FwYWJpbGl0eSIsImNvbnRleHRfc2xpY2VfcmVmIiwiZGVhZGxpbmUiLCJpZGVtcG90ZW5jeV9rZXkiLCJpbnB1dF9kaWdlc3QiLCJpbnZvY2F0aW9uX2lkIiwibW9kZWxfcmV2aXNpb24iLCJvYmplY3RfdHlwZSIsIm91dHB1dF9zY2hlbWFfZGlnZXN0IiwicG9saWN5X3NuYXBzaG90X2RpZ2VzdCIsInByb2plY3RfcmVmIiwicHJvdmlkZXJfcXVhbGlmaWNhdGlvbl9yZWYiLCJwdXJwb3NlIiwic2NoZW1hX3ZlcnNpb24iLCJzY29wZV9kaWdlc3QiLCJzdWJqZWN0X3JlZiIsInRlbXBsYXRlX2hhc2giXX0sIngtY2x1ZWQtZ2VuZXJhdGVkLWZyb20iOiJzaGEyNTY6Zjk2N2ZkZjNlNjMwMjhkMjllZDE5MTE2MDY5ODcyNmI1ZDcwN2FhYWU2M2JkOTUxZjZiYTJlODU4NDkzNmZlYyIsIngtY2x1ZWQtcmVnaXN0ZXJlZC10ZXN0LWNvdmVyYWdlIjp7InNjaGVtYV9zdXBwb3J0Ijp7ImNpIjpbIkNJLTEwMiIsIkNJLTkxIiwiQ0ktOTUiLCJDSS05NyIsIkNJLTk5Il0sImVpYSI6WyJFSUEtNDIiLCJFSUEtNDMiLCJFSUEtNDUiXX0sInNlbWFudGljX3J1bnRpbWVfcmVxdWlyZWQiOnsiY2kiOlsiQ0ktOTIiLCJDSS05MyJdLCJlaWEiOlsiRUlBLTQ0IiwiRUlBLTQ2IiwiRUlBLTQ3IiwiRUlBLTQ5Il19fSwieC1jbHVlZC1yZWdpc3RlcmVkLXRlc3QtZXhlY3V0aW9uIjoiTk9UX1JVTl9ERUZJTklUSU9OX09OTFkiLCJ4LWNsdWVkLXNvdXJjZS1zZWN0aW9ucyI6WyIzOC4xMCIsIjM4LjExIiwiMzguNSIsIjM4LjgiLCIzOC45Il0sIngtY2x1ZWQtc3VwZXJzZWRlcyI6InVybjpjbHVlZDpzY2hlbWE6bW9kZWwtaW52b2NhdGlvbi1yZXF1ZXN0OnYxIn0K")
SEGMENT_SCHEMA_RAW = (FIXTURE_ROOT / "development/contracts/information-flow/vendored/m0a/segment-input.v1.schema.json").read_bytes()
PUBLIC_ROWS = json.loads((FIXTURE_ROOT / "tests/fixtures/model-program-m2/core-development-candidate.json").read_bytes())["samples"]


def private_source(name, path, dependencies=None):
    module = types.ModuleType("private_request_projection_test." + name)
    module.__file__, module.__package__ = str(path), ""
    namespace = dict(vars(builtins))
    def resolve(import_name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and import_name in (dependencies or {}):
            return dependencies[import_name]
        return builtins.__import__(import_name, globals, locals, fromlist, level)
    namespace["__import__"] = resolve
    module.__dict__["__builtins__"] = namespace
    exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
    return module


RUNNER = private_source("runner", SCRIPTS / "saved_report_runner.py")
SCOPED = private_source("scoped", SCRIPTS / "validate_m2_scoped_successor.py")
RENDERER = private_source("renderer", SCRIPTS / "development_input_renderer.py",
                         {"saved_report_runner": RUNNER, "validate_m2_scoped_successor": SCOPED})
P = private_source("request", SCRIPTS / "development_invocation_projection.py",
                  {"development_input_renderer": RENDERER, "saved_report_runner": RUNNER,
                   "validate_m2_scoped_successor": SCOPED})


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def packet(count=1):
    rows = []
    for source in PUBLIC_ROWS[:count]:
        segment = copy.deepcopy(source["input"])
        signature = {"reference_time": segment["reference_time"], "timezone": segment["timezone"],
            "messages": [{k: v for k, v in message.items() if k not in {"message_id", "evidence_id"}}
                         for message in segment["messages"]]}
        rows.append({"id": source["sample_id"], "purpose_id": "development", "track": source["domain"],
            "input": segment, "input_sha256": digest(segment),
            "declared_provenance": {"source_ref": "e76:public_core_regression", "root_id": source["sample_id"],
                "family_id": source["sample_id"], "semantic_group_id": source["sample_id"],
                "template_id": "public_core", "language": "zh", "risk": "ordinary", "difficulty": "direct"},
            "scenario_sha256": "1"*64, "template_sha256": "2"*64,
            "exact_content_group_sha256": digest(signature)})
    return {"artifact_kind": "LOCAL_DEVELOPMENT_INPUT_CANDIDATE", "purpose_id": "development", "source_class": "C",
        "spec_raw_sha256": "3"*64, "segment_schema_raw_sha256": P.SEGMENT_SCHEMA_SHA256,
        "declared_renderer_sha256": "e913ab5a2c43ed2b7485bf6bb161c816434ac08ca6f656769deea1787de2f632",
        "samples": rows, "observed_row_count": count, "effective_independent_sample_count": None,
        "exposure": "AUTHOR_VISIBLE_DEVELOPMENT_NOT_UNSEEN", "semantic_dedup": "NOT_PERFORMED",
        "rights_and_privacy": "NOT_ATTESTED_HERE", "workflow_task_spec": "NOT_ADMITTED_HERE",
        "gold": None, "authority_effect": "NONE", "m2_verdict": "NOT_ISSUED", "model_calls": 0}


def complete_fields():
    # Hypothetical specification fields: syntax values are not live grants/usage.
    schema = json.loads(REQUEST_SCHEMA_RAW)
    fields = {}
    for key, shape in schema["properties"].items():
        if key in {"object_type", "schema_version", "purpose", "training_mode", "training_opt_in_receipt_ref", "input_digest"}:
            continue
        if key == "budgets":
            fields[key] = {name: 1 for name in shape["required"]}
            fields[key].update(currency="USD", currency_exponent=2, currency_profile_digest="sha256:"+"4"*64,
                               max_cost_minor_units=0, max_input_bytes=65536, max_response_bytes=65536)
        elif shape.get("format") == "date-time":
            fields[key] = "2026-10-12T12:00:00Z"
        elif shape.get("pattern", "").startswith("^sha256:"):
            fields[key] = "sha256:"+"5"*64
        elif "enum" in shape:
            fields[key] = {"provider_type": "Test", "data_classification": "private",
                           "capability": "extract"}[key]
        else:
            fields[key] = "SPECIFICATION_EXAMPLE"
    return fields


def project(value=None, fields=None, *, raw=None, ids=None, request_schema=REQUEST_SCHEMA_RAW,
            segment_schema=SEGMENT_SCHEMA_RAW):
    value = packet() if value is None else value
    ids = [row["id"] for row in value["samples"]] if ids is None else ids
    return P.project_development_request(canonical(value) if raw is None else raw, ids[0],
        {} if fields is None else fields, ids, request_schema_raw=request_schema,
        segment_schema_raw=segment_schema)


class DevelopmentInvocationProjection(unittest.TestCase):
    def test_real_v2_schema_pins_and_original_text_digest(self):
        self.assertEqual((len(REQUEST_SCHEMA_RAW), hashlib.sha256(REQUEST_SCHEMA_RAW).hexdigest()),
                         (6324, P.REQUEST_SCHEMA_SHA256))
        value = packet()
        result = project(value)
        text_bytes = canonical(value["samples"][0]["input"])
        self.assertEqual(result["input_bytes"], text_bytes)
        self.assertEqual(result["request_projection"]["input_digest"],
                         "sha256:" + hashlib.sha256(text_bytes).hexdigest())
        self.assertNotEqual(result["request_projection"]["input_digest"],
                            "sha256:" + hashlib.sha256(canonical(text_bytes.decode())).hexdigest())

    def test_missing_fields_remain_none_without_classification_or_ref_invention(self):
        result = project()
        request = result["request_projection"]
        self.assertEqual(len(request), 33)
        for key in ("data_classification", "binding_ref", "template_hash", "eval_set_digest", "budgets", "invocation_id"):
            self.assertIsNone(request[key])
            self.assertIn(key, result["external_inputs_required"])
        self.assertEqual(request["training_mode"], "none")
        self.assertIsNone(request["training_opt_in_receipt_ref"])
        self.assertFalse(result["sendable"])
        self.assertEqual(result["schema_validation"]["status"], "INCOMPLETE")

    def test_complete_test_provider_syntax_is_still_non_sendable(self):
        result = project(fields=complete_fields())
        self.assertEqual(result["schema_validation"]["status"], "LOCAL_SYNTAX_VALID_ONLY")
        self.assertTrue(result["schema_validation"]["v2_syntax_valid"])
        self.assertEqual(result["external_inputs_required"], [])
        self.assertFalse(result["sendable"])
        self.assertEqual(result["authority_effect"], "NONE")
        self.assertEqual(result["qualification"], "NOT_ISSUED")
        self.assertEqual(result["request_projection"]["data_classification"], "private")

    def test_partial_budgets_have_exact_missing_paths_no_zero_fill(self):
        result = project(fields={"budgets": {"max_attempts": 2, "max_input_tokens": None}})
        self.assertEqual(result["request_projection"]["budgets"]["max_attempts"], 2)
        self.assertIsNone(result["request_projection"]["budgets"]["max_cost_minor_units"])
        self.assertIn("budgets.currency_profile_digest", result["external_inputs_required"])
        self.assertIn("budgets.max_input_tokens", result["external_inputs_required"])

    def test_bad_given_reference_is_rejected_even_when_other_fields_missing(self):
        with self.assertRaises(ValueError):
            project(fields={"binding_ref": "00000000-0000-4000-8000-000000000000"})

    def test_unknown_fields_and_budget_fields_rejected(self):
        for fields in ({"profile_ref": "invented"}, {"budgets": {"unknown": 1}}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                project(fields=fields)

    def test_classification_is_only_explicit_existing_enum(self):
        for invalid in ("C", "author-visible", 1, True):
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                project(fields={"data_classification": invalid})
        self.assertEqual(project(fields={"data_classification": "secret_prohibited"})["request_projection"]["data_classification"],
                         "secret_prohibited")
        self.assertFalse(project(fields={"data_classification": "public"})["sendable"])

    def test_fixed_scope_training_and_input_digest_conflicts_rejected(self):
        cases = ({"training_mode": "learn"}, {"training_opt_in_receipt_ref": "invented"},
                 {"purpose": "qualification"}, {"schema_version": "1.0"},
                 {"object_type": "Other"}, {"input_digest": "sha256:"+"0"*64})
        for fields in cases:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                project(fields=fields)

    def test_invalid_dates_reject_even_for_incomplete_request(self):
        for key in ("deadline", "step_deadline", "lease_hard_stop"):
            for value in ("2026-02-30T00:00:00Z", "2026-01-01T00:00:00+24:00", True):
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    project(fields={key: value})

    def test_all_integer_budget_booleans_and_currency_errors_rejected(self):
        schema = json.loads(REQUEST_SCHEMA_RAW)["properties"]["budgets"]["properties"]
        for key, shape in schema.items():
            if shape.get("type") == "integer":
                with self.subTest(key=key), self.assertRaises(ValueError):
                    project(fields={"budgets": {key: True}})
        for values in ({"currency": "usd"}, {"currency_exponent": 10}, {"currency_profile_digest": "fake"},
                       {"max_attempts": 0}, {"max_elapsed_ms": -1}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                project(fields={"budgets": values})

    def test_full_expected_identity_and_order_are_required(self):
        value = packet(2)
        ids = [row["id"] for row in value["samples"]]
        for expected in (ids[:1], list(reversed(ids)), ids+[ids[0]], ids+["extra"]):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                project(value, ids=expected)

    def test_drift_in_unselected_row_rejected(self):
        value = packet(2)
        value["samples"][1]["input_sha256"] = "0"*64
        with self.assertRaises(ValueError):
            project(value)

    def test_segment_identity_input_hash_and_content_group_drift_rejected(self):
        for key in ("segment_id", "input_sha256", "exact_content_group_sha256"):
            value = packet()
            if key == "segment_id":
                value["samples"][0]["input"][key] = "other"
                value["samples"][0]["input_sha256"] = digest(value["samples"][0]["input"])
            else:
                value["samples"][0][key] = "0"*64
            with self.subTest(key=key), self.assertRaises(ValueError):
                project(value)

    def test_packet_scope_authority_gold_and_count_cannot_upgrade(self):
        for key, changed in (("gold", "fake"), ("authority_effect", "GRANTED"),
                             ("effective_independent_sample_count", 1), ("observed_row_count", True),
                             ("model_calls", False), ("exposure", "UNSEEN"), ("source_class", "A")):
            value = packet()
            value[key] = changed
            with self.subTest(key=key), self.assertRaises(ValueError):
                project(value)

    def test_strict_json_and_byte_count_caps_rejected(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'\xff', b' '* (P.MAX_PACKET_BYTES+1)):
            with self.subTest(raw_length=len(raw)), self.assertRaises((ValueError, UnicodeError)):
                project(raw=raw)
        value = packet()
        value["samples"] = value["samples"]*169
        value["observed_row_count"] = 169
        with self.assertRaises(ValueError):
            project(value, ids=["id"]*169)

    def test_pinned_schema_drift_rejects_without_remote_resolution(self):
        with mock.patch.object(P, "deny_remote", side_effect=AssertionError("remote accessed")):
            for request_schema, segment_schema in ((REQUEST_SCHEMA_RAW+b" ", SEGMENT_SCHEMA_RAW),
                                                   (REQUEST_SCHEMA_RAW, SEGMENT_SCHEMA_RAW+b" "),
                                                   (b'{"$ref":"https://example.invalid/schema"}', SEGMENT_SCHEMA_RAW)):
                with self.subTest(schema=request_schema[:10]), self.assertRaises(ValueError):
                    project(request_schema=request_schema, segment_schema=segment_schema)

    def test_raw_packet_whitespace_lineage_and_exposure_preserved(self):
        value = packet()
        raw = json.dumps(value, ensure_ascii=False, indent=2).encode()
        result = project(value, raw=raw)
        compact = project(value)
        self.assertEqual(result["packet_raw"], raw)
        self.assertEqual(result["input_bytes"], compact["input_bytes"])
        self.assertNotEqual(result["projection_sha256"], compact["projection_sha256"])
        self.assertEqual(result["sample_identity"]["sample"], value["samples"][0])
        self.assertEqual(result["sample_identity"]["exposure"], "AUTHOR_VISIBLE_DEVELOPMENT_NOT_UNSEEN")

    def test_no_mutation_or_aliases(self):
        value, fields = packet(), complete_fields()
        before = copy.deepcopy((value, fields))
        result = project(value, fields)
        self.assertEqual((value, fields), before)
        result["request_projection"]["budgets"]["max_attempts"] = 77
        result["sample_identity"]["sample"]["input"]["messages"][0]["content"] = "changed"
        self.assertEqual((value, fields), before)
        self.assertEqual(project(value, fields)["input_bytes"], canonical(value["samples"][0]["input"]))

    def test_request_fields_nonfinite_types_and_wrong_capability_rejected(self):
        for fields in ({"region": float("nan")}, {"region": {"bad": 1}},
                       {"capability": "decision.semantic_relation"}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                project(fields=fields)

    def test_projection_call_has_no_io_network_process_or_global_registry_mutation(self):
        fields = complete_fields()
        # Warm ordinary schema-library caches before observing this pure call.
        project(fields=fields)
        before_path, before_modules = list(sys.path), set(sys.modules)
        with mock.patch.object(builtins, "open", side_effect=AssertionError("file IO")), \
             mock.patch.object(socket, "socket", side_effect=AssertionError("network")), \
             mock.patch.object(subprocess, "Popen", side_effect=AssertionError("process")):
            result = project(fields=fields)
        self.assertFalse(result["sendable"])
        self.assertEqual(sys.path, before_path)
        self.assertEqual(set(sys.modules), before_modules)


if __name__ == "__main__":
    unittest.main()
