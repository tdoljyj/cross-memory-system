"""The package's policy and companion inputs for the configured node (README section 3). The configuration names one reviewed pair
(policyInput, companionInput); they carry the node they were made for: the node profile (`node`), its canonical sha256
(`nodeProfileSha256`), the owner SID the companion runs as (policy `companion.userSid`) and the WSL distribution (policy
`linux.distribution`, companion `companion.distribution`). build-package.mjs refuses inputs whose node is not the record's
(PACKAGE_NODE_PROFILE_CHANGED), so for another node (a first install, README section 8) these fields are taken from the configured node's
profile in the commit's tree; nothing else changes. The base node's own values must sit exactly in those fields, and none of them may be
left anywhere else in the outputs (NODE_INPUT_KEEPS_THE_BASE_NODE). The policy also gets this install's Owner decision and receipt
(`ownerAcceptance`; build-package keeps the input's). Create-only.
  python -I node-inputs.py <config.json> <tree> <decision-uuid> <receipt-uuid> <out-policy.json> <out-companion.json>
"""
import importlib.util, json, os, re, sys

spec = importlib.util.spec_from_file_location('rconfig', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rconfig.py'))
rconfig = importlib.util.module_from_spec(spec); spec.loader.exec_module(rconfig)
UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
PROFILE_TEXT = ('hostname', 'nodeName', 'ownerSid', 'controllerSid', 'ownerProfileDirectory', 'runnerService', 'mutationMutex', 'wslDistribution')


def need(ok, code, detail=None):
    if not ok:
        sys.exit('%s %s' % (code, detail) if detail is not None else code)


def derive(policy, companion, profile, profile_sha, decision, receipt):
    base = policy.get('node')
    need(isinstance(base, dict) and companion.get('companion', {}).get('node') == base, 'BASE_INPUTS_NOT_ONE_NODE')
    need(policy.get('companion', {}).get('userSid') == base.get('ownerSid'), 'BASE_POLICY_USER_SID_NOT_ITS_OWNER')
    need(policy.get('linux', {}).get('distribution') == base.get('wslDistribution') == companion['companion'].get('distribution'), 'BASE_DISTRIBUTION_NOT_ITS_NODES')
    p = json.loads(json.dumps(policy)); c = json.loads(json.dumps(companion))
    p['node'] = profile; p['nodeProfileSha256'] = profile_sha
    p['companion']['userSid'] = profile['ownerSid']; p['linux']['distribution'] = profile['wslDistribution']
    p['ownerAcceptance'] = {'decisionRef': decision, 'installReceiptRef': receipt}
    c['companion']['node'] = profile; c['companion']['nodeProfileSha256'] = profile_sha; c['companion']['distribution'] = profile['wslDistribution']
    if isinstance(c.get('status'), dict) and 'node' in c['status']:
        c['status']['node'] = profile['nodeName']
    # nothing of the base node may survive in another field (a path under its profile directory, its runner, its SIDs ...)
    stale = [base[k] for k in PROFILE_TEXT if isinstance(base.get(k), str) and base[k] != profile.get(k)]
    for doc in (p, c):
        text = rconfig.canonical(doc)
        left = [v for v in stale if v in text or json.dumps(v)[1:-1] in text]
        need(not left, 'NODE_INPUT_KEEPS_THE_BASE_NODE', left)
    return p, c


def main(argv):
    cfg = rconfig.load(argv[0])
    tree, decision, receipt, out_policy, out_companion = argv[1:6]
    need(UUID.match(decision) and UUID.match(receipt), 'REFS_SHAPE')
    profile, profile_sha = rconfig.node_profile(cfg, tree)
    with open(cfg['policyInput'], encoding='utf-8') as f:
        policy = json.load(f)
    with open(cfg['companionInput'], encoding='utf-8-sig') as f:
        companion = json.load(f)
    p, c = derive(policy, companion, profile, profile_sha, decision, receipt)
    for path, doc in ((out_policy, p), (out_companion, c)):
        with open(path, 'x', encoding='utf-8', newline='\n') as f:
            f.write(json.dumps(doc, sort_keys=True, separators=(',', ':')))
    print(json.dumps({'node': profile['nodeName'], 'nodeProfileSha256': profile_sha, 'baseNode': policy['node']['nodeName'],
                      'policy': out_policy, 'companion': out_companion}))


if __name__ == '__main__':
    main(sys.argv[1:])
