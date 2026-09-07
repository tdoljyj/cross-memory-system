"""Bounded final-binding review and the four affected projection controls; no full-suite rerun."""
import argparse
import copy
import difflib
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pointer(value, selection):
    if not selection:
        return value
    for key in selection[1:].split('/'):
        key = key.replace('~1','/').replace('~0','~')
        value = value[int(key)] if isinstance(value,list) else value[key]
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--bindings', required=True, type=Path)
    parser.add_argument('--candidate-zip', required=True, type=Path)
    parser.add_argument('--old-generator', required=True, type=Path)
    parser.add_argument('--existing-actual-receipt', required=True, type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    bindings_path = args.bindings.resolve()
    out = bindings_path.parent
    bindings = read(bindings_path)
    core = repo/'scripts/naming-governance'
    actual = read(args.existing_actual_receipt)
    assert actual['exit_code'] == 0 and actual['subject']['sha256'] == sha(bindings_path)
    assert actual['validator_sha256'] == sha(core/'naming_validator.py')
    assert actual['projection_summary']['mismatches'] == actual['projection_summary']['upstream_mismatches'] == []
    selected = lambda role: repo/bindings['inputs'][role]['path']
    projection_binding = read(selected('projection_bindings'))
    generated = repo/bindings['projection_output']

    # Independent of buildModel's implementation: recompute each source hash and each selected lineage pointer.
    source_values, observations = {}, []
    for source_id, meta in projection_binding['sources'].items():
        path = (repo/meta['path']).resolve()
        assert path.is_relative_to(repo) and not path.is_symlink()
        value = read(path) if meta['kind']=='json' else path.read_text(encoding='utf-8')
        source_values[source_id] = value
        observations.append({'source_id':source_id, 'path':meta['path'], 'sha256':sha(path),
                             'matches_selected_digest':sha(path)==meta['sha256']})
    lineage = []
    for row in projection_binding['lineage_checks']:
        expected = row['expected_digest']
        value = pointer(source_values[expected['source_id']], expected['pointer'])
        target = projection_binding['sources'][row['target_source_id']]['sha256']
        lineage.append({'id':row['id'], 'expected_sha256':value, 'actual_sha256':target, 'status':'MATCH' if value==target else 'FAIL'})
    manifest = read(generated/'GovernanceManifest.projection.json')
    fact_checks = []
    for name, selection in projection_binding['facts'].items():
        if selection is None:
            fact_checks.append({'fact':name, 'status':'UNBOUND'})
        else:
            expected = pointer(source_values[selection['source_id']], selection['pointer'])
            observed = manifest['facts'][name]
            fact_checks.append({'fact':name, 'status':'MATCH' if observed['value']==expected else 'FAIL'})
    consumer_rows = manifest['facts']['consumer_bindings']['value']
    decision_facts = {name:manifest['facts'][name] for name in ('step4_decision','step5_decision','step6_decision')}
    root_copy_checks = []
    for source_id, target_name in (('tool-routing','AGENTS.md'),('historical-status','CURRENT_STATUS.md')):
        meta = projection_binding['sources'][source_id]
        root_copy_checks.append({'source_id':source_id, 'path':meta['path'],
            'exact_retained_copy':Path(meta['path']).name=='PreMigration-'+target_name,
            'not_root_output':(repo/meta['path']).resolve() != (repo/target_name).resolve(),
            'sha256':meta['sha256']})
    old_lines = args.old_generator.read_text(encoding='utf-8').splitlines()
    new_lines = selected('projection_generator').read_text(encoding='utf-8').splitlines()
    diff = list(difflib.unified_diff(old_lines,new_lines,fromfile='retained-candidate-generator',tofile='repository-generator',lineterm=''))
    removed = [line[1:] for line in diff if line.startswith('-') and not line.startswith('---')]
    added = [line[1:] for line in diff if line.startswith('+') and not line.startswith('+++')]
    label_only = len(removed)==len(added)==2 and all(
        old.lstrip().startswith("['") and new.lstrip().startswith("['") and
        old.split("', ",1)[1] == new.split("', ",1)[1] for old,new in zip(removed,added))
    output_metadata = []
    for path in sorted(generated.iterdir()):
        row = {'file':path.name,'sha256':sha(path),'bytes':path.stat().st_size}
        if path.suffix=='.json':
            value = read(path)
            if 'sources' in value:
                row['source_metadata_complete'] = all(value['sources'].get(sid,{}).get('sha256')==meta['sha256']
                    and value['sources'].get(sid,{}).get('path')==meta['path'] for sid,meta in projection_binding['sources'].items())
            elif path.name=='StatusMigrationPlan.candidate.json':
                row['source_metadata_complete'] = value['source']['sha256']==projection_binding['sources']['historical-status']['sha256']
        output_metadata.append(row)
    checks = {
        'source_count_19':len(observations)==19,
        'all_source_hashes_match':all(row['matches_selected_digest'] for row in observations),
        'lineage_count_9':len(lineage)==9,
        'all_lineage_matches':all(row['status']=='MATCH' for row in lineage),
        'all_selected_facts_equal_source':all(row['status']=='MATCH' for row in fact_checks),
        'typed_consumers_18':len(consumer_rows)==18 and len({row['consumer_id'] for row in consumer_rows})==18,
        'no_runtime_pass_issued':all(row['gate_requirement']['runtime_gate_pass_claimed_by_this_binding'] is False for row in consumer_rows),
        'three_decisions_observed':all(row['state']=='SOURCE_VALUE_OBSERVED' for row in decision_facts.values()),
        'candidate_status_preserved':manifest['facts']['step6_candidate_status']['value']==source_values['consumers']['status'],
        'aggregate_nulls_not_minted':all(manifest['facts'][key]['value'] is None for key in ('formal_domain_id','formal_program_id','formal_stage_id')),
        'preserved_root_sources_no_self_reference':all(row['exact_retained_copy'] and row['not_root_output'] for row in root_copy_checks),
        'two_generator_label_changes_only':label_only,
        'output_count_12':len(output_metadata)==12,
        'generated_json_source_metadata_complete':all(row.get('source_metadata_complete',True) for row in output_metadata),
        'actual_core_reused_generator_and_matched_outputs':set(actual['projection_summary']['outputs_checked'])=={row['file'] for row in output_metadata},
    }
    independent = {'kind':'INDEPENDENT_FINAL_STEP7_SOURCE_AND_PROJECTION_BINDING_REVIEW',
        'status':'PASS' if all(checks.values()) else 'FAIL', 'reviewer':'/root/step1_verify',
        'authority_effect':'NONE', 'acceptance_issued':False, 'formal_step7_gate':False,
        'scope':'Final 19 source selectors, 9 lineage relationships, typed 18 consumers, three existing decisions, preserved root inputs and exact 12 outputs only.',
        'checks':checks, 'source_observations':observations, 'lineage_checks':lineage, 'fact_checks':fact_checks,
        'root_copy_checks':root_copy_checks, 'generator_diff':diff,
        'old_generator_sha256':sha(args.old_generator), 'new_generator_sha256':sha(selected('projection_generator')),
        'projection_bindings_sha256':sha(selected('projection_bindings')), 'outputs':output_metadata,
        'actual_check_receipt_sha256':sha(args.existing_actual_receipt),
        'limits':['No runtime/auth replay, migration, enforcement or release claim.',
                  'Aggregate nulls remain historical no-global-ID values; each consumer uses its actual source-qualified identity.',
                  'Observed prior scoped decisions are copied exactly; this review issues no Step7/8 acceptance.']}
    write(out/'IndependentStep7BindingReview.json', independent)
    assert independent['status']=='PASS', checks

    scratch = out/'.final-binding-controls'
    if scratch.exists():
        raise ValueError('refuse to overwrite an existing control run; preserve it first')
    scratch.mkdir()
    cases = []
    for name, target in (('readme_registry_drift','PROJECTION_DRIFT'),('pending_to_accepted','PENDING_ACCEPTED'),
                         ('unexecuted_to_pass','UNEXECUTED_PASS'),('accepted_upstream_drift','PROJECTION_DRIFT')):
        case = scratch/name
        case.mkdir()
        fixture_binding = copy.deepcopy(bindings)
        fixture_binding['fixture_only'] = True
        fixture_binding['projection_output'] = (case/'generated').relative_to(repo).as_posix()
        shutil.copytree(generated, case/'generated')
        if name=='readme_registry_drift':
            path = case/'generated/README.governance.md'
            path.write_bytes(path.read_bytes()+b'\nOwner: fixture_intruder\n')
        elif name in ('pending_to_accepted','unexecuted_to_pass'):
            path = case/'generated/GovernanceManifest.projection.json'
            value = read(path)
            if name=='pending_to_accepted':
                value['facts']['step6_candidate_status']['value']='ACCEPTED'
            else:
                value['facts']['consumer_bindings']['value'][0]['gate_requirement']['runtime_gate_pass_claimed_by_this_binding']=True
            write(path,value)
        else:
            path = case/'TypedAuthorizationRegistry.candidate.json'
            value = read(selected('typed_authorization'))
            value['bindings'][0]['scope'] += ' [isolated source drift]'
            write(path,value)
            fixture_binding['inputs']['typed_authorization'].update(path=path.relative_to(repo).as_posix(),sha256=sha(path))
            projection = copy.deepcopy(projection_binding)
            projection['sources']['typed-authorization'].update(path=path.relative_to(repo).as_posix(),sha256=sha(path))
            path = case/'ProjectionBindings.json'
            write(path,projection)
            fixture_binding['inputs']['projection_bindings'].update(path=path.relative_to(repo).as_posix(),sha256=sha(path))
            command = [bindings['node'],str(core/'render-fixture.mjs'),str(selected('projection_generator')),
                       str(path),str(repo),str(case/'generated'),str(scratch)]
            rendered = subprocess.run(command,capture_output=True,text=True,encoding='utf-8')
            assert rendered.returncode==0,rendered.stderr
        path = case/'SourceLocators.json'
        write(path,fixture_binding)
        command = [sys.executable,str(core/'run.py'),'--bindings',str(path),'--source-root',str(repo),
                   '--candidate-zip',str(args.candidate_zip),'--report',str(case/'Receipt.json')]
        result = subprocess.run(command,capture_output=True,text=True,encoding='utf-8',timeout=60)
        (case/'stdout.txt').write_text(result.stdout,encoding='utf-8')
        (case/'stderr.txt').write_text(result.stderr,encoding='utf-8')
        receipt = read(case/'Receipt.json')
        codes = [row['code'] for row in receipt['errors']]
        assert result.returncode==1 and target in codes and 'INVALID_INPUT' not in codes, (name,result.stdout,codes)
        if name=='accepted_upstream_drift':
            assert receipt['projection_summary']['mismatches']==[]
            assert len(receipt['projection_summary']['upstream_mismatches'])==1
        cases.append({'case':name,'target_rule':target,'actual_exit_code':result.returncode,'error_codes':codes,
                      'receipt_sha256':sha(case/'Receipt.json'),'command':command,
                      'upstream_mismatch_count':len(receipt['projection_summary'].get('upstream_mismatches',[]))})
    archive = out/'FinalBindingControls.zip'
    members = []
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as zf:
        for path in sorted(scratch.rglob('*')):
            if path.is_file():
                member = path.relative_to(scratch).as_posix()
                zf.write(path,member)
                members.append({'path':member,'bytes':path.stat().st_size,'sha256':sha(path)})
    with zipfile.ZipFile(archive) as zf:
        for row in members:
            assert hashlib.sha256(zf.read(row['path'])).hexdigest()==row['sha256']
    summary = {'status':'PASS','actual_input_check_reused':{'path':args.existing_actual_receipt.name,
                'sha256':sha(args.existing_actual_receipt),'exit_code':actual['exit_code']},
        'final_projection_controls_executed':4,'cases':cases,'core_rules_sha256':sha(core/'naming_validator.py'),
        'unchanged_13_positive_16_negative_evidence_reused':'Step8ValidatorEvidence_20260907.zip + EvidenceIndex.json',
        'artifact':{'path':archive.name,'bytes':archive.stat().st_size,'sha256':sha(archive),'members':members,
                    'all_member_digests_recomputed_after_pack':True},
        'formal_step8_gate':False,'acceptance_issued':False,'created_at_utc':datetime.now(timezone.utc).isoformat()}
    write(out/'FinalBindingVerification.json',summary)
    # Only this freshly created, fully retained scratch directory is removed; no shared source paths are touched.
    resolved = scratch.resolve()
    assert resolved.parent==out.resolve() and resolved.name=='.final-binding-controls' and resolved.is_relative_to(repo)
    shutil.rmtree(resolved)
    print(json.dumps({'status':'PASS','independent_step7':independent['status'],'final_controls':len(cases),
                      'retained_control_members':len(members),'report':str(out/'FinalBindingVerification.json')},ensure_ascii=False))


if __name__=='__main__':
    main()
