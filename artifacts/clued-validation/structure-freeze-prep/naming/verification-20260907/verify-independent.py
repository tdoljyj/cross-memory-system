import collections, hashlib, json
from pathlib import Path
from datetime import datetime, timezone
OUT=Path(__file__).resolve().parent
EXT=OUT.parent/'external-20260907'
def load(path): return json.loads(path.read_text(encoding='utf-8-sig'))
index=load(EXT/'SourceIndex.json')
scope=EXT.parent/'NamingSurfaceInventoryScope.json'
assert hashlib.sha256(scope.read_bytes()).hexdigest()==index['scope_sha256'], 'SourceIndex scope digest mismatch'
declared=[r['path'] for r in index['files']]
actual=[p.relative_to(EXT).as_posix() for p in (EXT/'sources').rglob('*') if p.is_file()]
assert len(declared)==len(set(declared))==13 and set(declared)==set(actual)
files=[]
for row in index['files']:
    p=EXT/row['path']; data=p.read_bytes()
    actual_hash=hashlib.sha256(data).hexdigest()
    assert len(data)==row['bytes'] and actual_hash==row['sha256'],row['path']
    files.append(dict(path=row['path'],bytes=len(data),sha256=actual_hash,status='VERIFIED'))
catalog=load(EXT/'sources/supabase-catalog.json')['data']
pages=catalog['pages']; sizes=[len(p['rows']) for p in pages]
rows=[r for p in pages for r in p['rows']]
keys=[(r['kind'],r['schema_name'],r['parent'],r['name'],r['detail']) for r in rows]
assert catalog['pagination']['total_count']==1562
assert len(pages)==catalog['pagination']['pages']==16
assert sizes==[100]*15+[62]
assert len(rows)==len(set(keys))==1562
assert all(r['total_count']==1562 for r in rows)
assert keys==sorted(keys), 'Catalog pages not globally sorted by stable identity tuple'
kind_counts=collections.Counter(r['kind'] for r in rows)
counts=load(EXT/'sources/supabase-catalog-counts.json')['data'][0]['catalog_counts']
for singular,plural in [('column','columns'),('function','functions'),('policy','policies'),('relation','relations')]:
    assert kind_counts[singular]==counts[plural]
assert set(r['name'] for r in rows if r['kind']=='schema')==set(counts['schemas'])
cf=load(EXT/'sources/cloudflare-deployments-and-dns.json')['data']+load(EXT/'sources/cloudflare-versions-remaining.json')['data']
cf_results=[]
for source,total,sizes_expected in [('worker_versions_prod',26,[10,10,6]),('worker_versions_canary',2,[2])]:
    selected=sorted((p for p in cf if p['source']==source),key=lambda p:p['result_info']['page'])
    nums=[p['result_info']['page'] for p in selected]
    assert nums==list(range(1,len(selected)+1))
    assert [len(p['result']) for p in selected]==sizes_expected
    assert all(p['success'] and p['status']==200 and p['result_info']['total_count']==total and p['result_info']['count']==len(p['result']) for p in selected)
    ids=[r['id'] for p in selected for r in p['result']]
    assert len(ids)==len(set(ids))==total
    version_numbers=[r['number'] for p in selected for r in p['result']]
    assert version_numbers==list(range(total,0,-1))
    cf_results.append(dict(source=source,pages=nums,rows_per_page=sizes_expected,unique_ids=len(set(ids)),version_numbers_cover_all=True))
result=dict(checked_at_utc=datetime.now(timezone.utc).isoformat(),status='VERIFIED',method='Independent Python assertions, no consolidator imported; stored semantic snapshots only, not new API collection',sources=files,supabase=dict(total=1562,pages=16,rows_per_page=sizes,unique_identity_count=len(set(keys)),globally_sorted=True,kind_counts=dict(collections.Counter(r['kind'] for r in rows)),atomic_snapshot=False),cloudflare=cf_results)
(OUT/'Verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k!='sources'},ensure_ascii=False))
