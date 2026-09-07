from pathlib import Path
import importlib.util,json,hashlib,shutil,subprocess,sys,zipfile
W=Path(__file__).parent; R=W/'phase2-governance-check'; D=R/'docs/execution-plans/phase2-structure-governance/step12-migration-20260907'
T=W/'migration-guard-test';T.mkdir(exist_ok=True)
with zipfile.ZipFile(D/'OriginalMigrationTestSources.zip') as z:
    (T/'migration_execute_before.py').write_bytes(z.read('migration_execute.py'))
    (T/'test_executor.py').write_bytes(z.read('test_executor.py'))
shutil.copyfile(D/'migration_execute.py',T/'migration_execute.py')
shutil.copyfile(D/'ExecutionInputs.candidate.json',T/'ExecutionInputs.candidate.json')
shutil.copytree(D/'execution-payload',T/'execution-payload',dirs_exist_ok=True)
def module(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
old=module('old_executor',T/'migration_execute_before.py');new=module('new_executor',T/'migration_execute.py')
root=T/'junction-fixture';(root/'docs').mkdir(parents=True,exist_ok=True);(root/'memory').mkdir(exist_ok=True)
marker=root/'memory/protected.txt';marker.write_bytes(b'isolated test marker, not business data\n')
link=root/'docs/bridge'
if not link.exists():
    if sys.platform=='win32':
        q=lambda p:"'"+str(p).replace("'","''")+"'"
        result=subprocess.run(['powershell','-NoProfile','-Command','New-Item -ItemType Junction -Path '+q(link)+' -Target '+q(root/'memory')+' | Out-Null'],capture_output=True,text=True)
        assert result.returncode==0,result.stderr
    else:link.symlink_to(root/'memory',target_is_directory=True)
before=old.safe(root,'docs/bridge/protected.txt',True)
assert before.resolve()==marker.resolve()
rejected=[]
for name in ['docs/bridge/protected.txt','Memory/protected.txt']:
    try:new.safe(root,name,True)
    except new.MigrationError as e:rejected.append({'path':name,'result':'REJECTED','reason':str(e)})
    else:raise AssertionError('unsafe migration path admitted: '+name)
assert new.safe(root,'docs/normal.txt',True)==root/'docs/normal.txt'
assert marker.read_bytes()==b'isolated test marker, not business data\n'
run=subprocess.run([sys.executable,str(T/'test_executor.py')],cwd=T,capture_output=True,text=True,encoding='utf-8')
assert run.returncode==0,run.stderr
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
report={'kind':'INDEPENDENT_FINDING_MIGRATION_PARENT_LINK_GUARD_REPAIR','status':'PASS','reviewer_finding_source':'/root/architecture_review','repair_author':'/root',
 'original_executor_sha256':sha(T/'migration_execute_before.py'),'repaired_executor_sha256':sha(D/'migration_execute.py'),'unchanged_execution_inputs_sha256':sha(D/'ExecutionInputs.candidate.json'),
 'real_parent_link_kind':'Windows directory junction' if sys.platform=='win32' else 'directory symlink','old_implementation_read_only_control_admitted_protected_target':True,
 'new_implementation_rejections':rejected,'ordinary_path_allowed':True,'isolated_marker_unchanged':True,
 'five_existing_executor_tests_rerun_on_repaired_code':{'exit_code':run.returncode,'stdout':run.stdout,'stderr':run.stderr,'test_source_sha256':sha(T/'test_executor.py')},
 'source_scope':'Only execution path guard changed; 64 target paths, exact payload/inputs and Step7/8 source/validator inputs unchanged. No real repository migration or Canonical mutation.',
 'acceptance_effect':'Closes the parent-link execution safety finding for these verified inputs; does not issue Architecture Acceptance, Freeze or Step12 completion.'}
(D/'ParentLinkGuardRepair.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps({'status':'PASS','executor':report['repaired_executor_sha256'],'real_junction_negative':True,'regression_exit':run.returncode,'report_sha256':sha(D/'ParentLinkGuardRepair.json')}))
