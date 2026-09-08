"""Exact public input validation for one engineering observation, not authority."""
import copy
import hashlib
import importlib.util
from pathlib import Path

BASE = Path(__file__).resolve().parent
MODEL_PATH = BASE.parent / 'linux-docker-driver' / 'candidate.py'
MODEL_SHA = '7eed6b480010c5aebba39e109356a9a499f8ecc96ced184d3ee926fa52346457'
if hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest() != MODEL_SHA:
    raise RuntimeError('Frozen validation source changed')
spec = importlib.util.spec_from_file_location('fixed_linux_model', MODEL_PATH)
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)

IMAGE_DIGEST = 'sha256:285a71327884a4d50efbea30104473b0fa43ecefa499458899670ca30dae76e5'
IMAGE = 'docker.io/library/python@' + IMAGE_DIGEST
CONFIG_DIGEST = 'sha256:1148adc3b50891ee01e6add44be22d277dedeb8dcac2f7cc8b700dd710c75c4d'
PUBLIC_ENV = [
    'PATH=/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'LANG=C.UTF-8',
    'GPG_KEY=7169605F62C751356D054A26A821E680E5FA6305',
    'PYTHON_VERSION=3.12.14',
    'PYTHON_SHA256=5c8462af5790baf43a321a1559dbe0db06d1be4300fb85fb53c40060668e548a',
]
# GPG_KEY above is the public release signing-key fingerprint from the exact
# verified image config; no private material or inherited host environment.
DIFF_IDS = [
    'sha256:34884abbe92863fce933ed7c39c0e045631af0ed86d5cc0dfbdf9fdca426ce3c',
    'sha256:e841883ead55c7764ef03835ed98a55882e84f57dd6f90ffbc7d31d5fc8974a6',
    'sha256:2a35f153520985da7afa7a4e0ad937ffc12ab85368a318897a7b5bbf238de41c',
    'sha256:1b3b53d060ded641f97028c035939c8f8ae188040ae683c2f5e019b948ed0356',
]


def image_valid(v):
    if type(v) is not dict or type(v.get('Config')) is not dict:
        return False
    c = v['Config']
    return (v.get('Id') == IMAGE_DIGEST and v.get('Architecture') == 'amd64'
            and v.get('Os') == 'linux' and v.get('Descriptor', {}).get('digest') == IMAGE_DIGEST
            and v.get('RepoDigests') == ['python@' + IMAGE_DIGEST]
            and v.get('RootFS') == {'Type': 'layers', 'Layers': DIFF_IDS}
            and c.get('Env') == PUBLIC_ENV and c.get('Cmd') == ['python3']
            and c.get('WorkingDir') == '/'
            and all(c.get(k) is None for k in ('Entrypoint', 'Healthcheck', 'User', 'Volumes')))


def host_valid(v):
    return (type(v) is dict and v.get('Version') == '29.7.2'
            and v.get('GitCommit') == '6a43e3d' and v.get('Os') == 'linux'
            and v.get('Arch') == 'amd64' and v.get('ApiVersion') == '1.55'
            and v.get('KernelVersion') == '6.18.33.2-microsoft-standard-WSL2')


def source_matches(actual, expected):
    if not isinstance(actual, str):
        return False
    win = str(expected).replace('\\', '/')
    aliases = {win}
    if len(win) > 3 and win[1:3] == ':/':
        aliases.add('/run/desktop/mnt/host/' + win[0].lower() + win[2:])
    return actual.replace('\\', '/') in aliases


def own_container(v, identity, nonce):
    return (type(v) is dict and v.get('Id') == model.container_id(identity)
            and v.get('Image') == IMAGE_DIGEST and v.get('Name') == '/clued-synthetic-' + nonce
            and type(v.get('Config')) is dict
            and type(v['Config'].get('Labels')) is dict
            and v['Config']['Labels'].get('clued.observation') == nonce
            and v['Config']['Labels'].get('clued.scope') == 'synthetic-engineering-only')


def prestart(v, identity, nonce, driver, allowed):
    if not own_container(v, identity, nonce) or v['Config'].get('Env') != PUBLIC_ENV:
        return False
    mounts = v.get('Mounts')
    if type(mounts) is not list or len(mounts) != 2:
        return False
    translated = copy.deepcopy(v)
    expected_linux = model.paths({'image': IMAGE, 'run_key': nonce})
    for entry in translated['Mounts']:
        if type(entry) is not dict:
            return False
        destination = entry.get('Destination')
        if destination == '/driver/probe.py' and source_matches(entry.get('Source'), driver):
            entry['Source'] = expected_linux[0]
        elif destination == '/allowed' and source_matches(entry.get('Source'), allowed):
            entry['Source'] = expected_linux[1]
        else:
            return False
    # Narrow successor input only: verify the five exact image defaults before
    # adapting to the unchanged pure validator. No generic environment override.
    translated['Config']['Env'] = []
    return model.prestart({'image': IMAGE, 'run_key': nonce}, identity, translated)


def probe_valid(v):
    if type(v) is not dict or type(v.get('pid')) is not int or v['pid'] != 1:
        return False
    checks = ('allowed_write', 'rootfs_write_denied', 'private_canary_read_denied',
              'loopback_positive_control', 'network_denied', 'tree_active', 'checks_observed')
    token = v.get('status')
    child = v.get('descendant_readiness')
    if type(token) is not dict or type(child) is not dict:
        return False
    return (all(v.get(k) is True for k in checks) and v.get('credential_canary_inherited') is False
            and type(v.get('uid')) is int and v['uid'] == 10001 and v.get('interfaces') == ['lo']
            and token.get('NoNewPrivs') == '1' and token.get('CapEff') == '0000000000000000'
            and token.get('CapPrm') == '0000000000000000'
            and type(v.get('network_errno')) is int and v['network_errno'] in {101, 1, 13}
            and type(v.get('descendant_pid')) is int and v['descendant_pid'] > 1
            and child.get('pid') == v['descendant_pid'] and type(child.get('pid')) is int
            and type(child.get('ppid')) is int and child['ppid'] == 1
            and type(child.get('uid')) is int and child['uid'] == 10001
            and child.get('sigterm_ignored') is True)
