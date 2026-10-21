"""Offline tests of the Linux privilege-boundary fixes of the independent PR-A review (MINOR-6, MINOR-7,
MINOR-8). Run on any OS: python -I -m unittest discover -s test -p "test_*.py" (from work/independent-ci-resident-v1).
Nothing on a host is touched; the installer is only sourced (its root-only main never runs)."""
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
R = HERE.parent
CI = R.parent / 'actions-hosted-migration' / 'independent-ci-v1'


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


tool = load('resident_linux_priv', R / 'linux' / 'bin' / 'clued-ci-resident-linux')
wsprep = load('prepare_workspaces_priv', CI / 'src' / 'resident-v2' / 'prepare-workspaces.py')
BATCH = '0123456789abcdef-0123456789ab'


def descriptor(**over):
    d = {'contract': 'clued.independent-ci.resident-batch-descriptor/2', 'batchId': BATCH, 'batchKey': BATCH[:16] + 'a' * 48,
         'repo': 'tdoljyj/cross-memory-system', 'pr': 884, 'headSha': '1' * 40, 'baseSha': '2' * 40, 'attempt': 1,
         'ciSourceManifestSha256': 'e' * 64, 'sourceCommit': 'c' * 40, 'gitleaksTomlSha256': '9' * 64, 'createdAt': '2026-10-21T08:00:00.000Z'}
    d['linuxJobIds'] = [tool.job_id_v2(d, r) for r in tool.LINUX_ROLES]
    d.update(over)
    return d


class ArchiveDescriptor(unittest.TestCase):
    def test_job_ids_are_rederived_from_content_with_the_ws_prep_formula(self):
        d = descriptor()
        self.assertEqual(tool.LINUX_ROLES, wsprep.LINUX_ROLES)
        for r in tool.LINUX_ROLES:
            self.assertEqual(tool.job_id_v2(d, r), wsprep.job_id_v2(d, r))
        raw = json.dumps(d).encode()
        self.assertEqual(tool.descriptor_job_ids(raw, BATCH), d['linuxJobIds'])
        self.assertEqual(list(wsprep.validate_descriptor(d, BATCH).values()), d['linuxJobIds'])

    def test_a_list_that_disagrees_with_the_content_refuses_the_archive(self):
        # e.g. a descriptor naming another batch's (or an attacker-chosen) workspace ids
        bad = descriptor(linuxJobIds=['f' * 64] * 3)
        with self.assertRaises(tool.Refused) as e:
            tool.descriptor_job_ids(json.dumps(bad).encode(), BATCH)
        self.assertEqual(e.exception.code, 'EXACT_CONTENT_JOB_ID_REQUIRED')
        moved = descriptor(headSha='3' * 40)  # content changed, list kept
        moved['linuxJobIds'] = descriptor()['linuxJobIds']
        with self.assertRaises(tool.Refused):
            tool.descriptor_job_ids(json.dumps(moved).encode(), BATCH)
        for raw in [b'', b'not json', json.dumps(descriptor(batchId='f' * 16 + '-' + 'f' * 12)).encode(), json.dumps(descriptor(attempt=3)).encode(),
                    json.dumps(descriptor(contract='clued.independent-ci.resident-batch-descriptor/1')).encode()]:
            with self.assertRaises(tool.Refused):
                tool.descriptor_job_ids(raw, BATCH)

    def test_the_descriptor_is_read_through_one_no_follow_handle(self):
        text = (R / 'linux' / 'bin' / 'clued-ci-resident-linux').read_text(encoding='utf8')
        body = text[text.index('def read_descriptor_bytes'):text.index('def stat_regular')]
        self.assertIn("O_NOFOLLOW", body)
        self.assertIn('os.fstat(fd)', body)
        self.assertNotIn('descriptor(parsed', text, 'the archive never trusts linuxJobIds directly')


class Units(unittest.TestCase):
    def test_wsprep_and_archive_units_bound_capabilities_syscalls_and_namespaces(self):
        for name in ('clued-ci-wsprep@.service', 'clued-ci-archive@.service'):
            unit = (R / 'linux' / 'systemd' / name).read_text(encoding='utf8')
            caps = re.search(r'^CapabilityBoundingSet=(.+)$', unit, re.M).group(1).split()
            self.assertEqual(sorted(caps), ['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_DAC_READ_SEARCH', 'CAP_FOWNER'], name)
            self.assertIn('SystemCallFilter=@system-service', unit)
            self.assertRegex(unit, r'(?m)^SystemCallFilter=~.*@privileged.*@mount')
            self.assertRegex(unit, r'(?m)^RestrictNamespaces=yes$')
            self.assertRegex(unit, r'(?m)^NoNewPrivileges=yes$')


class WsPrepCheckout(unittest.TestCase):
    def test_checkout_never_materialises_symlinks_and_modes_are_checked_first(self):
        self.assertIn('core.symlinks=false', wsprep.GIT_PREFIX)
        text = (CI / 'src' / 'resident-v2' / 'prepare-workspaces.py').read_text(encoding='utf8')
        ls = text.index("'ls-tree', '-r', '-z', '--full-tree', d['headSha']")
        checkout = text.index("'checkout', '--quiet', '--detach'")
        self.assertLess(ls, checkout, 'the head tree modes are validated before the checkout')
        with self.assertRaises(wsprep.Refused):
            wsprep.tree_modes_regular('120000 blob ' + 'a' * 40 + '\tlink\0')
        with self.assertRaises(wsprep.Refused):
            wsprep.tree_modes_regular('160000 commit ' + 'a' * 40 + '\tsub\0')


BASH = shutil.which('bash')


@unittest.skipIf(BASH is None, 'no bash')
class LinuxInstaller(unittest.TestCase):
    SCRIPT = R / 'linux' / 'install-resident-linux.sh'
    FILES = ['bin/clued-ci-resident-linux', 'manifest.json', 'systemd/clued-ci-worker@.service', 'systemd/clued-ci-wsprep@.service', 'systemd/clued-ci-archive@.service']

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pkg = pathlib.Path(self.tmp.name) / 'pkg'
        for f in self.FILES:
            p = self.pkg / f
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('content of ' + f)

    def tearDown(self):
        self.tmp.cleanup()

    def sourced(self, call):
        script = self.SCRIPT.as_posix()
        r = subprocess.run([BASH, '-c', f'source "$1"; {call}', 'x', script, self.pkg.as_posix()], capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout

    def test_the_plan_binds_the_script_bytes_and_every_package_file_including_the_manifest(self):
        code, plan = self.sourced('plan_text "$2"')
        self.assertEqual(code, 0)
        self.assertIn('install-script.sha256=' + hashlib.sha256(self.SCRIPT.read_bytes()).hexdigest(), plan)
        for f in self.FILES:
            # GNU coreutils prints "<sha>  <file>"; the MSYS build used offline marks binary mode "<sha> *<file>"
            self.assertRegex(plan, re.escape(hashlib.sha256(('content of ' + f).encode()).hexdigest()) + r' [ *]' + re.escape(f))
        (self.pkg / 'manifest.json').write_text('changed')
        _, again = self.sourced('plan_text "$2"')
        self.assertNotEqual(plan, again)

    def test_package_files_must_be_single_link_regular_files(self):
        self.assertEqual(self.sourced('package_files_ok "$2"')[0], 0)
        os.link(self.pkg / 'manifest.json', pathlib.Path(self.tmp.name) / 'second-link')
        self.assertNotEqual(self.sourced('package_files_ok "$2"')[0], 0)

    def test_apply_installs_from_the_staged_copy_and_never_re_executes_from_disk(self):
        text = self.SCRIPT.read_text(encoding='utf8')
        apply = text[text.index('    --apply)'):text.index('    --continue-after-boot)')]
        self.assertLess(apply.index('stage_copy'), apply.index('PLAN_CHANGED_SINCE_REVIEW'), 'plan computed from the staged copy')
        self.assertNotIn('$pkg/', apply.split('st=$(stage_copy')[1], 'nothing is read from the package after staging')
        self.assertNotIn('exec "$0"', text)
        self.assertIn('if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi', text)
        r = subprocess.run([BASH, '-n', self.SCRIPT.as_posix()], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == '__main__':
    unittest.main()
