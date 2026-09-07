#!/usr/bin/env python3
"""Consolidate observed naming metadata without granting acceptance or ownership."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

FIELDS = ('current_name', 'canonical_name', 'object_type', 'namespace', 'owner',
          'source', 'consumer', 'still_writable', 'read_only_history', 'needs_alias',
          'needs_migration', 'needs_deprecation', 'has_conflict', 'has_ambiguity',
          'multiple_names_same_object', 'same_name_different_objects')

def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def checked_evidence_path(root, row):
    path = (root / row['path']).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('Evidence path escapes its retained source or is missing')
    if path.stat().st_size != row['bytes'] or sha(path) != row['sha256']:
        raise ValueError('Evidence digest mismatch: '+row['path'])
    return path

def verify_catalog(catalog, expected_project):
    if catalog['project_id'] != expected_project:
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
        reverse = re.search(r'LIMIT\s+(\d+)\s+OFFSET\s+(\d+)\s*;?\s*$', page['query'], re.I)
        bounds = tuple(map(int, window.groups())) if window else (
            tuple(reversed(tuple(map(int, reverse.groups())))) if reverse else None)
        if (bounds != (number * page_size, page_size)
                or len(page['rows']) != min(page_size, expected_count - number * page_size)
                or page.get('project_id', catalog['project_id']) != catalog['project_id']):
            raise ValueError('Supabase page window or project mismatch')
    return rows

def retained_tool_object(path):
    response = load(path)['tool_response']
    if response.get('status') == 'fulfilled':
        response = response['value']
    if response.get('isError', False) is not False:
        raise ValueError('Retained tool reported failure')
    text_blocks = [block['text'] for block in response['content'] if block['type'] == 'text']
    if len(text_blocks) != 1:
        raise ValueError('Ambiguous retained tool response')
    return json.loads(text_blocks[0])

def verify_supplement(root, scope_sha256):
    """Validate retained observations; this does not issue review authority."""
    if root is None:
        return {}, [], None
    index = load(root/'SourceIndex.json')
    if index['schema'] != 'clued.naming-supplement-index/v1' or index['scope_sha256'] != scope_sha256:
        raise ValueError('Supplement scope binding mismatch')
    expected = {row['path'] for row in index['files']}
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*')
              if p.is_file() and p.name not in ('.gitattributes', 'SourceIndex.json')}
    if expected != actual or len(expected) != len(index['files']):
        raise ValueError('Supplement source set mismatch')
    for row in index['files']:
        checked_evidence_path(root, row)
    resolved, records = {}, []
    sites_path = root/'sites/sources/site-retirement.json'
    if sites_path.is_file():
        sites = load(sites_path)
        resource = sites['covered_resource']
        project_id = 'appgprj_6a8a7bff59548191b5250e5c28b8c80c'
        if (sites['schema'] != 'clued.historical-sites-retirement-evidence/v1'
                or resource['project_id'] != project_id
                or resource['hostname'] != 'clued-cloud.tdoljyj.chatgpt.site'
                or sites['status'] != 'REMOVED'
                or sites['historical_deletion']['user_authorization_recorded'] is not True
                or sites['historical_deletion']['permanent_deletion_confirmation_recorded'] is not True
                or sites['source_preservation']['hosting_project_id_verified'] != project_id
                or sites['scope_disposition']['claims_all_sites_absent'] is not False
                or sites['scope_disposition']['new_deletion_or_deployment_performed'] is not False):
            raise ValueError('Sites retirement subject or disposition mismatch')
        for ref in sites['evidence_refs']:
            checked_evidence_path(root/'sites', ref)
        hosting = load(root/'sites/evidence/sites-hosting-at-source-preservation.json')
        if hosting['project_id'] != project_id:
            raise ValueError('Sites preserved source identity mismatch')
        for filename in ('sites-get-site-response.json', 'sites-list-versions-response.json'):
            response = load(root/'sites/evidence'/filename)['structuredContent']
            if response['error_code'] != 'NOT_FOUND' or response['error_data']['code'] != 404:
                raise ValueError('Sites exact-object absence not corroborated')
        log = (root/'sites/evidence/sites-retirement-log-section.md').read_text(encoding='utf-8-sig')
        if '已永久删除 Clued' not in log or resource['hostname'] not in log:
            raise ValueError('Sites historical deletion record missing')
        resolved['NSI-GAP-SITES'] = {'status':'REMOVED','subject':resource,
            'evidence':'sites/sources/site-retirement.json',
            'basis':'Preserved contemporaneous deletion record, exact source identity and present exact-object absence. No new deletion.'}
        for kind, name in [('historical_sites_project', project_id), ('historical_sites_hostname', resource['hostname'])]:
            records.append(make_record(name, kind, {'input':'supplement','path':'sites/sources/site-retirement.json'},
                'sites:'+project_id, still_writable=False, read_only_history=True, observed_lifecycle='REMOVED'))
    library_path = root/'sites/sources/library-partial-metadata.json'
    if library_path.is_file():
        library = load(library_path)
        # Known retained references improve the inventory but never prove a complete live listing.
        for i, row in enumerate(library['records']):
            records.append(make_record(row['library_path'], 'historical_library_reference',
                {'input':'supplement','path':'sites/sources/library-partial-metadata.json','pointer':f'/records/{i}'},
                'chatgpt_library', observed_file_id=row['file_id'], observed_library_file_id=row['library_file_id'],
                live_rechecked=False))
    restore_path = root/'supabase/restore-catalog.json'
    if restore_path.is_file():
        project = 'gfnfxbphsdtayoaxitly'
        catalog = load(restore_path)['data']
        rows = verify_catalog(catalog, project)
        for filename, state in [('project-before.json','INACTIVE'),
                                ('restore-active-before.json','ACTIVE_HEALTHY'),
                                ('restore-active-after.json','ACTIVE_HEALTHY'),
                                ('project-final.json','INACTIVE')]:
            observed = retained_tool_object(root/'supabase'/filename)
            if observed['id'] != project or observed['status'] != state:
                raise ValueError('Restore project lifecycle is incomplete or mismatched')
        for filename in ('restore-response.json','pause-response.json'):
            if retained_tool_object(root/'supabase'/filename).get('success') is not True:
                raise ValueError('Restore or re-pause operation did not succeed')
        identities = sorted(tuple(row[k] for k in ('kind','schema_name','parent','name','detail')) for row in rows)
        identity_bytes = '\x1e'.join('\x1f'.join(row) for row in identities).encode('utf-8')
        digest = hashlib.md5(identity_bytes).hexdigest()
        final = catalog['final_catalog_digest'][0]
        if final['total_count'] != len(rows) or final['distinct_count'] != len(rows) or final['naming_identity_md5'] != digest:
            raise ValueError('Restore catalog differs from final database identity set')
        raw_final = retained_tool_object(root/'supabase/restore-final-catalog-digest.json')['result']
        normalized = raw_final.replace('\\n', '\n').replace('\\"', '"')
        match = re.search(r'<untrusted-data-[^>]+>\s*(\[[\s\S]*?\])\s*</untrusted-data-[^>]+>', normalized)
        if match is None:
            raise ValueError('Final database digest lacks its retained tool response')
        final_rows = json.loads(match.group(1))
        if (len(final_rows) != 1 or final_rows[0]['total_count'] != len(rows)
                or final_rows[0]['distinct_count'] != len(rows)
                or final_rows[0]['naming_identity_md5'] != digest):
            raise ValueError('Final database tool result does not match the enumerated identities')
        for i, row in enumerate(rows):
            records.append(make_record(row['name'], 'supabase_'+row['kind'],
                {'input':'supplement','path':'supabase/restore-catalog.json','row':i},
                'supabase:'+project+':'+row['schema_name'], observed_parent=row['parent'],
                observed_type_or_signature=row['detail'], observed_project_status='INACTIVE'))
        resolved['NSI-GAP-RESTORE'] = {'status':'SCANNED','subject':{'project_id':project},
            'evidence':'supabase/restore-catalog.json','records':len(rows),
            'identity_set_sha256':hashlib.sha256(identity_bytes).hexdigest(),
            'final_project_status':'INACTIVE',
            'basis':'Captured while ACTIVE_HEALTHY, final server identity-set digest matches every enumerated name, and the original paused state was restored.'}
    return resolved, records, sha(root/'SourceIndex.json')

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
    rows = verify_catalog(catalog, index['source_accounts']['supabase_production_project'])
    cf_pages = load(root/'sources/cloudflare-deployments-and-dns.json')['data'] + load(root/'sources/cloudflare-versions-remaining.json')['data']
    all_cf_pages = load(root/'sources/cloudflare-lists.json')['data'] + cf_pages
    details = load(root/'sources/cloudflare-worker-details.json')['data']
    pages_config = load(root/'sources/cloudflare-pages-config.json')['data']
    for response in [*details, pages_config]:
        if response.get('success') is not True or response.get('status') != 200 or response.get('errors'):
            raise ValueError('Cloudflare detail request failed')
    worker_names = {item['id'] for page in all_cf_pages
                    if page['source'] == 'workers' for item in page['result']}
    # The retained worker listing labels its source workers_scripts.
    if not worker_names:
        worker_names = {item['id'] for page in all_cf_pages
                        if '/workers/scripts' in page['path'] and page['path'].endswith('/workers/scripts')
                        for item in page['result']}
    expected_details = {(worker, leaf) for worker in worker_names
                        for leaf in ('settings', 'secrets', 'deployments', 'subdomain')}
    observed_details = [(page['worker'], page['leaf']) for page in details]
    if not worker_names or set(observed_details) != expected_details or len(observed_details) != len(expected_details):
        raise ValueError('Cloudflare worker detail coverage mismatch')
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

def consolidate(repo_manifest, findings, external_root, output, supplemental_root=None):
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
    if supplemental_root is not None:
        supplement_index = load(supplemental_root/'SourceIndex.json')
        delegation_path = 'docs/execution-plans/phase2-structure-governance/ExecutionDelegation_20260907.json'
        observed_delegation = next((item for item in r['files'] if item['path'] == delegation_path), None)
        if (observed_delegation is None
                or observed_delegation['content_sha256'] != supplement_index['delegation_sha256']
                or supplement_index['delegation_record_id'] != 'CLUED_PHASE2_USER_DELEGATION_20260907'
                or supplement_index['authority_effect'] != 'OBSERVATIONS_AND_SCOPED_INVENTORY_DISPOSITIONS_ONLY'):
            raise ValueError('Supplement does not bind the scanned task delegation')
        ancestry = subprocess.run(['git','-C',str(Path(__file__).resolve().parents[1]),
                                  'merge-base','--is-ancestor',supplement_index['source_repository_commit'],
                                  source_lock['commit_sha']], capture_output=True)
        if ancestry.returncode != 0:
            raise ValueError('Supplement source commit is not a verified ancestor of the scanned source')
    resolved_gaps, supplemental_records, supplemental_index_hash = verify_supplement(
        supplemental_root, source_lock['scope_sha256'])
    records = []
    directories = set()
    for i, f in enumerate(r['files']):
        records.append(make_record(f['path'], 'repository_path', {'input':'repository','pointer':f'/repository_inventory/files/{i}'}, 'repository', observed_blob=f['git_blob_sha1']))
        directories.update(str(p) for p in Path(f['path']).parents if str(p) != '.')
    for name in sorted(directories):
        records.append(make_record(name.replace('\\','/'), 'repository_directory', {'input':'repository','derived_from':'tracked paths'}, 'repository'))
    for i,t in enumerate(r['identifier_index']):
        records.append(make_record(t['token'], 'observed_identifier', {'input':'repository','pointer':f'/repository_inventory/identifier_index/{i}'}, occurrence_count=t['occurrence_count'], observed_types=t['types']))
    typed = r.get('typed_surface_inventory')
    if typed:
        for i, row in enumerate(typed['records']):
            records.append(make_record(row['current_name'], row['surface_kind'],
                {'input':'repository','pointer':f'/repository_inventory/typed_surface_inventory/records/{i}'},
                observed_rule=row['rule_id'], observed_source_path=row['path'], observation_only=True))
        for i, row in enumerate(typed['unresolved']):
            records.append(make_record('UNKNOWN', 'unresolved_naming_site',
                {'input':'repository','pointer':f'/repository_inventory/typed_surface_inventory/unresolved/{i}'},
                observed_rule=row['rule_id'], observed_source_path=row['path'],
                expression_sha256=row['expression_sha256'], unresolved_reason=row['reason'], observation_only=True))
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
        if page['leaf']=='secrets':
            for j,secret in enumerate(page['result']):
                add_cf(secret['name'],'worker_secret_name','cloudflare-worker-details.json',f'/{i}/result/{j}',ns)
    for file in ('cloudflare-deployments-and-dns.json','cloudflare-versions-remaining.json'):
        for i,page in enumerate(data(file)):
            for j,row in enumerate(page['result']):
                add_cf(row.get('name') or row.get('pattern') or row.get('url') or row.get('id'), 'cloudflare_'+page['source'], file, f'/{i}/result/{j}', 'cloudflare:'+page['path'])
    for i,env in enumerate(data('cloudflare-pages-config.json')['result']['deployment_configs']):
        add_cf(env['environment'],'pages_environment','cloudflare-pages-config.json',f'/result/deployment_configs/{i}', 'cloudflare:clued-prototype-pwa')
        for key, names in env.items():
            if key.endswith('_names'):
                for j,name in enumerate(names):
                    add_cf(name,'pages_'+key,'cloudflare-pages-config.json',f'/result/deployment_configs/{i}/{key}/{j}', 'cloudflare:clued-prototype-pwa:'+env['environment'])
    records.extend(supplemental_records)
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
    gaps = [gap for gap in gaps if gap['id'] not in resolved_gaps]
    if typed is None:
        gaps.append({'id':'NSI-GAP-TYPED-SURFACES','surface':'REPOSITORY_TEXT_IDENTIFIERS','status':'PARTIAL',
                     'owner_role':'inventory_maintainer','next_action':'Inventory actual API/RPC/routes, package/module and role/capability/scope naming sites; preserve a rule denominator and unresolved sites.'})
    else:
        gaps.append({'id':'NSI-GAP-TYPED-RULE-REVIEW','surface':'REPOSITORY_TEXT_IDENTIFIERS','status':'PARTIAL',
                     'owner_role':'inventory_reviewer','next_action':'Review the extracted naming-site denominator and disposition unresolved expressions against the fixed baseline; literal extraction alone is not complete semantic coverage.'})
    if r['skipped_text_files']:
        gaps.append({'id':'NSI-GAP-TEXT','surface':'REPOSITORY_TEXT_IDENTIFIERS','status':'PARTIAL','owner_role':'inventory_maintainer','next_action':'Disposition skipped selected text files using exact sources; binary signatures may justify explicit content exclusion.'})
    if any(f.get('json_parse_status') == 'invalid' for f in r['files']):
        gaps.append({'id':'NSI-GAP-JSON-PARSE','surface':'REPOSITORY_TEXT_IDENTIFIERS','status':'PARTIAL','owner_role':'inventory_maintainer','next_action':'Resolve malformed selected JSON before claiming structured identity coverage.'})
    if any(f.get('read_status') == 'missing_from_checkout' for f in r['files']):
        gaps.append({'id':'NSI-GAP-MISSING-FILE','surface':'REPOSITORY_TRACKED_PATHS','status':'PARTIAL','owner_role':'inventory_maintainer','next_action':'Materialize missing tracked files and repeat the affected scan.'})
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
             'supplemental_source_index_sha256':supplemental_index_hash,
             'resolved_source_gaps':resolved_gaps,
             'record_file':records_path.name,'record_file_sha256':sha(records_path),'record_count':len(records),
             'counts':{'repository_paths':len(r['files']),'directory_names':len(directories),'identifier_tokens':len(r['identifier_index']),
                       'structured_fields':len(r['structured_identity_fields']),'supabase_catalog':len(catalog),'cloudflare_records':cf_records,
                       'supplemental_records':len(supplemental_records),
                       'typed_surface_records':len(typed['records']) if typed else 0,
                       'unresolved_typed_sites':len(typed['unresolved']) if typed else None,
                       'truncated_token_locations':sum(bool(x['locations_truncated']) for x in r['identifier_index']), 'long_structured_values':truncated},
             'coverage':coverage,'gaps':gaps,'observation_dispositions':dispositions,
             'record_attribute_policy':'UNKNOWN is explicit absence of a verified binding. Ownership/alias/copy/consumer/semantic closure remains at Steps 4-8; account ownership does not grant namespace delegation.',
             'source_policy':'Snapshots were collected over a recorded window, not atomically across services. Source changes invalidate dependent observations under I1/I4; no indefinite freshness claim.',
             'scope_limit':'Selected text and identity rules are observational, not a semantic parser or completed runtime consumer binding. This file does not turn an incomplete source into N/A.'}
    (output/'NamingSurfaceInventoryConsolidated.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
    lines=['# Step 3 Naming 盘点补证','',f"受查提交：`{source_lock['commit_sha']}`。",'',
           f"统一记录：{len(records)}；数据库目录：{len(catalog)}；Cloudflare 记录：{cf_records}。",'',
           ('**阶段判定：NOT_READY，尚不能宣布全量盘点收口或进入 Step 4。**' if gaps else '**阶段判定：REQUIRES_REVIEW，等待对应源和规则的实际审核决定。**'),'',
           '| 来源类别 | 当前结果 |','|---|---|']
    lines += [f"| {c['surface_id']} | {c['status']} |" for c in coverage]
    lines += ['', '待补证项：']+[f"- {g['id']}：{g['next_action']}" for g in gaps]
    lines += ['', '所有记录包含固定基线要求的 16 项属性；未知值显式保留。账号归用户所有的说明已记录，不以假设存在其他用户阻断；剩余缺口是来源可达性与精确元数据。',
              '未执行命名迁移、改名、业务数据写入或接受/冻结决定。补证中既有恢复测试项目临时启用并重新暂停的操作及最终状态单独保留。']
    (output/'Step3Summary.md').write_text('\n'.join(lines)+'\n',encoding='utf-8',newline='\n')
    return summary

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--repository-inventory',type=Path,required=True)
    p.add_argument('--findings',type=Path,required=True)
    p.add_argument('--external-dir',type=Path,required=True)
    p.add_argument('--output-dir',type=Path,required=True)
    p.add_argument('--supplemental-dir',type=Path)
    a=p.parse_args()
    result=consolidate(a.repository_inventory,a.findings,a.external_dir,a.output_dir,a.supplemental_dir)
    print(json.dumps({'status':result['status'],'step3_gate':result['step3_gate'],'records':result['record_count'],'gaps':[g['id'] for g in result['gaps']]},sort_keys=True))

if __name__=='__main__':
    main()
