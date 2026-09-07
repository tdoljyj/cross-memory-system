from pathlib import Path
import importlib.util,sys,hashlib,json,subprocess,tempfile
O=Path(__file__).resolve().parent;R=O.parent/'phase2-governance-check';P=R/'scripts/naming-governance/publication.py'
s=importlib.util.spec_from_file_location('publication_independent_control',P);p=importlib.util.module_from_spec(s);sys.modules[s.name]=p;s.loader.exec_module(p)
root=Path(tempfile.mkdtemp(prefix='publication-race-',dir=O));repo=root/'candidate';outside=root/'outside';repo.mkdir();outside.mkdir()
parent=repo/p.TARGET.parent;parent.mkdir(parents=True);retained=root/'retained-original-parent'
original=p.validate
def simulated_network_window(*args):
 parent.rename(retained)
 q=lambda x:"'"+str(x).replace("'","''")+"'"
 run=subprocess.run(['powershell','-NoProfile','-Command','New-Item -ItemType Junction -Path '+q(parent)+' -Target '+q(outside)+' | Out-Null'],capture_output=True)
 assert run.returncode==0,run.stderr
 return {'sequence':1,'fixture_only':True},{'validation':'PASS','fixture_only':True}
p.validate=simulated_network_window
try:
 activation,report=p.publish(None,None,repo,{},'NONE')
 result={'control':'ISOLATED_CONCURRENT_PARENT_SWAP_AFTER_INITIAL_GUARD','source_sha256':hashlib.sha256(P.read_bytes()).hexdigest(),'published':report['activated'],'outside_activation_created':(outside/'Activation.json').is_file(),'fixture_root':str(root),'network_validation_stub':'Only supplies a success after simulating filesystem change in real network validation window; does not weaken filesystem writer logic. Not real signature or CI evidence.','actual_user_data_changed':False}
except Exception as e:result={'exception':type(e).__name__,'detail':str(e),'outside_activation_created':(outside/'Activation.json').is_file()}
finally:p.validate=original
(O/'ParentSwapControl.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
print(json.dumps(result))
