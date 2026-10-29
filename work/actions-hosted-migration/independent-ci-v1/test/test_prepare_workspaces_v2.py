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
                          ({k: v for k, v in d.items() if k != 'testSha'}, 'DESCRIPTOR_REFUSED'), ({**d, 'testSha': 'X' * 40}, 'DESCRIPTOR_REFUSED')]:
            with self.assertRaises(pw.Refused) as e:
                pw.validate_descriptor(bad, BATCH)
            self.assertEqual(e.exception.code, code)
            self.assertIsNotNone(e.exception.line)
        # step 3c-2: a train front batch tests S != H (its ids name S); its bundle must carry exactly that test ref
        front = descriptor(testSha='4' * 40)
        self.assertEqual(pw.validate_descriptor(front, BATCH)['trivy'], front['linuxJobIds'][1])
        self.assertEqual(pw.expected_test_refs(front), {'refs/clued-test/' + '4' * 40: '4' * 40})
        self.assertEqual(pw.expected_test_refs(d), {})
        self.assertTrue(pw.test_parents_ok(' '.join(['4' * 40, d['baseSha'], d['headSha']]), front))
        for line in (' '.join(['4' * 40, d['headSha'], d['baseSha']]), ' '.join(['4' * 40, d['baseSha']]), ' '.join(['4' * 40, d['baseSha'], d['headSha'], '5' * 40]), ''):
            self.assertFalse(pw.test_parents_ok(line, front))

    def test_receipt_binding_and_freshness(self):
        d = descriptor()
        now = time.time()
        stamp = datetime.fromtimestamp(now - 60, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        r = {'contract': 'clued.independent-ci.resident-bundle-receipt/1', 'status': 'EXACT_ALL_REFS_AND_REVIEWED_BUNDLE_CREATED', 'batchId': BATCH, 'descriptorSha256': 'f' * 64,
             'headSha': d['headSha'], 'mainSha': d['baseSha'], 'sourceCommit': d['sourceCommit'], 'gitleaksTomlSha256': d['gitleaksTomlSha256'], 'prerequisites': 0, 'bundleVersion': 2,
             'headPresent': True, 'basePresent': True, 'bundleSha256': 'a' * 64, 'refListSha256': 'b' * 64, 'reviewedRefListSha256': 'c' * 64, 'lsRemoteCompletedAt': stamp,
             'testSha': d['testSha'], 'testRefCount': 0, 'testRefListSha256': pw.ref_list_sha({})}
        self.assertIs(pw.validate_receipt(r, d, 'f' * 64, now), r)
        front = descriptor(testSha='4' * 40)
        fr = {**r, 'testSha': front['testSha'], 'testRefCount': 1, 'testRefListSha256': 'd' * 64}
        self.assertIs(pw.validate_receipt(fr, front, 'f' * 64, now), fr)
        for bad, desc in (({**fr, 'testRefCount': 0}, front), ({**fr, 'testSha': d['headSha']}, front), (fr, d), ({**r, 'testRefCount': 1}, d),
                          ({k: v for k, v in r.items() if k != 'testRefListSha256'}, d), ({k: v for k, v in r.items() if k != 'testSha'}, d)):
            with self.assertRaises(pw.Refused) as e:
                pw.validate_receipt(bad, desc, 'f' * 64, now)
            self.assertEqual(e.exception.code, 'BUNDLE_RECEIPT_REFUSED')
        old = datetime.fromtimestamp(now - 7300, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        for bad, code in [({**r, 'lsRemoteCompletedAt': old}, 'FRESH_BUNDLE_REQUIRED'), ({**r, 'descriptorSha256': '0' * 64}, 'BUNDLE_RECEIPT_REFUSED'),
                          ({**r, 'mainSha': '9' * 40}, 'BUNDLE_RECEIPT_REFUSED'), ({**r, 'sourceCommit': d['headSha']}, 'BUNDLE_RECEIPT_REFUSED')]:
            with self.assertRaises(pw.Refused) as e:
                pw.validate_receipt(bad, d, 'f' * 64, now)
            self.assertEqual(e.exception.code, code)

    def test_bundle_generation(self):
        """Task 4012c1b9: gen-2/ wins only when complete and bound to the first generation; never skipped when incomplete."""
        d = descriptor()
        now = time.time()
        stamp = datetime.fromtimestamp(now - 60, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        old = datetime.fromtimestamp(now - 7300, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        r1 = {'contract': 'clued.independent-ci.resident-bundle-receipt/1', 'status': 'EXACT_ALL_REFS_AND_REVIEWED_BUNDLE_CREATED', 'batchId': BATCH, 'descriptorSha256': 'f' * 64,
              'headSha': d['headSha'], 'mainSha': d['baseSha'], 'sourceCommit': d['sourceCommit'], 'gitleaksTomlSha256': d['gitleaksTomlSha256'], 'prerequisites': 0, 'bundleVersion': 2,
              'headPresent': True, 'basePresent': True, 'bundleSha256': 'a' * 64, 'refListSha256': 'b' * 64, 'reviewedRefListSha256': 'c' * 64, 'lsRemoteCompletedAt': stamp,
              'testSha': d['testSha'], 'testRefCount': 0, 'testRefListSha256': pw.ref_list_sha({})}
        r2 = {**r1, 'bundleSha256': '5' * 64, 'refListSha256': '6' * 64, 'generation': 2, 'previousBundleSha256': 'a' * 64, 'previousRefListSha256': 'b' * 64}
        with tempfile.TemporaryDirectory() as tmp:
            base = os.path.join(tmp, BATCH)
            os.mkdir(base)
            def put(path, v):
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(json.dumps(v))
            put(os.path.join(base, 'all-refs.receipt.json'), r1)
            self.assertEqual(pw.bundle_generation(base, d, 'f' * 64, now), (base, r1))
            # an old first generation is refused for freshness when it is the one used
            put(os.path.join(base, 'all-refs.receipt.json'), {**r1, 'lsRemoteCompletedAt': old})
            with self.assertRaises(pw.Refused) as e:
                pw.bundle_generation(base, d, 'f' * 64, now)
            self.assertEqual(e.exception.code, 'FRESH_BUNDLE_REQUIRED')
            # ... and accepted behind a fresh, bound second generation
            gen2 = os.path.join(base, 'gen-2')
            os.mkdir(gen2)
            with self.assertRaises(pw.Refused) as e:
                pw.bundle_generation(base, d, 'f' * 64, now)
            self.assertEqual(e.exception.code, 'BUNDLE_GENERATION_INCOMPLETE')
            put(os.path.join(gen2, 'all-refs.receipt.json'), r2)
            self.assertEqual(pw.bundle_generation(base, d, 'f' * 64, now), (f'{base}/gen-2', r2))
            for bad in ({**r2, 'generation': 3}, {**r2, 'previousBundleSha256': '7' * 64}, {k: v for k, v in r2.items() if k != 'generation'},
                        {**r2, 'previousRefListSha256': '7' * 64}, {**r2, 'descriptorSha256': '0' * 64}):
                put(os.path.join(gen2, 'all-refs.receipt.json'), bad)
                with self.assertRaises(pw.Refused) as e:
                    pw.bundle_generation(base, d, 'f' * 64, now)
                self.assertEqual(e.exception.code, 'BUNDLE_RECEIPT_REFUSED')
            # a first generation that names a generation, or belongs to another descriptor, is refused
            put(os.path.join(gen2, 'all-refs.receipt.json'), r2)
            for bad in ({**r1, 'generation': 1}, {**r1, 'descriptorSha256': '0' * 64}):
                put(os.path.join(base, 'all-refs.receipt.json'), bad)
                with self.assertRaises(pw.Refused) as e:
                    pw.bundle_generation(base, d, 'f' * 64, now)
                self.assertEqual(e.exception.code, 'BUNDLE_RECEIPT_REFUSED')

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
            formal, reviewed, test = pw.parse_bundle_header(data)
            self.assertEqual(formal, {'refs/heads/main': head, 'refs/tags/v1': head})
            self.assertEqual(reviewed, {'refs/reviewed/' + head: head})
            self.assertEqual(test, {})
            self.assertEqual(pw.ref_list_sha(formal), hashlib.sha256(f'{head} refs/heads/main\n{head} refs/tags/v1\n'.encode()).hexdigest())
            with self.assertRaises(pw.Refused):
                pw.parse_bundle_header(b'# v3 git bundle\n' + data.split(b'\n', 1)[1])
            with self.assertRaises(pw.Refused):
                pw.parse_bundle_header(data.replace(b'refs/tags/v1', b'refs/tags/v.lock', 1))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @unittest.skipUnless(shutil.which('git'), 'git required')
    def test_real_test_merge_in_the_bundle(self):
        """Step 3c-2: GitHub's test merge S of [T, H], carried under refs/clued-test/<S>, parses and passes the parents check."""
        tmp = tempfile.mkdtemp(prefix='clued-wsprep-s-')
        try:
            env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_AUTHOR_NAME': 'f', 'GIT_AUTHOR_EMAIL': 'f@f', 'GIT_COMMITTER_NAME': 'f', 'GIT_COMMITTER_EMAIL': 'f@f'}
            run = lambda *a: subprocess.run(['git', '-C', tmp, *a], env=env, capture_output=True, text=True, check=True).stdout
            run('init', '-q', '-b', 'main')
            for name in ('a.txt',):
                with open(os.path.join(tmp, name), 'w') as f:
                    f.write('a' + chr(10))
            run('add', '.')
            run('commit', '-q', '-m', 'root')
            run('checkout', '-q', '-b', 'pr')
            with open(os.path.join(tmp, 'b.txt'), 'w') as f:
                f.write('b' + chr(10))
            run('add', '.')
            run('commit', '-q', '-m', 'head')
            head = run('rev-parse', 'HEAD').strip()
            run('checkout', '-q', 'main')
            with open(os.path.join(tmp, 'c.txt'), 'w') as f:
                f.write('c' + chr(10))
            run('add', '.')
            run('commit', '-q', '-m', 'main moved')
            tip = run('rev-parse', 'HEAD').strip()
            run('merge', '-q', '--no-ff', '-m', 'test merge', 'pr')
            s = run('rev-parse', 'HEAD').strip()
            run('reset', '-q', '--hard', tip)
            run('update-ref', 'refs/clued-test/' + s, s)
            bundle = os.path.join(tmp, 'all.bundle')
            run('bundle', 'create', '--quiet', '--version=2', bundle, '--branches', '--tags', '--glob=refs/clued-test/*')
            with open(bundle, 'rb') as f:
                formal, reviewed, test = pw.parse_bundle_header(f.read())
            d = descriptor(headSha=head, baseSha=tip, testSha=s)
            self.assertEqual(formal['refs/heads/main'], tip)
            self.assertEqual(test, pw.expected_test_refs(d))
            self.assertTrue(pw.test_parents_ok(run('rev-list', '--parents', '-n', '1', s).strip(), d))
            self.assertFalse(pw.test_parents_ok(run('rev-list', '--parents', '-n', '1', s).strip(), descriptor(headSha=tip, baseSha=head, testSha=s)))
            # a plain clone maps no ref to S (only branches and tags); fetching the test ref gives S its ref
            cand = os.path.join(tmp, 'cand')
            show = lambda: subprocess.run(['git', '-C', cand, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/clued-test/'], env=env, capture_output=True, text=True, check=True).stdout.split()
            subprocess.run(['git', 'clone', '-q', '--no-checkout', '--', bundle, cand], env=env, check=True, capture_output=True)
            self.assertEqual(show(), [])
            subprocess.run(['git', '-C', cand, 'fetch', '-q', '--no-tags', '--', bundle, '+refs/clued-test/' + s + ':refs/clued-test/' + s], env=env, check=True, capture_output=True)
            self.assertEqual(show(), [s, 'refs/clued-test/' + s])
            self.assertEqual(subprocess.run(['git', '-C', cand, 'cat-file', '-t', s], env=env, capture_output=True, text=True, check=True).stdout.strip(), 'commit')
            # a second test ref, or one not named by its own SHA, is refused
            with open(bundle, 'rb') as f:
                data = f.read()
            with self.assertRaises(pw.Refused) as e:
                pw.parse_bundle_header(data.replace(('refs/clued-test/' + s).encode(), ('refs/clued-test/' + '0' * 40).encode(), 1))
            self.assertEqual(e.exception.code, 'EXACT_TEST_REF_REQUIRED')
            line = (s + ' refs/clued-test/' + s).encode()
            second = (tip + ' refs/clued-test/' + tip).encode()
            with self.assertRaises(pw.Refused) as e:
                pw.parse_bundle_header(data.replace(line, line + bytes([10]) + second, 1))
            self.assertEqual(e.exception.code, 'EXACT_TEST_REF_REQUIRED')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_formal_ref_names(self):
        for ok in ('refs/heads/main', 'refs/tags/v1.2', 'refs/heads/a/b-c'):
            self.assertTrue(pw.formal_ref_name_ok(ok))
        for bad in ('refs/pull/1/head', 'refs/heads/../x', 'refs/heads/a b', 'refs/heads/x.lock', 'refs/heads/a@{1}', 'refs/heads/'):
            self.assertFalse(pw.formal_ref_name_ok(bad))


if __name__ == '__main__':
    unittest.main()
