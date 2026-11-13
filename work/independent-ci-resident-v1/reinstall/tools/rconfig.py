"""The reinstall build configuration (clued.independent-ci.reinstall-config/1, README.md section 2): one JSON file per run, written on
the node from what it has installed (rollout/fleet/install.mjs), that names every input the tools used to carry as constants (work directory, repository, base package, runner facts,
pause/rearm reasons, Linux installed-state copies). Public values and paths only: a secret-looking key or value is refused here, so no
token, key or password can enter a configuration, a generated script or a report through it.

Used by the reinstall tools (loaded by path; the tools run under python -I):
  cfg = load(path)            the validated configuration (dict)
  profile = node_profile(cfg)   the installed node profile: the base package's record (no configuration names a node)
"""
import hashlib, json, os, re

CONTRACT = 'clued.independent-ci.reinstall-config/1'
KEYS = {'contract', 'workDir', 'repo', 'basePackage', 'nodeRecord', 'nodeExe', 'policyInput', 'companionInput',
        'upgradeTokenFile', 'heartbeat', 'runner', 'launcher', 'linux', 'secretTargetsExist', 'signer', 'operatorSid', 'companionAccount'}
# M5-b (ADR 0023), optional and only together: operatorSid is the Owner who runs the launcher when the node profile's ownerSid is the
# companion's own non-administrator account; companionAccount.wslVhdxDirectory is where the resident distribution's ext4.vhdx moves.
COMPANION_ACCOUNT_KEYS = {'wslVhdxDirectory'}
VHDX_DIR = re.compile(r'[A-Z]:\\(?:[A-Za-z0-9._-]{1,64}\\){0,6}[A-Za-z0-9._-]{1,64}')
USER_SID = re.compile(r'S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}')
# The node heartbeat (DESIGN section 41.6a), optional: the heartbeat-only connection's token file (path only, like upgradeTokenFile) and,
# optionally and only with it, that connection's binding id (public, informational: the Owner links it on /bindings/failover). The
# launcher passes -HeartbeatTokenFile, and -HeartbeatBindingId only when configured.
HEARTBEAT_KEYS = {'tokenFile', 'bindingId'}
# The node's own result signer for the record's signers.json (another node than the base package's; README section 8): the Ed25519
# public key its Linux worker signs with (the root-made key's public half, never the private one), its keyId, and the runtimeId its
# role policies name (verifyResultV2 requires payload.runtimeId === signer.runtimeId).
SIGNER_SHAPES = {'keyId': r'[a-z0-9][a-z0-9-]{6,78}[a-z0-9]', 'runtimeId': r'[A-Za-z0-9][A-Za-z0-9._-]{6,78}[A-Za-z0-9]',
                 'publicKeyPem': r'-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=\n-----END PUBLIC KEY-----\n'}
NODE_RECORD_KEYS = {'appKeyId', 'appPublicKeySha256Base64', 'ciPrincipalBindingId', 'ciPrincipalRoleRef', 'ciTokenPinSha256', 'controllerNodeSha256'}
_UUID = r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
NODE_RECORD_SHAPES = {'appPublicKeySha256Base64': r'[A-Za-z0-9+/]{43}=', 'ciPrincipalBindingId': _UUID, 'ciPrincipalRoleRef': _UUID,
                      'ciTokenPinSha256': r'[0-9a-f]{64}', 'controllerNodeSha256': r'[0-9a-f]{64}'}
PUBLIC_KEYS = {'upgradeTokenFile', 'secretTargetsExist', 'ciTokenPinSha256', 'tokenFile'}   # names of paths, two booleans and a public pin
# review 1-3: paths reach the root shell and the elevated PowerShell; ASCII letters, digits, blank, '.', '_', '-' and '\' only
WIN_PATH = re.compile(r'^[A-Za-z]:\\[A-Za-z0-9 ._\\-]+$')
RUNNER_BINARY = re.compile(r'^"[A-Za-z]:\\[A-Za-z0-9 ._\\-]+\.exe"$')
SDDL = re.compile(r'^D:[A-Z0-9();:-]+$')
LINUX_KEYS = {'distribution', 'installedManifest', 'installedRoles', 'host'}
# review 1-1: the node's own Linux host facts the root tools pin: the toolchain node and the verify-result public key (Source v1 is
# retired: no configuration names one)
LINUX_HOST_SHAPES = {'toolchainNodeSha256': r'[0-9a-f]{64}', 'resultPublicKeySha256': r'[0-9a-f]{64}'}
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
    for k in ('workDir', 'repo', 'basePackage', 'nodeExe', 'policyInput', 'companionInput', 'upgradeTokenFile', 'runner', 'launcher', 'linux'):
        need(k in cfg, 'CONFIG_KEY_MISSING', k)
    no_secrets(cfg)
    for k in ('workDir', 'repo', 'basePackage', 'nodeExe', 'policyInput', 'companionInput', 'upgradeTokenFile'):
        need(isinstance(cfg[k], str) and WIN_PATH.match(cfg[k]) and '..' not in cfg[k].split('\\'), 'CONFIG_PATH_SHAPE', k)
    hb = cfg.get('heartbeat')
    need(hb is None or isinstance(hb, dict) and 'tokenFile' in hb and set(hb) <= HEARTBEAT_KEYS and isinstance(hb['tokenFile'], str) and WIN_PATH.match(hb['tokenFile'])
         and '..' not in hb['tokenFile'].split('\\') and hb['tokenFile'].lower() != cfg['upgradeTokenFile'].lower()
         and (hb.get('bindingId') is None or isinstance(hb['bindingId'], str) and re.fullmatch(_UUID, hb['bindingId'])), 'CONFIG_HEARTBEAT')
    cfg['heartbeat'] = None if hb is None else {'tokenFile': hb['tokenFile'], 'bindingId': hb.get('bindingId')}
    op, ca = cfg.get('operatorSid'), cfg.get('companionAccount')
    need((op is None) == (ca is None), 'CONFIG_COMPANION_ACCOUNT_NEEDS_BOTH')
    need(op is None or isinstance(op, str) and USER_SID.fullmatch(op), 'CONFIG_OPERATOR_SID')
    need(ca is None or isinstance(ca, dict) and set(ca) == COMPANION_ACCOUNT_KEYS and isinstance(ca['wslVhdxDirectory'], str)
         and VHDX_DIR.fullmatch(ca['wslVhdxDirectory']) and '..' not in ca['wslVhdxDirectory'].split('\\'), 'CONFIG_COMPANION_ACCOUNT')
    cfg['operatorSid'], cfg['companionAccount'] = op, ca
    nr = cfg.get('nodeRecord') or {}
    need(isinstance(nr, dict) and set(nr) <= NODE_RECORD_KEYS, 'CONFIG_NODE_RECORD', sorted(set(nr) - NODE_RECORD_KEYS) if isinstance(nr, dict) else None)
    for k, v in nr.items():   # the public fingerprints the node reports; an example's REPLACE_ placeholder never passes
        need(isinstance(v, int) and not isinstance(v, bool) and v > 0 if k == 'appKeyId' else isinstance(v, str) and re.fullmatch(NODE_RECORD_SHAPES[k], v),
             'CONFIG_NODE_RECORD_VALUE', k)
    r = cfg['runner']
    need(isinstance(r, dict) and set(r) == {'binary', 'sddl'} and RUNNER_BINARY.match(r['binary'] or '') and SDDL.match(r['sddl'] or ''), 'CONFIG_RUNNER')
    la = cfg['launcher']
    need(isinstance(la, dict) and set(la) == {'pauseReason', 'rearmReason', 'w1PauseReason'} and all(REASON.match(v or '') for v in la.values()), 'CONFIG_LAUNCHER')
    li = cfg['linux']
    need(isinstance(li, dict) and set(li) in (LINUX_KEYS, LINUX_KEYS | {'rehearsalUser'}), 'CONFIG_LINUX')
    ru = li.get('rehearsalUser')
    need(ru is None or isinstance(ru, str) and re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', ru) and ru != 'root', 'CONFIG_LINUX_REHEARSAL_USER')
    lh = li['host']
    # A node without an installed Linux CI yet (a first install, README section 8) has no roles or result key: those values are
    # null, never invented. The reinstall tools that need them (prep.py, rehearse.py) refuse such a configuration (need_installed_linux).
    need(isinstance(lh, dict) and set(lh) == set(LINUX_HOST_SHAPES) and all(lh[k] is None or isinstance(lh[k], str) and re.fullmatch(v, lh[k])
                                                                         for k, v in LINUX_HOST_SHAPES.items()), 'CONFIG_LINUX_HOST')
    need(re.fullmatch(r'[A-Za-z0-9._-]{1,64}', li['distribution'] or ''), 'CONFIG_LINUX_DISTRIBUTION')
    need(isinstance(li['installedManifest'], str) and WIN_PATH.match(li['installedManifest'])
         and (li['installedRoles'] is None or isinstance(li['installedRoles'], str) and WIN_PATH.match(li['installedRoles'])), 'CONFIG_PATH_SHAPE', 'linux')
    sg = cfg.get('signer')
    need(sg is None or isinstance(sg, dict) and set(sg) == set(SIGNER_SHAPES)
         and all(isinstance(sg[k], str) and re.fullmatch(v, sg[k]) for k, v in SIGNER_SHAPES.items()), 'CONFIG_SIGNER')
    cfg['signer'] = sg
    st = cfg.get('secretTargetsExist', [True, True])
    need(isinstance(st, list) and len(st) == 2 and all(isinstance(x, bool) for x in st), 'CONFIG_SECRET_TARGETS_EXIST')
    cfg['secretTargetsExist'] = st
    cfg['nodeRecord'] = nr
    cfg['_sha256'] = hashlib.sha256(raw).hexdigest()
    return cfg


def need_installed_linux(cfg):
    """The reinstall-only tools need the node's installed Linux CI facts; a first-install configuration (nulls) is refused.
    The root scripts take the signing lineage from the node's installed, signed roles-v3 qualifications (README section 6)."""
    li = cfg['linux']
    need(li['installedRoles'] is not None and li['host']['toolchainNodeSha256'] is not None and li['host']['resultPublicKeySha256'] is not None,
         'NODE_HAS_NO_INSTALLED_LINUX_CI')


def need_first_install_linux(cfg):
    """linux/first-install.py: a node without a Linux CI yet (no installed roles), whose toolchain node and new result key
    are known (linux.host), signing with its own signer (the public half of that key, same SHA-256)."""
    li, sg = cfg['linux'], cfg['signer']
    need(li['installedRoles'] is None, 'NODE_HAS_AN_INSTALLED_LINUX_CI')
    need(li['host']['toolchainNodeSha256'] is not None and li['host']['resultPublicKeySha256'] is not None, 'FIRST_INSTALL_NEEDS_THE_NODES_HOST_FACTS')
    need(sg is not None and hashlib.sha256(sg['publicKeyPem'].encode('ascii')).hexdigest() == li['host']['resultPublicKeySha256'], 'FIRST_INSTALL_SIGNER_NOT_THE_NODES_RESULT_KEY')


def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def node_profile(cfg):
    """The node profile: always the installed one, the node profile of the base (installed) package's record (record/acceptance.json
    `node`, held to the package manifest's pin). No configuration names a node or a profile file: the repository carries none."""
    base = cfg['basePackage']
    pins = {f['target']: f['sha256'] for f in json.loads(open(os.path.join(base, 'package-manifest.json'), 'rb').read().decode('utf-8'))['files']}
    raw = open(os.path.join(base, 'record', 'acceptance.json'), 'rb').read()
    need(hashlib.sha256(raw).hexdigest() == pins.get('record\\acceptance.json'), 'BASE_RECORD_FILE_NOT_ITS_PACKAGE', 'acceptance.json')
    prof = json.loads(raw.decode('utf-8')).get('node')
    need(isinstance(prof, dict) and prof.get('contract') == 'clued.independent-ci.node-profile/1', 'INSTALLED_NODE_PROFILE_MISSING')
    need(prof.get('wslDistribution') == cfg['linux']['distribution'], 'CONFIG_DISTRIBUTION_NOT_THE_PROFILES', prof.get('wslDistribution'))   # review 1-10
    return prof, hashlib.sha256(canonical(prof).encode('utf-8')).hexdigest()
