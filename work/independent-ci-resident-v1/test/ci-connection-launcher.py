"""用正式模板及续作变换生成离线夹具，不访问节点。"""
import runpy
import sys
from pathlib import Path

launcher = Path(__file__).resolve().parents[1] / 'reinstall' / 'launcher'
generate = runpy.run_path(str(launcher / 'continue.py'))
fragment, finish = generate['reviewed_sources']()
mode, destination = sys.argv[1:]
pins = "$FleetPlanSha256 = '" + 'b' * 64 + "'\n$FleetFirstInstall = $null"
if mode == 'first-install':
    pins = pins.replace('$null', '$true')
elif mode == 'non-fleet':
    pins = "$FleetPlanSha256 = $null\n$FleetFirstInstall = $null"
source = (launcher / 'template.ps1').read_text(encoding='utf-8').replace('#PINS#', pins)
if mode not in ('original', 'first-install', 'non-fleet'):
    extra = "\n$ContinueOriginalLauncherSha256 = '" + 'a' * 64 + "'\n$ContinuePriorRoot = 'prior-launch'"
    source = generate['transform'](source, pins, pins, extra, mode, 'verify', fragment, finish)
Path(destination).write_bytes(source.encode('utf-8'))
