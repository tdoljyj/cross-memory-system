from datetime import datetime, timezone, timedelta
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('host_stop_fix',Path(__file__).with_name('fixed_host.py'))
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)

class Checks(unittest.TestCase):
    def test_guard_check_crossing_stop_window_prevents_popen(self):
        with tempfile.TemporaryDirectory() as temp:
            session=object.__new__(host.FixedHost);session.folder=Path(temp);session.prefix='main';session.nonce='a'*32;session.container='b'*64;session.deadline=31
            session.record={'ga_sha256':'c'*64,'deadline_utc':(datetime.now(timezone.utc)+timedelta(seconds=60)).isoformat()}
            clock=[0]
            def guard_check(*args):clock[0]=2;return True
            with patch.object(host.sys,'platform','win32'),patch.object(host.observation,'digest',return_value=host.observation.DOCKER_SHA),patch.object(host.time,'monotonic',side_effect=lambda:clock[0]),patch.object(host.observation,'load_record',return_value={'container_id':session.container}),patch.object(host.observation,'guard_ready',side_effect=guard_check),patch.object(host.subprocess,'Popen') as process:
                with self.assertRaises(host.observation.Unknown):session._invoke('start','start',guard=object())
                process.assert_not_called()

    def test_start_during_stop_window_never_launches_cli(self):
        session=object.__new__(host.FixedHost);session.deadline=time.monotonic()+29
        with patch.object(session,'inspect') as inspect,patch.object(host.subprocess,'Popen') as process:
            with self.assertRaises(host.observation.Unknown):session.start_exact('a'*64,object())
            inspect.assert_not_called();process.assert_not_called()

    def test_complete_stop_chain_fits_reserved_window_with_margin(self):
        session=object.__new__(host.FixedHost);session.folder=Path('.');session.prefix='main'
        elapsed=[];final={'State':{'ExitCode':0}}
        def inspect(exact,tag):elapsed.append(6);return final
        def invoke(tag,operation,limit):elapsed.append(limit);return '0'
        with patch.object(session,'inspect',side_effect=inspect),patch.object(session,'_invoke',side_effect=invoke),patch.object(host.parent.v.model,'stopped',return_value=True),patch.object(host.observation,'persist'):
            self.assertIs(session.stop_exact('a'*64),final)
        self.assertEqual(sum(elapsed),24);self.assertGreaterEqual(host.STOP_RESERVE_SECONDS-sum(elapsed),6)

    def test_nonfinite_local_deadline_is_corrupt_evidence_not_unbounded_permission(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);deadline=(datetime.now(timezone.utc)+timedelta(seconds=60)).isoformat()
            (folder/'ga.raw').write_text(json.dumps({'deadline':deadline}),encoding='utf-8')
            for value in (float('nan'),float('inf'),float('-inf')):
                record={'nonce':'a'*32,'ga_sha256':'b'*64,'host_source_sha256':'c'*64,'deadline_utc':deadline,'deadline_monotonic':value}
                with patch.object(host.parent,'paths',return_value=(folder,None,None)),patch.object(host.observation,'load_record',return_value=record),patch.object(host.observation,'digest',return_value='b'*64),patch.object(host,'source_sha',return_value='c'*64):
                    with self.assertRaises(ValueError):host.FixedHost('a'*32,'b'*64)

if __name__=='__main__':unittest.main()
