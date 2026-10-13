import io
import json
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/model-program"))
from development_currentness_channel import PrivateCurrentnessChannel, SCHEMA, CurrentnessChannelError

LIVE_PINS = {"task_version": 2, "claim_id": "SOURCE ONLY CLAIM", "claim_fence": 3}

def channel(reader, writer, **kwargs):
    return PrivateCurrentnessChannel(reader, writer, live_pins=LIVE_PINS, **kwargs)


def binding():
    return {"identity": {"task_id": "SOURCE ONLY TASK", "profile_sha256": "1" * 64,
        "request_sha256": "2" * 64, "approval_record_id": "SOURCE ONLY APPROVAL",
        "approval_version": 1, "approval_receipt_id": "SOURCE ONLY RECEIPT"},
        "execution_plan_sha256": "3" * 64}


def observation(bound):
    return {**bound["identity"], "kind": "CURRENT_OWNER_DECISION_AND_PROFILE_BINDING_OBSERVATION",
        "approval_content_hash": "4" * 64, "task_version": 2, "claim_id": "SOURCE ONLY CLAIM",
        "claim_fence": 3, "authority_effect": "NONE", "permission_issued": False,
        "attempt_consumed": False}


class RoundTrip:
    def __init__(self, transform=lambda x: x):
        self.raw = b""
        self.transform = transform
        self.writes = 0
    def write(self, raw):
        self.writes += 1
        request = json.loads(raw)
        reply = {k: request[k] for k in ("schema", "id", "sequence", "phase")}
        reply.update(admitted=True, observation=observation(request["binding"]))
        self.raw = (json.dumps(self.transform(reply)) + "\n").encode()
        return len(raw)
    def flush(self):
        pass
    def readline(self, maximum):
        return self.raw[:maximum]


class CurrentnessChannelTests(unittest.TestCase):
    def test_exact_source_roundtrip_returns_none_not_an_observation(self):
        pipes = RoundTrip()
        live = channel(pipes, pipes)
        self.assertIsNone(live("preflight", binding()))
        self.assertIsNone(live("consume", binding()))
        self.assertEqual(pipes.writes, 2)

    def test_mismatched_reply_is_permanently_sealed_before_retry_write(self):
        for key in ("id", "sequence", "phase", "schema"):
            pipes = RoundTrip(lambda r: {**r, key: "WRONG"})
            live = channel(pipes, pipes)
            with self.assertRaises(CurrentnessChannelError): live("consume", binding())
            with self.assertRaisesRegex(CurrentnessChannelError, "SEALED"): live("consume", binding())
            self.assertEqual(pipes.writes, 1)

    def test_refusal_pin_drift_or_forged_authority_never_admits(self):
        for transform in (lambda r: {**r, "admitted": False},
                lambda r: {**r, "observation": {**r["observation"], "request_sha256": "9" * 64}},
                lambda r: {**r, "observation": {**r["observation"], "permission_issued": True}},
                lambda r: {**r, "observation": {**r["observation"], "token": "SOURCE ONLY SECRET"}}):
            pipes = RoundTrip(transform)
            with self.assertRaises(CurrentnessChannelError):
                channel(pipes, pipes)("consume", binding())

    def test_eof_and_oversize_are_not_offline_fallbacks(self):
        for raw in (b"", b"{}", b" " * 32769 + b"\n"):
            writer = io.BytesIO()
            live = channel(io.BytesIO(raw), writer)
            with self.assertRaises(CurrentnessChannelError): live("preflight", binding())
            size = writer.tell()
            with self.assertRaisesRegex(CurrentnessChannelError, "SEALED"): live("consume", binding())
            self.assertEqual(writer.tell(), size)

    def test_timeout_late_reply_cannot_unseal_or_send_again(self):
        release = threading.Event()
        pipes = RoundTrip()
        class DelayedReader:
            def readline(self, maximum):
                release.wait(2)
                return pipes.readline(maximum)
        live = channel(DelayedReader(), pipes, timeout_seconds=0.01)
        try:
            with self.assertRaises(TimeoutError): live("consume", binding())
            release.set()
            with self.assertRaisesRegex(CurrentnessChannelError, "SEALED"): live("consume", binding())
            self.assertEqual(pipes.writes, 1)
        finally: release.set()

    def test_entire_write_flush_read_round_has_a_finite_wait(self):
        for blocked_step in ("write", "flush"):
            release = threading.Event()
            pipes = RoundTrip()
            class BlockedWriter:
                def write(self, raw):
                    if blocked_step == "write": release.wait(2)
                    return pipes.write(raw)
                def flush(self):
                    if blocked_step == "flush": release.wait(2)
            live = channel(pipes, BlockedWriter(), timeout_seconds=0.01)
            try:
                with self.assertRaises(TimeoutError): live("consume", binding())
                release.set()
                with self.assertRaisesRegex(CurrentnessChannelError, "SEALED"): live("consume", binding())
            finally: release.set()

    def test_boolean_versions_and_changed_live_claim_pins_reject(self):
        for change in (lambda r: {**r, "sequence": True},
                lambda r: {**r, "observation": {**r["observation"], "approval_version": True}},
                lambda r: {**r, "observation": {**r["observation"], "claim_fence": 4}},
                lambda r: {**r, "observation": {**r["observation"], "claim_id": "OTHER"}},
                lambda r: {**r, "observation": {**r["observation"], "task_version": 3}}):
            pipes = RoundTrip(change)
            with self.assertRaises(CurrentnessChannelError): channel(pipes, pipes)("consume", binding())


if __name__ == "__main__": unittest.main()
