from datetime import datetime, timezone, timedelta
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('start_window_fix',Path(__file__).with_name('fixed_host.py'))
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
class Checks(unittest.TestCase):
 def test_entire_start_cli_budget_must_fit_before_stop_window(self):
  for remaining,guard_seconds in ((31,0),(38,3)):
   with tempfile.TemporaryDirectory() as temp:
    s=object.__new__(host.FixedHost);s.folder=Path(temp);s.prefix='main';s.nonce='a'*32;s.container='b'*64;s.deadline=remaining
    s.record={'ga_sha256':'c'*64,'deadline_utc':(datetime.now(timezone.utc)+timedelta(seconds=60)).isoformat()};clock=[0]
    def ready(*args):clock[0]=guard_seconds;return True
    with patch.object(host.sys,'platform','win32'),patch.object(host.observation,'digest',return_value=host.observation.DOCKER_SHA),patch.object(host.time,'monotonic',side_effect=lambda:clock[0]),patch.object(host.observation,'load_record',return_value={'container_id':s.container}),patch.object(host.observation,'guard_ready',side_effect=ready),patch.object(host.subprocess,'Popen') as process:
     with self.assertRaises(host.observation.Unknown):s._invoke('start','start',guard=object())
     process.assert_not_called()
if __name__=='__main__':unittest.main()
