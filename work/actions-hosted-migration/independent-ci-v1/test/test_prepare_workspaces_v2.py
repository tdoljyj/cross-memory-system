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

    def test_base_rule_on_main_descriptor(self):
        """bc982192: baseRule is optional and only 'on-main' on an S = H /3 descriptor (push landing); absent means main's tip is baseSha."""
        self.assertFalse(pw.on_main(descriptor()))
        d = descriptor(baseRule='on-main')
        self.assertTrue(pw.on_main(d))
        self.assertEqual(pw.validate_descriptor(d, BATCH)['trivy'], d['linuxJobIds'][1])
        self.assertEqual(d['linuxJobIds'], descriptor()['linuxJobIds'], 'baseRule is not part of any job id')
        for bad in (descriptor(baseRule='any'), descriptor(baseRule=True), descriptor(baseRule=None), descriptor(baseRule='on-main', testSha='4' * 40)):
            with self.assertRaises(pw.Refused) as e:
                pw.validate_descriptor(bad, BATCH)
            self.assertEqual(e.exception.code, 'DESCRIPTOR_REFUSED')

    def test_base_on_main_real_git(self):
        """bc982192: base must be an ancestor of the head and of main's tip, or that tip (git rev-list --count x..base == 0)."""
        tmp = tempfile.mkdtemp(prefix='clued-wsprep-base-')
        try:
            env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_AUTHOR_NAME': 'f', 'GIT_AUTHOR_EMAIL': 'f@f', 'GIT_COMMITTER_NAME': 'f', 'GIT_COMMITTER_EMAIL': 'f@f'}
            run = lambda *a: subprocess.run(['git', '-C', tmp, *a], env=env, capture_output=True, text=True, check=True).stdout
            run('init', '-q', '-b', 'main')
            def commit(msg):
                with open(os.path.join(tmp, msg + '.txt'), 'w') as f:
                    f.write(msg + chr(10))
                run('add', '.')
                run('commit', '-q', '-m', msg)
                return run('rev-parse', 'HEAD').strip()
            t0 = commit('t0')
            run('checkout', '-q', '-b', 'pr')
            head = commit('head')
            run('checkout', '-q', 'main')
            commit('m1')
            m2 = commit('m2')
            run('checkout', '-q', '-b', 'other', t0)
            other = commit('other')
            count = lambda a, b: run('rev-list', '--count', f'{a}..{b}')
            self.assertTrue(pw.base_on_main(count, t0, head, m2), 'the merge base of a head two commits behind main')
            self.assertTrue(pw.base_on_main(count, m2, m2, m2), "main's tip itself")
            self.assertFalse(pw.base_on_main(count, m2, head, m2), 'not an ancestor of the head')
            self.assertFalse(pw.base_on_main(count, head, head, m2), 'not an ancestor of main')
            self.assertFalse(pw.base_on_main(count, other, head, m2), 'neither')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

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

    def test_chain_descriptor_shape(self):
        """Resident ADR 0019: descriptor /4 names 2..4 members (the front first) and S's tree; anything else is refused. Its job ids are /3's."""
        heads = ['5' * 40, '6' * 40, '7' * 40]
        members = [{'pr': 888, 'headSha': heads[0]}, {'pr': 901, 'headSha': heads[1]}, {'pr': 902, 'headSha': heads[2]}]
        d = descriptor(contract=pw.DESCRIPTOR_CHAIN_CONTRACT, headSha=heads[0], testSha='4' * 40, testTree='8' * 40, members=members)
        self.assertEqual(pw.DESCRIPTOR_CHAIN_CONTRACT, 'clued.independent-ci.resident-batch-descriptor/4')
        self.assertEqual(pw.validate_descriptor(d, BATCH)['trivy'], d['linuxJobIds'][1])
        three = descriptor(headSha=heads[0], testSha='4' * 40)
        self.assertEqual(d['linuxJobIds'], three['linuxJobIds'], 'the same job ids as /3: S names the whole chain')
        self.assertEqual(pw.expected_test_refs(d), {'refs/clued-test/' + '4' * 40: '4' * 40})

        def again(**o):
            x = {**d, **o}
            x['linuxJobIds'] = [pw.job_id_v2(x, r) for r in pw.LINUX_ROLES]
            return x
        for bad in (again(members=members[:1]), again(members=members + [{'pr': 903, 'headSha': '9' * 40}, {'pr': 904, 'headSha': 'a' * 40}]),
                    again(members=members[1:] + members[:1]), again(members=[members[0], {'pr': 888, 'headSha': heads[1]}]),
                    again(members=[members[0], {'pr': 901, 'headSha': heads[0]}]), again(members=[members[0], {'pr': 901, 'headSha': '4' * 40}]),
                    again(members=[members[0], {'pr': 901, 'headSha': d['baseSha']}]), again(members=[members[0], {**members[1], 'claimId': 'x'}]),
                    again(members=[members[0], {'pr': True, 'headSha': heads[1]}]), again(members=[members[0], {'pr': 901, 'headSha': 'X' * 40}]),
                    again(members={'0': members[0]}), {k: v for k, v in d.items() if k != 'testTree'}, again(testTree='z' * 40), again(testSha=heads[0]),
                    {k: v for k, v in d.items() if k != 'members'}):
            with self.assertRaises(pw.Refused) as e:
                pw.validate_descriptor(bad, BATCH)
            self.assertEqual(e.exception.code, 'BATCH_CHAIN_DESCRIPTOR_REFUSED', bad)
        # /3 is what it was: it never names members or a tree
        for extra in ({'members': members}, {'testTree': '8' * 40}):
            with self.assertRaises(pw.Refused) as e:
                pw.validate_descriptor({**three, **extra}, BATCH)
            self.assertEqual(e.exception.code, 'DESCRIPTOR_REFUSED')

    def test_chain_receipt_binding(self):
        """ADR 0019: a /4 bundle's receipt names the same members and tree (build-bundle.ps1 checked that chain); /3 receipts are unchanged."""
        heads = ['5' * 40, '6' * 40]
        members = [{'pr': 888, 'headSha': heads[0]}, {'pr': 901, 'headSha': heads[1]}]
        d = descriptor(contract=pw.DESCRIPTOR_CHAIN_CONTRACT, headSha=heads[0], testSha='4' * 40, testTree='8' * 40, members=members)
        now = time.time()
        stamp = datetime.fromtimestamp(now - 60, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        r = {'contract': 'clued.independent-ci.resident-bundle-receipt/1', 'status': 'EXACT_ALL_REFS_AND_REVIEWED_BUNDLE_CREATED', 'batchId': BATCH, 'descriptorSha256': 'f' * 64,
             'headSha': d['headSha'], 'mainSha': d['baseSha'], 'sourceCommit': d['sourceCommit'], 'gitleaksTomlSha256': d['gitleaksTomlSha256'], 'prerequisites': 0, 'bundleVersion': 2,
             'headPresent': True, 'basePresent': True, 'bundleSha256': 'a' * 64, 'refListSha256': 'b' * 64, 'reviewedRefListSha256': 'c' * 64, 'lsRemoteCompletedAt': stamp,
             'testSha': d['testSha'], 'testRefCount': 1, 'testRefListSha256': 'd' * 64, 'chainMembers': members, 'testTree': '8' * 40}
        self.assertIs(pw.validate_receipt(r, d, 'f' * 64, now), r)
        for bad in ({k: v for k, v in r.items() if k != 'chainMembers'}, {k: v for k, v in r.items() if k != 'testTree'}, {**r, 'chainMembers': members[::-1]},
                    {**r, 'chainMembers': members[:1]}, {**r, 'testTree': '9' * 40}):
            with self.assertRaises(pw.Refused) as e:
                pw.validate_receipt(bad, d, 'f' * 64, now)
            self.assertEqual(e.exception.code, 'BUNDLE_RECEIPT_REFUSED')

    @unittest.skipUnless(shutil.which('git'), 'git required')
    def test_real_three_pr_chain(self):
        """ADR 0019 on real objects: T -> S1 = merge(T, H1) -> S2 = merge(S1, H2) -> S3 = merge(S2, H3) passes check_chain on a store and on a
        candidate cloned from the bundle; a wrong parent, a third parent, a head that is not a member, members in another order or a
        different count, another base, S's tree, a member head that is no branch tip are each refused."""
        tmp = tempfile.mkdtemp(prefix='clued-wsprep-chain-')
        real_git = pw.git
        try:
            env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_AUTHOR_NAME': 'f', 'GIT_AUTHOR_EMAIL': 'f@f', 'GIT_COMMITTER_NAME': 'f', 'GIT_COMMITTER_EMAIL': 'f@f'}
            src = os.path.join(tmp, 'src')
            os.mkdir(src)
            run = lambda *a: subprocess.run(['git', '-C', src, *a], env=env, capture_output=True, text=True, check=True).stdout.strip()

            def put(name):
                with open(os.path.join(src, name), 'w') as f:
                    f.write(name + chr(10))
                run('add', name)
            run('init', '-q', '-b', 'main')
            put('t.txt')
            run('commit', '-q', '-m', 'T')
            t = run('rev-parse', 'HEAD')
            heads = []
            for n in (1, 2, 3):
                run('checkout', '-q', '-b', f'pr-{n}', t)
                put(f'p{n}.txt')
                run('commit', '-q', '-m', f'H{n}')
                heads.append(run('rev-parse', 'HEAD'))
            run('checkout', '-q', '--detach', t)
            steps = []
            for n in (1, 2, 3):
                run('merge', '-q', '--no-ff', '-m', f'Merge train batch: H{n}', f'pr-{n}')
                steps.append(run('rev-parse', 'HEAD'))
            s = steps[-1]
            tree = run('rev-parse', s + '^{tree}')
            # a sibling of H2 on its own branch (a live tip, not a member), S2 with its parents swapped, and an octopus last step
            run('checkout', '-q', '-b', 'other', t)
            put('o.txt')
            run('commit', '-q', '-m', 'O')
            other = run('rev-parse', 'HEAD')
            swapped = run('commit-tree', '-p', heads[1], '-p', steps[0], '-m', 'swapped', run('rev-parse', steps[1] + '^{tree}'))
            s_swapped = run('commit-tree', '-p', swapped, '-p', heads[2], '-m', 'S3 on swapped', tree)
            octo = run('commit-tree', '-p', steps[1], '-p', heads[2], '-p', other, '-m', 'octopus', tree)
            run('checkout', '-q', 'main')
            for x in (s, s_swapped, octo):
                run('update-ref', 'refs/clued-test/' + x, x)
            members = [{'pr': 900 + n, 'headSha': heads[n - 1]} for n in (1, 2, 3)]
            d = descriptor(contract=pw.DESCRIPTOR_CHAIN_CONTRACT, pr=901, headSha=heads[0], baseSha=t, testSha=s, testTree=tree, members=members)
            pw.validate_descriptor(d, BATCH)
            formal = {}
            for line in run('for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/').splitlines():
                sha, _, name = line.partition(' ')
                formal[name] = sha
            self.assertEqual(formal['refs/heads/main'], t)
            pw.git = lambda args, cwd='/', timeout=300: subprocess.run(['git', *args], env=env, capture_output=True, text=True, check=True).stdout
            pw.check_chain(['-C', src], d, formal)
            # the same on a candidate cloned from a bundle that carries S under its test ref (as prepare() builds it)
            bundle = os.path.join(tmp, 'all.bundle')
            subprocess.run(['git', '-C', src, 'bundle', 'create', '--quiet', '--version=2', bundle, '--branches', '--tags', 'refs/clued-test/' + s], env=env, check=True, capture_output=True)
            with open(bundle, 'rb') as f:
                bformal, _, btest = pw.parse_bundle_header(f.read())
            self.assertEqual(btest, pw.expected_test_refs(d))
            self.assertTrue(pw.member_tips_ok(bformal, d))
            cand = os.path.join(tmp, 'cand')
            subprocess.run(['git', 'clone', '-q', '--no-checkout', '--', bundle, cand], env=env, check=True, capture_output=True)
            subprocess.run(['git', '-C', cand, 'fetch', '-q', '--no-tags', '--', bundle, f'+refs/clued-test/{s}:refs/clued-test/{s}'], env=env, check=True, capture_output=True)
            pw.check_chain(['-C', cand], d, bformal)
            lines = lambda x: run('rev-list', '--parents', '-n', '1', x)
            self.assertTrue(pw.chain_ok(lines, d))

            def refused(code, formal_refs=formal, **o):
                with self.assertRaises(pw.Refused) as e:
                    pw.check_chain(['-C', src], {**d, **o}, formal_refs)
                self.assertEqual(e.exception.code, code, o)
            refused('BATCH_CHAIN_REQUIRED', testSha=s_swapped)
            refused('BATCH_CHAIN_REQUIRED', testSha=octo)
            refused('BATCH_CHAIN_REQUIRED', members=[members[0], {'pr': 902, 'headSha': other}, members[2]])
            refused('BATCH_CHAIN_REQUIRED', members=[members[0], members[2], members[1]])
            refused('BATCH_CHAIN_REQUIRED', members=members[:2])
            refused('BATCH_CHAIN_REQUIRED', members=members + [{'pr': 904, 'headSha': other}])
            refused('BATCH_CHAIN_REQUIRED', baseSha=heads[0])
            refused('BATCH_TEST_TREE_CHANGED', testTree=run('rev-parse', t + '^{tree}'))
            refused('BATCH_MEMBER_NOT_BRANCH_TIP', formal_refs={k: v for k, v in formal.items() if k != 'refs/heads/pr-2'})
            # the /3 parents check still refuses a chain S, and /3 never reaches the chain check
            self.assertFalse(pw.test_parents_ok(lines(s), descriptor(headSha=heads[0], baseSha=t, testSha=s)))
        finally:
            pw.git = real_git
            shutil.rmtree(tmp, ignore_errors=True)

    def test_formal_ref_names(self):
        for ok in ('refs/heads/main', 'refs/tags/v1.2', 'refs/heads/a/b-c'):
            self.assertTrue(pw.formal_ref_name_ok(ok))
        for bad in ('refs/pull/1/head', 'refs/heads/../x', 'refs/heads/a b', 'refs/heads/x.lock', 'refs/heads/a@{1}', 'refs/heads/'):
            self.assertFalse(pw.formal_ref_name_ok(bad))


if __name__ == '__main__':
    unittest.main()
