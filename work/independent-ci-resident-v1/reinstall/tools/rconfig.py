"""The reinstall build configuration (clued.independent-ci.reinstall-config/1, README.md section 2): one JSON file per node and run that
names every input the tools used to carry as constants (node profile, work directory, repository, base package, runner facts,
pause/rearm reasons, Linux installed-state copies). Public values and paths only: a secret-looking key or value is refused here, so no
token, key or password can enter a configuration, a generated script or a report through it.

Used by the reinstall tools (loaded by path; the tools run under python -I):
  cfg = load(path)            the validated configuration (dict)
  profile = node_profile(cfg, tree)   the node profile of the commit's tree that the configuration names, checked against cfg['node']
"""
import hashlib, json, os, re

CONTRACT = 'clued.independent-ci.reinstall-config/1'
KEYS = {'contract', 'node', 'nodeProfile', 'workDir', 'repo', 'basePackage', 'nodeRecord', 'nodeExe', 'policyInput', 'companionInput',
        'upgradeTokenFile', 'runner', 'launcher', 'linux', 'secretTargetsExist'}
NODE_RECORD_KEYS = {'appKeyId', 'appPublicKeySha256Base64', 'ciPrincipalBindingId', 'ciPrincipalRoleRef', 'ciTokenPinSha256', 'controllerNodeSha256'}
_UUID = r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
NODE_RECORD_SHAPES = {'appPublicKeySha256Base64': r'[A-Za-z0-9+/]{43}=', 'ciPrincipalBindingId': _UUID, 'ciPrincipalRoleRef': _UUID,
                      'ciTokenPinSha256': r'[0-9a-f]{64}', 'controllerNodeSha256': r'[0-9a-f]{64}'}
PUBLIC_KEYS = {'upgradeTokenFile', 'secretTargetsExist', 'ciTokenPinSha256'}   # names of a path, two booleans and a public pin
WIN_PATH = re.compile(r'^[A-Za-z]:\\[^"\'\r\n]+$')
REASON = re.compile(r'^[a-z0-9-]{1,200}$')
# A configuration names files; it never holds one. These shapes are what a private key, a GitHub or Supabase secret or a token looks like.
SECRET_KEY = re.compile(r'(?i)(password|passwd|secret|private|token(?!File)|credential|apikey)')
SECRET_VALUE = re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsb_secret_[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.')


class ConfigError(Exception):
    def __init__(self, code, detail=None):
        super().__init__(code if detail is None else '%s %s' % (code, detail))
        self.code = code


def need(ok, code, detail=None):
    if not ok:
        raise ConfigError(code, detail)


def no_secrets(v, at='$'):
    if isinstance(v, dict):
        for k, x in v.items():
            need(not SECRET_KEY.search(k) or k in PUBLIC_KEYS, 'CONFIG_SECRET_SHAPED_KEY', at + '.' + k)
            no_secrets(x, at + '.' + k)
    elif isinstance(v, list):
        for i, x in enumerate(v):
            no_secrets(x, '%s[%d]' % (at, i))
    elif isinstance(v, str):
        need(not SECRET_VALUE.search(v), 'CONFIG_SECRET_SHAPED_VALUE', at)


def load(path):
    with open(path, 'rb') as f:
        raw = f.read()
    cfg = json.loads(raw.decode('utf-8'))
    need(isinstance(cfg, dict) and cfg.get('contract') == CONTRACT, 'CONFIG_CONTRACT')
    need(set(cfg) <= KEYS, 'CONFIG_UNKNOWN_KEYS', sorted(set(cfg) - KEYS))
    for k in ('node', 'nodeProfile', 'workDir', 'repo', 'basePackage', 'nodeExe', 'policyInput', 'companionInput', 'upgradeTokenFile', 'runner', 'launcher', 'linux'):
        need(k in cfg, 'CONFIG_KEY_MISSING', k)
    no_secrets(cfg)
    need(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?', cfg['node'] or ''), 'CONFIG_NODE_NAME')
    need(re.fullmatch(r'config/node-profile\.[a-z0-9-]+\.json', cfg['nodeProfile'] or ''), 'CONFIG_NODE_PROFILE_PATH')
    for k in ('workDir', 'repo', 'basePackage', 'nodeExe', 'policyInput', 'companionInput', 'upgradeTokenFile'):
        need(isinstance(cfg[k], str) and WIN_PATH.match(cfg[k]), 'CONFIG_PATH_SHAPE', k)
    nr = cfg.get('nodeRecord') or {}
    need(isinstance(nr, dict) and set(nr) <= NODE_RECORD_KEYS, 'CONFIG_NODE_RECORD', sorted(set(nr) - NODE_RECORD_KEYS) if isinstance(nr, dict) else None)
    for k, v in nr.items():   # the public fingerprints the node reports; an example's REPLACE_ placeholder never passes
        need(isinstance(v, int) and not isinstance(v, bool) and v > 0 if k == 'appKeyId' else isinstance(v, str) and re.fullmatch(NODE_RECORD_SHAPES[k], v),
             'CONFIG_NODE_RECORD_VALUE', k)
    r = cfg['runner']
    need(isinstance(r, dict) and set(r) == {'binary', 'sddl'} and r['binary'].startswith('"') and r['sddl'].startswith('D:'), 'CONFIG_RUNNER')
    la = cfg['launcher']
    need(isinstance(la, dict) and set(la) == {'pauseReason', 'rearmReason', 'w1PauseReason'} and all(REASON.match(v or '') for v in la.values()), 'CONFIG_LAUNCHER')
    li = cfg['linux']
    need(isinstance(li, dict) and set(li) == {'distribution', 'installedManifest', 'installedRoles'}, 'CONFIG_LINUX')
    need(re.fullmatch(r'[A-Za-z0-9._-]{1,64}', li['distribution'] or ''), 'CONFIG_LINUX_DISTRIBUTION')
    need(all(isinstance(li[k], str) and WIN_PATH.match(li[k]) for k in ('installedManifest', 'installedRoles')), 'CONFIG_PATH_SHAPE', 'linux')
    st = cfg.get('secretTargetsExist', [True, True])
    need(isinstance(st, list) and len(st) == 2 and all(isinstance(x, bool) for x in st), 'CONFIG_SECRET_TARGETS_EXIST')
    cfg['secretTargetsExist'] = st
    cfg['nodeRecord'] = nr
    cfg['_sha256'] = hashlib.sha256(raw).hexdigest()
    return cfg


def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def node_profile(cfg, tree):
    """The node profile the configuration names, read from the commit's tree (the package records exactly that file's canonical bytes)."""
    p = os.path.join(tree, 'work', 'independent-ci-resident-v1', *cfg['nodeProfile'].split('/'))
    with open(p, 'rb') as f:
        prof = json.loads(f.read().decode('utf-8'))
    need(prof.get('contract') == 'clued.independent-ci.node-profile/1' and prof.get('nodeName') == cfg['node'], 'NODE_PROFILE_NOT_THIS_NODE', prof.get('nodeName'))
    return prof, hashlib.sha256(canonical(prof).encode('utf-8')).hexdigest()
