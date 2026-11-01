"""The build configuration of an in-place upgrade (DESIGN §42.3.1 steps 1 and 3): the node's reinstall configuration with `basePackage`
replaced by the package the node runs now, so that record-inputs.py carries that package's acceptance references and acceptedAt unchanged
(Decision b1dd8a84: the node identity pins them) and node-inputs.py starts from the same node. NON-elevated; writes one new file.

The installed package must be the node's current generation: its package-manifest.json hashes to upgrade\\current.json's
packageManifestSha256 (Owner-readable), and its record names the configured node.

  python -I upgrade-config.py <reinstall-config.json> <installed package dir> <resident root> <out.json>
"""
import hashlib, importlib.util, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('rconfig', os.path.join(HERE, '..', '..', 'reinstall', 'tools', 'rconfig.py'))
rconfig = importlib.util.module_from_spec(spec); spec.loader.exec_module(rconfig)


def need(ok, code, detail=None):
    if not ok:
        print(json.dumps({'status': 'REFUSED', 'code': code, 'detail': detail}))
        sys.exit(1)


def main(argv):
    need(len(argv) == 4, 'USAGE')
    cfg_path, installed, root, out = argv
    need(not os.path.exists(out), 'OUTPUT_EXISTS_NEVER_OVERWRITTEN')
    rconfig.load(cfg_path)   # the original must load as it is
    raw = json.loads(open(cfg_path, 'rb').read().decode('utf-8'))
    installed = os.path.abspath(installed)
    pkg_raw = open(os.path.join(installed, 'package-manifest.json'), 'rb').read()
    current = json.loads(open(os.path.join(root, 'upgrade', 'current.json'), 'rb').read().decode('utf-8'))
    need(hashlib.sha256(pkg_raw).hexdigest() == current.get('packageManifestSha256'), 'INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION',
         {'package': hashlib.sha256(pkg_raw).hexdigest(), 'current': current.get('packageManifestSha256'), 'generation': current.get('generation')})
    acc = json.loads(open(os.path.join(installed, 'record', 'acceptance.json'), 'rb').read().decode('utf-8'))
    need(acc.get('node', {}).get('nodeName') == raw.get('node'), 'INSTALLED_PACKAGE_IS_FOR_ANOTHER_NODE', acc.get('node', {}).get('nodeName'))
    raw['basePackage'] = installed
    data = (json.dumps(raw, indent=1, sort_keys=True) + '\n').encode('utf-8')
    with open(out, 'xb') as f:
        f.write(data)
    rconfig.load(out)   # and so must the derived one (paths, no secret-shaped value)
    print(json.dumps({'status': 'UPGRADE_CONFIG_WRITTEN', 'config': out, 'basePackage': installed, 'generation': current.get('generation'),
                      'carriedReferences': {k: acc.get(k) for k in ('sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef',
                                                                  'ciPrincipalQualificationRef', 'ownerPackageAcceptanceRef', 'installationReceiptRef',
                                                                  'ownerDecisionRef', 'ownerReceiptRef', 'acceptedAt')}}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
