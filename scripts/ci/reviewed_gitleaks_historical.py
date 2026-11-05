"""PROPOSED exact historical evidence; stdlib only, no scanner or ignore writer."""
import hashlib
import json
import re
import subprocess

H = 'cc353e29a32b991696df95d5fc3f9b9d107e8d1c'
SOURCE_COMMIT = '956078fcec98844ab9be05e857fe4f53b3372fc4'
CATALOG = 'scripts/ci/clued-gated-proof-profiles.json'
ROLES = 'scripts/ci/clued-gated-proof-role-specs.json'
CATALOG_SHA = 'c38d9475c18abd22a426c64cef1fdaca00a341fa59275751cd7bc7a58ca9f2dd'
CATALOG_BLOB = 'eb27cd1676c6dba9a63bdd92b43ae79d8b4c1adb'
ROLES_SHA = 'c6cc098dd1e64b1487441eb326c105c798b8d6b08a7cea4bc434dd7e909a0997'
ROLES_BLOB = '90577b7e1b61a8862145c856f0b35c5cc81ac7bd'
PATCH_SHA = 'aa1a47130618e2a4dd0e5ad5757a52f3b1e21efbf5cfbc5b6642757e66beb83f'
KIND = 'EXACT_ESCAPED_JSON_DOCKER_UID_GID'
SPECS = (
    {'workflow': '.github/workflows/gitleaks.yml', 'index': 5, 'line': 3829,
     'columns': [4107,9705], 'decoded': [86,155],
     'blob': 'ba4690650935961e7f4aa289a3aa0dc874b8b4fd',
     'sha': 'd8daffb6f35d572ada3028f1b372bc9e728edb9d757a6442a702ae423645ff77',
     'role': 'gitleaks-trusted-self-hosted',
     'role_sha': '2325e6f3f3d459f1204a77a842d4726b13cad06e73c1312478a6b9df013882bd'},
    {'workflow': '.github/workflows/trivy.yml', 'index': 3, 'line': 5538,
     'columns': [3846,13689], 'decoded': [83,212],
     'blob': '9867c4c847a61aa33761e27b793e0928bc6cbfdc',
     'sha': 'ef85f4ad53e75d2105c1892600b83b8b70b198dc1518ff856ba53fb6c4053ccb',
     'role': 'trivy-trusted-self-hosted',
     'role_sha': '7745a8c7286ffba75761d8ee00fbb099809318a9bdc6bf52760064d040cefa8f'},
)
FINDINGS = {f'{H}:{CATALOG}:curl-auth-user:{s["line"]}': s for s in SPECS}
RULE_SHA = '8ab46c184e6a18bebfab3c64129b16e167ab08b9e7a3d28c36995081ce6ec4d2'
# Official v8.30.1 rule literal is populated by the bounded local builder.
RULE = '\\bcurl\\b(?:.*|.*(?:[\\r\\n]{1,2}.*){1,5})[ \\t\\n\\r](?:-u|--user)(?:=|[ \\t]{0,5})("(:[^"]{3,}|[^:"]{3,}:|[^:"]{3,}:[^"]{3,})"|\'([^:\']{3,}:[^\']{3,})\'|((?:"[^"]{3,}"|\'[^\']{3,}\'|[\\w$@.-]+):(?:"[^"]{3,}"|\'[^\']{3,}\'|[\\w${}@.-]+)))(?:\\s|\\z)'

def need(ok):
    if not ok:
        raise ValueError('Exact historical candidate proof refused; raw data withheld')

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def blob(raw):
    return hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

def strict_json(raw):
    def pairs(items):
        result = {}
        for key,value in items:
            need(key not in result)
            result[key] = value
        return result
    return json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=pairs,
                      parse_constant=lambda _: need(False))

def regex():
    need(isinstance(RULE,str) and sha(RULE.encode()) == RULE_SHA)
    # Python absolute end is \\Z, unlike JS /$/ and unlike newline-tolerant anchors.
    return re.compile(RULE.replace('\\z','\\Z'), re.ASCII)

def relation(source):
    """Safe booleans/positions only; never return the capture or command."""
    return _relation(source)[0]

def _relation(source):
    need(isinstance(source,str) and source.isascii() and len(source.encode()) <= 524288
         and '\r' not in source and '\x00' not in source)
    encoded = json.dumps(source, ensure_ascii=False, separators=(',',':'))
    matches = list(regex().finditer(encoded))
    if len(matches) != 1:
        return {'eligible': False}, ''
    match = matches[0]
    capture = match.group(1)
    mapping = [None]
    for index,char in enumerate(source):
        mapping.extend([index]*len(json.dumps(char,ensure_ascii=False)[1:-1]))
    need(len(mapping) == len(encoded)-1)
    start = source[:mapping[match.start()]].count('\n')+1
    end = source[:mapping[match.end()-1]].count('\n')+1
    lines=source.split('\n'); first=end-1
    while first>0 and lines[first-1].rstrip().endswith('\\'):
        first-=1
    command='\n'.join(row.lstrip() for row in lines[first:end])
    # The first actual shell command must be docker run, never quoted printf/echo text.
    docker = (re.fullmatch(r'[0-9]+:[0-9]+',capture) is not None
              and re.match(r'\Adocker[ \t]+run(?:[ \t\\]|$)',command) is not None
              and re.search(r'\bcurl\b',command) is None
              and re.search(r'(?:^|\s)(?:-u|--user)(?:=|[ \t]+)'+re.escape(capture)+r'(?=\s|$)',command) is not None)
    good = docker and not list(regex().finditer(source)) and end-start>5
    return {'eligible':bool(good),'decoded_lines':[start,end],
            'captured_is_numeric_docker_uid_gid':bool(docker)}, command

def git(repo,args):
    result=subprocess.run(['git',*args],cwd=repo,capture_output=True,check=False)
    need(result.returncode==0 and len(result.stdout)<=2097152)
    return result.stdout

def load(repo):
    get=lambda name,commit=H: git(repo,['cat-file','blob',commit+':'+name])
    return {'catalog':get(CATALOG),'roles':get(ROLES),
            'patch':git(repo,['diff','--no-ext-diff','--no-textconv','--no-color','--no-renames',
                             '--diff-algorithm=myers','--unified=0',H+'^',H,'--',CATALOG]),
            'sources':{s['workflow']:get(s['workflow'],SOURCE_COMMIT) for s in SPECS}}

def verify(fingerprint,data):
    spec=FINDINGS.get(fingerprint); need(spec is not None)
    raw=data['catalog']; roles_raw=data['roles']
    need(sha(raw)==CATALOG_SHA and blob(raw)==CATALOG_BLOB
         and sha(roles_raw)==ROLES_SHA and blob(roles_raw)==ROLES_BLOB
         and sha(data['patch'])==PATCH_SHA)
    root=strict_json(raw); roles=strict_json(roles_raw)
    need(root['schema']=='clued.gated-proof-profiles/2' and roles['schema']=='clued.gated-proof-role-specs/2')
    profile=root['workflows'][spec['workflow']]['accepted_sources'][spec['index']]
    source=profile['source_yaml']; source_raw=source.encode('utf-8')
    need(profile['workflow_blob']==spec['blob'] and profile['source_sha256']==spec['sha']
         and sha(source_raw)==spec['sha'] and blob(source_raw)==spec['blob']
         and source_raw==data['sources'][spec['workflow']])
    line=raw.decode('utf-8').split('\n')[spec['line']-1]
    encoded=json.dumps(source,ensure_ascii=False,separators=(',',':'))
    need(line.count(encoded)==1)
    added=None; number=0
    for row in data['patch'].decode('utf-8').split('\n'):
        if row.startswith('@@'):
            number=int(re.search(r'\+(\d+)',row).group(1)); continue
        if row.startswith(('+++','---','diff ','index ')): continue
        if row.startswith('+'):
            if number==spec['line']: added=row
            number+=1
        elif row.startswith(' '): number+=1
    need(added=='+'+line)
    matches=list(regex().finditer(added)); need(len(matches)==1)
    match=matches[0]
    need([len(added[:match.start()].encode())+1,len(added[:match.end()].encode())]==spec['columns'])
    result,command=_relation(source)
    need(result['eligible'] and result['decoded_lines']==spec['decoded'])
    selected=roles['workflows'][spec['workflow']]['sources'][spec['blob']]
    need(isinstance(selected,list) and len(selected)==1)
    role=selected[0]
    need(set(role)=={'job_id','definition_sha256','definition'} and role['job_id']==spec['role']
         and role['definition_sha256']==spec['role_sha']
         and sha(canonical(role['definition']).encode())==spec['role_sha'])
    normalize=lambda s:'\n'.join(row.lstrip() for row in s.split('\n')).strip()
    need(any(isinstance(step.get('run'),str) and normalize(command) in normalize(step['run'])
             for step in role['definition']['steps']))
    return {'status':'PROPOSED','clear_candidate_not_authorized':True,
            'runtime_ignore_eligible':False,'fixed_historical_subject_verified':True}
