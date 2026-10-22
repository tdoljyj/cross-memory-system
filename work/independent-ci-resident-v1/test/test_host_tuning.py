"""Offline tests for linux/host-tuning/clued-wsl-host-tuning (run on any OS; the symlink case needs Linux):
python -I -m unittest discover -s test -p "test_*.py" (from work/independent-ci-resident-v1)."""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
TUNING = HERE.parent / 'linux' / 'host-tuning'
TOOL = TUNING / 'clued-wsl-host-tuning'
loader = importlib.machinery.SourceFileLoader('wsl_host_tuning', str(TOOL))
spec = importlib.util.spec_from_loader('wsl_host_tuning', loader)
tool = importlib.util.module_from_spec(spec)
loader.exec_module(tool)

CONF = (TUNING / '60-clued-ci-hvsock-memory.conf').read_bytes()
TARGET_NAME = '60-clued-ci-hvsock-memory.conf'
DEFAULTS = {'net.core.rmem_default': 212992, 'net.core.wmem_default': 212992, 'vm.watermark_scale_factor': 10, 'vm.watermark_boost_factor': 15000}
TOOL_SHA = 'a' * 64
KERNEL = '6.18.33.2-microsoft-standard-WSL2'
OLD_DEV = '28b4324c-0000-4000-8000-000000000001'
NEW_DEV = '28b4324c-0000-4000-8000-000000000002'


def conf(**over):
    values = {'net.core.rmem_default': 65536, 'net.core.wmem_default': 65536, 'vm.watermark_scale_factor': 200, 'vm.watermark_boost_factor': 3500, **over}
    return ''.join(f'{k} = {v}\n' for k, v in values.items()).encode('ascii')


class ConfAndRing(unittest.TestCase):
    def test_shipped_conf_cuts_the_ring_to_order_5(self):
        values = tool.parse_conf(CONF)
        self.assertEqual(values, {'net.core.rmem_default': 65536, 'net.core.wmem_default': 65536, 'vm.watermark_scale_factor': 200, 'vm.watermark_boost_factor': 3500})
        self.assertEqual(tool.ring_order(values['net.core.rmem_default'], values['net.core.wmem_default']), 5)

    def test_ring_sizes_match_what_turing_showed(self):
        # 2026-10-22: every live host-initiated hv_sock channel had a 208896-byte send ring with the 212992
        # defaults, and the failed allocations were order 7.
        self.assertEqual(tool.ring_bytes(212992) - tool.PAGE, 208896)
        self.assertEqual(tool.ring_order(212992, 212992), 7)
        self.assertEqual(tool.ring_order(131072, 131072), 6)
        self.assertEqual(tool.ring_bytes(65536) - tool.PAGE, 61440)
        self.assertEqual(tool.ring_order(32768, 32768), 4)
        self.assertEqual(tool.ring_bytes(1), 6 * tool.PAGE, 'hv_sock never goes below 6 pages')
        self.assertEqual(tool.ring_order(1, 1), 4, 'so the ring is always a costly order (> 3)')
        self.assertEqual(tool.ring_bytes(4 << 20), 64 * tool.PAGE, 'nor above 64 pages')
        self.assertEqual(tool.ring_order(4 << 20, 4 << 20), 7)

    def test_conf_is_exact(self):
        bad = [
            b'',
            conf().replace(b'vm.watermark_boost_factor = 3500\n', b''),                     # a key missing
            conf() + b'vm.watermark_scale_factor = 200\n',                                 # duplicated
            conf() + b'vm.min_free_kbytes = 131072\n',                                     # not reviewed
            conf().replace(b'net.core.rmem_default', b'-net.core.rmem_default'),           # ignore-errors prefix
            conf(**{'vm.watermark_scale_factor': 5}),                                      # below bounds
            conf(**{'vm.watermark_boost_factor': 20000}),                                  # above bounds
            conf(**{'net.core.wmem_default': 300000}),                                     # above 64 pages
            conf(**{'net.core.rmem_default': 20480}),                                      # below 6 pages
            conf(**{'net.core.rmem_default': 65537}),                                      # not page aligned
            conf() + '# é\n'.encode('utf-8'),                                              # not ascii
            conf() + b'#' * 5000,                                                          # too large
        ]
        for raw in bad:
            with self.assertRaises(tool.Refused, msg=raw[:80]):
                tool.parse_conf(raw)
        self.assertEqual(tool.parse_conf(b'# c\n\n' + conf())['vm.watermark_boost_factor'], 3500)

    def test_busy_units_buddyinfo_zoneinfo(self):
        listing = '\n'.join([
            'clued-ci-worker@' + 'e' * 64 + '.service loaded failed failed Clued job',
            'clued-ci-wsprep@0123456789abcdef-0123456789ab.service loaded activating start Clued prep',
            'clued-ci-archive@0123456789abcdef-0123456789ab_x.service loaded inactive dead Clued archive',
            'docker.service loaded active running Docker',
        ])
        self.assertEqual(tool.busy_units(listing), ['clued-ci-wsprep@0123456789abcdef-0123456789ab.service'])
        snap = ('Node 0, zone    DMA32   2769   2985   2892   2611   2299   1834   1308    773    388    265    427\n'
                'Node 0, zone   Normal    300   1063    795    356    271    170     90     49      5     44    151\n')
        self.assertEqual(tool.buddy_summary(snap), {'0:DMA32': {'order5plus': 1834 + 1308 + 773 + 388 + 265 + 427, 'order7plus': 773 + 388 + 265 + 427},
                                                    '0:Normal': {'order5plus': 170 + 90 + 49 + 5 + 44 + 151, 'order7plus': 49 + 5 + 44 + 151}})
        zoneinfo = ('Node 0, zone    DMA32\n  per-node stats\n      nr_free_pages 1\n  pages free     113117\n        boost    5120\n'
                    '        min      7424\n        low      9280\n        high     11136\n        spanned  1015808\n'
                    'Node 0, zone  Movable\n  pages free     0\n        boost    0\n        min      32\n        low      32\n        high     32\n')
        self.assertEqual(tool.zone_summary(zoneinfo)['DMA32'], {'free': 113117, 'boost': 5120, 'min': 7424, 'low': 9280, 'high': 11136})

    def test_boot_overrides(self):
        files = {
            '05-early.conf': '-vm.watermark_boost_factor\n',                # earlier bare '-key': replaced by the drop-in
            '10-network-security.conf': 'vm.watermark_scale_factor = 10\n',   # earlier: the drop-in wins
            TARGET_NAME: CONF.decode('ascii'),
            '60-clued-runner.conf': 'kernel.yama.ptrace_scope = 1\n',       # later, other key
            '70-x.conf': 'vm.watermark_*=5\n',                              # later glob: an explicit key still wins
            '80-late.conf': '-vm.watermark_boost_factor\n-vm.watermark_*\n',  # later exact bare '-key' unsets it; a negated glob does not
            '99-sysctl.conf': '# comment\n;x\n-net/core/rmem_default = 1\n',  # later, slash form and '-' prefix
        }
        self.assertEqual(tool.boot_overrides(files, TARGET_NAME), ['80-late.conf:-vm.watermark_boost_factor', '99-sysctl.conf:net.core.rmem_default'])
        self.assertEqual(tool.boot_overrides({TARGET_NAME: '', '60-clued-runner.conf': 'kernel.yama.ptrace_scope = 1\n'}, TARGET_NAME), [])

    def test_ring_verdict_counts_only_new_devices(self):
        before = {OLD_DEV}
        self.assertEqual(tool.ring_verdict({OLD_DEV: 208896}, before, 61440, 208896), (None, {}), 'nothing opened since apply')
        self.assertEqual(tool.ring_verdict({OLD_DEV: 208896, NEW_DEV: 61440}, before, 61440, 208896)[0], True)
        self.assertEqual(tool.ring_verdict({OLD_DEV: 61440, NEW_DEV: 208896}, before, 61440, 208896)[0], False, 'the relay sets its own buffers')
        third = NEW_DEV[:-1] + '3'
        self.assertIs(tool.ring_verdict({NEW_DEV: 61440, third: 208896}, before, 61440, 208896)[0], True,
                      'after a restart, listeners WSL made before systemd-sysctl keep the old size next to the new ones')
        self.assertIsNone(tool.ring_verdict({NEW_DEV: 24576}, before, 61440, 208896)[0], 'explicitly sized guest channels say neither')


class Host(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        r = pathlib.Path(self.tmp.name)
        self.p = {'proc_sys': str(r / 'proc'), 'target': str(r / 'etc' / TARGET_NAME), 'state': str(r / 'state'),
                  'hv_sock': str(r / 'hv_sock'), 'buddyinfo': str(r / 'buddyinfo'), 'zoneinfo': str(r / 'zoneinfo'),
                  'sysctl_dirs': (str(r / 'etc'), str(r / 'usr-lib'))}
        (r / 'etc').mkdir()
        (r / 'usr-lib').mkdir()
        (r / 'etc' / '60-clued-runner.conf').write_text('kernel.yama.ptrace_scope = 1\n')
        for k, v in DEFAULTS.items():
            f = pathlib.Path(tool.proc_path(self.p['proc_sys'], k))
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(f'{v}\n')
        self.device(OLD_DEV, 208896)

    def tearDown(self):
        self.tmp.cleanup()

    def plan(self, raw=CONF):
        text, _, _, _ = tool.plan_tuning(self.p, raw, TOOL_SHA, KERNEL)
        return tool.plan_sha(text)

    def device(self, dev, ring_bytes, queued=0):
        d = pathlib.Path(self.p['hv_sock']) / dev
        d.mkdir(parents=True)
        (d / 'out_read_bytes_avail').write_text(f'{queued}\n')
        (d / 'out_write_bytes_avail').write_text(f'{ring_bytes - queued}\n')

    def test_apply_verify_rollback(self):
        want = self.plan()
        with self.assertRaises(tool.Refused) as e:
            tool.apply_tuning(self.p, CONF, '0' * 64, TOOL_SHA, KERNEL, [], 's1')
        self.assertEqual(e.exception.code, 'PLAN_CHANGED_SINCE_REVIEW')
        with self.assertRaises(tool.Refused) as e:
            tool.apply_tuning(self.p, CONF, want, TOOL_SHA, KERNEL, ['clued-ci-worker@x.service'], 's1')
        self.assertEqual(e.exception.code, 'CI_UNIT_ACTIVE')
        self.assertFalse(os.path.exists(self.p['target']), 'a refusal writes nothing')
        self.assertFalse(os.path.exists(self.p['state']))

        r = tool.apply_tuning(self.p, CONF, want, TOOL_SHA, KERNEL, [], 's1')
        self.assertEqual(r['status'], 'HOST_TUNING_APPLIED')
        self.assertEqual(r['previous'], DEFAULTS)
        self.assertEqual(pathlib.Path(self.p['target']).read_bytes(), CONF)
        self.assertEqual(tool.read_live(self.p['proc_sys']), tool.parse_conf(CONF))
        saved = json.loads(pathlib.Path(r['saved']).read_text())
        self.assertEqual((saved['values'], saved['dropInBefore'], saved['devicesBefore']), (DEFAULTS, 'absent', [OLD_DEV]))
        self.assertEqual(sorted(os.listdir(os.path.dirname(self.p['target']))), ['60-clued-ci-hvsock-memory.conf', '60-clued-runner.conf'], 'no temporary name left')

        again = tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's2')
        self.assertEqual(again['status'], 'HOST_TUNING_ALREADY_APPLIED')
        self.assertEqual(len(tool.saved_files(self.p['state'])), 1, 'no second saved file that would make rollback a no-op')

        result, ok = tool.verify_tuning(self.p, CONF, r['saved'])
        self.assertTrue(ok)
        self.assertIsNone(result['ringEffective'], 'no device opened since apply: no claim either way')
        self.device(NEW_DEV, 61440, queued=4096)  # queued bytes do not change the ring size read
        result, _ = tool.verify_tuning(self.p, CONF, r['saved'])
        self.assertEqual((result['ringEffective'], result['ringOrderForNewChannels'], result['newDeviceRingBytes']), (True, 5, {'61440': 1}))

        back = tool.rollback_tuning(self.p, r['saved'], 's3')
        self.assertEqual(back['now'], DEFAULTS)
        self.assertFalse(os.path.exists(self.p['target']))
        self.assertEqual(pathlib.Path(back['dropInMovedTo']).read_bytes(), CONF, 'moved aside, not deleted')
        self.assertEqual(tool.saved_files(self.p['state']), [], 'the used saved file is retired')
        self.assertTrue(os.path.exists(back['savedRetiredAs']))
        result, ok = tool.verify_tuning(self.p, CONF)
        self.assertEqual((ok, result['ringEffective']), (False, None))

    def test_a_ring_that_did_not_shrink_is_reported(self):
        r = tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's1')
        self.device(NEW_DEV, 208896)
        self.assertIs(tool.verify_tuning(self.p, CONF, r['saved'])[0]['ringEffective'], False)

    def test_a_different_drop_in_is_never_replaced(self):
        pathlib.Path(self.p['target']).write_bytes(conf(**{'vm.watermark_scale_factor': 100}))
        with self.assertRaises(tool.Refused) as e:
            tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's1')
        self.assertEqual(e.exception.code, 'DROP_IN_DIFFERS_OWNER_DECIDES')
        self.assertEqual(tool.read_live(self.p['proc_sys']), DEFAULTS)
        self.assertFalse(os.path.exists(self.p['state']))
        with self.assertRaises(tool.Refused) as e:
            tool._create_only(self.p['target'], CONF, 0o644)
        self.assertEqual(e.exception.code, 'DROP_IN_APPEARED')
        self.assertEqual(len(os.listdir(os.path.dirname(self.p['target']))), 2)

    def test_a_later_sysctl_file_that_overrides_a_key_is_refused(self):
        pathlib.Path(self.p['sysctl_dirs'][1], '99-tuning.conf').write_text('vm.watermark_scale_factor = 10\n')
        text, _, _, overrides = tool.plan_tuning(self.p, CONF, TOOL_SHA, KERNEL)
        self.assertEqual(overrides, ['99-tuning.conf:vm.watermark_scale_factor'])
        self.assertIn('bootOverride=99-tuning.conf:vm.watermark_scale_factor', text.splitlines())
        with self.assertRaises(tool.Refused) as e:
            tool.apply_tuning(self.p, CONF, tool.plan_sha(text), TOOL_SHA, KERNEL, [], 's1')
        self.assertEqual(e.exception.code, 'KEY_OVERRIDDEN_AT_BOOT')
        self.assertFalse(os.path.exists(self.p['target']))

    def test_drop_in_present_but_values_not_live(self):
        # For example a drop-in placed by hand: the values are written, the file is kept on rollback.
        pathlib.Path(self.p['target']).write_bytes(CONF)
        r = tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's1')
        self.assertEqual((r['status'], r['dropIn']), ('HOST_TUNING_APPLIED', 'already-present'))
        back = tool.rollback_tuning(self.p, r['saved'], 's2')
        self.assertIsNone(back['dropInMovedTo'], 'a drop-in that was there before stays')
        self.assertTrue(os.path.exists(self.p['target']))
        self.assertEqual(back['now'], DEFAULTS)
        again = tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's3')
        self.assertEqual(again['status'], 'HOST_TUNING_APPLIED', 'a retired saved file does not block the next apply')

    def test_an_apply_that_stopped_half_way_is_rolled_back_first(self):
        real = tool.write_value
        def flaky(proc_sys, key, value):
            if key == 'vm.watermark_scale_factor':
                raise OSError('write failed')
            real(proc_sys, key, value)
        with mock.patch.object(tool, 'write_value', flaky):
            with self.assertRaises(OSError):
                tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's1')
        self.assertTrue(os.path.exists(self.p['target']))
        [saved] = tool.saved_files(self.p['state'])
        with self.assertRaises(tool.Refused) as e:
            tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's2')
        self.assertEqual((e.exception.code, e.exception.detail), ('PREVIOUS_APPLY_NOT_ROLLED_BACK', [saved]), 'the refusal names the file to roll back with')
        self.assertEqual(len(tool.saved_files(self.p['state'])), 1)
        back = tool.rollback_tuning(self.p, f"{self.p['state']}/{saved}", 's3')
        self.assertEqual(back['now'], DEFAULTS)
        self.assertFalse(os.path.exists(self.p['target']))
        self.assertEqual(tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's4')['status'], 'HOST_TUNING_APPLIED')

    def test_rollback_leaves_a_replaced_drop_in_alone(self):
        r = tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's1')
        pathlib.Path(self.p['target']).write_bytes(conf(**{'vm.watermark_scale_factor': 300}))
        with self.assertRaises(tool.Refused) as e:
            tool.rollback_tuning(self.p, r['saved'], 's2')
        self.assertEqual(e.exception.code, 'DROP_IN_CHANGED_SINCE_APPLY')
        self.assertTrue(os.path.exists(self.p['target']))
        self.assertEqual(tool.read_live(self.p['proc_sys']), tool.parse_conf(CONF), 'nothing written back either')

    def test_rollback_reads_only_its_own_saved_files(self):
        os.makedirs(self.p['state'])
        good = {'contract': tool.SAVED_CONTRACT, 'values': DEFAULTS, 'dropInBefore': 'absent', 'confSha256': tool.sha256(CONF), 'devicesBefore': [OLD_DEV]}
        outside = pathlib.Path(self.tmp.name) / 'previous.json'
        outside.write_text(json.dumps(good))
        with self.assertRaises(tool.Refused) as e:
            tool.rollback_tuning(self.p, str(outside), 's1')
        self.assertEqual(e.exception.code, 'SAVED_OUTSIDE_STATE')
        for bad in [{**good, 'contract': 'clued.wsl-host-tuning-previous/1'},
                    {**good, 'values': {**DEFAULTS, 'vm.min_free_kbytes': 1}},
                    {**good, 'values': {**DEFAULTS, 'vm.watermark_scale_factor': '10'}},
                    {**good, 'dropInBefore': 'different'},
                    {**good, 'confSha256': 'x'},
                    {**good, 'devicesBefore': ['../x']}]:
            f = pathlib.Path(self.p['state']) / 'previous-bad.json'
            f.write_text(json.dumps(bad))
            with self.assertRaises(tool.Refused):
                tool.rollback_tuning(self.p, str(f), 's1')
            f.unlink()
        self.assertEqual(tool.read_live(self.p['proc_sys']), DEFAULTS)

    def test_plan_binds_tool_conf_live_values_and_overrides(self):
        base = self.plan()
        self.assertEqual(base, self.plan(), 'deterministic')
        self.assertNotEqual(base, tool.plan_sha(tool.plan_tuning(self.p, CONF, 'b' * 64, KERNEL)[0]))
        self.assertNotEqual(base, self.plan(conf(**{'vm.watermark_scale_factor': 150})))
        pathlib.Path(tool.proc_path(self.p['proc_sys'], 'vm.watermark_boost_factor')).write_text('15001\n')
        self.assertNotEqual(base, self.plan(), 'a live value changed since review')

    @unittest.skipUnless(hasattr(os, 'O_NOFOLLOW') and hasattr(os, 'symlink'), 'symlink refusal needs O_NOFOLLOW (Linux)')
    def test_symlinked_drop_in_or_conf_is_refused(self):
        real = pathlib.Path(self.tmp.name) / 'elsewhere.conf'
        real.write_bytes(CONF)
        os.symlink(real, self.p['target'])
        with self.assertRaises(OSError):
            tool.read_optional(self.p['target'])

    def test_main_dispatch(self):
        with self.assertRaises(tool.Refused) as e:
            tool.main(['bogus'], self.p)
        self.assertEqual(e.exception.code, 'COMMAND_REFUSED')
        if not tool.is_root():
            for cmd in (['apply', '--conf', 'x', '--plan', 'y'], ['rollback', '--saved', 'x']):
                with self.assertRaises(tool.Refused) as e:
                    tool.main(cmd, self.p)
                self.assertEqual(e.exception.code, 'ROOT_REQUIRED')
        conf_path = pathlib.Path(self.tmp.name) / 'conf'
        conf_path.write_bytes(CONF)
        result, ok = tool.main(['verify', '--conf', str(conf_path)], self.p)
        self.assertEqual((result['status'], ok), ('HOST_TUNING_NOT_IN_EFFECT', False))

    def test_cli_prints_one_json_object_and_exit_code(self):
        def run(*args):
            r = subprocess.run([sys.executable, '-I', '-B', str(TOOL), *args], capture_output=True, text=True, timeout=60)
            return r.returncode, json.loads(r.stdout)
        self.assertEqual(run('bogus'), (1, {'status': 'REFUSED', 'code': 'COMMAND_REFUSED'}))
        self.assertEqual(run('verify', '--conf', str(pathlib.Path(self.tmp.name) / 'missing.conf')), (1, {'status': 'REFUSED', 'code': 'FILE_MISSING'}))
        if not tool.is_root():
            self.assertEqual(run('apply', '--conf', 'x', '--plan', 'y'), (1, {'status': 'REFUSED', 'code': 'ROOT_REQUIRED'}))


GUARD = TUNING / 'clued-wsl-memguard'
gloader = importlib.machinery.SourceFileLoader('wsl_memguard', str(GUARD))
gspec = importlib.util.spec_from_loader('wsl_memguard', gloader)
guard = importlib.util.module_from_spec(gspec)
gloader.exec_module(guard)

LOW_BUDDY = ('Node 0, zone    DMA32   5131   2227    703    424    335    263    210      0      0      0      0\n'
             'Node 0, zone   Normal   1037    597    194     44     21     21      5      0      0      0      0\n')
HIGH_BUDDY = ('Node 0, zone    DMA32   3949   3186   2754   1852   1554   1267    934    632    360    197    528\n'
              'Node 0, zone   Normal   3408   2170   1256    938    588    370    250    168    161    137    173\n')
LITTLE_GAIN = ('Node 0, zone    DMA32   5131   2227    703    424    335    263    210      3      0      0      0\n'
               'Node 0, zone   Normal   1037    597    194     44     21     21      5      0      0      0      0\n')


class MemGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        r = pathlib.Path(self.tmp.name)
        self.proc = r / 'proc'
        (self.proc / 'vm').mkdir(parents=True)
        (self.proc / 'net' / 'core').mkdir(parents=True)
        for name in ('compact_memory', 'drop_caches'):
            (self.proc / 'vm' / name).write_text('')
        self.set_buffers(212992)
        self.buddy = r / 'buddyinfo'
        self.state = r / 'run'
        self.state.mkdir()
        self.writes = []

    def tearDown(self):
        self.tmp.cleanup()

    def set_buffers(self, size):
        for name in ('rmem_default', 'wmem_default'):
            (self.proc / 'net' / 'core' / name).write_text(f'{size}\n')

    def run_pass(self, now, start, after_compact, after_drop=None):
        # The kernel effect of each write is played by rewriting buddyinfo; only the two /proc writes are recorded.
        self.buddy.write_text(start)
        self.writes.clear()
        real = guard.write
        def fake(path, value):
            real(path, value)
            name = pathlib.Path(path).name
            if name in ('compact_memory', 'drop_caches'):
                self.writes.append(name)
            if name == 'compact_memory':
                self.buddy.write_text(after_drop if 'drop_caches' in self.writes and after_drop else after_compact)
        with mock.patch.object(guard, 'write', fake):
            return guard.guard_pass(str(self.proc), str(self.buddy), str(self.state), lambda: now)

    def test_ring_order_and_block_count(self):
        self.assertEqual((guard.ring_order(212992, 212992), guard.ring_order(65536, 65536)), (7, 5))
        self.assertEqual(guard.ring_order(65536, 65536), tool.ring_order(65536, 65536))
        self.assertEqual(guard.zone_blocks(HIGH_BUDDY, 7), {'DMA32': 632 + 360 + 197 + 528, 'Normal': 168 + 161 + 137 + 173})
        self.assertEqual(guard.blocks_at_least(LOW_BUDDY, 7), 0)
        self.assertEqual(guard.blocks_at_least(LOW_BUDDY, 5), 263 + 210 + 21 + 5)

    def test_quiet_when_enough_blocks_with_a_status_line_every_ten_minutes(self):
        r = self.run_pass(1000.0, HIGH_BUDDY, HIGH_BUDDY)
        self.assertEqual((r['status'], r['blocks']), ('OK', guard.blocks_at_least(HIGH_BUDDY, 7)))
        self.assertIsNone(self.run_pass(1599.0, HIGH_BUDDY, HIGH_BUDDY))
        self.assertEqual(self.run_pass(1600.0, HIGH_BUDDY, HIGH_BUDDY)['status'], 'OK')
        self.assertEqual(self.writes, [], 'nothing written to /proc when enough')

    def test_compaction_first_then_drop_at_most_every_five_minutes(self):
        r = self.run_pass(1000.0, LOW_BUDDY, HIGH_BUDDY)
        self.assertEqual((r['order'], r['before'], r['compacted'], r['dropped']), (7, 0, True, False))
        self.assertEqual(self.writes, ['compact_memory'], 'compaction was enough: page cache kept')
        r = self.run_pass(1060.0, LOW_BUDDY, LOW_BUDDY, HIGH_BUDDY)
        self.assertEqual((r['dropped'], r['afterDrop']), (True, guard.blocks_at_least(HIGH_BUDDY, 7)))
        self.assertEqual(self.writes, ['compact_memory', 'drop_caches', 'compact_memory'])
        self.assertEqual((self.proc / 'vm' / 'drop_caches').read_text(), '1\n', 'clean page cache only, never slab')
        r = self.run_pass(1060.0 + 299, LOW_BUDDY, HIGH_BUDDY)
        self.assertEqual((r['dropped'], self.writes), (False, ['compact_memory']), 'no second drop within 300 s')
        r = self.run_pass(1060.0 + 300, LOW_BUDDY, LOW_BUDDY, HIGH_BUDDY)
        self.assertTrue(r['dropped'])

    def test_compaction_that_gains_little_backs_off(self):
        r = self.run_pass(1000.0, LOW_BUDDY, LITTLE_GAIN, LITTLE_GAIN)
        self.assertEqual((r['compacted'], r['afterCompact'], r['dropped']), (True, 3, True))
        r = self.run_pass(1060.0, LOW_BUDDY, HIGH_BUDDY)
        self.assertEqual((r['status'], r['compacted'], r['dropped'], self.writes), ('BACKOFF', False, False, []),
                         'gain 3 < 8 and still below 64: no compaction for 300 s, drop not due')
        r = self.run_pass(1300.0, LOW_BUDDY, HIGH_BUDDY)
        self.assertEqual((r['compacted'], self.writes), (True, ['compact_memory']))

    def test_a_small_gain_that_crossed_the_threshold_does_not_back_off(self):
        def blocks(n):  # n free order-7 blocks in DMA32, none elsewhere
            return (f'Node 0, zone    DMA32      0      0      0      0      0      0      0 {n:6d}      0      0      0\n'
                    'Node 0, zone   Normal      0      0      0      0      0      0      0      0      0      0      0\n')
        r = self.run_pass(1000.0, blocks(60), blocks(66))
        self.assertEqual((r['compacted'], r['afterCompact'], r['dropped']), (True, 66, False))
        r = self.run_pass(1060.0, blocks(61), blocks(70))
        self.assertEqual((r['compacted'], r['dropped'], self.writes), (True, False, ['compact_memory']),
                         'gain 6 but back over 64 last time: compacting again is cheaper than dropping the page cache')

    def test_a_damaged_state_file_counts_as_no_record(self):
        (self.state / 'last-compact').write_text('1000.0 3\n')  # an old two-field record
        (self.state / 'last-drop').write_text('garbage\n')
        r = self.run_pass(1000.0, LOW_BUDDY, LOW_BUDDY, HIGH_BUDDY)
        self.assertEqual((r['compacted'], r['dropped']), (True, True))

    def test_threshold_follows_the_live_ring_order(self):
        self.set_buffers(65536)
        r = self.run_pass(1000.0, LOW_BUDDY, LOW_BUDDY)  # 499 blocks of order >= 5: enough once the rings are order 5
        self.assertEqual((r['status'], self.writes), ('OK', []))

    def test_no_drop_without_its_time_stamp(self):
        (self.state / 'last-drop').mkdir()  # the stamp cannot be written
        with self.assertRaises(OSError):
            self.run_pass(1000.0, LOW_BUDDY, LOW_BUDDY, HIGH_BUDDY)
        self.assertNotIn('drop_caches', self.writes)

    def test_a_pass_that_cannot_write_fails_before_acting(self):
        (self.proc / 'vm' / 'drop_caches').unlink()
        with self.assertRaises(OSError):
            self.run_pass(1000.0, LOW_BUDDY, HIGH_BUDDY)
        (self.proc / 'vm' / 'drop_caches').write_text('')
        self.state.rmdir()
        with self.assertRaises(OSError):
            self.run_pass(1000.0, LOW_BUDDY, HIGH_BUDDY)
        self.assertEqual(self.writes, [], 'no compaction either')


class FakeSystemctl:
    def __init__(self, fail_start=False):
        self.calls, self.enabled, self.active, self.loaded, self.result, self.ran, self.fail_start = [], False, False, False, 'success', False, fail_start

    def __call__(self, *args):
        self.calls.append(args)
        if args[0] == 'daemon-reload':
            self.loaded = True
        elif args[:2] == ('enable', '--now'):
            self.enabled = self.active = True
        elif args[:2] == ('disable', '--now'):
            self.enabled = self.active = False
        elif args[0] == 'start':
            self.ran = True
            self.result = 'exit-code' if self.fail_start else 'success'
            return (1, '') if self.fail_start else (0, '')
        elif args[0] == 'is-active':
            return (0, 'active\n') if self.active else (3, 'inactive\n')
        elif args[0] == 'is-enabled':
            return (0, 'enabled\n') if self.enabled else ((1, 'disabled\n') if self.loaded else (4, 'not-found\n'))
        elif args[0] == 'show':
            return 0, f"LoadState={'loaded' if self.loaded else 'not-found'}\nResult={self.result}\nExecMainStartTimestampMonotonic={123 if self.ran else 0}\n"
        return 0, ''


class GuardInstall(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        r = pathlib.Path(self.tmp.name)
        self.p = {'state': str(r / 'state'),
                  'guard_files': (('clued-wsl-memguard', str(r / 'lib' / 'clued-wsl-memguard'), 0o755),
                                  ('clued-wsl-memguard.service', str(r / 'systemd' / 'clued-wsl-memguard.service'), 0o644),
                                  ('clued-wsl-memguard.timer', str(r / 'systemd' / 'clued-wsl-memguard.timer'), 0o644))}
        self.pkg = str(TUNING)

    def tearDown(self):
        self.tmp.cleanup()

    def plan(self):
        return tool.plan_sha(tool.guard_plan(self.p, self.pkg, TOOL_SHA, KERNEL)[0])

    def installed(self):
        return [os.path.exists(t) for _, t, _ in self.p['guard_files']]

    def test_apply_verify_rollback(self):
        sc = FakeSystemctl()
        self.assertEqual(tool.guard_verify(self.p, self.pkg, sc)[0]['lastPassSucceeded'], False, 'a unit that never ran is not a success')
        want = self.plan()
        with self.assertRaises(tool.Refused) as e:
            tool.guard_apply(self.p, self.pkg, want, TOOL_SHA, KERNEL, ['clued-ci-worker@x.service'], 's1', sc)
        self.assertEqual(e.exception.code, 'CI_UNIT_ACTIVE')
        r = tool.guard_apply(self.p, self.pkg, want, TOOL_SHA, KERNEL, [], 's1', sc)
        self.assertEqual(r['status'], 'GUARD_APPLIED')
        for name, target, _ in self.p['guard_files']:
            self.assertEqual(pathlib.Path(target).read_bytes(), (TUNING / name).read_bytes())
        saved = json.loads(pathlib.Path(r['saved']).read_text())
        self.assertEqual(saved['timerBefore'], {'enabled': 'not-found', 'active': 'inactive'})
        self.assertEqual(tool.guard_verify(self.p, self.pkg, sc)[1], True)
        self.assertEqual(tool.guard_apply(self.p, self.pkg, self.plan(), TOOL_SHA, KERNEL, [], 's2', sc)['status'], 'GUARD_ALREADY_APPLIED')
        back = tool.guard_rollback(self.p, r['saved'], 's3', sc)
        self.assertEqual(len(back['movedTo']), 3)
        self.assertEqual(self.installed(), [False, False, False])
        self.assertFalse(sc.active)
        self.assertIn(('reset-failed', 'clued-wsl-memguard.service'), sc.calls)
        self.assertEqual(tool.guard_saved_files(self.p['state']), [])

    def test_a_first_pass_that_fails_turns_the_timer_off(self):
        sc = FakeSystemctl(fail_start=True)
        with self.assertRaises(tool.Refused) as e:
            tool.guard_apply(self.p, self.pkg, self.plan(), TOOL_SHA, KERNEL, [], 's1', sc)
        self.assertEqual(e.exception.code, 'GUARD_FIRST_RUN_FAILED')
        self.assertFalse(sc.enabled or sc.active, 'not left failing every minute')
        saved = e.exception.detail
        with self.assertRaises(tool.Refused) as e:  # the same host: no silent ALREADY_APPLIED over a failing guard
            tool.guard_apply(self.p, self.pkg, self.plan(), TOOL_SHA, KERNEL, [], 's2', sc)
        self.assertEqual((e.exception.code, e.exception.detail), ('PREVIOUS_GUARD_APPLY_NOT_ROLLED_BACK', [os.path.basename(saved)]))
        tool.guard_rollback(self.p, saved, 's3', sc)
        self.assertEqual(self.installed(), [False, False, False])
        sc.fail_start = False
        self.assertEqual(tool.guard_apply(self.p, self.pkg, self.plan(), TOOL_SHA, KERNEL, [], 's4', sc)['status'], 'GUARD_APPLIED')

    def test_changed_files_are_left_alone(self):
        sc = FakeSystemctl()
        r = tool.guard_apply(self.p, self.pkg, self.plan(), TOOL_SHA, KERNEL, [], 's1', sc)
        timer = self.p['guard_files'][2][1]
        pathlib.Path(timer).write_text('[Timer]\nOnUnitActiveSec=1s\n')
        with self.assertRaises(tool.Refused) as e:
            tool.guard_rollback(self.p, r['saved'], 's2', sc)
        self.assertEqual(e.exception.code, 'GUARD_FILE_CHANGED_SINCE_APPLY')
        self.assertEqual(self.installed(), [True, True, True], 'nothing moved')
        self.assertTrue(sc.active, 'timer not touched')
        with self.assertRaises(tool.Refused) as e:
            tool.guard_apply(self.p, self.pkg, self.plan(), TOOL_SHA, KERNEL, [], 's3', sc)
        self.assertEqual(e.exception.code, 'GUARD_FILE_DIFFERS_OWNER_DECIDES')

    def test_rollback_of_an_apply_over_an_existing_running_install_keeps_it_running(self):
        sc = FakeSystemctl()
        for name, target, mode in self.p['guard_files']:  # installed and running before this apply
            os.makedirs(os.path.dirname(target), exist_ok=True)
            pathlib.Path(target).write_bytes((TUNING / name).read_bytes())
        sc.loaded = sc.enabled = sc.active = True
        sc.result, sc.ran = 'exit-code', True  # its last pass failed, so apply runs again rather than ALREADY_APPLIED
        r = tool.guard_apply(self.p, self.pkg, self.plan(), TOOL_SHA, KERNEL, [], 's1', sc)
        back = tool.guard_rollback(self.p, r['saved'], 's2', sc)
        self.assertEqual((back['movedTo'], sc.active, self.installed()), ([], True, [True, True, True]))


if __name__ == '__main__':
    unittest.main()
