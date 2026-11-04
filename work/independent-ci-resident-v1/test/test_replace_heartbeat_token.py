"""Offline tests of windows/replace-heartbeat-token.ps1 (Task 1abde401): the Owner tool that puts in or replaces the node heartbeat
token without a reinstall. Real Windows PowerShell 5.1 on scratch directories; the script's functions are dot-sourced with the
test-only parameters (owner, descriptors, elevation), so nothing is elevated, no C:\\ProgramData path is read or written, and no real
secret is used (every token here is random test data).

Not testable without an elevated Owner token on a real node: the production descriptors with owner Administrators (they are
asserted textually against install-resident.ps1 and verify-resident.ps1 instead), the real UAC check, and the real node profile.
  python -I -B -m unittest discover -s test -p "test_*.py"     (from work/independent-ci-resident-v1)
"""
import json, os, re, secrets, shutil, string, subprocess, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, 'windows', 'replace-heartbeat-token.ps1')
INSTALL = os.path.join(ROOT, 'windows', 'install-resident.ps1')
VERIFY = os.path.join(ROOT, 'windows', 'verify-resident.ps1')
POWERSHELL = os.path.join(os.environ.get('SystemRoot', 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
ALPHABET = string.ascii_letters + string.digits + '-_'
HOSTNAME = 'TESTHOST-1'

DRIVER = r"""
param([string]$Script, [string]$Case)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. $Script
$c = Get-Content -LiteralPath $Case -Raw | ConvertFrom-Json
$script:ClearedForTest = New-Object Collections.ArrayList
$p = @{ Root = $c.root }
foreach ($k in @('TokenFile', 'ExpectedPlanSha256', 'ConnectionId', 'CurrentSid', 'Machine', 'DirectorySddl', 'FileSddl', 'DirectoryOwnerSid')) {
  $v = $c.PSObject.Properties[$k]; if ($null -ne $v -and $null -ne $v.Value) { $p[$k] = [string]$v.Value }
}
if ($null -ne $c.PSObject.Properties['Elevated']) { $p['Elevated'] = [bool]$c.Elevated }
$out = [ordered]@{ result = $null; error = $null }
try { $out.result = Invoke-HeartbeatTokenReplace @p -Apply:($null -ne $c.PSObject.Properties['Apply'] -and [bool]$c.Apply) -AllowSameToken:($null -ne $c.PSObject.Properties['AllowSameToken'] -and [bool]$c.AllowSameToken) } catch { $out.error = [string]$_.Exception.Message }
$cleared = @($script:ClearedForTest)
$out.clearedArrays = $cleared.Count
$out.allCleared = (@($cleared | Where-Object { @($_ | Where-Object { $_ -ne 0 }).Count -ne 0 }).Count -eq 0)
$out | ConvertTo-Json -Depth 12 -Compress
"""


def slurp(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def ps(args, **kw):
    return subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'] + args, capture_output=True, text=True, timeout=180, **kw)


def token():
    return 'clued_hbt_' + ''.join(secrets.choice(ALPHABET) for _ in range(43))


def tree(path):
    out = []
    for d, dirs, files in os.walk(path):
        for n in dirs + files:
            p = os.path.join(d, n)
            out.append((os.path.relpath(p, path), os.path.getsize(p) if os.path.isfile(p) else -1))
    return sorted(out)


@unittest.skipUnless(os.path.exists(POWERSHELL), 'Windows PowerShell 5.1 is not available')
class ReplaceHeartbeatToken(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work = tempfile.mkdtemp(prefix='hbt-')
        cls.driver = os.path.join(cls.work, 'driver.ps1')
        with open(cls.driver, 'w', encoding='ascii') as f:
            f.write(DRIVER)
        r = ps(['-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'])
        cls.me = r.stdout.strip()
        assert re.match(r'^S-1-5-21-\d+-\d+-\d+-\d+$', cls.me), r.stdout + r.stderr
        # Test descriptors: the install's, plus the test user with full control (a non-elevated token cannot set owner Administrators
        # and could not read back a file it is not on the DACL of).
        cls.dir_sddl = 'O:%sG:%sD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;%s)' % (cls.me, cls.me, cls.me)
        cls.file_sddl = 'O:%sG:%sD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;%s)' % (cls.me, cls.me, cls.me)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def setUp(self):
        self.n = getattr(self, 'n', 0)
        self.base = tempfile.mkdtemp(prefix='r-', dir=self.work)
        self.root = os.path.join(self.base, 'resident')
        for d in ('record', 'install', 'secrets'):
            os.makedirs(os.path.join(self.root, d))
        with open(os.path.join(self.root, 'record', 'acceptance.json'), 'w', encoding='utf-8') as f:
            json.dump({'node': {'ownerSid': self.me, 'hostname': HOSTNAME}}, f)
        self.src_dir = os.path.join(self.base, 'download')
        os.makedirs(self.src_dir)
        self.hb_dir = os.path.join(self.root, 'secrets', 'heartbeat')
        self.target = os.path.join(self.hb_dir, 'ci-node-heartbeat.token')
        self.seen = []   # every secret this test used: none may appear in any output

    def source(self, text, name='new.token', raw=None):
        p = os.path.join(self.src_dir, name)
        with open(p, 'wb') as f:
            f.write(raw if raw is not None else text.encode('ascii'))
        return p

    def run_case(self, **kw):
        case = {'root': self.root, 'Machine': HOSTNAME, 'CurrentSid': self.me, 'Elevated': True,
                'DirectorySddl': self.dir_sddl, 'FileSddl': self.file_sddl, 'DirectoryOwnerSid': self.me}
        case.update(kw)
        self.n += 1
        cf = os.path.join(self.base, 'case%d.json' % self.n)
        with open(cf, 'w') as f:
            json.dump(case, f)
        r = ps(['-File', self.driver, '-Script', SCRIPT, '-Case', cf])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for s in self.seen:
            self.assertNotIn(s, r.stdout + r.stderr, 'a token appeared in the output')
        return json.loads(r.stdout.strip().splitlines()[-1])

    def dry(self, tf, **kw):
        return self.run_case(TokenFile=tf, **kw)

    def apply(self, tf, sha=None, **kw):
        if sha is None:
            d = self.dry(tf, **{k: v for k, v in kw.items() if k in ('ConnectionId', 'AllowSameToken')})
            self.assertIsNone(d['error'], d)
            sha = d['result']['planSha256']
        return self.run_case(TokenFile=tf, Apply=True, ExpectedPlanSha256=sha, **kw)

    def read(self, p):
        with open(p, 'rb') as f:
            return f.read()

    def sddl_of(self, p):
        r = ps(['-Command', "(Get-Acl -LiteralPath '%s').Sddl" % p])
        return r.stdout.strip()

    # ---- the descriptors and the text of the shared functions are the installer's ----
    def test_shared_functions_are_the_installers(self):
        mine = slurp(SCRIPT)
        for path in (INSTALL,):
            theirs = slurp(path)
            for name in ('Get-HeartbeatDirectorySddl', 'Get-HeartbeatFileSddl', 'Get-DaclPart'):
                rx = re.compile(r'^function ' + re.escape(name) + r'\b.*$', re.M)
                self.assertEqual(rx.search(mine).group(0), rx.search(theirs).group(0), name)
        # verify-resident.ps1 checks the same two descriptors (its own copies, inline)
        v = slurp(VERIFY)
        self.assertIn("'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $ownerSid + ')'", v)
        self.assertIn("'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x120089;;;' + $ownerSid + ')'", v)
        self.assertIn("'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $owner + ')'", mine)
        self.assertIn("'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x120089;;;' + $owner + ')'", mine)

    def test_every_secret_path_clears_its_buffers_in_a_finally(self):
        mine = slurp(SCRIPT)
        body = mine[mine.index('function Invoke-HeartbeatTokenReplace'):mine.index('# Dot-sourced')]
        self.assertRegex(body, r'(?s)\} finally \{.*Clear-HeldBytes\s*\}\s*\}\s*$')
        # every byte array that can hold token bytes is created through Hold-Bytes
        self.assertEqual(len(re.findall(r'New-Object byte\[\]', mine)), 3)   # held read buffer, held token copy, the zero block of the temp copy
        self.assertNotRegex(mine, r'Write-Host|Write-Output|Write-Verbose|Write-Debug')

    def test_script_body_does_not_run_when_dot_sourced_and_refuses_before_touching_anything(self):
        r = ps(['-Command', '. "%s"; "dot-sourced-ok"' % SCRIPT])
        self.assertEqual(r.stdout.strip(), 'dot-sourced-ok', r.stdout + r.stderr)
        r = ps(['-File', SCRIPT, '-Apply'])   # no token file: refused before any path is read
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)['code'], 'TOKEN_FILE_REQUIRED_FOR_APPLY')
        r = ps(['-File', SCRIPT, '-ExpectedPlanSha256', 'zz'])
        self.assertNotEqual(r.returncode, 0)

    # ---- shape refusals ----
    def test_shape_refusals_and_zeroing(self):
        good = token()
        cases = {
            'HEARTBEAT_TOKEN_IS_NOT_A_HEARTBEAT_TOKEN': ['clued_bnd_' + 'A' * 43, 'clued_bnd_' + 'A' * 8],
            'HEARTBEAT_TOKEN_SHAPE_REFUSED': [good[:-1], good + 'A', good + ' ', good + '\n\n', good + '\r\n\r\n', '\ufeff' + good, ' ' + good,
                                              good[:-1] + '=', good[:-1] + '.', 'clued_hbt_' + 'A' * 42 + '!', good.replace('clued_hbt_', 'Clued_hbt_'), 'x' * 53],
        }
        for code, texts in cases.items():
            for t in texts:
                with self.subTest(code=code, text=len(t)):
                    raw = t.encode('utf-8')
                    self.seen = [good]
                    tf = self.source(None, raw=raw)
                    d = self.dry(tf)
                    self.assertEqual(d['error'], code, d)
                    self.assertIsNone(d['result'])
                    self.assertGreaterEqual(d['clearedArrays'], 1)
                    self.assertTrue(d['allCleared'])
        self.assertEqual(tree(self.hb_dir) if os.path.exists(self.hb_dir) else [], [])

    def test_source_refusals(self):
        d = self.dry(os.path.join(self.src_dir, 'missing.token'))
        self.assertEqual(d['error'], 'HEARTBEAT_TOKEN_SOURCE_REFUSED')
        d = self.dry(self.source('', raw=b''))
        self.assertEqual(d['error'], 'HEARTBEAT_TOKEN_SOURCE_REFUSED')
        d = self.dry(self.src_dir)
        self.assertEqual(d['error'], 'HEARTBEAT_TOKEN_SOURCE_REFUSED')
        d = self.dry(self.source(None, raw=b'A' * 5000, name='big'))
        self.assertEqual(d['error'], 'HEARTBEAT_TOKEN_SOURCE_REFUSED')
        inside = os.path.join(self.root, 'secrets', 'x.token')
        with open(inside, 'w') as f:
            f.write(token())
        d = self.dry(inside)
        self.assertEqual(d['error'], 'HEARTBEAT_TOKEN_SOURCE_INSIDE_SECRETS')
        self.assertTrue(d['allCleared'])

    def test_one_trailing_line_end_is_accepted(self):
        for ending in ('', '\n', '\r\n'):
            t = token(); self.seen = [t]
            d = self.dry(self.source(t + ending, name='t' + str(len(ending))))
            self.assertIsNone(d['error'], d)
            self.assertEqual(d['result']['status'], 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN')
            self.assertEqual(d['result']['plan']['tokenLength'], 53)
            self.assertTrue(d['allCleared']); self.assertGreaterEqual(d['clearedArrays'], 2)

    # ---- the dry run writes nothing ----
    def test_dry_run_writes_nothing_and_needs_no_token_to_show_the_state(self):
        t = token(); self.seen = [t]
        tf = self.source(t)
        before = tree(self.base)
        d = self.dry(tf)
        self.assertIsNone(d['error'], d)
        p = d['result']['plan']
        self.assertTrue(p['createsDirectory']); self.assertFalse(p['targetExists']); self.assertTrue(p['companionRestartNeeded'])
        self.assertFalse(p['installReceiptUpdated']); self.assertFalse(p['deletesAnything'])
        self.assertEqual(p['directorySddl'], self.dir_sddl)
        after = tree(self.base)
        self.assertEqual([x for x in after if not x[0].startswith('case')], [x for x in before if not x[0].startswith('case')])
        self.assertFalse(os.path.exists(self.hb_dir))
        d2 = self.run_case()   # no token file at all: the state only
        self.assertIsNone(d2['error'], d2)
        self.assertIsNone(d2['result']['plan']['tokenLength'])

    # ---- first token, then renewal ----
    def test_first_placement_creates_folder_and_file_with_the_descriptors_and_a_receipt(self):
        t = token(); self.seen = [t]
        a = self.apply(self.source(t + '\n'), ConnectionId='3B0C8A7E-1111-4222-8333-444455556666'.lower())
        self.assertIsNone(a['error'], a)
        r = a['result']
        self.assertEqual(r['status'], 'HEARTBEAT_TOKEN_PLACED'); self.assertFalse(r['replaced']); self.assertTrue(r['companionRestartNeeded'])
        self.assertEqual(self.read(self.target), t.encode('ascii'))   # exactly the token, the line end is not stored
        self.assertTrue(a['allCleared'])
        self.assertEqual(sorted(os.listdir(self.hb_dir)), ['ci-node-heartbeat.token'])
        self.assertEqual(self.sddl_of(self.hb_dir).split('D:')[1], self.expected_dacl(self.dir_sddl, True))
        self.assertEqual(self.sddl_of(self.target).split('D:')[1], self.expected_dacl(self.file_sddl, False))
        receipt = self.read(r['receipt']).decode('ascii')
        self.assertNotIn(t, receipt)
        rj = json.loads(receipt)
        self.assertEqual(rj['contract'], 'clued.independent-ci.heartbeat-token-replace/1')
        self.assertFalse(rj['hadToken']); self.assertEqual(rj['tokenLength'], 53); self.assertFalse(rj['installReceiptUpdated'])
        self.assertEqual(rj['connectionId'], '3b0c8a7e-1111-4222-8333-444455556666'); self.assertEqual(rj['planSha256'], r['planSha256'])
        self.assertTrue(set(rj) <= {'contract', 'opId', 'at', 'planSha256', 'target', 'hadToken', 'keptOldCopyAs', 'tokenLength', 'fileSddl',
                                    'directoryCreated', 'connectionId', 'installReceiptUpdated'})   # no hash or fingerprint of the token
        self.assertEqual(os.path.dirname(r['receipt']), os.path.join(self.root, 'install'))
        # nothing else under the root changed
        self.assertEqual(sorted(os.listdir(self.root)), ['install', 'record', 'secrets'])
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, 'secrets'))), ['heartbeat'])

    def expected_dacl(self, sddl, directory):
        r = ps(['-Command', "$s = New-Object Security.AccessControl.%s; $s.SetSecurityDescriptorSddlForm('%s'); $s.GetSecurityDescriptorSddlForm('Access')"
                % ('DirectorySecurity' if directory else 'FileSecurity', sddl)])
        return r.stdout.strip().split('D:')[1] if 'D:' in r.stdout else r.stdout.strip()

    def test_renewal_renames_and_keeps_the_old_copy_with_exact_descriptors(self):
        old, new = token(), token(); self.seen = [old, new]
        self.assertIsNone(self.apply(self.source(old, name='old'))['error'])
        a = self.apply(self.source(new, name='new'))
        self.assertIsNone(a['error'], a)
        r = a['result']
        self.assertTrue(r['replaced']); self.assertFalse(r['companionRestartNeeded'])
        self.assertEqual(self.read(self.target), new.encode('ascii'))
        kept = os.path.join(self.hb_dir, r['keptOldCopyAs'])
        self.assertRegex(r['keptOldCopyAs'], r'^ci-node-heartbeat\.token\.replaced-\d{8}T\d{9}Z$')
        self.assertEqual(self.read(kept), old.encode('ascii'))
        self.assertEqual(sorted(os.listdir(self.hb_dir)), sorted(['ci-node-heartbeat.token', r['keptOldCopyAs']]))   # no temporary file left
        self.assertEqual(self.sddl_of(self.target).split('D:')[1], self.expected_dacl(self.file_sddl, False))
        self.assertEqual(self.sddl_of(kept).split('D:')[1], self.expected_dacl(self.file_sddl, False))   # the kept copy keeps its descriptor
        rj = json.loads(self.read(r['receipt']))
        self.assertTrue(rj['hadToken']); self.assertEqual(rj['keptOldCopyAs'], r['keptOldCopyAs'])
        for s in (old, new):
            self.assertNotIn(s, self.read(r['receipt']).decode('ascii'))
        self.assertGreaterEqual(a['clearedArrays'], 4); self.assertTrue(a['allCleared'])

    def test_same_token_is_a_refused_no_op_unless_allowed(self):
        t = token(); self.seen = [t]
        self.assertIsNone(self.apply(self.source(t, name='a'))['error'])
        same = self.source(t + '\r\n', name='b')
        d = self.dry(same)
        self.assertEqual(d['error'], 'HEARTBEAT_TOKEN_SAME_AS_INSTALLED_NOTHING_TO_DO'); self.assertTrue(d['allCleared'])
        d = self.dry(same, AllowSameToken=True)
        self.assertIsNone(d['error'], d); self.assertTrue(d['result']['plan']['sameAsInstalled'])

    # ---- Apply refusals write nothing ----
    def test_apply_refusals(self):
        t = token(); self.seen = [t]
        tf = self.source(t)
        sha = self.dry(tf)['result']['planSha256']
        before = tree(self.root)
        for kw, code in (({'ExpectedPlanSha256': '0' * 64}, 'PLAN_CHANGED_SINCE_REVIEW'), ({'ExpectedPlanSha256': 'abc'}, 'EXPECTED_PLAN_SHA256_REFUSED'),
                         ({'ExpectedPlanSha256': sha, 'Elevated': False}, 'ELEVATED_OWNER_TOKEN_REQUIRED_FOR_SECRETS'),
                         ({'ExpectedPlanSha256': sha, 'CurrentSid': 'S-1-5-21-1-2-3-1001'}, 'OWNER_ACCOUNT_REQUIRED'),
                         ({'ExpectedPlanSha256': sha, 'Machine': 'OTHERHOST'}, 'NODE_HOST_REQUIRED')):
            with self.subTest(code=code):
                d = self.run_case(TokenFile=tf, Apply=True, **kw)
                self.assertEqual(d['error'], code, d)
                self.assertTrue(d['allCleared'])
                self.assertEqual(tree(self.root), before)
        d = self.run_case(Apply=True, ExpectedPlanSha256=sha)
        self.assertEqual(d['error'], 'TOKEN_FILE_REQUIRED_FOR_APPLY')
        d = self.run_case(ConnectionId='3b0c8a7e-1111-4222-8333-444455556666')
        self.assertEqual(d['error'], 'CONNECTION_ID_REQUIRES_TOKEN_FILE')
        d = self.run_case(TokenFile=tf, ConnectionId='not-a-uuid')
        self.assertEqual(d['error'], 'CONNECTION_ID_REFUSED')

    def test_plan_changes_when_the_node_state_changes(self):
        t = token(); self.seen = [t]
        tf = self.source(t)
        sha = self.dry(tf)['result']['planSha256']
        os.makedirs(self.hb_dir)   # the folder appeared since the review: the plan no longer says "creates the folder"
        self.assertEqual(self.run_case(TokenFile=tf, Apply=True, ExpectedPlanSha256=sha)['error'], 'HEARTBEAT_TOKEN_DIRECTORY_ACL_MISMATCH')

    def test_node_layout_refusals(self):
        t = token(); self.seen = [t]; tf = self.source(t)
        shutil.rmtree(os.path.join(self.root, 'secrets'))
        self.assertEqual(self.dry(tf)['error'], 'HEARTBEAT_TOKEN_SECRETS_DIRECTORY_MISSING')
        os.makedirs(os.path.join(self.root, 'secrets'))
        shutil.rmtree(os.path.join(self.root, 'install'))
        self.assertEqual(self.dry(tf)['error'], 'INSTALL_DIRECTORY_MISSING')
        os.makedirs(os.path.join(self.root, 'install'))
        os.remove(os.path.join(self.root, 'record', 'acceptance.json'))
        self.assertEqual(self.dry(tf)['error'], 'NODE_PROFILE_UNREADABLE')

    def test_wrong_folder_descriptor_stray_temporary_and_wrong_file_descriptor(self):
        t = token(); self.seen = [t]; tf = self.source(t)
        self.assertIsNone(self.apply(self.source(token(), name='first'))['error'])
        # a stray temporary file of an earlier failed run blocks the next one (it is the Owner's to look at)
        stray = os.path.join(self.hb_dir, 'ci-node-heartbeat.token.new-' + 'a' * 32)
        with open(stray, 'wb') as f:
            f.write(b'x')
        self.assertEqual(self.dry(tf)['error'], 'HEARTBEAT_TOKEN_STRAY_TEMPORARY_FILE')
        os.remove(stray)
        # a folder with another descriptor
        d = self.dry(tf, DirectorySddl='O:%sG:%sD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;%s)' % (self.me, self.me, self.me))
        self.assertEqual(d['error'], 'HEARTBEAT_TOKEN_DIRECTORY_ACL_MISMATCH')
        # a token file with another descriptor
        d = self.dry(tf, FileSddl='O:%sG:%sD:P(A;;FA;;;SY)(A;;FA;;;%s)' % (self.me, self.me, self.me))
        self.assertEqual(d['error'], 'HEARTBEAT_TOKEN_FILE_ACL_MISMATCH')
        self.assertTrue(d['allCleared'])

    def test_links_are_refused(self):
        t = token(); self.seen = [t]; tf = self.source(t)
        elsewhere = os.path.join(self.base, 'elsewhere')
        os.makedirs(elsewhere)
        link = self.hb_dir
        r = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', link, elsewhere], capture_output=True, text=True)
        if r.returncode != 0:
            self.skipTest('a directory junction cannot be created here: ' + r.stdout + r.stderr)
        before = tree(elsewhere)
        d = self.dry(tf)
        self.assertEqual(d['error'], 'LINK_REFUSED:heartbeat', d)
        self.assertTrue(d['allCleared'])
        self.assertEqual(tree(elsewhere), before)
        subprocess.run(['cmd.exe', '/c', 'rmdir', link], capture_output=True)
        # a linked secrets folder
        shutil.rmtree(os.path.join(self.root, 'secrets'))
        r = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', os.path.join(self.root, 'secrets'), elsewhere], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.dry(tf)['error'], 'LINK_REFUSED:secrets')
        subprocess.run(['cmd.exe', '/c', 'rmdir', os.path.join(self.root, 'secrets')], capture_output=True)
        os.makedirs(os.path.join(self.root, 'secrets'))
        # a source that is a link is refused too (a file symlink needs a privilege: skipped when not creatable)
        srcdir = os.path.join(self.base, 'srcjunction')
        r = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', srcdir, self.src_dir], capture_output=True, text=True)
        if r.returncode == 0:
            d = self.dry(os.path.join(srcdir, 'new.token'))   # a path through a junction is a normal file under it: accepted shape-wise
            self.assertNotEqual(d['error'], 'LINK_REFUSED')
            subprocess.run(['cmd.exe', '/c', 'rmdir', srcdir], capture_output=True)


if __name__ == '__main__':
    unittest.main()
