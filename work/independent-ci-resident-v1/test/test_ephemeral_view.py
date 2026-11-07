"""L2, the Linux execution side used once and thrown away (DESIGN 70). Offline, any OS:
python -I -B -m unittest discover -s test -p "test_*.py" (from work/independent-ci-resident-v1).

What is proven here, without a host:
  - the worker unit's file-system view (a model of its systemd settings, most specific path wins) shows a run nothing an earlier
    batch wrote except the trivy cache, which stays writable (cache hits still work), after the REAL archive code moved batch 1;
  - the guard refuses while any labelled container exists in any state, and an archive removes leftovers only after recording
    them, before anything moves, so a failed sweep leaves the instance runnable again (cleanup also works when a batch failed);
  - docker is only ever called with ps / inspect / diff / rm: never an image, volume or network command (the image cache stays).
The kernel side of the same view (tmpfs + binds, a late file through a bind, no mount left behind) was rehearsed once with
unshare -m, DESIGN 70.6; the systemd side is the rehearsal probe of DESIGN 70.7 (view-properties + view-check)."""
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import re
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
R = HERE.parent
loader = importlib.machinery.SourceFileLoader('resident_linux_l2', str(R / 'linux' / 'bin' / 'clued-ci-resident-linux'))
spec = importlib.util.spec_from_loader('resident_linux_l2', loader)
tool = importlib.util.module_from_spec(spec)
loader.exec_module(tool)

WORKER_UNIT = (R / 'linux' / 'systemd' / 'clued-ci-worker@.service').read_text(encoding='utf8')
STATE = '/var/lib/clued-independent-ci'
CACHE = '/var/lib/clued-independent-ci-trivy-cache'
B1 = '1111111111111111-111111111111'
B2 = '2222222222222222-222222222222'
CID = [c * 64 for c in 'abcdef']


def descriptor(batch, head):
    d = {'contract': 'clued.independent-ci.resident-batch-descriptor/3', 'batchId': batch, 'batchKey': batch[:16] + 'a' * 48,
         'repo': 'tdoljyj/cross-memory-system', 'pr': 900, 'headSha': head * 40, 'baseSha': '2' * 40, 'testSha': head * 40, 'attempt': 1,
         'ciSourceManifestSha256': 'e' * 64}
    d['linuxJobIds'] = [tool.job_id_v2(d, r) for r in tool.LINUX_ROLES]
    return d


# ---------- a model of the worker's view: the unit's settings applied to a host tree ----------

def view_rules(unit_text, job_id):
    rules = []
    for line in unit_text.splitlines():
        key, sep, value = line.partition('=')
        if not sep:
            continue
        value = value.replace('%i', job_id)
        if key == 'ProtectSystem' and value == 'strict':
            rules.append(('/', 'ro'))
        elif key in ('ReadWritePaths', 'ReadOnlyPaths', 'InaccessiblePaths', 'BindPaths'):
            kind = {'ReadWritePaths': 'rw', 'ReadOnlyPaths': 'ro', 'InaccessiblePaths': 'hidden', 'BindPaths': 'rw'}[key]
            rules += [(p.lstrip('-'), kind) for p in value.split()]
        elif key == 'TemporaryFileSystem':
            rules.append((value.split(':')[0], 'tmpfs'))
    return rules


def classify(rules, path):
    """'rw', 'ro', 'hidden' or 'tmpfs-root': the most specific rule covering the path decides (systemd orders mounts by path)."""
    best = max((r for r in rules if path == r[0] or path.startswith(r[0].rstrip('/') + '/')), key=lambda r: len(r[0]))
    if best[1] == 'tmpfs':
        return 'tmpfs-root' if path == best[0] else 'hidden'
    return best[1]


class View:
    """The view a worker run gets of a host tree that mirrors absolute paths under root."""
    def __init__(self, root, unit_text, job_id):
        self.root, self.rules = root, view_rules(unit_text, job_id)

    def host(self, path):
        return os.path.join(self.root, path.lstrip('/'))

    def entries(self, path):
        kind = classify(self.rules, path)
        if kind == 'hidden':
            return None if not os.path.lexists(self.host(path)) else []
        if not os.path.isdir(self.host(path)):
            return [] if kind == 'tmpfs-root' else None
        names = sorted(os.listdir(self.host(path)))
        return [n for n in names if classify(self.rules, path.rstrip('/') + '/' + n) != 'hidden']

    def writable(self, path):
        return classify(self.rules, path) == 'rw' and os.path.lexists(self.host(path))

    def visible_files(self):
        out = {}
        for base, dirs, files in os.walk(self.root):
            for name in files:
                full = os.path.join(base, name)
                path = '/' + os.path.relpath(full, self.root).replace(os.sep, '/')
                kind = classify(self.rules, path)
                if kind != 'hidden':
                    out[path] = kind
        return out


def write(root, path, text='x'):
    p = pathlib.Path(root) / path.lstrip('/')
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


class FakeDocker:
    """docker ps / inspect / diff / rm over a dict of labelled containers; records every argv."""
    def __init__(self, containers=None, rm_fail=(), ps_fail=0, inspect_override=None, diff_fail=()):
        self.containers = dict(containers or {})
        self.rm_fail, self.ps_fail, self.diff_fail = set(rm_fail), ps_fail, set(diff_fail)
        self.inspect_override = inspect_override or {}
        self.calls = []

    def __call__(self, argv):
        self.calls.append(list(argv))
        assert argv[0] in tool.DOCKER_VERBS, argv
        if argv == tool.NONCE_LIST:
            if self.ps_fail:
                self.ps_fail -= 1
                return 1, ''
            return 0, ''.join(f'{cid} {state}\n' for cid, state in self.containers.items())
        cid = argv[-1]
        if argv[0] == 'inspect':
            if cid in self.inspect_override:
                return 0, json.dumps(self.inspect_override[cid])
            if cid not in self.containers:
                return 1, ''
            return 0, json.dumps([{'Id': cid, 'State': {'Status': self.containers[cid]}, 'Config': {'Labels': {'clued.verify.nonce': 'n' * 64}}}])
        if argv[0] == 'diff':
            return (1, '') if cid in self.diff_fail else (0, 'C /scratch\n')
        if argv[0] == 'rm':
            assert argv[1:] == ['--volumes', cid], argv  # never --force
            if cid in self.rm_fail:
                return 1, ''
            self.containers.pop(cid, None)
            return 0, cid + '\n'
        raise AssertionError(argv)


class WorkerUnitView(unittest.TestCase):
    def test_the_unit_builds_a_view_of_only_this_job(self):
        u = WORKER_UNIT
        self.assertIn(f'TemporaryFileSystem={STATE}/formal-spool:ro,mode=0755,nosuid,nodev,noexec', u)
        self.assertIn(f'BindPaths=-{STATE}/formal-spool/incoming -{STATE}/formal-spool/outgoing', u)
        self.assertIn(f'TemporaryFileSystem={STATE}/workspaces:ro,mode=0700,nosuid,nodev,noexec', u)
        self.assertIn(f'BindPaths=-{STATE}/workspaces/%i', u)
        self.assertIn('TemporaryFileSystem=/mnt:ro,mode=0755,nosuid,nodev,noexec', u)
        self.assertIn(f'ReadOnlyPaths=-{STATE}/toolchain-build-legacy-v1', u)
        hidden = re.search(r'(?m)^InaccessiblePaths=(.+)$', u).group(1).split()
        self.assertEqual(hidden, [f'-{STATE}/resident', f'-{STATE}/verify-spool', f'-{STATE}/verify-once-state', f'-{STATE}/trusted-source', '-/run/WSL'])
        for key in ('PrivateTmp', 'PrivateIPC'):
            self.assertRegex(u, rf'(?m)^{key}=yes$')
        # every bound/hidden/read-only path is optional: a missing one never fails the unit at namespace setup
        for key in ('BindPaths', 'ReadOnlyPaths', 'InaccessiblePaths'):
            for line in re.findall(rf'(?m)^{key}=(.+)$', u):
                self.assertTrue(all(p.startswith('-') for p in line.split()), line)

    def test_the_state_root_runs_and_the_cache_stay_real_writable_paths(self):
        tmpfs = [l.split('=', 1)[1].split(':')[0] for l in WORKER_UNIT.splitlines() if l.startswith('TemporaryFileSystem=')]
        for p in (STATE, f'{STATE}/runs', CACHE, '/var/lib/docker'):
            self.assertFalse(any(p == t or p.startswith(t + '/') for t in tmpfs), p)
        rules = view_rules(WORKER_UNIT, 'f' * 64)
        for p in (STATE, f'{STATE}/formal-role.lock', f'{STATE}/runs/trivy-x', f'{CACHE}/db', f'{STATE}/workspaces/{"f" * 64}/candidate',
                  f'{STATE}/formal-spool/incoming/response-01.json', f'{STATE}/formal-spool/outgoing/result.json'):
            self.assertEqual(classify(rules, p), 'rw', p)
        for p in (f'{STATE}/toolchain-build-legacy-v1/node', '/etc/clued-independent-ci/result.key', '/opt/clued-independent-ci/source-v2/x'):
            self.assertEqual(classify(rules, p), 'ro', p)
        for p in (f'{STATE}/formal-spool/failed-x/candidate', f'{STATE}/workspaces/{"e" * 64}', f'{STATE}/resident/archive-status/a.json',
                  '/mnt/c/ProgramData/x', '/run/WSL/1_interop'):
            self.assertEqual(classify(rules, p), 'hidden', p)

    def test_view_properties_carry_exactly_the_unit_settings_for_one_job(self):
        job = 'f' * 64
        props = tool.namespace_properties(WORKER_UNIT, job)
        self.assertIn(f'--property=BindPaths=-{STATE}/workspaces/{job}', props)
        self.assertIn('--property=ProtectSystem=strict', props)
        self.assertTrue(all('%' not in p for p in props))
        keys = [p.split('=', 2)[1] for p in props]
        self.assertEqual(sorted(set(keys)), sorted(tool.VIEW_KEYS))
        for bad in ('x', 'F' * 64):
            with self.assertRaises(tool.Refused):
                tool.namespace_properties(WORKER_UNIT, bad)
        with self.assertRaises(tool.Refused):
            tool.namespace_properties(WORKER_UNIT + '\nBindPaths=/x/%n\n', job)


class TwoBatches(unittest.TestCase):
    """Batch 1 runs and fails; the real archive code moves it (sweeping a leftover container on the second try); batch 2's worker
    view shows nothing batch 1 wrote except the trivy cache."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.state = os.path.join(self.root, STATE.lstrip('/'))
        for d in ('formal-spool/incoming', 'formal-spool/outgoing', 'runs', 'workspaces', 'resident', 'toolchain-build-legacy-v1', 'trusted-source'):
            os.makedirs(os.path.join(self.state, d))
        write(self.root, f'{STATE}/toolchain-build-legacy-v1/node', 'node')
        write(self.root, f'{STATE}/resident/upgrade/current.json', '{}')
        write(self.root, f'{STATE}/trusted-source/old.txt', 'legacy')
        write(self.root, '/mnt/c/ProgramData/CluedIndependentCI/resident/outbox/x', 'windows')
        write(self.root, '/run/WSL/1_interop', 'interop')
        write(self.root, '/etc/clued-independent-ci/result.key', 'key')
        write(self.root, '/opt/clued-independent-ci/resident-v1/manifest.json', '{}')
        self.d1, self.d2 = descriptor(B1, '1'), descriptor(B2, '3')

    def tearDown(self):
        self.tmp.cleanup()

    def run_batch_1(self):
        written = []
        for j in self.d1['linuxJobIds']:
            written.append(write(self.root, f'{STATE}/workspaces/{j}/candidate/app.py', 'print("pr 1")'))
        written.append(write(self.root, f'{STATE}/runs/placement-{self.d1["linuxJobIds"][2]}/observation.json'))
        written.append(write(self.root, f'{STATE}/formal-spool/incoming/issue.json', '{}'))
        written.append(write(self.root, f'{STATE}/formal-spool/incoming/issue.ready.json', '{}'))
        written.append(write(self.root, f'{STATE}/formal-spool/outgoing/active.lock', '{}'))
        written.append(write(self.root, f'{STATE}/formal-role.lock', 'lock'))  # failed placement: lock retained
        cache = write(self.root, f'{CACHE}/db/trivy.db', 'db generation 1')
        return written, cache

    def archive(self, instance, docker):
        status_dir = os.path.join(self.state, 'resident', 'archive-status')
        quiet = {'linuxUnitsInactive': True, 'containersZero': True, 'details': {}}
        with mock.patch.object(tool, 'STATE', self.state), mock.patch.object(tool, 'SPOOL', os.path.join(self.state, 'formal-spool')), \
                mock.patch.object(tool, 'RESIDENT_STATE', os.path.join(self.state, 'resident')), \
                mock.patch.object(tool, 'quiescence', return_value=quiet), mock.patch.object(tool, 'docker_port', docker), \
                mock.patch.object(tool, 'read_descriptor_bytes', return_value=json.dumps(self.d1).encode()), \
                mock.patch.object(tool, '_protected_dir', lambda p: tool.need(os.path.isdir(p) and not os.path.islink(p), 'ARCHIVE_PARENT_REDIRECTED')), \
                mock.patch('os.geteuid', create=True, return_value=0):
            return tool.main(['archive', '--instance', instance]), status_dir

    def test_batch_2_sees_nothing_of_batch_1_but_the_cache(self):
        written, cache = self.run_batch_1()
        inst = f'{B1}_formal-bridge-stage-deadline'
        docker = FakeDocker({CID[0]: 'exited'}, rm_fail={CID[0]})
        # first try: the leftover container cannot be removed -> refused BEFORE anything moved or any status was written
        with self.assertRaises(tool.Refused) as e:
            self.archive(inst, docker)
        self.assertEqual(e.exception.code, 'CONTAINER_SWEEP_UNCONFIRMED')
        self.assertEqual(e.exception.details, [f'{CID[0]} exited'])
        self.assertFalse(os.path.exists(os.path.join(self.state, 'resident', 'archive-status', f'{inst}.json')))
        self.assertTrue(all(p.exists() for p in written), 'nothing moved')
        evidence = os.listdir(os.path.join(self.state, 'resident', 'container-sweep', inst))
        self.assertEqual(len(evidence), 1)
        # second try of the SAME instance (the rearm case of review B1): sweeps, then archives the whole failed scene
        docker.rm_fail.clear()
        result, status_dir = self.archive(inst, docker)
        self.assertTrue(result['verified'])
        self.assertEqual([c['id'] for c in result['containersSwept']], [CID[0]])
        self.assertEqual(result['deleted'], 1)
        self.assertEqual(docker.containers, {})
        with open(os.path.join(status_dir, f'{inst}.json')) as f:
            self.assertTrue(json.load(f)['verified'])
        self.assertEqual(len(os.listdir(os.path.join(self.state, 'resident', 'container-sweep', inst))), 2)
        self.assertTrue(all(not p.exists() for p in written), 'the whole failed scene was moved')
        self.assertEqual({c[0] for c in docker.calls} - set(tool.DOCKER_VERBS), set())

        # batch 2: ws-prep makes its workspaces; its trivy worker gets the view of exactly its own job
        for j in self.d2['linuxJobIds']:
            write(self.root, f'{STATE}/workspaces/{j}/candidate/app.py', 'print("pr 2")')
        trivy2 = self.d2['linuxJobIds'][1]
        view = View(self.root, WORKER_UNIT, trivy2)
        visible = view.visible_files()
        batch1 = [p for p in visible if '1' * 16 in p or self.d1['linuxJobIds'][0] in p or 'pr 1' in pathlib.Path(view.host(p)).read_text()]
        self.assertEqual(batch1, [], 'no file batch 1 wrote is visible to batch 2')
        self.assertFalse(any('/formal-spool/failed-' in p for p in visible))
        self.assertFalse(any(p.startswith(f'{STATE}/resident/') for p in visible))
        self.assertFalse(any(p.startswith('/mnt/') or p.startswith('/run/WSL') for p in visible))
        own = [p for p in visible if p.startswith(f'{STATE}/workspaces/')]
        self.assertEqual(own, [f'{STATE}/workspaces/{trivy2}/candidate/app.py'])
        # cache hit: the DB batch 1 left is there and still writable (the next DB generation can be promoted)
        self.assertEqual(visible[f'{CACHE}/db/trivy.db'], 'rw')
        self.assertEqual(visible[f'{STATE}/toolchain-build-legacy-v1/node'], 'ro')
        # and the in-view check the rehearsal runs agrees
        with mock.patch.object(tool, 'TRIVY_CACHE', CACHE):
            facts = tool.view_facts(trivy2, view.entries, view.writable)
        self.assertEqual(facts['failures'], [])
        self.assertTrue(facts['ok'])

    def test_the_model_and_the_check_notice_a_unit_without_the_view(self):
        self.run_batch_1()
        plain = '\n'.join(l for l in WORKER_UNIT.splitlines() if not l.startswith(('TemporaryFileSystem=', 'BindPaths=', 'InaccessiblePaths=', 'ReadOnlyPaths=')))
        job = self.d1['linuxJobIds'][1]
        os.makedirs(os.path.join(self.state, 'formal-spool', 'failed-old'))
        write(self.root, f'{STATE}/workspaces/{"0" * 64}/candidate/x', 'other')
        view = View(self.root, plain, job)
        facts = tool.view_facts(job, view.entries, view.writable)
        self.assertFalse(facts['ok'])
        for code in ('EARLIER_ARCHIVES_VISIBLE', 'OTHER_WORKSPACES_VISIBLE', 'RESIDENT_STATE_VISIBLE', 'LEGACY_STATE_VISIBLE', 'WINDOWS_PATHS_VISIBLE', 'TOOLCHAIN_WRITABLE'):
            self.assertIn(code, facts['failures'])

    def test_the_view_check_command_refuses_unless_the_view_is_exact(self):
        self.run_batch_1()
        job = self.d1['linuxJobIds'][1]
        os.makedirs(os.path.join(self.state, 'formal-spool', 'failed-old'))
        plain = '\n'.join(l for l in WORKER_UNIT.splitlines() if not l.startswith('TemporaryFileSystem='))
        for unit, ok in ((WORKER_UNIT, True), (plain, False)):
            view = View(self.root, unit, job)
            with mock.patch.object(tool, '_entries', view.entries), mock.patch.object(tool, 'TRIVY_CACHE', CACHE), \
                    mock.patch('os.access', lambda p, m: view.writable(p)), mock.patch('os.geteuid', create=True, return_value=0):
                if ok:
                    self.assertTrue(tool.main(['view-check', '--instance', job])['ok'])
                else:
                    with self.assertRaises(tool.Refused) as e:
                        tool.main(['view-check', '--instance', job])
                    self.assertEqual(e.exception.code, 'WORKER_VIEW_CHECK_FAILED')
                    self.assertIn('EARLIER_ARCHIVES_VISIBLE', e.exception.details)

    def test_a_completed_scope_with_a_leftover_container_refuses_and_changes_nothing(self):
        written, _ = self.run_batch_1()
        os.remove(os.path.join(self.state, 'formal-role.lock'))
        docker = FakeDocker({CID[1]: 'exited'})
        with self.assertRaises(tool.Refused) as e:
            self.archive(f'{B1}_success-close', docker)
        self.assertEqual(e.exception.code, 'CONTAINER_PRESENT_PRESERVED')
        self.assertEqual(docker.containers, {CID[1]: 'exited'})
        self.assertFalse([c for c in docker.calls if c[0] != 'ps'])
        self.assertFalse(os.path.exists(os.path.join(self.state, 'resident', 'container-sweep')))
        self.assertFalse(os.path.exists(os.path.join(self.state, 'resident', 'archive-status', f'{B1}_success-close.json')))


class Sweep(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.join(self.tmp.name, 'container-sweep', 'inst')

    def tearDown(self):
        self.tmp.cleanup()

    def sweep(self, docker, completed=False):
        with mock.patch.object(tool, '_protected_dir', lambda p: None):
            return tool.sweep_containers(docker, self.dir, completed, now=lambda: '2026-11-07T00:00:00Z')

    def test_nothing_to_sweep_is_one_read(self):
        docker = FakeDocker()
        self.assertEqual(self.sweep(docker), [])
        self.assertEqual(docker.calls, [tool.NONCE_LIST])
        self.assertFalse(os.path.exists(self.dir))

    def test_each_container_is_recorded_then_removed_and_the_list_proven_empty(self):
        docker = FakeDocker({CID[0]: 'exited', CID[1]: 'dead'})
        swept = self.sweep(docker)
        self.assertEqual([s['id'] for s in swept], [CID[0], CID[1]])
        self.assertEqual(docker.containers, {})
        self.assertEqual(docker.calls[-1], tool.NONCE_LIST)
        for s in swept:
            path = os.path.join(self.dir, s['evidence'])
            with open(path, 'rb') as f:
                raw = f.read()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), s['evidenceSha256'])
            rec = json.loads(raw)
            self.assertEqual((rec['contract'], rec['id'], rec['inspect']['Id'], rec['diff']), (tool.SWEEP_CONTRACT, s['id'], s['id'], ['C /scratch']))
        # order per container: inspect, diff, rm (the evidence exists before the removal)
        verbs = [c[0] for c in docker.calls]
        self.assertEqual(verbs, ['ps', 'inspect', 'diff', 'rm', 'inspect', 'diff', 'rm', 'ps'])

    def test_a_running_or_created_container_refuses_and_nothing_is_removed(self):
        for state in ('running', 'created', 'paused', 'restarting'):
            docker = FakeDocker({CID[0]: 'exited', CID[1]: state})
            with self.assertRaises(tool.Refused) as e:
                self.sweep(docker)
            self.assertEqual(e.exception.code, 'CONTAINER_NOT_QUIET')
            self.assertEqual(len(docker.containers), 2)

    def test_an_identity_that_does_not_match_refuses_before_any_removal(self):
        for wrong in ([{'Id': CID[1], 'Config': {'Labels': {'clued.verify.nonce': 'n'}}}], [{'Id': CID[0], 'Config': {'Labels': {}}}], [], {'Id': CID[0]}):
            docker = FakeDocker({CID[0]: 'exited'}, inspect_override={CID[0]: wrong})
            with self.assertRaises(tool.Refused) as e:
                self.sweep(docker)
            self.assertEqual(e.exception.code, 'CONTAINER_IDENTITY_UNCONFIRMED')
            self.assertNotIn('rm', [c[0] for c in docker.calls])

    def test_a_failed_removal_refuses_with_the_ids_and_a_second_sweep_finishes(self):
        docker = FakeDocker({CID[0]: 'exited', CID[1]: 'exited'}, rm_fail={CID[1]})
        with self.assertRaises(tool.Refused) as e:
            self.sweep(docker)
        self.assertEqual((e.exception.code, e.exception.details), ('CONTAINER_SWEEP_UNCONFIRMED', [f'{CID[0]} exited', f'{CID[1]} exited']))
        self.assertEqual(docker.containers, {CID[1]: 'exited'})
        docker.rm_fail.clear()
        self.assertEqual([s['id'] for s in self.sweep(docker)], [CID[1]])
        self.assertEqual(len(os.listdir(self.dir)), 3, 'every attempt keeps its evidence')

    def test_an_unreadable_diff_is_recorded_and_does_not_stop_the_removal(self):
        docker = FakeDocker({CID[0]: 'dead'}, diff_fail={CID[0]})
        swept = self.sweep(docker)
        self.assertIsNone(swept[0]['diffEntries'])
        self.assertEqual(docker.containers, {})

    def test_a_container_that_reappears_after_removal_refuses(self):
        docker = FakeDocker({CID[0]: 'exited'})
        real = docker.__call__

        def again(argv):
            r = real(argv)
            if argv[0] == 'rm':
                docker.containers[CID[2]] = 'created'
            return r
        with self.assertRaises(tool.Refused) as e:
            self.sweep(again)
        self.assertEqual(e.exception.code, 'CONTAINER_SWEEP_UNCONFIRMED')

    def test_docker_is_never_asked_for_anything_but_ps_inspect_diff_rm(self):
        for verb in ('rmi', 'image', 'system', 'volume', 'network', 'run', 'exec', 'kill'):
            with self.assertRaises(tool.Refused) as e:
                tool.docker_port([verb, 'x'])
            self.assertEqual(e.exception.code, 'DOCKER_VERB_REFUSED')
        self.assertEqual(tool.DOCKER_VERBS, ('ps', 'inspect', 'diff', 'rm'))
        text = (R / 'linux' / 'bin' / 'clued-ci-resident-linux').read_text(encoding='utf8')
        self.assertNotRegex(text, r"\[DOCKER, '(?!ps')")  # the only direct docker argv left is the quiescence list
        self.assertEqual(tool.NONCE_LIST[:3], ['ps', '--all', '--no-trunc'])

    def test_a_malformed_list_is_unreadable(self):
        for out in ('abc exited\n', f'{CID[0]}\n', f'{CID[0]} exited extra\n'):
            with self.assertRaises(tool.Refused) as e:
                tool.list_nonce(lambda argv: (0, out))
            self.assertEqual(e.exception.code, 'DOCKER_READ_UNCONFIRMED')


class Guard(unittest.TestCase):
    def test_a_worker_starts_only_with_no_labelled_container_in_any_state(self):
        self.assertEqual(tool.guard_no_earlier_containers(FakeDocker(), sleep=lambda s: None), {'containersPresent': 0})
        for state in ('exited', 'dead', 'created', 'running'):
            with self.assertRaises(tool.Refused) as e:
                tool.guard_no_earlier_containers(FakeDocker({CID[3]: state}), sleep=lambda s: None)
            self.assertEqual((e.exception.code, e.exception.details), ('EARLIER_CONTAINER_PRESENT', [f'{CID[3]} {state}']))

    def test_an_unreadable_list_is_read_again_twice_before_refusing(self):
        slept = []
        self.assertEqual(tool.guard_no_earlier_containers(FakeDocker(ps_fail=2), sleep=slept.append), {'containersPresent': 0})
        self.assertEqual(slept, [2.0, 2.0])
        with self.assertRaises(tool.Refused) as e:
            tool.guard_no_earlier_containers(FakeDocker(ps_fail=3), sleep=lambda s: None)
        self.assertEqual(e.exception.code, 'DOCKER_READ_UNCONFIRMED')

    def test_only_the_worker_guard_reads_docker(self):
        text = (R / 'linux' / 'bin' / 'clued-ci-resident-linux').read_text(encoding='utf8')
        body = text[text.index("    if cmd == 'guard':"):text.index("    if cmd == 'view-properties':")]
        self.assertEqual(body.count('guard_no_earlier_containers(docker_port)'), 1)
        self.assertLess(body.index("if unit == 'worker':"), body.index('guard_no_earlier_containers(docker_port)'))

    def test_the_archive_sweeps_after_quiescence_and_before_planning(self):
        text = (R / 'linux' / 'bin' / 'clued-ci-resident-linux').read_text(encoding='utf8')
        body = text[text.index("    if cmd == 'archive':"):text.index("    if cmd == 'archive-status':")]
        order = [body.index(s) for s in ('earlier_result(', 'quiescence(', 'sweep_containers(', 'plan_archive(', 'apply_archive(')]
        self.assertEqual(order, sorted(order))


if __name__ == '__main__':
    unittest.main()
