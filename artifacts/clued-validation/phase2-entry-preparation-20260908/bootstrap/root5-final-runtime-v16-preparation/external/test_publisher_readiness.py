"""Candidate parser regression only; no GitHub, tickets, or remote mutations."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('publisher_candidate', Path(__file__).with_name('original_input_publisher.candidate.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)

class PublisherReadiness(unittest.TestCase):
    def test_original_and_escaped_transport_have_separate_bounds(self):
        value = dict(kind='ACTUAL_VERIFIER_ORIGINAL_INPUTS', ga_raw='{}', observation_raw='"' * 1700000, runtime_acceptance_raw='{}', qualification_raw='{}')
        original = (json.dumps(value, separators=(',', ':')) + '\n').encode()
        request = json.dumps(dict(ga_raw='{}', original_artifact=dict(raw=original.decode(), uri='test', sha256=publisher.sha(original)), expected_parent='a' * 40)).encode()
        self.assertLess(len(original), 4000000)
        self.assertGreater(len(request), 4194304)
        self.assertLess(len(request), 8388608)
        self.assertEqual(publisher.raw_record(original), value)
        self.assertEqual(publisher.strict_transport_json(request)['original_artifact']['raw'].encode(), original)

    def test_each_bound_rejects_one_byte_excess(self):
        with self.assertRaises(publisher.Unknown):
            publisher.raw_record(b' ' * 4000001)
        with self.assertRaises(publisher.Unknown):
            publisher.strict_transport_json(b' ' * 8388609)

    def test_duplicate_and_float_still_fail(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":1.5}', b'{"a":NaN}'):
            with self.assertRaises(publisher.Unknown):
                publisher.strict_transport_json(raw)

if __name__ == '__main__':
    unittest.main()
