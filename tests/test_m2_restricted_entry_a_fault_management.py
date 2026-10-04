"""No VM, cgroup, installed directory or platform focus is touched here."""
import copy
from dataclasses import asdict
import importlib.util
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'kernel/host' / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


management = load('test_fault_management', 'm2-restricted-entry-a-fault-management.py')
bridge = load('test_fault_bridge', 'm2-restricted-entry-a-fault-bridge.py')
observer = load('test_fault_observer_wiring', 'm2-restricted-entry-a-fault-observer.py')
PROOF = dict(scope='entire_cgroup', cgroup_empty=True, leader_reaped=True, identity_unchanged=True)


def observations():
    leader = observer.ProcessIdentity(30, 40, 30, 30, 1001, 1001, 'S')
    child = observer.ProcessIdentity(31, 41, 30, 30, 1001, 1001, 'S')
    binding = observer.GroupBinding('11111111-1111-4111-8111-111111111111', leader)
    before = observer.Observation(binding, (leader, child), (), True)
    after = observer.Observation(binding, (), (None, None), True)
    return before, after


def row(case):
    before, after = observations()
    return dict(schema='m2-a-fault-case-observation-v1', case=case,
                request_id=bridge.REQUEST_IDS[case], qualification='NOT_ISSUED',
                scenario_status='CONFIRMED_OBSERVATIONS', execution_state='STOPPED',
                trigger_actual=case, stop_elapsed_seconds=0.001,
                trigger_to_observation_seconds=0.002, before=asdict(before), after=asdict(after),
                native_proof=copy.deepcopy(PROOF))


def wire(value):
    # Real JSON round trip, including dataclass tuples becoming lists.
    return json.loads(json.dumps(value))


def batch():
    return wire(dict(schema='m2-a-fault-batch-observation-v1', qualification='NOT_ISSUED',
                     batch_status='OBSERVATIONS_COMPLETE', cases=[row(case) for case in bridge.CASES]))


class Stream:
    def __init__(self, values):
        self.raw = bytearray(b''.join(management.encoded(value) for value in values))
        self.sent = bytearray()
        self.closed = False

    def recv(self, count):
        value = bytes(self.raw[:count])
        del self.raw[:count]
        return value

    def sendall(self, value):
        self.sent.extend(value)

    def close(self):
        self.closed = True


class FaultProtocol(unittest.TestCase):
    def test_verified_source_snapshot_ignores_disk_replacement_and_cached_bytecode(self):
        import py_compile
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'pinned.py'
            path.write_text('VALUE = "unapproved"\n', encoding='ascii')
            py_compile.compile(str(path), doraise=True)
            cached = {str(p): p.read_bytes() for p in path.parent.rglob('*') if p.is_file()}
            with mock.patch.object(sys, 'dont_write_bytecode', False):
                loaded = management.load('verified_snapshot_test', path, b'VALUE = "approved"\n')
                self.assertFalse(sys.dont_write_bytecode)
            self.assertEqual(loaded.VALUE, 'approved')
            self.assertEqual(cached, {str(p): p.read_bytes() for p in path.parent.rglob('*') if p.is_file()})

    def test_batch_uses_fixed_fault_order_actual_close_and_one_audit_connection(self):
        ready = lambda case: dict(schema='m2-a-fault-ready-v1', qualification='NOT_ISSUED',
                                  ready=True, request_id=bridge.REQUEST_IDS[case])
        fault = Stream([ready('timeout'), row('timeout'), ready('revoke'), row('revoke'), ready('disconnect')])
        audit = Stream([batch()])
        connect = mock.Mock(side_effect=[fault, audit])
        result, events = bridge.run_batch(connect)
        self.assertEqual(result, batch())
        self.assertEqual(connect.call_count, 2)
        self.assertTrue(fault.closed and audit.closed)
        frames = [json.loads(x) for x in fault.sent.splitlines()]
        self.assertEqual(frames, [dict(action='start', request_id=bridge.REQUEST_IDS['timeout']),
                                 dict(action='start', request_id=bridge.REQUEST_IDS['revoke']),
                                 dict(action='revoke', request_id=bridge.REQUEST_IDS['revoke']),
                                 dict(action='start', request_id=bridge.REQUEST_IDS['disconnect'])])
        self.assertEqual(json.loads(audit.sent), dict(action='collect-fixed-summary'))
        self.assertEqual([e['action'] for e in events], ['revoke-sent', 'actual-socket-close'])

    def test_bad_readiness_never_revokes_or_connects_audit_or_retries(self):
        for ready in (False, 1, None):
            with self.subTest(ready=ready):
                stream = Stream([dict(schema='m2-a-fault-ready-v1', qualification='NOT_ISSUED',
                                      ready=ready, request_id=bridge.REQUEST_IDS['timeout'])])
                connect = mock.Mock(return_value=stream)
                with self.assertRaises(ValueError):
                    bridge.run_batch(connect)
                self.assertEqual(connect.call_count, 1)
                self.assertTrue(stream.closed)
                self.assertEqual(len(stream.sent.splitlines()), 1)

    def test_duplicate_keys_oversized_and_closed_frames_fail(self):
        for raw in (b'{"action":"start","action":"revoke"}\n', b'x' * (bridge.MAX_FRAME + 2), b''):
            with self.subTest(raw_size=len(raw)):
                stream = Stream([])
                stream.raw = bytearray(raw)
                with self.assertRaises((ValueError, EOFError)):
                    bridge.receive(stream)

    def test_control_frames_never_accept_agent_command_role_or_case_override(self):
        frame = dict(action='start', request_id=management.REQUEST_IDS['timeout'])
        management.control_frame(frame, 'start', frame['request_id'])
        for change in (dict(command='anything'), dict(role='root'), dict(case='revoke'), dict(request_id='other')):
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    management.control_frame({**frame, **change}, 'start', frame['request_id'])

    def test_real_socketpair_receives_one_frame_without_consuming_next(self):
        left, right = socket.socketpair()
        try:
            bridge.send(left, dict(action='start'))
            bridge.send(left, dict(action='collect-fixed-summary'))
            self.assertEqual(management.receive(right, time.monotonic() + 1), dict(action='start'))
            self.assertEqual(management.receive(right, time.monotonic() + 1), dict(action='collect-fixed-summary'))
        finally:
            left.close()
            right.close()

    def test_default_cli_denies_without_any_connector_or_installed_read(self):
        for module in (bridge, management):
            with self.subTest(module=module.__name__), mock.patch.object(module, 'main', wraps=module.main) as call:
                with mock.patch('sys.stdout', new=io.StringIO()), mock.patch.object(module, 'socket') as sockets:
                    self.assertEqual(call([]), 2)
                    sockets.socket.assert_not_called()


class FaultObservationContract(unittest.TestCase):
    def test_complete_batch_keeps_qualification_not_issued(self):
        self.assertEqual(bridge.validate_summary(batch())['qualification'], 'NOT_ISSUED')

    def test_timing_missing_nonfinite_bool_and_existing_bound_fail_closed(self):
        for key in ('stop_elapsed_seconds', 'trigger_to_observation_seconds'):
            for value in (None, True, -1, 0.1, float('inf'), float('nan')):
                with self.subTest(key=key, value=value):
                    candidate = batch()
                    candidate['cases'][0][key] = value
                    with self.assertRaises(ValueError):
                        bridge.validate_summary(candidate)

    def test_partial_group_wrong_trigger_or_native_proof_never_confirms(self):
        mutations = [lambda r: r.update(trigger_actual='revoke'),
                     lambda r: r.update(qualification='PASS'),
                     lambda r: r['native_proof'].update(scope='process_group'),
                     lambda r: r['native_proof'].update(cgroup_empty=1),
                     lambda r: r['after'].update(complete=False),
                     lambda r: r['after'].update(tracked=[None]),
                     lambda r: r['before'].update(members=r['before']['members'][:1]),
                     lambda r: r['after'].update(tracked=copy.deepcopy(r['before']['members'])),
                     lambda r: r['before']['members'][1].update(uid=0),
                     lambda r: r['before']['binding'].update(boot_id='not-a-boot-id')]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                candidate = batch()
                mutate(candidate['cases'][0])
                with self.assertRaises(ValueError):
                    bridge.validate_summary(candidate)

    def test_member_identity_types_state_empty_and_generation_reuse_rejected(self):
        for field, value in (('pid', True), ('start_ticks', 0), ('session', -1), ('state', ''),
                             ('state', 'garbage'), ('uid', '1001'), ('extra', 1)):
            with self.subTest(field=field, value=value):
                candidate = batch()
                candidate['cases'][0]['before']['members'][1][field] = value
                with self.assertRaises(ValueError):
                    bridge.validate_summary(candidate)
        candidate = batch()
        changed = copy.deepcopy(candidate['cases'][0]['before']['members'][1])
        changed.update(start_ticks=99, state='Z')
        candidate['cases'][0]['after']['tracked'][1] = changed
        with self.assertRaises(ValueError):
            bridge.validate_summary(candidate)

    def test_profile_closed_scope_hashes_ids_and_nonroot_role(self):
        profile = dict(schema='m2-a-fault-installed-v1', instance=management.INSTANCE, vm_id=management.VM_ID,
                       files={name: 'a'*64 for name in management.CODE_FILES}, base_receipt_sha256='b'*64,
                       request_ids=management.REQUEST_IDS.copy(),
                       binding=dict(uid=1001, gid=1001, input=[1, 2], output=[1, 3]),
                       log_directory_identity={})
        self.assertIs(management.validate_profile(profile), profile)
        for mutate in (lambda p: p.update(command='arbitrary'), lambda p: p.update(instance='another'),
                       lambda p: p['request_ids'].update(timeout='another'), lambda p: p['binding'].update(uid=0),
                       lambda p: p['files'].update(management='missing'), lambda p: p.update(base_receipt_sha256='A'*64)):
            with self.subTest(mutation=mutate):
                changed = copy.deepcopy(profile)
                mutate(changed)
                with self.assertRaises(ValueError):
                    management.validate_profile(changed)


class FaultRunnerWiring(unittest.TestCase):
    def runner(self, case, conn=None):
        class Native:
            def __init__(self, binding):
                self.uid, self.gid = 1001, 1001
                self.process = types.SimpleNamespace(pid=30)
                self.stop_calls = 0

            def run(self, tool, payload, deadline, interrupted):
                return interrupted()

            def stop(self, bound):
                self.stop_calls += 1
                return copy.deepcopy(PROOF)

        base = types.SimpleNamespace(CgroupRunner=Native, TOOLS=('read', 'write', 'execute'), STOP_TIMEOUT=0.1)
        return management.runner_type(base, observer)({}, case, conn, mock.Mock()), base

    def test_command_is_pinned_management_fixture_only(self):
        runner, base = self.runner('timeout')
        runner.launch_deadline = time.monotonic() + 1
        self.assertEqual(runner.command(base.TOOLS[2]), observer.FIXED_COMMAND)
        runner.verify_fixture.assert_called_once_with()
        with self.assertRaises(ValueError):
            runner.command(base.TOOLS[0])
        with self.assertRaises(ValueError):
            self.runner('arbitrary')

    def test_validation_expiry_prevents_command_return_and_launch(self):
        runner, base = self.runner('timeout')
        runner.launch_deadline = 1
        runner.verify_fixture.side_effect = lambda: None
        with mock.patch.object(management.time, 'monotonic', return_value=2):
            with self.assertRaises(TimeoutError):
                runner.command(base.TOOLS[2])

    def test_actual_disconnect_and_revoke_are_observed_only_after_readiness(self):
        before, after = observations()
        for case in ('disconnect', 'revoke'):
            with self.subTest(case=case):
                left, right = socket.socketpair()
                try:
                    runner, base = self.runner(case, right)
                    if case == 'disconnect':
                        left.close()
                    else:
                        bridge.send(left, dict(action='revoke', request_id=management.REQUEST_IDS[case]))
                    # Isolate transport trigger from peer send failure in closed case.
                    with mock.patch.object(management, 'send'), mock.patch.object(observer, 'bind_started_group'), mock.patch.object(observer, 'observe', return_value=before):
                        self.assertTrue(runner.run(base.TOOLS[2], {}, time.monotonic()+1, lambda: False))
                    self.assertEqual(runner.trigger_actual, case)
                    self.assertIs(runner.before, before)
                finally:
                    left.close()
                    right.close()

    def test_deadline_trigger_is_actual_timeout_not_requested_case(self):
        runner, base = self.runner('revoke')
        with mock.patch.object(observer, 'bind_started_group', side_effect=observer.Uncertain('missing')):
            self.assertTrue(runner.run(base.TOOLS[2], {}, time.monotonic()-1, lambda: False))
        self.assertEqual(runner.trigger_actual, 'timeout')
        self.assertIsNone(runner.before)

    def test_native_stop_called_once_and_slow_or_unobserved_stop_unknown(self):
        before, after = observations()
        for ready, elapsed in ((True, 0.002), (True, 0.11), (False, 0.002)):
            with self.subTest(ready=ready, elapsed=elapsed):
                runner, base = self.runner('timeout')
                runner.before = before if ready else None
                runner.trigger_actual = 'timeout'
                runner.trigger_monotonic = 1
                def observe_stop(native, original, bound):
                    native.stop(bound)
                    return dict(execution_state='STOPPED', qualification='NOT_ISSUED', observation=after)
                with mock.patch.object(observer, 'stop_and_observe', side_effect=observe_stop), mock.patch.object(management.time, 'monotonic', side_effect=[1, 1+elapsed, 1+elapsed]):
                    proof = runner.stop(base.STOP_TIMEOUT)
                self.assertEqual(bool(proof), ready and elapsed < 0.1)
                self.assertEqual(runner.stop(base.STOP_TIMEOUT), proof)
                self.assertEqual(runner.stop_calls, 1)
                record = management.case_record(runner, dict(execution_state='STOPPED' if proof else 'UNKNOWN'))
                self.assertEqual(record['scenario_status'], 'CONFIRMED_OBSERVATIONS' if proof else 'UNKNOWN')
                self.assertEqual(record['qualification'], 'NOT_ISSUED')

    def test_log_is_exclusive_fixed_id_and_drift_prevents_write(self):
        strict = mock.Mock()
        strict.identity.return_value = dict(inode=7)
        profile = dict(log_directory_identity=dict(inode=7))
        record = row('timeout')
        management.write_record(strict, profile, record)
        strict.exclusive.assert_called_once_with(management.LOG / (management.REQUEST_IDS['timeout']+'.json'), management.encoded(record), 0o600)
        strict.reset_mock()
        strict.identity.return_value = dict(inode=8)
        with self.assertRaises(ValueError):
            management.write_record(strict, profile, record)
        strict.exclusive.assert_not_called()


class FaultServeContract(unittest.TestCase):
    def test_real_executor_uses_original_lease_burns_and_single_audit(self):
        base = load('serve_original_executor', 'm2-restricted-entry-a-executor.py')
        now = [100.0]
        clock = lambda: now[0]
        ledger = mock.Mock()
        native = base.Executor(ledger, mock.Mock(), management.INSTANCE, {}, clock=clock)
        native.started = 50.0  # The batch expires at110, not each case+60.
        before, after = observations()
        deadlines = []
        class FixedRunner:
            def __init__(self, binding, case, conn, verify):
                self.case = case
                self.before = before
                self.trigger_actual = case
                self.stop_elapsed = self.trigger_to_observation = 0.001
                self.native_proof = self.cached_proof = PROOF
                self.stop_result = dict(observation=after)

            def run(self, tool, payload, deadline, interrupted):
                deadlines.append(deadline)
                now[0] = 109.5  # Subsequent case is near the original expiry.
                raise TimeoutError('fixed simulated native interruption')

            def stop(self, bound):
                return PROOF
        conn, audit = mock.MagicMock(), mock.MagicMock()
        conn.__enter__.return_value = conn
        audit.__enter__.return_value = audit
        listener = mock.Mock()
        listener.accept.side_effect = [(conn, (2, 0)), (audit, (2, 0))]
        frames = [dict(action='start', request_id=management.REQUEST_IDS[c]) for c in management.CASES]
        frames.append(dict(action='collect-fixed-summary'))
        with mock.patch.object(management, 'installed', return_value=(base, observer, mock.Mock(), dict(binding={}))), \
             mock.patch.object(base, 'installed_executor', return_value=native), \
             mock.patch.object(management, 'runner_type', return_value=FixedRunner), \
             mock.patch.object(management, 'receive', side_effect=frames), \
             mock.patch.object(management, 'send') as send, \
             mock.patch.object(management, 'write_record') as write, \
             mock.patch.object(management, 'summary', return_value=batch()), \
             mock.patch.object(management.time, 'monotonic', side_effect=clock), \
             mock.patch.object(management.socket, 'AF_VSOCK', 40, create=True), \
             mock.patch.object(management.socket, 'VMADDR_CID_HOST', 2, create=True), \
             mock.patch.object(management.socket, 'VMADDR_CID_ANY', -1, create=True), \
             mock.patch.object(management.socket, 'socket', return_value=listener), \
             mock.patch('sys.stdout', new=io.StringIO()):
            management.serve()
        self.assertEqual(deadlines, [101.0, 110.0, 110.0])
        self.assertEqual(ledger.burn.call_args_list,
                         [mock.call(management.INSTANCE, management.REQUEST_IDS[c]) for c in management.CASES])
        ledger.close.assert_called_once_with()
        self.assertEqual(write.call_count, 3)
        self.assertEqual(listener.accept.call_count, 2)
        self.assertEqual(send.call_count, 3)  # two case replies, one audit summary
        listener.close.assert_called_once_with()

    def test_expired_original_lease_never_accepts_or_launches(self):
        base = types.SimpleNamespace(LEASE=60, PORT=44101)
        native = types.SimpleNamespace(started=0, ledger=mock.Mock())
        base.installed_executor = mock.Mock(return_value=native)
        listener = mock.Mock()
        with mock.patch.object(management, 'installed', return_value=(base, observer, mock.Mock(), {})), \
             mock.patch.object(management.time, 'monotonic', return_value=61), \
             mock.patch.object(management.socket, 'AF_VSOCK', 40, create=True), \
             mock.patch.object(management.socket, 'VMADDR_CID_HOST', 2, create=True), \
             mock.patch.object(management.socket, 'VMADDR_CID_ANY', -1, create=True), \
             mock.patch.object(management.socket, 'socket', return_value=listener), \
             mock.patch.object(management, 'runner_type') as runner:
            with self.assertRaises(TimeoutError):
                management.serve()
        listener.accept.assert_not_called()
        runner.assert_not_called()
        native.ledger.close.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
