"""Claim-free record inputs (clued.independent-ci.resident-record-inputs/2) for resident-v2/prepare-record.mjs, for any node.

Shared public values (repository, App and installation ids, the KooYomi public URL and publishable key, the formal role descriptors and
the public signer registry) are read from the record of a reviewed package (configuration `basePackage`, normally the package installed
on the node, or for a new node the one installed on TURING); every record file is checked against that package's own manifest. The
node profile is the one the configuration names, read from the commit's tree; the node's own public fingerprints (configuration
`nodeRecord`: App key id and public-key fingerprint, ci-admission binding id and token pin, ...) replace the base values when given.
Nothing secret is read or written; prepare-record.mjs refuses secret-named fields itself.

References: by default the base record's (DRAFT). A FINAL record names the Owner decision that accepts the new Source:
  --ref <key>=<uuid> ... --owner-decision-ref <uuid> --owner-receipt-ref <uuid> --accepted-at <ISO-8601 Z>
sourceAcceptanceRef and hostQualificationRef also go into every role's controllerRelay and every signer, so they change
ciSourceManifestSha256.

  python -I record-inputs.py <config.json> <tree-root> <commit40> <out.json> [--ref k=v ...] [--owner-decision-ref u]
         [--owner-receipt-ref u] [--accepted-at t] [--valid-until t]
"""
import hashlib, importlib.util, json, os, re, sys

spec = importlib.util.spec_from_file_location('rconfig', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rconfig.py'))
rconfig = importlib.util.module_from_spec(spec); spec.loader.exec_module(rconfig)

CFG, TREE, COMMIT, OUT = sys.argv[1:5]
assert re.fullmatch(r'[0-9a-f]{40}', COMMIT), 'COMMIT_MUST_BE_40_HEX'
assert not os.path.exists(OUT), 'OUTPUT_EXISTS_NEVER_OVERWRITTEN'
args = sys.argv[5:]
def opt(name):
    return args[args.index(name) + 1] if name in args else None
refs_override = dict(args[i + 1].split('=', 1) for i, a in enumerate(args) if a == '--ref')

cfg = rconfig.load(CFG)
REC = os.path.join(cfg['basePackage'], 'record')
REFS = ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef',
        'ownerPackageAcceptanceRef', 'installationReceiptRef']
UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
sha = lambda b: hashlib.sha256(b).hexdigest()
canonical = rconfig.canonical

# the base record, byte for byte the reviewed package's (its manifest pins every record file)
pkg_raw = open(os.path.join(cfg['basePackage'], 'package-manifest.json'), 'rb').read()
pins = {f['target']: f['sha256'] for f in json.loads(pkg_raw)['files']}
raw = {n: open(os.path.join(REC, n), 'rb').read() for n in ('record-manifest.json', 'installation.json', 'acceptance.json', 'source-manifest.json', 'signers.json')}
for n in raw:
    assert sha(raw[n]) == pins.get('record\\' + n), ('BASE_RECORD_FILE_NOT_ITS_PACKAGE', n)
rm = json.loads(raw['record-manifest.json'])
for n, e in rm['files'].items():
    assert sha(raw[n]) == e['sha256'], ('BASE_RECORD_FILE_CHANGED', n)
inst = json.loads(raw['installation.json']); acc = json.loads(raw['acceptance.json']); man = json.loads(raw['source-manifest.json'])
signers = json.loads(raw['signers.json'])
assert all('privateKey' not in s and 'BEGIN PUBLIC KEY' in s['publicKeyPem'] and 'PRIVATE' not in s['publicKeyPem'] for s in signers['signers']), 'SIGNERS_NOT_PUBLIC'

node, node_sha = rconfig.node_profile(cfg)

roles = {}
for r in ('gitleaks', 'trivy', 'contract-placement'):
    roles[r] = {k: v for k, v in man['roles'][r].items() if k not in ('sourceFiles', 'controllerRelay')}

refs = {k: acc[k] for k in REFS}
for k, v in refs_override.items():
    assert k in REFS and UUID.match(v), ('BAD_REF', k)
    refs[k] = v
owner = {'ownerDecisionRef': opt('--owner-decision-ref') or acc['ownerDecisionRef'], 'ownerReceiptRef': opt('--owner-receipt-ref') or acc['ownerReceiptRef'],
         'acceptedAt': opt('--accepted-at') or acc['acceptedAt'], 'validUntil': opt('--valid-until') or acc['validUntil']}
draft = not (refs_override and opt('--owner-decision-ref') and opt('--accepted-at'))
# record.mjs / signed-result.mjs: every signer names the record's sourceAcceptanceRef and hostQualificationRef (qualificationRef). Only
# those two fields of the public registry change; keyId, publicKeyPem, runtimeId and domain stay byte-identical.
for s in signers['signers']:
    if s['sourceAcceptanceRef'] != acc['sourceAcceptanceRef'] or s['qualificationRef'] != acc['hostQualificationRef']:
        sys.exit('BASE_SIGNER_NOT_BOUND_TO_BASE_RECORD')
    s['sourceAcceptanceRef'] = refs['sourceAcceptanceRef']
    s['qualificationRef'] = refs['hostQualificationRef']
# Another node signs its results with its own key (Z1): the configuration's signer replaces the base registry. Without one the base
# node's signer stays: enough for a STANDBY that publishes nothing (Decision d339ddb2), never for a node that takes the role.
if cfg['signer']:
    sg = cfg['signer']
    signers['signers'] = [{'domain': 'production', 'keyId': sg['keyId'], 'publicKeyPem': sg['publicKeyPem'], 'qualificationRef': refs['hostQualificationRef'],
                           'runtimeId': sg['runtimeId'], 'sourceAcceptanceRef': refs['sourceAcceptanceRef']}]

base_values = {k: inst[k] for k in ('appKeyId', 'appPublicKeySha256Base64', 'ciPrincipalBindingId', 'ciPrincipalRoleRef', 'ciTokenPinSha256', 'controllerNodeSha256')}
# review 1-5: another node than the base package's never inherits its identity values; all six come from the configuration
if node['nodeName'] != acc['node']['nodeName'] and set(cfg['nodeRecord']) != set(base_values):
    sys.exit('NODE_RECORD_INCOMPLETE_FOR_ANOTHER_NODE %s' % sorted(set(base_values) - set(cfg['nodeRecord'])))
# review 3-1: nor its connection's qualification (build.ps1 -CiPrincipalQualificationRef)
if node['nodeName'] != acc['node']['nodeName'] and 'ciPrincipalQualificationRef' not in refs_override:
    sys.exit('CI_PRINCIPAL_QUALIFICATION_REF_REQUIRED_FOR_ANOTHER_NODE')
node_values = {**base_values, **cfg['nodeRecord']}
inputs = {
    'contract': 'clued.independent-ci.resident-record-inputs/2', 'repository': inst['repository'], 'sourceCommit': COMMIT, 'scope': inst['scope'],
    'node': node, 'controllerAccount': acc['controllerAccount'],
    'appId': inst['appId'], 'installationId': inst['installationId'], 'repositoryId': inst['repositoryId'], 'appKeyId': node_values['appKeyId'],
    'ciPrincipalBindingId': node_values['ciPrincipalBindingId'], 'ciPrincipalRoleRef': node_values['ciPrincipalRoleRef'], 'ciTokenPinSha256': node_values['ciTokenPinSha256'],
    'appPublicKeySha256Base64': node_values['appPublicKeySha256Base64'], 'supabaseUrl': inst['supabaseUrl'], 'publishableKey': inst['publishableKey'],
    'controllerNodeSha256': node_values['controllerNodeSha256'], 'references': refs, 'owner': owner, 'formalRoles': roles, 'signers': signers,
}
data = (canonical(inputs) + '\n').encode('utf8')
with open(OUT, 'xb') as f:
    f.write(data)
print(json.dumps({'inputs': OUT, 'sha256': sha(data), 'sourceCommit': COMMIT, 'draftReferences': draft, 'references': refs, 'owner': owner,
                  'node': node['nodeName'], 'nodeProfileSha256': node_sha, 'nodeRecordOverrides': sorted(cfg['nodeRecord']),
                  'signerRegistrySha256': sha(canonical(signers).encode('utf8')), 'signerKeyIds': [s['keyId'] for s in signers['signers']],
                  'signerFromConfiguration': bool(cfg['signer'])}, indent=1))
