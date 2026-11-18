"""按上一轮的实际断点生成完整续作；所有回执、进度和节点目录均为夹具。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'reinstall' / 'test'))
from test_fleet_continue import CONTINUE, LINUX_DONE, Scene, sha
from test_fleet_continue_resume_points import inside_scene, installed_scene

mode, destination = sys.argv[1:]
scene = Scene(Path(destination).parent / 'prior')
resident = scene.ci / 'resident'
pause = b'{"source":{"reason":"fixture-w1"}}'
scene.pins.update(InstalledPausedSha256=repr(sha(pause)), FleetW1PauseReason="'fixture-w1'")
if mode != 'after-uninstall':
    (resident / 'state').mkdir(parents=True)
    (resident / 'state' / 'PAUSED.json').write_bytes(pause)

if mode == 'first-install':
    scene.pins['FleetFirstInstall'] = '$true'
elif mode == 'non-fleet':
    scene.pins['FleetPlanSha256'] = '$null'
elif mode == 'inside-uninstall':
    inside_scene(scene)
elif mode == 'after-install':
    installed_scene(scene, ['first-train', 'verify'], status='STOPPED', verify='RESIDENT_NOT_VERIFIED')
elif mode == 'before-uninstall':
    scene.terminal.update(completed=LINUX_DONE, code='UNINSTALL_PLAN_REFUSED', detail={})
elif mode in ('a-timeout', 'b-timeout'):
    phase = mode[0].upper()
    run = str(resident / 'install' / ('linux-run-' + '7' * 32))
    scene.terminal.update(completed=LINUX_DONE[:6 if phase == 'A' else 7], code='LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED', detail={})
    scene.linux = {'codes': [scene.terminal['code']], 'runs': [{'name': phase, 'outcome': 'TIMEOUT', 'directory': run}]}

def unexpected_host_call(*args):
    raise AssertionError('夹具不应查询服务或发起暂停')

scene.write()
if mode in ('original', 'first-install', 'non-fleet'):
    data = scene.launcher.read_bytes()
else:
    data, facts = CONTINUE.build(str(scene.launcher), ci_root=str(scene.ci), services=unexpected_host_call, pause=unexpected_host_call)
    assert facts['mode'] == mode, facts['mode']
Path(destination).write_bytes(data)
