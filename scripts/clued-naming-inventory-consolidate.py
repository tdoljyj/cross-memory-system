#!/usr/bin/env python3
"""Consolidate observed naming metadata without granting acceptance or ownership."""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
import re
from pathlib import Path

FIELDS = ('current_name', 'canonical_name', 'object_type', 'namespace', 'owner',
          'source', 'consumer', 'still_writable', 'read_only_history', 'needs_alias',
          'needs_migration', 'needs_deprecation', 'has_conflict', 'has_ambiguity',
          'multiple_names_same_object', 'same_name_different_objects')

def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def verify_sources(root):
    index = load(root / 'SourceIndex.json')
    actual = {p.relative_to(root).as_posix() for p in (root / 'sources').rglob('*') if p.is_file()}
    expected = {r['path'] for r in index['files']}
    if actual != expected or len(expected) != len(index['files']):
        raise ValueError('External source set mismatch')
    for row in index['files']:
        path = root / row['path']
        if path.stat().st_size != row['bytes'] or sha(path) != row['sha256']:
            raise ValueError('External source digest mismatch: '+row['path'])
    catalog = load(root / 'sources/supabase-catalog.json')['data']
    if catalog['project_id'] != index['source_accounts']['supabase_production_project']:
        raise ValueError('Supabase catalog project binding mismatch')
    pages = catalog['pages']
    rows = [r for p in pages for r in p['rows']]
    expected_count = catalog['pagination']['total_count']
    identities = {(r['kind'], r['schema_name'], r['parent'], r['name'], r['detail']) for r in rows}
    if len(rows) != expected_count or len(identities) != expected_count or any(r['total_count'] != expected_count for r in rows):
        raise ValueError('Supabase catalog missing, duplicate, or drifting page')
    if len(pages) != catalog['pagination']['pages']:
        raise ValueError('Supabase page count mismatch')
    page_size = catalog['pagination']['page_size']
    if not catalog['pagination'].get('complete') or page_size <= 0:
        raise ValueError('Supabase pagination incomplete')
    for number, page in enumerate(pages):
        window = re.search(r'OFFSET\s+(\d+)\s+LIMIT\s+(\d+)\s*;?\s*$', page['query'], re.I)
        if (not window or tuple(map(int, window.groups())) != (number * page_size, page_size)
                or len(page['rows']) != min(page_size, expected_count - number * page_size)
                or page.get('project_id', catalog['project_id']) != catalog['project_id']):
            raise ValueError('Supabase page window or project mismatch')
    cf_pages = load(root/'sources/cloudflare-deployments-and-dns.json')['data'] + load(root/'sources/cloudflare-versions-remaining.json')['data']
    all_cf_pages = load(root/'sources/cloudflare-lists.json')['data'] + cf_pages
    groups = {}
    for page in all_cf_pages:
        if page.get('success') is not True or page.get('status') != 200 or page.get('errors'):
            raise ValueError('Cloudflare source request failed')
        groups.setdefault((page['source'], page['path']), []).append(page)
    for group in groups.values():
        info = group[0].get('result_info')
        if info is None:
            continue  # These retained endpoints return an unpaginated collection.
        total = info['total_count']
        size = info['per_page']
        expected_pages = max(1, (total + size - 1) // size) if size > 0 else 0
        numbers = [page['result_info']['page'] for page in group]
        items = [item for page in group for item in page['result']]
        identities = [item.get('id') for item in items]
        if (sorted(numbers) != list(range(1, expected_pages + 1)) or len(items) != total
                or len(identities) != len(set(identities))
                or any(page['result_info']['total_count'] != total
                       or page['result_info']['per_page'] != size
                       or page['result_info'].get('count', len(page['result'])) != len(page['result'])
                       for page in group)):
            raise ValueError('Cloudflare collection pagination mismatch')
    for group in ('worker_versions_prod', 'worker_versions_canary'):
        selected = [p for p in cf_pages if p['source'] == group]
        if not selected or len({p['path'] for p in selected}) != 1:
            raise ValueError('Cloudflare version source missing or mixed')
        ids = [r['id'] for p in selected for r in p['result']]
        total = selected[0]['result_info']['total_count']
        if len(ids) != total or len(set(ids)) != total or any(p['result_info']['total_count'] != total for p in selected):
            raise ValueError('Cloudflare version pagination mismatch')
    return index, rows, cf_pages

def make_record(name, kind, source, namespace='UNKNOWN', **extra):
    row = dict.fromkeys(FIELDS, 'UNKNOWN')
    row.update(current_name=str(name), object_type=kind, source=source, namespace=namespace)
    row.update(extra)
    identity = json.dumps([kind, str(name), source, namespace], ensure_ascii=False, sort_keys=True)
    row['record_id'] = 'NSI-'+hashlib.sha256(identity.encode()).hexdigest()[:24]
    return row

def consolidate(repo_manifest, findings, external_root, output):
    source_index, catalog, cf_pages = verify_sources(external_root)
    original = load(repo_manifest)
    observations = load(findings)
    if (source_index.get('authority_effect') != 'NONE'
            or source_index['scope_record_id'] != original['scope_contract']['record_id']
            or source_index['scope_sha256'] != original['source_lock']['scope_sha256']):
        raise ValueError('External sources do not bind repository scope')
    if observations['source_manifest_record_id'] != original['record_id']:
        raise ValueError('Findings do not bind source inventory')
    if original['authority_effect'] != 'NONE':
        raise ValueError('Inventory cannot carry authority')
    r = original['repository_inventory']
    if any(t.get('locations_truncated') or len(t['locations']) != t['occurrence_count'] for t in r['identifier_index']):
        raise ValueError('Repository identifier occurrence locations are incomplete')
    output.mkdir(parents=True, exist_ok=True)
    data = lambda filename: load(external_root/'sources'/filename)['data']
    source_lock = original['source_lock']
    records = []
    directories = set()
    for i, f in enumerate(r['files']):
        records.append(make_record(f['path'], 'repository_path', {'input':'repository','pointer':f'/repository_inventory/files/{i}'}, 'repository', observed_blob=f['git_blob_sha1']))
        directories.update(str(p) for p in Path(f['path']).parents if str(p) != '.')
    for name in sorted(directories):
        records.append(make_record(name.replace('\\','/'), 'repository_directory', {'input':'repository','derived_from':'tracked paths'}, 'repository'))
    for i,t in enumerate(r['identifier_index']):
        records.append(make_record(t['token'], 'observed_identifier', {'input':'repository','pointer':f'/repository_inventory/identifier_index/{i}'}, occurrence_count=t['occurrence_count'], observed_types=t['types']))
    for i,f in enumerate(r['structured_identity_fields']):
        if f['value'] is None or isinstance(f['value'], (bool, int, float)):
            continue
        records.append(make_record(f['value'], 'structured_identity_field', {'input':'repository','pointer':f'/repository_inventory/structured_identity_fields/{i}'}, observed_field=f['field'], value_truncated=f.get('value_truncated',False), original_value_sha256=f.get('original_value_sha256')))
    g = original['github_inventory'] or {}
    for category in ('branches','tags','releases','workflows','artifacts'):
        for i,row in enumerate(g.get(category, [])):
            records.append(make_record(row.get('name') or row.get('tag_name') or row.get('id'), 'github_'+category, {'input':'repository','pointer':f'/github_inventory/{category}/{i}'}, 'github:'+source_lock['repository']))
            for j,a in enumerate(row.get('assets', [])):
                records.append(make_record(a['name'], 'github_release_asset', {'input':'repository','pointer':f'/github_inventory/{category}/{i}/assets/{j}'}, 'github:'+source_lock['repository']))
    for i,row in enumerate(catalog):
        project_id = source_index['source_accounts']['supabase_production_project']
        records.append(make_record(row['name'], 'supabase_'+row['kind'], {'input':'supabase-catalog.json','row':i}, 'supabase:'+project_id+':'+row['schema_name'], observed_parent=row['parent'], observed_type_or_signature=row['detail']))
    for i,p in enumerate(data('supabase-projects.json')['projects']):
        records.append(make_record(p['name'], 'supabase_project', {'input':'supabase-projects.json','pointer':f'/projects/{i}'}, 'supabase:'+p['id'], observed_status=p['status']))
    cf_records = 0
    def add_cf(name, kind, file, pointer, namespace, **extra):
        nonlocal cf_records
        records.append(make_record(name, kind, {'input':file,'pointer':pointer}, namespace, **extra))
        cf_records += 1
    for i,page in enumerate(data('cloudflare-lists.json')):
        for j,row in enumerate(page['result']):
            add_cf(row.get('name') or row.get('hostname') or row.get('id'), 'cloudflare_'+page['source'], 'cloudflare-lists.json', f'/{i}/result/{j}', 'cloudflare:'+page['path'])
    for i,page in enumerate(data('cloudflare-worker-details.json')):
        ns='cloudflare:'+page['worker']
        if page['leaf']=='settings':
            for j,b in enumerate(page['result']['bindings']):
                add_cf(b['name'],'worker_binding','cloudflare-worker-details.json',f'/{i}/result/bindings/{j}',ns,observed_binding_type=b['type'])
        if page['leaf']=='deployments':
            for j,d in enumerate(page['result']['deployments']):
                add_cf(d['id'],'worker_deployment','cloudflare-worker-details.json',f'/{i}/result/deployments/{j}',ns)
    for file in ('cloudflare-deployments-and-dns.json','cloudflare-versions-remaining.json'):
        for i,page in enumerate(data(file)):
            for j,row in enumerate(page['result']):
                add_cf(row.get('name') or row.get('pattern') or row.get('url') or row.get('id'), 'cloudflare_'+page['source'], file, f'/{i}/result/{j}', 'cloudflare:'+page['path'])
    for i,env in enumerate(data('cloudflare-pages-config.json')['result']['deployment_configs']):
        add_cf(env['environment'],'pages_environment','cloudflare-pages-config.json',f'/result/deployment_configs/{i}', 'cloudflare:clued-prototype-pwa')
    ids=[r['record_id'] for r in records]
    if len(ids)!=len(set(ids)) or any(set(FIELDS)-r.keys() for r in records):
        raise ValueError('Record identity collision or missing required field')
    records_path=output/'NamingSurfaceInventoryRecords.jsonl'
    with records_path.open('w',encoding='utf-8',newline='\n') as f:
        for record in records:
            f.write(json.dumps(record,ensure_ascii=False,separators=(',',':'))+'\n')
    gaps=[
        {'id':'NSI-GAP-LIBRARY','surface':'CHATGPT_LIBRARY_METADATA','status':'UNAVAILABLE','owner_role':'operator_with_Library_access','next_action':'Restore readable Library metadata channel or supply existing metadata export; do not assume empty or N/A.'},
        {'id':'NSI-GAP-RESTORE','surface':'SUPABASE_IDENTIFIERS','status':'UNKNOWN','owner_role':'Supabase_account_owner','next_action':'Obtain schema metadata of inactive gfnfxbphsdtayoaxitly from retained evidence or separately authorize restoration; no restore performed.'},
        {'id':'NSI-GAP-AUTH','surface':'SUPABASE_IDENTIFIERS','status':'UNKNOWN','owner_role':'Supabase_configuration_reader','next_action':'Read current auth redirect configuration identifiers using an authorized management channel; source defaults do not prove live settings.'},
        {'id':'NSI-GAP-SITES','surface':'CLOUDFLARE_AND_DEPLOYMENT_IDENTIFIERS','status':'UNKNOWN','owner_role':'historical_Sites_owner','next_action':'Resolve historical clued-cloud.tdoljyj.chatgpt.site identity/retirement; empty current owner/editor listings do not prove retirement.'},
    ]
    if r['skipped_text_files']:
        gaps.append({'id':'NSI-GAP-TEXT','surface':'REPOSITORY_TEXT_IDENTIFIERS','status':'PARTIAL','owner_role':'inventory_maintainer','next_action':'Disposition skipped selected text files using exact sources; binary signatures may justify explicit content exclusion.'})
    truncated=sum(bool(x.get('value_truncated')) for x in r['structured_identity_fields'])
    if truncated:
        gaps.append({'id':'NSI-GAP-LONG-VALUES','surface':'REPOSITORY_TEXT_IDENTIFIERS','status':'PARTIAL','owner_role':'inventory_maintainer','next_action':'Classify long structured values by source pointer and full-value hash before claiming exact name coverage; clipped previews are not complete names.'})
    coverage=[]
    for s in original['scope_contract']['required_surfaces']:
        matching=[gap['id'] for gap in gaps if gap['surface']==s['surface_id']]
        if s['surface_id'] in ('SKILL_MECHANISM_ADAPTER_PROVIDER_IDENTIFIERS', 'CANDIDATE_DECISION_EVIDENCE_RECEIPT_AUTHORIZATION'):
            # Both scope clauses include connected systems, not just repository matches.
            matching = [gap['id'] for gap in gaps]
        status='PARTIAL' if matching else 'SCANNED_WITH_DECLARED_RULESET'
        if s['surface_id']=='CHATGPT_LIBRARY_METADATA': status='UNAVAILABLE'
        if s['surface_id']=='GITHUB_BRANCHES_TAGS_RELEASES_WORKFLOWS_ARTIFACTS' and not g.get('pagination_complete'):
            status='PARTIAL'
            gaps.append({'id':'NSI-GAP-GITHUB','surface':s['surface_id'],'status':'PARTIAL','owner_role':'repository_reader','next_action':'Complete authenticated GitHub pagination.'})
            matching.append('NSI-GAP-GITHUB')
        coverage.append({'surface_id':s['surface_id'],'status':status,'gaps':matching})
    dispositions=[{'finding_id':f['finding_id'],'observed_category':f['category'],'status':'OBSERVED_NOT_ADJUDICATED',
                   'owner_role':'inventory_maintainer' if f['category']=='coverage' else 'namespace_or_identity_reviewer',
                   'next_step':3 if f['category']=='coverage' else (18 if f['category']=='enforcement' else 5),
                   'action':'Resolve the concrete source gap during Step 3.' if f['category']=='coverage' else 'Preserve source evidence; adjudicate namespace, representation and identity meaning at its scheduled step. No automatic rename or severity assignment.'}
                  for f in observations['findings']]
    summary={'schema':'clued.naming-surface-inventory-consolidated/v1','authority_effect':'NONE',
             'status':'INVENTORY_CANDIDATE_NOT_CLOSEOUT','step3_gate':'NOT_READY' if gaps else 'REQUIRES_REVIEW',
             'source_lock':source_lock,'repository_manifest_sha256':sha(repo_manifest),'repository_findings_sha256':sha(findings),
             'external_source_index_sha256':sha(external_root/'SourceIndex.json'),
             'record_file':records_path.name,'record_file_sha256':sha(records_path),'record_count':len(records),
             'counts':{'repository_paths':len(r['files']),'directory_names':len(directories),'identifier_tokens':len(r['identifier_index']),
                       'structured_fields':len(r['structured_identity_fields']),'supabase_catalog':len(catalog),'cloudflare_records':cf_records,
                       'truncated_token_locations':sum(bool(x['locations_truncated']) for x in r['identifier_index']), 'long_structured_values':truncated},
             'coverage':coverage,'gaps':gaps,'observation_dispositions':dispositions,
             'record_attribute_policy':'UNKNOWN is explicit absence of a verified binding. Ownership/alias/copy/consumer/semantic closure remains at Steps 4-8; account ownership does not grant namespace delegation.',
             'source_policy':'Snapshots were collected over a recorded window, not atomically across services. Source changes invalidate dependent observations under I1/I4; no indefinite freshness claim.',
             'scope_limit':'Selected text and identity rules are observational, not a semantic parser or completed runtime consumer binding. This file does not turn an incomplete source into N/A.'}
    (output/'NamingSurfaceInventoryConsolidated.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
    lines=['# Step 3 Naming 盘点补证','',f"受查提交：`{source_lock['commit_sha']}`。",'',
           f"统一记录：{len(records)}；数据库目录：{len(catalog)}；Cloudflare 记录：{cf_records}。",'',
           '**阶段判定：NOT_READY，尚不能宣布全量盘点收口或进入 Step 4。**','',
           '| 来源类别 | 当前结果 |','|---|---|']
    lines += [f"| {c['surface_id']} | {c['status']} |" for c in coverage]
    lines += ['', '待补证项：']+[f"- {g['id']}：{g['next_action']}" for g in gaps]
    lines += ['', '所有记录包含固定基线要求的 16 项属性；未知值显式保留。账号归用户所有的说明已记录，不以假设存在其他用户阻断；剩余缺口是来源可达性与精确元数据。',
              '未执行迁移、改名、停用、数据库写入或接受/冻结决定。']
    (output/'Step3Summary.md').write_text('\n'.join(lines)+'\n',encoding='utf-8',newline='\n')
    return summary

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--repository-inventory',type=Path,required=True)
    p.add_argument('--findings',type=Path,required=True)
    p.add_argument('--external-dir',type=Path,required=True)
    p.add_argument('--output-dir',type=Path,required=True)
    a=p.parse_args()
    result=consolidate(a.repository_inventory,a.findings,a.external_dir,a.output_dir)
    print(json.dumps({'status':result['status'],'step3_gate':result['step3_gate'],'records':result['record_count'],'gaps':[g['id'] for g in result['gaps']]},sort_keys=True))

if __name__=='__main__':
    main()
