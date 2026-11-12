"""The Python side of the differential tests of rollout/fleet (test/ports.test.mjs). Test-only, offline, writes nothing.
  python -I oracle.py dumps   < [[json_text, {sort_keys, separators, ensure_ascii, indent}], ...]   -> [json.dumps(json.loads(text), **opts), ...]
  python -I oracle.py derive                                                                       -> the frozen Linux tool's derive_role on its own fixtures
"""
import base64, copy, hashlib, importlib.machinery, importlib.util, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
sys.dont_write_bytecode = True


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    m = importlib.util.module_from_spec(spec)
    loader.exec_module(m)
    return m


def b64(b):
    return base64.b64encode(b).decode('ascii')


def dumps():
    out = []
    for text, opts in json.load(sys.stdin):
        if opts.get('separators') is not None:
            opts['separators'] = tuple(opts['separators'])
        out.append(json.dumps(json.loads(text), **opts))
    print(json.dumps(out))


def derive():
    fx = load('test_upgrade_linux', os.path.join(RES, 'test', 'test_upgrade_linux.py'))   # the tool's own offline fixtures
    tool = fx.tool
    sha = lambda b: hashlib.sha256(b).hexdigest()
    manifest = fx.source_manifest('b' * 40, 'B')
    msha = sha(manifest)
    files = fx.SOURCE['B']

    def file_sha(rel):
        tool.safe_rel(rel)
        if rel not in files:
            raise tool.Refused('PINNED_FILE_MISSING_IN_NEW_COMMIT', path=rel)
        return sha(files[rel])

    cases = []
    for role in fx.ROLES:
        pol = fx.policy_of(role, 'A', sha(fx.source_manifest('a' * 40, 'A')))
        pay = fx.payload_of(pol, sha(b'pub'), '2026-10-26T06:01:53.209Z')
        variants = {'ok': (pol, pay)}
        p = copy.deepcopy(pol); p['cpus'] = 1.5; p['memoryBytes'] = 2147483648.0; p['note'] = 'café 中 \U0001F600'
        variants['floats-and-unicode'] = (p, pay)
        p = copy.deepcopy(pol); p['hostAcceptanceRef'] = '99999999-9999-4999-8999-999999999999'
        q = copy.deepcopy(pay); q['hostAcceptanceRef'] = p['hostAcceptanceRef']
        variants['host-changed'] = (p, q)
        q = copy.deepcopy(pay); q['image'] = 'sha256:' + '0' * 64
        variants['payload-not-policy'] = (pol, q)
        p = copy.deepcopy(pol); p['entryFile'] = '/opt/elsewhere/x.mjs'
        variants['entry-outside'] = (p, pay)
        p = copy.deepcopy(pol); p['entryFile'] = tool.PRODUCTION['source'] + '/missing/entry.mjs'
        variants['entry-missing'] = (p, pay)
        p = copy.deepcopy(pol); del p['jobSha256']
        variants['policy-lacks-a-source-key'] = (p, pay)
        q = copy.deepcopy(pay); q['fixture'] = True
        variants['payload-fixture'] = (pol, q)
        for name, (p, q) in variants.items():
            case = {'role': role, 'name': name, 'policy': b64(tool.canonical_bytes(p)), 'payload': b64(tool.canonical_bytes(q))}
            try:
                np, nq = tool.derive_role(role, json.loads(tool.canonical_bytes(p)), json.loads(tool.canonical_bytes(q)), msha, json.loads(manifest), file_sha)
                case['newPolicy'] = b64(tool.canonical_bytes(np))
                case['newPayload'] = b64(tool.canonical_bytes(nq))
            except tool.Refused as e:
                case['code'] = e.code
            cases.append(case)
    print(json.dumps({'manifest': b64(manifest), 'manifestSha256': msha, 'files': {k: b64(v) for k, v in files.items()}, 'cases': cases,
                      'constants': {'SOURCE_KEYS': list(tool.SOURCE_KEYS), 'PIN_FILES': tool.PIN_FILES, 'BIND': list(tool.BIND),
                                    'TRUSTED_SOURCE': tool.PRODUCTION['source'], 'ROLES': list(tool.ROLES)}}))


if __name__ == '__main__':
    {'dumps': dumps, 'derive': derive}[sys.argv[1]]()
