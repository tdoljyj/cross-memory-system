"""Only the new independent-review deadline and watchdog fixes; no Docker."""
import ast
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('observer_review_fixed', HERE / 'observe.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ReviewFixes(unittest.TestCase):
    def test_persistence_crossing_absolute_deadline_never_launches(self):
        with tempfile.TemporaryDirectory() as path:
            session = m.Session(Path(path), {'nonce': 'b' * 32, 'image': m.v.IMAGE,
                'probe_sha256': m.PROBE_SHA, 'source_bindings': m.source_bindings(),
                'started_monotonic': 10.0, 'deadline_monotonic': 100.0})
            for kind in ('create', 'start'):
                session.identity = 'c' * 64
                clock = [99.0]
                def persist_then_cross(*args):
                    clock[0] = 100.0
                with self.subTest(kind=kind), patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(m, 'persist', side_effect=persist_then_cross), \
                        patch.object(m.subprocess, 'Popen') as launch:
                    with self.assertRaises(m.Unknown): session.invoke(kind, kind)
                    launch.assert_not_called()

    def test_ready_requires_exact_nonce_deadline_typed_pid_and_live_guard(self):
        guard = Mock(pid=123)
        guard.poll.return_value = None
        ready = {'pid': 123, 'nonce': 'b' * 32, 'deadline_monotonic': 100.0}
        self.assertTrue(m.guard_ready(ready, guard, 'b' * 32, 100.0))
        for key, value in [('nonce', 'wrong'), ('deadline_monotonic', 101.0),
                           ('deadline_monotonic', True), ('pid', True), ('pid', 124)]:
            with self.subTest(key=key, value=value):
                self.assertFalse(m.guard_ready({**ready, key: value}, guard, 'b' * 32, 100.0))
        guard.poll.return_value = 0
        self.assertFalse(m.guard_ready(ready, guard, 'b' * 32, 100.0))

    def test_actual_observe_uses_ready_guard_at_final_and_prestart_boundaries(self):
        tree = ast.parse((HERE / 'observe.py').read_text(encoding='utf-8'))
        observe = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'observe')
        checks = [n for n in ast.walk(observe) if isinstance(n, ast.If)
                  and any(isinstance(c, ast.Call) and isinstance(c.func, ast.Name) and c.func.id == 'guard_ready'
                          for c in ast.walk(n.test))]
        self.assertEqual(len(checks), 3)  # ready loop, final acceptance, immediately before start
        start = next(n for n in ast.walk(observe) if isinstance(n, ast.Call)
                     and ast.unparse(n.func) == 'session.invoke' and n.args
                     and isinstance(n.args[0], ast.Constant) and n.args[0].value == 'start')
        self.assertTrue(any(n.lineno < start.lineno and 'digest' in ast.unparse(n.test) for n in checks))


if __name__ == '__main__':
    unittest.main(verbosity=2)
