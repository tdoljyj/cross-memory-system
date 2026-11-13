"""First install (README section 8c), Windows: the node's build configuration from its config and the facts its Owner returned
(linux/tools/first-install-facts.py). Puts in only the node's public facts: linux.host (toolchain node and result public key SHA-256),
linux.installedRoles = null and signer.publicKeyPem. The keyId and runtimeId are the config's own (signer.keyId,
signer.runtimeId); nothing about any node is a constant here. Refuses facts that are not a first-install-ready host. Writes the new
configuration create-only and validates it as the reinstall tools will (rconfig.load + need_first_install_linux).
  python -I first-install-config.py <config.json, signer without publicKeyPem allowed> <facts.json> <out config.json>
"""
import hashlib, importlib.util, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('rconfig', os.path.join(HERE, 'rconfig.py'))
rconfig = importlib.util.module_from_spec(spec); spec.loader.exec_module(rconfig)
need = rconfig.need
FACTS = 'clued.independent-ci.linux-first-install-facts/1'


def main(cfg_path, facts_path, out_path):
    cfg = json.loads(open(cfg_path, 'rb').read().decode('utf-8'))
    f = json.loads(open(facts_path, 'rb').read().decode('utf-8'))
    need(isinstance(f, dict) and f.get('contract') == FACTS and f.get('root') is True, 'FACTS_CONTRACT')
    need(f.get('linuxCiPresent') == [], 'NODE_HAS_AN_INSTALLED_LINUX_CI', f.get('linuxCiPresent'))
    for k in ('systemdPid1', 'cgroupV2', 'dockerActive', 'python312'):
        need(f.get(k) is True, 'HOST_NOT_READY', k)
    node, pub = f.get('toolchainNode') or {}, f.get('resultPublicKey') or {}
    need(node.get('present') is True and node.get('protected') is True, 'TOOLCHAIN_NODE_MISSING_OR_UNPROTECTED')
    need(pub.get('present') is True and pub.get('protected') is True and (f.get('resultKey') or {}).get('protected') is True, 'RESULT_KEY_MISSING_OR_UNPROTECTED')
    for name, x in (f.get('executables') or {}).items():
        need(x.get('present') is True and x.get('protected') is True, 'HOST_EXECUTABLE_MISSING_OR_UNPROTECTED', name)
    pem = pub.get('pem')
    need(isinstance(pem, str) and re.fullmatch(rconfig.SIGNER_SHAPES['publicKeyPem'], pem) and hashlib.sha256(pem.encode('ascii')).hexdigest() == pub.get('sha256'),
         'RESULT_PUBLIC_KEY_NOT_AN_ED25519_PEM')
    sg = cfg.get('signer')
    need(isinstance(sg, dict) and set(sg) - {'publicKeyPem'} == {'keyId', 'runtimeId'}, 'CONFIG_SIGNER_NEEDS_KEY_ID_AND_RUNTIME_ID')
    need(sg.get('publicKeyPem') in (None, pem), 'CONFIG_SIGNER_IS_ANOTHER_KEY')
    li = cfg.get('linux')
    need(isinstance(li, dict) and li.get('installedRoles') is None, 'NODE_HAS_AN_INSTALLED_LINUX_CI')
    for k, v in (('toolchainNodeSha256', node['sha256']), ('resultPublicKeySha256', pub['sha256'])):
        need((li.get('host') or {}).get(k) in (None, v), 'CONFIG_HOST_FACT_DIFFERS', k)
    cfg['signer'] = {'keyId': sg['keyId'], 'runtimeId': sg['runtimeId'], 'publicKeyPem': pem}
    li['host'] = {'toolchainNodeSha256': node['sha256'], 'resultPublicKeySha256': pub['sha256']}
    data = (json.dumps(cfg, indent=2, ensure_ascii=False) + '\n').encode('utf-8')
    with open(out_path, 'xb') as o:
        o.write(data)
    out = rconfig.load(out_path)
    rconfig.need_first_install_linux(out)
    return {'status': 'FIRST_INSTALL_CONFIG_WRITTEN', 'config': out_path, 'configSha256': out['_sha256'],
            'keyId': sg['keyId'], 'runtimeId': sg['runtimeId'], 'resultPublicKeySha256': pub['sha256'], 'toolchainNodeSha256': node['sha256']}


if __name__ == '__main__':
    try:
        print(json.dumps(main(*sys.argv[1:4]), indent=1))
    except rconfig.ConfigError as e:
        print(json.dumps({'status': 'REFUSED', 'code': e.code, 'detail': str(e)}))
        sys.exit(1)
