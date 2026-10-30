"""The upgrader configuration of a fresh install for the record's node (clued.independent-ci.resident-upgrader-config/1,
DESIGN section 34.8, build-package --upgrader-config), from the claim-free record of this package. Public values only: the KooYomi project
URL and its publishable key are the ones every page of the service carries (apps/clued-cloud/app/supabase-public-config.ts); the Grant
page origin is the service origin; tokenFile is the installer's fixed target (install-resident.ps1 $UpgradeTokenTarget), never a token.
The written file is validated by the tree's own validateUpgraderConfig before it is used. Create-only.
  python -I upgrader-config.py <record-dir> <out-file> <tree>"""
import json, os, re, subprocess, sys

REC, OUT, TREE = sys.argv[1:4]
manifest = json.load(open(os.path.join(REC, 'record-manifest.json'), encoding='utf-8'))
node = json.load(open(os.path.join(REC, 'acceptance.json'), encoding='utf-8'))['node']
installer = open(os.path.join(TREE, 'work', 'independent-ci-resident-v1', 'windows', 'install-resident.ps1'), encoding='utf-8').read()
target = re.search(r"(?m)^\$UpgradeTokenTarget = '([^']+)'", installer).group(1)
root = re.search(r"(?m)^\$Root = '([^']+)'", installer).group(1)
cfg = {'contract': 'clued.independent-ci.resident-upgrader-config/1', 'node': node['nodeName'], 'nodeProfileSha256': manifest['nodeProfileSha256'],
       'ownerSid': node['ownerSid'], 'root': root, 'supabaseUrl': 'https://ccxsikzwxlolxqlosril.supabase.co',
       'publishableKey': 'sb_publishable_tVKKh7Ok4FhBhHtHyZfwBA_i2RJD2Fg', 'confirmOrigin': 'https://kooyumi.pixelgrav.com', 'tokenFile': target,
       'timeouts': {'drainMaxMinutes': 120, 'drainRetryMinutes': 60, 'deferMaxHours': 24, 'pauseConfirmMs': 600000, 'verifyMaxMs': 2700000, 'grantPollMs': [30000, 120000]},
       'keepGenerations': 3}
assert re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?', cfg['node']) and cfg['root'] == 'C:\\ProgramData\\CluedIndependentCI\\resident', cfg
open(OUT, 'x', encoding='utf-8', newline='\n').write(json.dumps(cfg, indent=2) + '\n')
mod = 'file:///' + os.path.join(TREE, 'work', 'independent-ci-resident-v1', 'upgrader', 'src', 'config.mjs').replace('\\', '/')
check = ("import { validateUpgraderConfig } from " + json.dumps(mod) + "; import fs from 'node:fs';"
         " validateUpgraderConfig(JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))); console.log('UPGRADER_CONFIG_VALID');")
p = subprocess.run(['node', '--input-type=module', '-e', check, OUT], capture_output=True, text=True)
assert p.returncode == 0 and 'UPGRADER_CONFIG_VALID' in p.stdout, ('UPGRADER_CONFIG_REFUSED_BY_THE_TREE', p.stdout, p.stderr[-600:])
print(json.dumps({'upgraderConfig': OUT, 'valid': True, 'nodeProfileSha256': cfg['nodeProfileSha256']}))
