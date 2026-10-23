"""Offline tests of resident-v2/prepare-workspaces.py pure helpers (no root, no WSL, no network).

    python -I -B -m unittest discover -s work/actions-hosted-migration/independent-ci-v1/test -p "test_*.py"
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), 'src', 'resident-v2', 'prepare-workspaces.py')
spec = importlib.util.spec_from_file_location('prepare_workspaces_v2', SRC)
pw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pw)

BATCH = 'a1b2c3d4e5f60718-0123456789ab'


def descriptor(**o):
    d = {'contract': 'clued.independent-ci.resident-batch-descriptor/3', 'batchId': BATCH, 'batchKey': BATCH[:16] + 'c' * 48, 'repo': pw.REPO, 'pr': 888,
         'headSha': '1' * 40, 'baseSha': '2' * 40, 'testSha': '1' * 40, 'sourceCommit': '3' * 40, 'ciSourceManifestSha256': 'd' * 64, 'gitleaksTomlSha256': 'e' * 64, 'attempt': 1}
    d.update(o)
    d['linuxJobIds'] = [pw.job_id_v2(d, r) for r in pw.LINUX_ROLES]
    return d


def node_job_id(d, role):
    """The Node formula (job-v2.mjs) computed by node itself, so the two can never drift."""
    url = 'file:///' + os.path.join(os.path.dirname(HERE), 'src', 'job-v2.mjs').replace('\\', '/').lstrip('/')
    script = (f"import {{jobIdV2}} from '{url}';process.stdout.write(jobIdV2(JSON.parse(process.argv[1])));")
    job = {'repo': d['repo'], 'pr': d['pr'], 'headSha': d['headSha'], 'baseSha': d['baseSha'], 'testSha': d['testSha'], 'sourceManifestSha256': d['ciSourceManifestSha256'], 'role': role, 'attempt': d['attempt']}
    return subprocess.run(['node', '--input-type=module', '-e', script, json.dumps(job)], capture_output=True, text=True, check=True).stdout


class PrepareWorkspacesV2Tests(unittest.TestCase):
    def test_job_ids_match_node_and_include_attempt(self):
        d = descriptor()
        if shutil.which('node'):
            for role in pw.LINUX_ROLES:
                self.assertEqual(pw.job_id_v2(d, role), node_job_id(d, role))
        self.assertEqual(pw.validate_descriptor(d, BATCH)['gitleaks'], d['linuxJobIds'][0])
        two = descriptor(attempt=2)
        self.assertTrue(all(a != b for a, b in zip(d['linuxJobIds'], two['linuxJobIds'])))
        # job contract /3: the tested commit is part of the id (another S, other ids), and Node agrees on it too
        other = descriptor(testSha='4' * 40)
        self.assertTrue(all(a != b for a, b in zip(d['linuxJobIds'], other['linuxJobIds'])))
        if shutil.which('node'):
            self.assertEqual(pw.job_id_v2(other, 'trivy'), node_job_id(other, 'trivy'))

    def test_descriptor_refusals(self):
        d = descriptor()
        for bad, code in [({**d, 'linuxJobIds': d['linuxJobIds'][::-1]}, 'EXACT_CONTENT_JOB_ID_REQUIRED'), ({**d, 'attempt': 3}, 'DESCRIPTOR_REFUSED'),
                          ({**d, 'batchId': 'f' * 16 + '-' + '0' * 12}, 'DESCRIPTOR_REFUSED'), ({**d, 'pr': True}, 'DESCRIPTOR_REFUSED'),
                          ({**d, 'contract': 'clued.independent-ci.resident-batch-descriptor/1'}, 'DESCRIPTOR_REFUSED'),
                          ({**d, 'contract': 'clued.independent-ci.resident-batch-descriptor/2'}, 'DESCRIPTOR_REFUSED'),
                          ({k: v for k, v in d.items() if k != 'testSha'}, 'DESCRIPTOR_REFUSED'), ({**d, 'testSha': 'X' * 40}, 'DESCRIPTOR_REFUSED'),
                          # step 3b: S = H; another tested commit is refused until step 3c (ids recomputed so only S differs)
                          (descriptor(testSha='4' * 40), 'TEST_COMMIT_NOT_HEAD')]:
            with self.assertRaises(pw.Refused) as e:
                pw.validate_descriptor(bad, BATCH)
            self.assertEqual(e.exception.code, code)
            self.assertIsNotNone(e.exception.line)

    def test_receipt_binding_and_freshness(self):
        d = descriptor()
        now = time.time()
        stamp = datetime.fromtimestamp(now - 60, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        r = {'contract': 'clued.independent-ci.resident-bundle-receipt/1', 'status': 'EXACT_ALL_REFS_AND_REVIEWED_BUNDLE_CREATED', 'batchId': BATCH, 'descriptorSha256': 'f' * 64,
             'headSha': d['headSha'], 'mainSha': d['baseSha'], 'sourceCommit': d['sourceCommit'], 'gitleaksTomlSha256': d['gitleaksTomlSha256'], 'prerequisites': 0, 'bundleVersion': 2,
             'headPresent': True, 'basePresent': True, 'bundleSha256': 'a' * 64, 'refListSha256': 'b' * 64, 'reviewedRefListSha256': 'c' * 64, 'lsRemoteCompletedAt': stamp}
        self.assertIs(pw.validate_receipt(r, d, 'f' * 64, now), r)
        old = datetime.fromtimestamp(now - 7300, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        for bad, code in [({**r, 'lsRemoteCompletedAt': old}, 'FRESH_BUNDLE_REQUIRED'), ({**r, 'descriptorSha256': '0' * 64}, 'BUNDLE_RECEIPT_REFUSED'),
                          ({**r, 'mainSha': '9' * 40}, 'BUNDLE_RECEIPT_REFUSED'), ({**r, 'sourceCommit': d['headSha']}, 'BUNDLE_RECEIPT_REFUSED')]:
            with self.assertRaises(pw.Refused) as e:
                pw.validate_receipt(bad, d, 'f' * 64, now)
            self.assertEqual(e.exception.code, code)

    def test_tree_modes_and_git_config(self):
        self.assertTrue(pw.tree_modes_regular('100644 blob ' + 'a' * 40 + '\tx\0100755 blob ' + 'b' * 40 + '\ty\0'))
        for row in ('120000 blob ' + 'a' * 40 + '\tlink\0', '160000 commit ' + 'a' * 40 + '\tsub\0'):
            with self.assertRaises(pw.Refused):
                pw.tree_modes_regular(row)
        self.assertTrue(pw.git_config_safe('[core]\n\tbare = true\n'))
        self.assertFalse(pw.git_config_safe('[includeIf "gitdir:/x"]\n\tpath = /y\n'))

    @unittest.skipUnless(shutil.which('git'), 'git required')
    def test_real_bundle_header_and_ref_list(self):
        tmp = tempfile.mkdtemp(prefix='clued-wsprep-')
        try:
            env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_AUTHOR_NAME': 'f', 'GIT_AUTHOR_EMAIL': 'f@f', 'GIT_COMMITTER_NAME': 'f', 'GIT_COMMITTER_EMAIL': 'f@f'}
            run = lambda *a: subprocess.run(['git', '-C', tmp, *a], env=env, capture_output=True, text=True, check=True).stdout
            run('init', '-q', '-b', 'main')
            with open(os.path.join(tmp, 'a.txt'), 'w') as f:
                f.write('a\n')
            run('add', 'a.txt')
            run('commit', '-q', '-m', 'a')
            head = run('rev-parse', 'HEAD').strip()
            run('tag', 'v1')
            run('update-ref', 'refs/reviewed/' + head, head)
            bundle = os.path.join(tmp, 'all.bundle')
            run('bundle', 'create', '--quiet', '--version=2', bundle, '--branches', '--tags', '--glob=refs/reviewed/*')
            with open(bundle, 'rb') as f:
                data = f.read()
            formal, reviewed = pw.parse_bundle_header(data)
            self.assertEqual(formal, {'refs/heads/main': head, 'refs/tags/v1': head})
            self.assertEqual(reviewed, {'refs/reviewed/' + head: head})
            self.assertEqual(pw.ref_list_sha(formal), hashlib.sha256(f'{head} refs/heads/main\n{head} refs/tags/v1\n'.encode()).hexdigest())
            with self.assertRaises(pw.Refused):
                pw.parse_bundle_header(b'# v3 git bundle\n' + data.split(b'\n', 1)[1])
            with self.assertRaises(pw.Refused):
                pw.parse_bundle_header(data.replace(b'refs/tags/v1', b'refs/tags/v.lock', 1))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_formal_ref_names(self):
        for ok in ('refs/heads/main', 'refs/tags/v1.2', 'refs/heads/a/b-c'):
            self.assertTrue(pw.formal_ref_name_ok(ok))
        for bad in ('refs/pull/1/head', 'refs/heads/../x', 'refs/heads/a b', 'refs/heads/x.lock', 'refs/heads/a@{1}', 'refs/heads/'):
            self.assertFalse(pw.formal_ref_name_ok(bad))


if __name__ == '__main__':
    unittest.main()
