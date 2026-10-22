"""Offline tests for linux/host-tuning/clued-wsl-host-tuning (run on any OS):
python -I -m unittest discover -s test -p "test_*.py" (from work/independent-ci-resident-v1)."""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
TUNING = HERE.parent / 'linux' / 'host-tuning'
loader = importlib.machinery.SourceFileLoader('wsl_host_tuning', str(TUNING / 'clued-wsl-host-tuning'))
spec = importlib.util.spec_from_loader('wsl_host_tuning', loader)
tool = importlib.util.module_from_spec(spec)
loader.exec_module(tool)

CONF = (TUNING / '60-clued-ci-hvsock-memory.conf').read_bytes()
DEFAULTS = {'net.core.rmem_default': 212992, 'net.core.wmem_default': 212992, 'vm.watermark_scale_factor': 10}
TOOL_SHA = 'a' * 64
KERNEL = '6.18.33.2-microsoft-standard-WSL2'
DEV = '1b61d1fa-0000-4000-8000-000000000001'


def conf(**over):
    values = {'net.core.rmem_default': 65536, 'net.core.wmem_default': 65536, 'vm.watermark_scale_factor': 200, **over}
    return ''.join(f'{k} = {v}\n' for k, v in values.items()).encode('ascii')


class ConfAndRing(unittest.TestCase):
    def test_shipped_conf_cuts_the_ring_to_order_5(self):
        values = tool.parse_conf(CONF)
        self.assertEqual(values, {'net.core.rmem_default': 65536, 'net.core.wmem_default': 65536, 'vm.watermark_scale_factor': 200})
        self.assertEqual(tool.ring_order(values['net.core.rmem_default'], values['net.core.wmem_default']), 5)

    def test_ring_sizes_match_what_turing_showed(self):
        # 2026-10-22: every live hv_sock channel reported write_avail 208896 with the 212992 defaults,
        # and the failed allocations were order 7.
        self.assertEqual(tool.ring_bytes(212992) - tool.PAGE, 208896)
        self.assertEqual(tool.ring_order(212992, 212992), 7)
        self.assertEqual(tool.ring_order(131072, 131072), 6)
        self.assertEqual(tool.ring_bytes(65536) - tool.PAGE, 61440)
        self.assertEqual(tool.ring_bytes(1), 5 * tool.PAGE, 'hv_sock never goes below 5 pages')
        self.assertEqual(tool.ring_bytes(4 << 20), 64 * tool.PAGE, 'nor above 64 pages')
        self.assertEqual(tool.ring_order(4 << 20, 4 << 20), 7)

    def test_conf_is_exact(self):
        bad = [
            b'',
            conf().replace(b'vm.watermark_scale_factor = 200\n', b''),                    # a key missing
            conf() + b'vm.watermark_scale_factor = 200\n',                                 # duplicated
            conf() + b'vm.min_free_kbytes = 131072\n',                                     # not reviewed
            conf().replace(b'net.core.rmem_default', b'-net.core.rmem_default'),           # ignore-errors prefix
            conf(**{'vm.watermark_scale_factor': 5}),                                      # below bounds
            conf(**{'net.core.wmem_default': 300000}),                                     # above 64 pages
            conf(**{'net.core.rmem_default': 65537}),                                      # not page aligned
            conf() + '# é\n'.encode('utf-8'),                                              # not ascii
            conf() + b'#' * 5000,                                                          # too large
        ]
        for raw in bad:
            with self.assertRaises(tool.Refused, msg=raw[:80]):
                tool.parse_conf(raw)
        self.assertEqual(tool.parse_conf(b'# c\n\n' + conf())['vm.watermark_scale_factor'], 200)

    def test_busy_units_and_buddyinfo(self):
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


class Host(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        r = pathlib.Path(self.tmp.name)
        self.p = {'proc_sys': str(r / 'proc'), 'target': str(r / 'etc' / '60-clued-ci-hvsock-memory.conf'),
                  'state': str(r / 'state'), 'hv_sock': str(r / 'hv_sock'), 'buddyinfo': str(r / 'buddyinfo')}
        (r / 'etc').mkdir()
        for k, v in DEFAULTS.items():
            f = pathlib.Path(tool.proc_path(self.p['proc_sys'], k))
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(f'{v}\n')

    def tearDown(self):
        self.tmp.cleanup()

    def plan(self, raw=CONF):
        text, _, _ = tool.plan_tuning(self.p, raw, TOOL_SHA, KERNEL)
        return tool.plan_sha(text)

    def channel(self, dev, relid, write_avail):
        d = pathlib.Path(self.p['hv_sock']) / dev / 'channels' / str(relid)
        d.mkdir(parents=True)
        (d / 'write_avail').write_text(f'{write_avail}\n')

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
        self.assertEqual((saved['values'], saved['dropInBefore']), (DEFAULTS, 'absent'))
        self.assertEqual([n for n in os.listdir(os.path.dirname(self.p['target']))], ['60-clued-ci-hvsock-memory.conf'], 'no temporary name left')

        again = tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's2')
        self.assertEqual(again['status'], 'HOST_TUNING_ALREADY_APPLIED')
        self.assertEqual(len(os.listdir(self.p['state'])), 1, 'no second saved file that would make rollback a no-op')

        result, ok = tool.verify_tuning(self.p, CONF)
        self.assertTrue(ok)
        self.assertIsNone(result['ringEffective'], 'no channel, no claim either way')
        self.channel(DEV, 35, 208896)
        self.assertFalse(tool.verify_tuning(self.p, CONF)[0]['ringEffective'], 'only old-size rings: the relay may set its own buffers')
        self.channel(DEV, 36, 61440)
        result, _ = tool.verify_tuning(self.p, CONF)
        self.assertEqual((result['ringEffective'], result['ringOrderForNewChannels'], result['ringWriteAvail']), (True, 5, {'61440': 1, '208896': 1}))

        back = tool.rollback_tuning(self.p, r['saved'], 's3')
        self.assertEqual(back['now'], DEFAULTS)
        self.assertFalse(os.path.exists(self.p['target']))
        self.assertEqual(pathlib.Path(back['dropInMovedTo']).read_bytes(), CONF, 'moved aside, not deleted')
        self.assertFalse(tool.verify_tuning(self.p, CONF)[1])

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
        self.assertEqual(len(os.listdir(os.path.dirname(self.p['target']))), 1)

    def test_drop_in_present_but_values_not_live(self):
        # For example after a restart where systemd-sysctl did not run: the values are written, the file is kept.
        pathlib.Path(self.p['target']).write_bytes(CONF)
        r = tool.apply_tuning(self.p, CONF, self.plan(), TOOL_SHA, KERNEL, [], 's1')
        self.assertEqual((r['status'], r['dropIn']), ('HOST_TUNING_APPLIED', 'already-present'))
        back = tool.rollback_tuning(self.p, r['saved'], 's2')
        self.assertIsNone(back['dropInMovedTo'], 'a drop-in that was there before stays')
        self.assertTrue(os.path.exists(self.p['target']))
        self.assertEqual(back['now'], DEFAULTS)

    def test_rollback_reads_only_its_own_saved_files(self):
        os.makedirs(self.p['state'])
        outside = pathlib.Path(self.tmp.name) / 'previous.json'
        outside.write_text(json.dumps({'contract': tool.SAVED_CONTRACT, 'values': DEFAULTS, 'dropInBefore': 'absent'}))
        with self.assertRaises(tool.Refused) as e:
            tool.rollback_tuning(self.p, str(outside), 's1')
        self.assertEqual(e.exception.code, 'SAVED_OUTSIDE_STATE')
        for bad in [{'contract': 'x', 'values': DEFAULTS, 'dropInBefore': 'absent'},
                    {'contract': tool.SAVED_CONTRACT, 'values': {**DEFAULTS, 'vm.min_free_kbytes': 1}, 'dropInBefore': 'absent'},
                    {'contract': tool.SAVED_CONTRACT, 'values': {**DEFAULTS, 'vm.watermark_scale_factor': '10'}, 'dropInBefore': 'absent'},
                    {'contract': tool.SAVED_CONTRACT, 'values': DEFAULTS, 'dropInBefore': 'different'}]:
            f = pathlib.Path(self.p['state']) / 'previous-bad.json'
            f.write_text(json.dumps(bad))
            with self.assertRaises(tool.Refused):
                tool.rollback_tuning(self.p, str(f), 's1')
            f.unlink()
        self.assertEqual(tool.read_live(self.p['proc_sys']), DEFAULTS)

    def test_plan_binds_tool_conf_and_live_values(self):
        base = self.plan()
        self.assertEqual(base, self.plan(), 'deterministic')
        self.assertNotEqual(base, tool.plan_sha(tool.plan_tuning(self.p, CONF, 'b' * 64, KERNEL)[0]))
        self.assertNotEqual(base, self.plan(conf(**{'vm.watermark_scale_factor': 150})))
        pathlib.Path(tool.proc_path(self.p['proc_sys'], 'vm.watermark_scale_factor')).write_text('20\n')
        self.assertNotEqual(base, self.plan(), 'a live value changed since review')


if __name__ == '__main__':
    unittest.main()
