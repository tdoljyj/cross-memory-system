"""Only the two independent review fixes; no Docker/WSL/Linux execution."""
import ast
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

BASE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('review_' + name, BASE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


probe = load('probe')
prepare = load('prepare')


class ReviewFixes(unittest.TestCase):
    def test_descendant_installs_ignored_sigterm_before_publishing_readiness(self):
        tree = ast.parse((BASE / 'probe.py').read_text(encoding='utf-8'))
        branch = next(node for node in ast.walk(tree) if isinstance(node, ast.If)
                      and any(isinstance(item, ast.Constant) and item.value == '--descendant' for item in ast.walk(node.test)))
        signal_index = next(i for i, statement in enumerate(branch.body)
                            if any(isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                                   and isinstance(call.func.value, ast.Name) and call.func.value.id == 'signal'
                                   and call.func.attr == 'signal' for call in ast.walk(statement)))
        save_index = next(i for i, statement in enumerate(branch.body)
                          if any(isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                                 and call.func.id == 'save' for call in ast.walk(statement)))
        self.assertLess(signal_index, save_index)

    def test_ready_requires_exact_typed_process_identities_and_installed_handler(self):
        valid = {'pid': 41, 'ppid': 1, 'uid': 10001, 'sigterm_ignored': True}
        self.assertTrue(probe.descendant_ready(valid, 41, 1))
        for change in [{'pid': 42}, {'pid': '41'}, {'ppid': True}, {'uid': 0},
                       {'uid': '10001'}, {'sigterm_ignored': False}, {'sigterm_ignored': 1}]:
            self.assertFalse(probe.descendant_ready({**valid, **change}, 41, 1))
        self.assertFalse(probe.descendant_ready(None, 41, 1))

    def test_half_written_or_mismatched_ready_never_counts_as_ready(self):
        work = BASE / 'work'
        work.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='review-ready-', dir=work) as temporary:
            path = Path(temporary) / 'descendant.json'
            self.assertIsNone(probe.read_descendant_ready(path, 41, 1))
            path.write_text('{"pid":41,', encoding='utf-8')
            self.assertIsNone(probe.read_descendant_ready(path, 41, 1))
            valid = {'pid': 41, 'ppid': 1, 'uid': 10001, 'sigterm_ignored': True}
            path.write_text(json.dumps(valid), encoding='utf-8')
            self.assertEqual(probe.read_descendant_ready(path, 41, 1), valid)
            self.assertIsNone(probe.read_descendant_ready(path, 42, 1))

    def test_stop_rejects_empty_garbage_zero_invalid_or_timezone_free_times(self):
        cid = 'd' * 64
        value = {'Id': cid, 'State': {'Running': False, 'Pid': 0, 'Status': 'exited'}}
        for finished in ['', 'garbage', '0001-01-01T00:00:00Z', '2026-02-30T00:00:00Z',
                         '2026-09-08T00:00:00', '2026-09-08T99:00:00Z', '2026-09-08T00:00:00+25:00', None, 123]:
            self.assertFalse(prepare.stopped({**value, 'State': {**value['State'], 'FinishedAt': finished}}, cid))
        for finished in ['2026-09-08T00:00:00Z', '2026-09-08T10:24:14.381163800Z', '2026-09-08T08:00:00+08:00']:
            self.assertTrue(prepare.stopped({**value, 'State': {**value['State'], 'FinishedAt': finished}}, cid))

    def test_stop_rejects_non_object_and_bool_numeric_coercions(self):
        cid = 'd' * 64
        value = {'Id': cid, 'State': {'Running': False, 'Pid': 0, 'Status': 'exited', 'FinishedAt': '2026-09-08T00:00:00Z'}}
        for item in [None, [], {'State': None}, {'State': []}]:
            self.assertFalse(prepare.stopped(item, cid))
        for change in [{'Pid': False}, {'Pid': 0.0}, {'Pid': '0'}, {'Running': 0}, {'Running': 'false'}]:
            self.assertFalse(prepare.stopped({**value, 'State': {**value['State'], **change}}, cid))


if __name__ == '__main__':
    unittest.main(verbosity=2)
