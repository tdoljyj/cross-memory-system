"""Rebuild this bounded evidence mapping. No tests, authority issuance or network."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
COMMIT = 'f3d0066197c06220d34f825dd59c74bcf968cdfd'
D = 'docs/execution-plans/phase2-structure-governance/'
STATE = 'ENGINEERING_PREPARATION_ONLY'
sources = {}
local_inputs = []

def sha(data):
    return hashlib.sha256(data).hexdigest()

def read(path):
    data = (ROOT / path).read_bytes()
    committed = subprocess.check_output(['git', 'show', f'{COMMIT}:{path}'], cwd=ROOT)
    if data != committed and data.replace(b'\r\n', b'\n') != committed.replace(b'\r\n', b'\n'):
        raise ValueError('Source differs from pinned commit: ' + path)
    sources[path] = {'path': path, 'bytes': len(committed), 'sha256': sha(committed), 'commit': COMMIT,
                     'worktree_sha256': sha(data), 'worktree_byte_relation': 'EXACT' if data == committed else 'LINE_ENDINGS_ONLY'}
    return committed

def doc(path):
    return json.loads(read(path))

def ref(path, pointer=''):
    if path not in sources:
        read(path)
    return {**sources[path], 'pointer': pointer}

def write(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

def local_input(name):
    path = ROOT.parent / 'slice-a-contracts' / name
    data = path.read_bytes()
    record = {'path': str(path), 'bytes': len(data), 'sha256': sha(data),
              'scope': 'Observed extracted candidate input; historical status is not a current authority decision.'}
    local_inputs.append(record)
    return json.loads(data), record

prior_path = 'artifacts/clued-validation/phase2-entry-readiness-20260908/EvidenceIndex.json'
prior = doc(prior_path)
for item in prior['sources']:
    if sha(read(item['path'])) != item['sha256']:
        raise ValueError('Prior source digest mismatch: ' + item['path'])

consumer_path = D + 'step06-bindings-20260907/TypedConsumerRegistry.candidate.json'
auth_path = D + 'step06-bindings-20260907/TypedAuthorizationRegistry.candidate.json'
receipt_path = D + 'step06-bindings-20260907/TypedReceiptRegistry.candidate.json'
target_path = D + 'step13-14-actual-verification-20260907/TargetConsumerBindingManifest.json'
allowed_path = D + 'step15-enforcement-20260907/workflow-review/AllowedDifferences.json'
registry, auth, receipts, target, allowed = map(doc, [consumer_path, auth_path, receipt_path, target_path, allowed_path])
allowed_after = {x['path']: x['after_sha256'] for x in allowed['files']}
rows = []
for index, historical in enumerate(target['consumers']):
    cid = historical['consumer_id']
    typed_index, typed = next((i, c) for i, c in enumerate(registry['consumers']) if c['consumer_id'] == cid)
    bindings = []
    for b in historical['bindings']:
        p = b['target_path']
        current = ref(p)
        expected = allowed_after.get(p, b['actual_sha256'])
        bindings.append({
            'original_path': b['original_path'], 'current_source': current,
            'historical_symbol': b['symbol'], 'historical_sha256': b['actual_sha256'],
            'applicable_step17_expected_sha256': expected,
            'applicability': 'CURRENT_BYTES_MATCH_BOUND_SOURCE' if current['sha256'] == expected else 'CHANGED_SOURCE_REQUIRES_TARGETED_REVIEW',
            'symbol_or_behavior_requalified': False,
        })
    ar = []
    for a in historical['required_authorization']:
        i = int(a['pointer'].split('/')[-1])
        assert auth['bindings'][i]['consumer_id'] == cid
        ar.append(ref(auth_path, a['pointer']))
    rp = historical['required_receipt']['pointer']
    assert receipts['bindings'][int(rp.split('/')[-1])]['consumer_id'] == cid
    rows.append({
        'consumer_id': cid, 'label': typed['label'], 'consumer_type': typed['consumer_type'],
        'governance_domain': typed['domain_id']['identifier'], 'declared_owner': typed['owner'],
        'operations': typed['stage_id'].get('operations', []),
        'current_code_bindings': bindings,
        'typed_consumer_ref': ref(consumer_path, f'/consumers/{typed_index}'),
        'historical_actual_binding_ref': ref(target_path, f'/consumers/{index}'),
        'required_authorization_contracts': ar, 'required_receipt_contract': ref(receipt_path, rp),
        'authority_rule': 'Original source-qualified contracts retained; these references issue no current grant.',
        'failure_behavior_ref': ref(consumer_path, f'/consumers/{typed_index}/failure_behavior'),
        'unknown_behavior_ref': ref(consumer_path, f'/consumers/{typed_index}/unknown_behavior'),
    })
assert len(rows) == 18 and sum(len(r['required_authorization_contracts']) for r in rows) == 27
write('ConsumerMapping.json', {'state': STATE, 'authority_effect': 'NONE', 'source_commit': COMMIT,
    'consumer_count': 18, 'authorization_contract_count': 27, 'receipt_contract_count': 18,
    'observation_boundary': 'Read/hash current pinned source files; historical symbols and runtime behavior are not newly tested.',
    'step17_successor_ref': ref(allowed_path), 'consumers': rows})

skill_files = ['SKILL.md', 'references/engineering.md', 'references/memory-operations.md']
installed_root = Path('C:/Users/Windows/.codex/skills')
skill_rows = []
for name in skill_files:
    source = ref('skills/clued/' + name)
    installed = installed_root / 'clued' / name
    actual = installed.read_bytes()
    skill_rows.append({'source': source, 'installed_path': str(installed), 'installed_sha256': sha(actual),
        'installed_bytes': len(actual), 'source_bytes_equal_installed': source['sha256'] == sha(actual)})
assert all(x['source_bytes_equal_installed'] for x in skill_rows)
updater = ref('scripts/update_clued_skills.py')
read('skills/README.md')
old_rows = []
for name, historical_path in [
    ('clued-developer', D+'step20-skill-20260907/clued-developer/SKILL.md'),
    ('clued-user', D+'step21-skill-20260907/clued-user/SKILL.md'),
    ('clued-continuity', D+'step21-skill-20260907/continuity-routing/SKILL.md')]:
    old_rows.append({'historical_identity': name, 'historical_artifact': ref(historical_path),
        'current_install_path': str(installed_root / name), 'currently_present': (installed_root / name).exists(),
        'documented_successor': 'clued', 'successor_ref': ref('skills/README.md'),
        'retirement_implementation_ref': updater,
        'meaning': 'Updater explicitly retires this named entry; historical acceptance remains bound to its own bytes.'})
alias_ref = ref(D+'step05-identity-20260907/AliasRegistry.candidate.json', '/explicit_dispositions/1')
write('SkillLineage.json', {'state': STATE, 'authority_effect': 'NONE', 'source_commit': COMMIT,
    'active_entry': 'clued', 'skill_source_last_change_commit': 'a1c7e8607d5ed9a6ae78fae302e565ed748d4f66',
    'current_files': skill_rows, 'documented_old_entries': old_rows,
    'projection_routes': [
        {'operation': 'engineering', 'entry': 'skills/clued/SKILL.md', 'reference': 'skills/clued/references/engineering.md',
         'actual_mechanism_refs': [ref('AGENTS.md'), ref('scripts/sync-memory.py'), ref('scripts/sync-memory.ps1')],
         'boundary': 'Authorized checkout alignment and existing trusted publisher/reader; Skill grants no issuer or runtime authority.'},
        {'operation': 'memory', 'entry': 'skills/clued/SKILL.md', 'reference': 'skills/clued/references/memory-operations.md',
         'actual_mechanism_refs': [ref('apps/clued-cloud/worker/continuity.ts')],
         'boundary': 'Formal authenticated Clued service; no repository memory write-back or permission union.'}],
    'unresolved_legacy_identity': {'name': 'clued-kernel-developer', 'identity_status': 'NO_PROVEN_ALIAS_OR_RETIREMENT_CHAIN',
        'currently_present_at_this_host': (installed_root / 'clued-kernel-developer').exists(), 'scope_rule': alias_ref,
        'required_action': 'Bind its actual historical artifact/host/role/consumer if this R13 subject applies; absence alone is not deprecation or N/A.'},
    'not_established': ['Current host discovery in every client', 'R09 mechanism freeze', 'R11 actual Shadow', 'Qualified Skill activation', 'New Binding or expanded privilege']})

readiness_contract, readiness_ref = local_input('ReadinessAndGateCandidate.json')
qualification_plan, qualification_ref = local_input('TestControllerQualificationPlan.json')
stage_rows = [
 {'id':'R07','depends_on':['R06'],'mapped_readiness':['RepositoryDevelopmentMigrationReceipt','ResponsibilityTransferClosureReceipt'],
  'evidence':[ref(D+'step12-actual-migration-20260907/receipt.json'),ref(D+'Step06-ScopedAcceptance_20260907.json'),ref(D+'Step13-ScopedAcceptance_20260907.json'),ref(target_path)],
  'reusable':'64-path migration and scoped 18-consumer wiring are historical actual evidence, retained without rerunning.',
  'dimensions':[
   {'name':'Responsibility','mapping':'ConsumerMapping.json maps every C01–C18 source-qualified domain/owner/operation to actual source paths. No new owner IDs are minted.'},
   {'name':'Authority','mapping':'All 27 typed authorization contract pointers remain exact; they do not constitute active service or controller grants.'},
   {'name':'Evidence','mapping':'All 18 typed receipt contract pointers remain exact; actual Step12/13 records are separately bound.'},
   {'name':'Gate','mapping':'C15 and C18 retain exact validation workflow/receipt entry points; historical result is not a current gate result.'},
   {'name':'Pointer','mapping':'AGENTS.md keeps formal current pointer/immutable bundle reader; this package creates no pointer or canonical write.'},
   {'name':'Compatibility','mapping':'Step13 source-qualified six-tool compatibility remains evidence only where current bytes match or an accepted exact successor applies.'},
   {'name':'Rollback','mapping':'Existing Step12 transaction record and current updater backup/restore code are identified; current end-to-end control-plane rollback qualification is not inferred.'}],
  'gaps':['Accept exact reuse/changed-source dispositions for the R07 subject, including any current responsibilities outside historical 18-consumer scope.','Bind applicable live authority, pointer and rollback actors; governance owner fields are not runtime issuers.'],
  'next_action':'Review the changed consumer rows and complete current scoped transfer mapping; reuse unchanged evidence only within its original boundary.'},
 {'id':'R08','depends_on':['R07'],'mapped_readiness':['CanonicalSemanticNoChangeReceipt'],
  'evidence':[ref(D+'Step17-ScopedAcceptance_20260907.json'),ref(D+'Step15-17-EvidenceRefreshDecision_20260907.json'),ref(allowed_path),ref(D+'AcceptanceAndInvalidation.md')],
  'reusable':'Step17 source722d3b2/run34114596702 and refreshed evidence prove original migration semantics, not subsequent business runtime equivalence.',
  'gaps':['Current changed consumer paths require targeted semantic dispositions; the migration comparison cannot be relabeled as acceptance of later OAuth/project-list behavior.'],
  'next_action':'Bind the R07 change set to semantic invariants and existing applicable successor evidence; run only missing affected comparisons, never reset all historical gates.'},
 {'id':'R09','depends_on':['R08'],'mapped_readiness':['DevelopmentMechanismFreezeReceipt'],
  'evidence':[ref('AGENTS.md'),ref('skills/clued/references/engineering.md'),ref(D+'NamingIntegrityCloseoutDecision_20260907.json')],
  'reusable':'Current vendor-independent workflow instructions, actual consumer paths, trusted publication boundary and scoped naming acceptance are available as inputs.',
  'gaps':['No current accepted DevelopmentMechanismFreezeReceipt located in this bounded source set.','Mechanism subject must bind authority, execution channels, evidence, stop/revocation, rollback and exact immutable identities; naming freeze is not this freeze.'],
  'next_action':'Assemble the precise mechanism review subject from mapped components and retain unknown authority/controller fields; obtain applicable scoped acceptance without modifying old Frozen Registry or pins.'},
 {'id':'R10','depends_on':['R09'],'mapped_readiness':['DevelopmentSkillProjectionReceipt'],
  'evidence':[ref(D+'Step20-SkillProjectionAcceptance_20260907.json'),ref(D+'Step21-SkillProjectionAcceptance_20260907.json'),ref('skills/README.md'),updater]+[x['source'] for x in skill_rows],
  'reusable':'Current unified clued files exactly match installation, with explicit old-entry retirement code and separated engineering/memory references.',
  'gaps':['Current unified projection must bind the actual R09 mechanism subject; old thin-adapter acceptance is not automatically its qualification.','R11 requires accepted qualification profile, independent qualified controller and actual action authorization.'],
  'next_action':'Review SkillLineage.json against the accepted R09 subject, preserve precise old identities, then admit only authorized isolated qualification work.'},
]
for stage in stage_rows:
    index, original = next((i, row) for i, row in enumerate(readiness_contract['source_record']['stage_nodes']) if row['step_id'] == stage['id'])
    assert stage['depends_on'] == original['depends_on']
    stage['stage_definition_ref'] = {**readiness_ref, 'pointer': f'/source_record/stage_nodes/{index}'}
    stage['original_stage_name'] = original['name']
write('ReadinessMapping.json', {'state':STATE,'authority_effect':'NONE','source_commit':COMMIT,
    'no_formal_decisions_issued':True,'stages':stage_rows,
    'separate_current_service_evidence': {
        'refs': [ref('artifacts/clued-validation/project-list-auth-repair-20260908/README.md'),
                 ref('artifacts/clued-validation/project-list-auth-repair-20260908/production-deployment.json')],
        'scope': 'Actual scoped project-list and transport repair; does not requalify every consumer operation, OAuth UI or core Entry.'},
    'later_stage_boundary':'R11 actual Shadow -> R12 governance -> R13 activation/deprecation -> R14 Entry. Mapping is not readiness issuance.',
    'cleared_historical_gaps':['M0 originals recovered with 206 files verified','Formal project-list authorization repair completed in its own evidence scope'],
    'do_not_restart':['Completed 21-step Naming/Structure series','Retired P5/P6 or old Developer-to-User grant/link bridge']})

# Follow only the already identified package members; no broad search or execution.
acceptance = doc(D+'ArchitectureConstitutionAcceptanceDecision_20260907.json')
zip_path = Path('C:/Users/Windows/Documents/Codex/2026-09-07/ni-6/work/candidate-source/Clued_Phase2_三轨修订与补证_完整审查候选包_v0.2.7.1_Manifest修复_20260906.zip')
prefix='Clued_Phase2_三轨修订与补证_v0.2.7_20260906/sources/architecture_v024/'
members=[('S06','sources/Clued_Kernel_Next_多厂商连续性与执行基础设施完整整合方案_v3.3.md','f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec'),
         ('ACTUAL_QUALIFICATION_BINDINGS','data/ActualQualificationBindings.json','61fc5a4ac9e0980e1ccf602d4008a7d1f0b275f20a81cba217384ee80feb3d65')]
external=[]
with zipfile.ZipFile(zip_path) as archive:
    for identity, member, expected in members:
        data=archive.read(prefix+member)
        assert sha(data)==expected
        external.append({'source_id':identity,'container_locator':str(zip_path),'member':prefix+member,'bytes':len(data),'sha256':expected,
          'reference_scope':'Existing exact two-hop source trace; not an active controller or authority.'})
    actual=json.loads(archive.read(prefix+'data/ActualQualificationBindings.json'))
write('ControllerSourceBoundary.json', {'state':STATE,'authority_effect':'NONE','source_commit':COMMIT,'references':external,
    'qualification_plan_ref': qualification_ref,
    's06_boundary':{'lines':[5,10,12,3876,3885,3887],'status':'frozen_pending_g1 natural-language contract; not live Gate Baseline'},
    'actual_bindings_id':actual['id'],'actual_bindings_state':actual['state'],
    'unbound_fields':[k for k,v in actual.items() if v is None],
    'real_execution_results':actual['real_execution_results'],'missing_ref_behavior':actual['missing_ref_behavior'],
    'required_external_inputs':['Current verifiable Control Evidence Store and existing trust-root generation/issuer purpose/expiry/revocation source','Exact runner/config/host and independent scoped qualification','Accepted applicable profile and actual scoped time-bounded authorization'],
    'local_preparation_allowed':['Pin source and input digests','Prepare isolated controller candidate and negative cases','Prepare evidence/stop/revocation/UNKNOWN recovery design'],
    'not_claimed':'No reusable qualified controller is established by this reference chain; no claim that other authorized environments have none.'})

write('SourceBindings.json', {'state':STATE,'authority_effect':'NONE','source_commit':COMMIT,
    'prior_index':ref(prior_path),'prior_sources_reused':len(prior['sources']),
    'sources':sorted(sources.values(),key=lambda x:x['path']),'external_references':external,'local_candidate_inputs':local_inputs})
changed=sorted({b['current_source']['path'] for r in rows for b in r['current_code_bindings'] if b['applicability']=='CHANGED_SOURCE_REQUIRES_TARGETED_REVIEW'})
write('Verification.json', {'state':STATE,'verification_scope':'Reference existence, exact pinned Git bytes, SHA256, JSON pointer consumer IDs and installed Skill bytes only',
    'source_commit':COMMIT,'repository_sources_checked':len(sources),'prior_sources_reused':len(prior['sources']),
    'consumers_mapped':len(rows),'authorization_pointers_checked':27,'receipt_pointers_checked':18,
    'skill_files_matching_installation':len(skill_rows),'external_members_matching_locked_hashes':len(external),
    'local_candidate_inputs_hashed':len(local_inputs),'stage_dependencies_matched_to_source':len(stage_rows),
    'changed_consumer_paths':changed,'tests_executed':0,'readiness_decisions_issued':0,'new_authority_grants':0,
    'frozen_sources_modified':False,'canonical_writes':0,'pins_modified':False,
    'file_results':[{'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='Verification.json']})
print(json.dumps({'sources':len(sources),'consumers':len(rows),'changed_consumer_paths':changed,'output':str(OUT)},ensure_ascii=False))
