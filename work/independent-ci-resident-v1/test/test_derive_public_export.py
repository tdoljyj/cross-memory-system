"""tools/derive-public-export.py: the public six-role export generator (formal form of make_export236/237/238.py).

Synthetic fixtures in temp directories only; the tool runs as a subprocess (python -I -B), as an operator would."""
import base64, hashlib, json, os, re, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent / 'tools' / 'derive-public-export.py'
H = lambda s: hashlib.sha256(s.encode()).hexdigest()
sha = lambda b: hashlib.sha256(b).hexdigest()
ROLES = ('contract-placement', 'gitleaks', 'trivy')
OLD_DEADLINE = '2026-11-04T16:00:00Z'
NEW_DEADLINE = '2026-11-04T20:00:00Z'
OBSERVED = '2026-11-04T09:22:18.020Z'


def old_pins():
    p = {'package': H('pkg-old'), 'source': H('src-old'), 'sourceCommit': H('c-old')[:40], 'linuxManifest': H('lm-old'), 'files': {}}
    for r in ROLES:
        p['files'][f'{r}.json'] = H(r + '-pol-old')
        p['files'][f'{r}.qualification.json'] = H(r + '-qual-old')
    return p


def new_pins(same_linux=False):
    return {'package': H('pkg-new'), 'source': H('src-new'), 'sourceCommit': H('c-new')[:40],
            'linuxManifest': H('lm-old') if same_linux else H('lm-new'),
            'files': {k: H(k + '-new') for k in old_pins()['files']}}


def make_old_export(d, deadline=OLD_DEADLINE, literal='2026,11,4,16,0', gen_eq=3, extra_body='', extra_py='', pins=None, label='237'):
    """A tiny reviewed export: python, BODY, START with an encoded loader; pins, labels, generation, deadline, hash chain."""
    d.mkdir(parents=True)
    p = pins or old_pins()
    allpins = [p['package'], p['source'], p['sourceCommit'], p['linuxManifest']] + list(p['files'].values())
    py = ('import datetime\nEXPECTED_GENERATION=5\n'
          f'DEADLINE=datetime.datetime({literal},tzinfo=datetime.timezone.utc)\n'
          + ''.join(f'PIN{i}="{x}"\n' for i, x in enumerate(allpins))
          + f"OUT=r'C:\\w\\relay-qual-169\\package-inputs{label}\\public-six{label}'\n" + extra_py).encode()
    (d / f'copy-desk-six-public{label}.py').write_bytes(py)
    body = (f'# DESK_PUBLIC_SIX{label}_BODY\n' + ''.join(f'$g{i} = "generation-eq 5"\n' for i in range(gen_eq))
            + f'$until = "{deadline}"\n$py = "{sha(py)}"\n' + ''.join(f'$p{i}="{x}"\n' for i, x in enumerate(allpins))
            + f'$py = "copy-desk-six-public{label}.py"\n' + extra_body).encode()
    (d / f'DESK_PUBLIC_SIX{label}_BODY.ps1').write_bytes(body)
    loader = f'$body = "{sha(body)}"\n$pkg = "{p["package"]}"\n# export{label}\n'
    start = (f'# DESK_PUBLIC_SIX{label}_START\n$until = "{deadline}"\n$body = "{sha(body)}"\n'
             f"powershell -NoProfile '-EncodedCommand','{base64.b64encode(loader.encode('utf-16-le')).decode()}'\n").encode()
    (d / f'DESK_PUBLIC_SIX{label}_START.ps1').write_bytes(start)
    expected = {'package': p['package'], 'source': p['source'], 'generation': 5, 'linuxManifest': p['linuxManifest'], 'sourceCommit': p['sourceCommit'],
                'deadline': deadline, 'factsObservedAt': '2026-11-04T01:00:00Z', 'files': p['files'], 'derivedFrom': 'public-export236'}
    (d / f'expected-public{label}.json').write_text(json.dumps(expected, indent=2) + '\n', encoding='utf8')


def make_facts(root, new=None, generation=6, current_generation=None, observed=OBSERVED, staged=None, pins_ok=True):
    n = new or new_pins()
    facts = {'generation': generation, 'staged': staged, 'pinsOk': pins_ok, 'ciSourceManifestSha256': n['source'], 'sourceCommit': n['sourceCommit'],
             'manifestSha256': n['linuxManifest'], 'observedAt': observed,
             'roles': {r: {'policySha256': n['files'][f'{r}.json'], 'qualificationSha256': n['files'][f'{r}.qualification.json']} for r in ROLES}}
    current = {'generation': generation if current_generation is None else current_generation, 'packageManifestSha256': n['package'], 'ciSourceManifestSha256': n['source']}
    (root / 'version-facts.json').write_text(json.dumps(facts), encoding='utf-8-sig')
    (root / 'current.json').write_text(json.dumps(current), encoding='utf-8')


class DeriveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='derive-export-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.old = self.tmp / 'in' / 'public-export237'
        self.new = self.tmp / 'out' / 'public-export238'
        self.six = self.tmp / 'out' / 'public-six238'
        (self.tmp / 'out').mkdir()

    def run_tool(self, deadline=NEW_DEADLINE, extra=()):
        argv = [sys.executable, '-I', '-B', str(TOOL), '--old-dir', str(self.old), '--new-dir', str(self.new), '--old-label', '237', '--new-label', '238',
                '--facts', str(self.tmp / 'version-facts.json'), '--current', str(self.tmp / 'current.json'), '--deadline-new', deadline, *extra]
        return subprocess.run(argv, capture_output=True, text=True, encoding='utf-8')

    def assertRefused(self, r, code):
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn('REFUSED ' + code, r.stderr)
        self.assertNotIn('Traceback', r.stderr)

    def assertNoResidue(self):
        self.assertFalse(self.new.exists())
        self.assertFalse(self.six.exists())
        self.assertEqual([p.name for p in (self.tmp / 'out').iterdir()], [])

    def read(self, name):
        return (self.new / name).read_bytes().decode('utf8')

    # ---- happy path

    def test_happy_path_and_hash_chain(self):
        make_old_export(self.old)
        make_facts(self.tmp)
        r = self.run_tool()
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        n, o = new_pins(), old_pins()
        py, body, start = self.read('copy-desk-six-public238.py'), self.read('DESK_PUBLIC_SIX238_BODY.ps1'), self.read('DESK_PUBLIC_SIX238_START.ps1')
        pyb, bodyb = py.encode(), body.encode()
        self.assertIn('EXPECTED_GENERATION=6', py)
        self.assertEqual(len(re.findall(r'generation-eq 6\b', body)), 3)
        self.assertNotIn('generation-eq 5', body)
        self.assertIn('DEADLINE=datetime.datetime(2026,11,4,20,0,tzinfo=datetime.timezone.utc)', py)
        self.assertIn(NEW_DEADLINE, body)
        self.assertIn(NEW_DEADLINE, start)
        loader = base64.b64decode(re.search(r"'-EncodedCommand','([A-Za-z0-9+/=]+)'", start).group(1)).decode('utf-16-le')
        # the chain: python -> BODY -> START and its loader
        self.assertIn(sha(pyb), body)
        self.assertIn(sha(bodyb), start)
        self.assertIn(sha(bodyb), loader)
        self.assertTrue(out['loader_has_body_hash'] and out['start_has_body_hash'])
        self.assertEqual((out['python'], out['body']), (sha(pyb), sha(bodyb)))
        for txt in (py, body, start, loader):
            self.assertNotIn('237', txt)
            self.assertNotIn(OLD_DEADLINE, txt)
            for v in [o['package'], o['source'], o['sourceCommit'], o['linuxManifest'], *o['files'].values()]:
                self.assertNotIn(v, txt)
        self.assertIn(n['package'], py)
        self.assertIn(n['package'], loader)
        self.assertIn('package-inputs238', py)
        exp = json.loads(self.read('expected-public238.json'))
        self.assertEqual((exp['generation'], exp['deadline'], exp['derivedFrom']), (6, NEW_DEADLINE, 'public-export237'))
        self.assertEqual((exp['pythonSha256'], exp['bodySha256']), (sha(pyb), sha(bodyb)))
        self.assertEqual(exp['files'], n['files'])
        self.assertTrue(self.six.is_dir() and not list(self.six.iterdir()))
        self.assertEqual(sorted(p.name for p in (self.tmp / 'out').iterdir()), ['public-export238', 'public-six238'])
        # the old export is read-only to the tool
        self.assertIn('EXPECTED_GENERATION=5', (self.old / 'copy-desk-six-public237.py').read_text())

    def test_dry_run_writes_nothing(self):
        make_old_export(self.old)
        make_facts(self.tmp)
        r = self.run_tool(extra=('--dry-run',))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(json.loads(r.stdout)['dryRun'])
        self.assertNoResidue()

    # ---- the deadline literal

    def test_deadline_literal_variants(self):
        cases = [('2026-11-04T16:00:00Z', '2026,11,4,16,0', '2026-11-04T20:00:00Z', '2026,11,4,20,0'),
                 ('2026-11-04T16:00:30Z', '2026,11,4,16,0,30', '2026-11-04T20:00:00Z', '2026,11,4,20,0'),
                 ('2026-11-04T16:05:00Z', '2026,11,4,16,5', '2026-11-04T20:30:15Z', '2026,11,4,20,30,15'),
                 ('2026-11-04T16:00:00Z', '2026,11,4,16,0,0', '2026-11-04T20:00:00Z', '2026,11,4,20,0')]
        for old_dl, old_lit, new_dl, new_lit in cases:
            with self.subTest(old=old_lit, new=new_lit):
                shutil.rmtree(self.tmp / 'in', True)
                shutil.rmtree(self.tmp / 'out', True)
                (self.tmp / 'out').mkdir()
                make_old_export(self.old, deadline=old_dl, literal=old_lit)
                make_facts(self.tmp)
                r = self.run_tool(deadline=new_dl)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn(f'DEADLINE=datetime.datetime({new_lit},tzinfo=datetime.timezone.utc)', self.read('copy-desk-six-public238.py'))

    def test_literal_for_another_deadline_is_refused(self):
        make_old_export(self.old, literal='2026,11,4,12,0')   # the body/start say 16:00; the literal does not
        make_facts(self.tmp)
        self.assertRefused(self.run_tool(), 'DEADLINE_LITERAL_NOT_OLD')
        self.assertNoResidue()

    def test_missing_or_double_literal_is_refused(self):
        make_old_export(self.old, extra_py='DEADLINE=datetime.datetime(2026,11,4,16,0,tzinfo=datetime.timezone.utc)\n')
        make_facts(self.tmp)
        self.assertRefused(self.run_tool(), 'DEADLINE_LITERAL_COUNT')
        self.assertNoResidue()

    def test_old_deadline_left_behind_is_detected(self):
        # a second, differently spaced literal in the body: not the pattern, still the old deadline
        make_old_export(self.old, extra_body='$d = [datetime]::new(2026, 11, 4, 16, 0, 0)\n')
        make_facts(self.tmp)
        self.assertRefused(self.run_tool(), 'OLD_DEADLINE_LEFT')
        self.assertNoResidue()

    # ---- pins

    def test_unchanged_pin_is_not_an_old_pin_left(self):
        make_old_export(self.old)
        make_facts(self.tmp, new=new_pins(same_linux=True))
        r = self.run_tool()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(old_pins()['linuxManifest'], self.read('copy-desk-six-public238.py'))
        self.assertEqual(json.loads(self.read('expected-public238.json'))['linuxManifest'], old_pins()['linuxManifest'])

    def test_unchanged_role_hash_and_equal_old_values_with_same_new(self):
        p = old_pins()
        p['files']['trivy.json'] = p['files']['gitleaks.json']       # two entries share one old value ...
        n = new_pins()
        n['files']['trivy.json'] = n['files']['gitleaks.json']       # ... and one new value: fine
        make_old_export(self.old, pins=p)
        make_facts(self.tmp, new=n)
        self.assertEqual(self.run_tool().returncode, 0)

    def test_ambiguous_pin_is_refused(self):
        p = old_pins()
        p['files']['trivy.json'] = p['files']['gitleaks.json']       # equal old values, different new ones
        make_old_export(self.old, pins=p)
        make_facts(self.tmp)
        self.assertRefused(self.run_tool(), 'AMBIGUOUS_PIN')
        self.assertNoResidue()

    def test_unexpected_label_context_is_refused(self):
        make_old_export(self.old, extra_py='note = "build-237-x"\n')
        make_facts(self.tmp)
        self.assertRefused(self.run_tool(), 'UNEXPECTED_LABEL_CONTEXT')
        self.assertNoResidue()

    # ---- no residue that blocks the next run

    def test_failure_then_immediate_rerun(self):
        make_old_export(self.old, gen_eq=2)                          # fails in the body, after the python file was staged
        make_facts(self.tmp)
        self.assertRefused(self.run_tool(), 'GENERATION_MARKER_COUNT')
        self.assertNoResidue()
        shutil.rmtree(self.tmp / 'in')
        make_old_export(self.old, gen_eq=3)
        r = self.run_tool()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(p.name for p in (self.tmp / 'out').iterdir()), ['public-export238', 'public-six238'])

    def test_existing_target_is_refused_and_untouched(self):
        make_old_export(self.old)
        make_facts(self.tmp)
        self.new.mkdir()
        (self.new / 'marker.txt').write_text('keep')
        self.assertRefused(self.run_tool(), 'EXPORT_DIR_EXISTS')
        self.assertEqual([p.name for p in self.new.iterdir()], ['marker.txt'])
        self.assertEqual((self.new / 'marker.txt').read_text(), 'keep')
        shutil.rmtree(self.new)
        self.six.mkdir()
        (self.six / 'marker.txt').write_text('keep')
        self.assertRefused(self.run_tool(), 'EXPORT_DIR_EXISTS')
        self.assertEqual((self.six / 'marker.txt').read_text(), 'keep')
        self.assertFalse(self.new.exists())
        self.assertEqual(sorted(p.name for p in (self.tmp / 'out').iterdir()), ['public-six238'])

    # ---- facts and deadline sanity

    def test_generation_mismatch_is_refused(self):
        make_old_export(self.old)
        make_facts(self.tmp, generation=6, current_generation=7)
        self.assertRefused(self.run_tool(), 'GENERATION_MISMATCH')
        self.assertNoResidue()

    def test_generation_not_newer_is_refused(self):
        make_old_export(self.old)
        make_facts(self.tmp, generation=5)
        self.assertRefused(self.run_tool(), 'GENERATION_NOT_NEWER')

    def test_staged_or_pins_not_ok_is_refused(self):
        make_old_export(self.old)
        make_facts(self.tmp, staged={'x': 1})
        self.assertRefused(self.run_tool(), 'FACTS_STAGED')
        make_facts(self.tmp, pins_ok=False)
        self.assertRefused(self.run_tool(), 'FACTS_PINS_NOT_OK')

    def test_deadline_sanity(self):
        make_old_export(self.old)
        make_facts(self.tmp)
        self.assertRefused(self.run_tool(deadline='2026-11-04T09:00:00Z'), 'DEADLINE_NOT_AFTER_FACTS')   # before observedAt
        self.assertRefused(self.run_tool(deadline=OLD_DEADLINE), 'DEADLINE_UNCHANGED')
        self.assertRefused(self.run_tool(deadline='2026-11-04T20:00:00+08:00'), 'DEADLINE_FORMAT')
        self.assertRefused(self.run_tool(deadline='2026-11-04 20:00:00'), 'DEADLINE_FORMAT')
        self.assertNoResidue()


if __name__ == '__main__':
    unittest.main()
