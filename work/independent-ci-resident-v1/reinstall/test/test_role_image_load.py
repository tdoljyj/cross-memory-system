"""The local role image from the host preparation to Linux B, under native Git Bash, never WSL (Fable ruling 0e418483, r7 phase B).

r7 stopped in B on IMAGE_INSPECT_FAILED: linux/first-host-prep.sh pinned the classic image store, where a loaded image's ID is its config
digest, while the policies, the kit, the archive and the worker all mean the containerd store's ID (the archive's index target digest).
The old test missed it because its docker double returned whatever ID the case named. Here the double (fake_docker_store.py) computes
the ID from the archive by the store, and the store is the one the REAL host preparation text writes into daemon.json: step 4 of
linux/first-host-prep.sh is cut out by its markers and run with DAEMON in a temporary directory. Then the actual docker_ready text of
first-install.py (phase A's gate) and the actual LOCAL_IMAGE_LOAD text of phase B run against the same double. Real gzip and sha256sum
read disposable OCI archives (test_export_role_image.oci_archive). Nothing touches a real docker or service.
"""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_export_role_image import oci_archive, tar_gz

HERE = Path(__file__).resolve().parent
RES = HERE.parents[1]
FAKE = HERE / 'fake_docker_store.py'


def fragment(name):
    tree = ast.parse((RES / 'reinstall/linux/first-install.py').read_text(encoding='utf-8'))
    return ast.literal_eval(next(n.value for n in tree.body if isinstance(n, ast.Assign)
                                 and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)))


def host_prep_step4():
    """Step 4 of the real host preparation: from its '# 4. ' line up to the '# 5. ' line."""
    lines = (RES / 'linux/first-host-prep.sh').read_text(encoding='utf-8').splitlines(keepends=True)
    start = next(i for i, l in enumerate(lines) if l.startswith('# 4. '))
    end = next(i for i, l in enumerate(lines) if l.startswith('# 5. '))
    return ''.join(lines[start:end])


SYSTEMCTL = r'''#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$CASE_DIR/calls"
case "$*" in
  'show --property=ActiveState --property=Job docker.service') printf 'ActiveState=active\nJob=\n' ;;
  'is-active docker.service') echo active ;;
  'enable docker.service'|'start docker.service'|'restart docker.service') : ;;
  'show -p ActiveState,SubState,Result,Job docker.service') printf 'ActiveState=active\nSubState=running\nResult=success\nJob=\n' ;;
  'list-jobs --no-legend'|'is-system-running') : ;;
  *) exit 99 ;;
esac
'''

HARNESS = r'''set -euo pipefail
CASE_DIR=$(cd "$CASE_DIR" && pwd); export CASE_DIR
export PATH="$CASE_DIR/bin:/usr/bin:/bin"
W=$CASE_DIR; T=$CASE_DIR/run; mkdir -p "$T"
DAEMON=$CASE_DIR/etc/docker/daemon.json; LOG=$CASE_DIR/log
refuse() { printf 'REFUSED:%s\n' "$1"; exit 3; }
refuse_tail() { printf 'REFUSED:%s\n' "$1"; exit 3; }
install() { :; }   # the host preparation's `install -d ... /etc/docker`: DAEMON's directory is made by the test
'''


class Chain(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = os.environ.get('CLUED_TEST_BASH') or (r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else shutil.which('bash'))
        if not cls.bash or not Path(cls.bash).is_file():
            raise RuntimeError('NON_WSL_BASH_REQUIRED_FOR_ROLE_IMAGE_TEST')

    def run_chain(self, *, steps, daemon=None, indexed=False, compressed=True, image_id='target', present=None, changed=False,
                  load_fail=False, inspect_fail=False, report_id=None):
        """steps: the texts in order, from 'step4' (host preparation), 'ready' (docker_ready + its call), 'load' (B's LOCAL_IMAGE_LOAD).
        daemon: a daemon.json text in place before step 4 (None: no file). image_id: 'target' (the index target digest, the containerd
        store's ID, as the export writes it) or 'config' (the config digest)."""
        entries, target, config = oci_archive(indexed=indexed)
        self.assertNotEqual(target, config)
        hexid = target if image_id == 'target' else config
        data = tar_gz(entries)
        if not compressed:
            import gzip
            data = gzip.decompress(data)
        with tempfile.TemporaryDirectory(prefix='image-chain-') as tmp:
            root = Path(tmp); (root / 'images').mkdir(); (root / 'bin').mkdir(); (root / 'etc' / 'docker').mkdir(parents=True)
            name = hexid + ('.tar.gz' if compressed else '.tar')
            (root / 'images' / name).write_bytes(data + (b'changed' if changed else b''))
            pin = hashlib.sha256(data).hexdigest()
            if daemon is not None:
                (root / 'etc' / 'docker' / 'daemon.json').write_text(daemon, encoding='utf-8', newline='\n')
            (root / 'calls').write_text('')
            py = Path(sys.executable).as_posix()
            (root / 'bin' / 'docker').write_text('#!/bin/bash\nexec "%s" -I "%s" "$@"\n' % (py, FAKE.as_posix()), encoding='utf-8', newline='\n')
            (root / 'bin' / 'systemctl').write_text(SYSTEMCTL, encoding='utf-8', newline='\n')
            for f in ('docker', 'systemctl'):
                (root / 'bin' / f).chmod(0o755)
            parts = {'step4': host_prep_step4().replace('/usr/bin/python3.12', py),
                     'ready': fragment('DOCKER_READY') + 'docker_ready\n',
                     'load': fragment('LOCAL_IMAGE_LOAD').replace('@@LOCAL_IMAGES@@', f'{hexid} {name} {pin}\n')}
            text = HARNESS + ''.join(parts[s] for s in steps) + '\nprintf "VERIFIED\\n"\n'
            driver = root / 'driver.sh'; driver.write_text(text, encoding='utf-8', newline='\n')
            env = {**os.environ, 'CASE_DIR': root.as_posix(), 'FAKE_DOCKER_DAEMON': (root / 'etc' / 'docker' / 'daemon.json').as_posix(),
                   'FAKE_DOCKER_PRESENT': (hexid if present == 'same' else present or ''), 'FAKE_DOCKER_LOAD_FAIL': str(int(load_fail)),
                   'FAKE_DOCKER_INSPECT_FAIL': str(int(inspect_fail)), 'FAKE_DOCKER_REPORT_ID': report_id or ''}
            result = subprocess.run([self.bash, '--noprofile', '--norc', driver.as_posix()], capture_output=True, text=True,
                                    encoding='utf-8', errors='replace', timeout=60, env=env)
            calls = (root / 'calls').read_text().splitlines()
            written = (root / 'etc' / 'docker' / 'daemon.json').read_text(encoding='utf-8') if (root / 'etc' / 'docker' / 'daemon.json').exists() else None
            return result, calls, {'target': target, 'config': config, 'hex': hexid, 'daemon': written}

    def assert_refused(self, result, code):
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn('REFUSED:' + code, result.stdout)
        self.assertNotIn('VERIFIED', result.stdout)

    # the main case: what r7 ran, from the host preparation's daemon.json to B's load of the r7 archive shape (index -> manifest, no tag)
    def test_host_preparation_gate_and_load_keep_the_archive_id(self):
        r, calls, ids = self.run_chain(steps=('step4', 'ready', 'load'))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('VERIFIED', r.stdout)
        self.assertEqual(json.loads(ids['daemon']), {'features': {'containerd-snapshotter': True}})
        self.assertEqual(sum(c.startswith('load -q') for c in calls), 1)
        # B writes the store and each local image's .Id (r8's receipt carries them)
        out = [json.loads(l) for l in r.stdout.splitlines() if l.startswith('{"imageStore"')]
        self.assertEqual(len(out), 1, r.stdout)
        self.assertIn('io.containerd.snapshotter', json.dumps(out[0]['imageStore']))
        self.assertEqual(out[0]['localImages'], {ids['target']: 'sha256:' + ids['target']})

    def test_host_preparation_records_the_store_it_checked(self):
        r, _, _ = self.run_chain(steps=('step4',))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('VERIFIED', r.stdout)
        text = (RES / 'linux/first-host-prep.sh').read_text(encoding='utf-8')
        self.assertIn('\\"dockerDriver\\":\\"$driver\\"', text)

    def test_an_existing_daemon_json_must_name_the_containerd_store(self):
        for daemon in ('{"features":{"containerd-snapshotter":false}}\n', '{"features":{}}\n', '{}\n'):
            with self.subTest(daemon=daemon):
                r, calls, ids = self.run_chain(steps=('step4',), daemon=daemon)
                self.assert_refused(r, 'DOCKER_DAEMON_JSON_NOT_THE_CONTAINERD_STORE')
                self.assertEqual(ids['daemon'], daemon)   # never rewritten
        r, _, ids = self.run_chain(steps=('step4',), daemon='{"features":{"containerd-snapshotter":true}}\n')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_phase_a_gate_refuses_the_classic_store_before_any_load(self):
        r, calls, _ = self.run_chain(steps=('ready', 'load'), daemon='{"features":{"containerd-snapshotter":false}}\n')
        self.assert_refused(r, 'DOCKER_IMAGE_STORE_NOT_CONTAINERD')
        self.assertFalse(any(c.startswith('load') for c in calls), calls)
        self.assertEqual(r.stdout.splitlines()[-1], 'REFUSED:DOCKER_IMAGE_STORE_NOT_CONTAINERD')
        # the scene on stderr: the driver and its status
        self.assertIn('overlay2', r.stderr)
        self.assertIn('DriverStatus', r.stderr)

    def test_phase_a_gate_passes_the_containerd_store(self):
        for daemon in (None, '{"features":{"containerd-snapshotter":true}}\n'):
            with self.subTest(daemon=daemon):
                r, _, _ = self.run_chain(steps=('ready',), daemon=daemon)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertRegex(r.stdout, r'(?m)^\{"dockerReady":"active","waitedSeconds":\d+\}$')

    def test_an_id_the_store_does_not_keep_is_refused_with_the_scene(self):
        # the containerd store, an archive named by its config digest: loaded, but under its index target
        r, calls, ids = self.run_chain(steps=('ready', 'load'), image_id='config')
        self.assert_refused(r, 'IMAGE_ID_NOT_KEPT_BY_THIS_STORE:' + ids['config'])
        self.assertEqual(sum(c.startswith('load -q') for c in calls), 1)
        self.assertIn('Loaded image ID: sha256:' + ids['target'], r.stderr)   # the load output, kept
        self.assertIn('IMAGE ID', r.stderr)                                    # docker image ls --no-trunc --digests
        self.assertIn('io.containerd.snapshotter', r.stderr)                   # the store reading

    def test_manifest_and_index_targets_load_under_the_containerd_store(self):
        for indexed in (False, True):
            for compressed in (False, True):
                with self.subTest(indexed=indexed, compressed=compressed):
                    r, calls, ids = self.run_chain(steps=('ready', 'load'), indexed=indexed, compressed=compressed)
                    self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                    self.assertIn('VERIFIED', r.stdout)
                    self.assertEqual(sum(c.startswith('load -q') for c in calls), 1)

    def test_a_config_id_never_passes_on_any_store(self):
        # the old classic=True success case: an archive named by its config digest is refused on the classic store (A's gate, before any
        # load) and on the containerd store (B: the store does not keep that ID)
        r, calls, _ = self.run_chain(steps=('ready', 'load'), image_id='config', daemon='{"features":{"containerd-snapshotter":false}}\n')
        self.assert_refused(r, 'DOCKER_IMAGE_STORE_NOT_CONTAINERD')
        self.assertFalse(any(c.startswith('load') for c in calls))
        r, _, ids = self.run_chain(steps=('ready', 'load'), image_id='config')
        self.assert_refused(r, 'IMAGE_ID_NOT_KEPT_BY_THIS_STORE:' + ids['config'])

    def test_present_image_is_rechecked_without_reloading(self):
        r, calls, _ = self.run_chain(steps=('ready', 'load'), present='same')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse(any(c.startswith('load') for c in calls))

    def test_archive_tamper_load_failure_inspect_failure_and_wrong_id_refuse(self):
        for opts, code in (({'changed': True}, 'IMAGE_ARCHIVE_NOT_THE_PINNED_ONE'),
                           ({'load_fail': True}, 'IMAGE_LOAD_FAILED'),
                           ({'inspect_fail': True}, 'IMAGE_INSPECT_FAILED'),
                           ({'report_id': '0' * 64}, 'IMAGE_NOT_PRESENT'),
                           ({'present': 'same', 'report_id': '0' * 64}, 'IMAGE_NOT_PRESENT')):
            with self.subTest(opts=opts):
                r, calls, _ = self.run_chain(steps=('ready', 'load'), **opts)
                self.assert_refused(r, code + ':')
                if opts.get('changed'):
                    self.assertFalse(any(c.startswith('load') for c in calls))

    def test_the_load_output_is_kept_not_discarded(self):
        text = fragment('LOCAL_IMAGE_LOAD')
        self.assertNotRegex(text, r'docker load[^\n]*>\s*/dev/null')


if __name__ == '__main__':
    unittest.main()
