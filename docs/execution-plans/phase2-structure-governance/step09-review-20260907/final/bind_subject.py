from pathlib import Path
import subprocess,hashlib,json
R=Path(__file__).resolve().parent.parent/'phase2-governance-check';O=Path(__file__).resolve().parent
P=R/'docs/execution-plans/phase2-structure-governance/step09-review-20260907/ReviewSubject_20260907.json'
sha=lambda b:hashlib.sha256(b).hexdigest()
raw=P.read_bytes();j=json.loads(raw)
assert sha(raw)=='960cab1c1b87fb898f6c2ce0604e54cf8026125f29b9633543971b7ab7de43a9'
commit=j['candidate_commit'];tree=subprocess.check_output(['git','rev-parse',commit+'^{tree}'],cwd=R).decode().strip()
assert tree==j['candidate_tree']
rows=j['supplementary_files'];inputs=''.join(commit+':'+r['path']+'\n' for r in rows).encode('utf8')
result=subprocess.run(['git','cat-file','--batch'],cwd=R,input=inputs,capture_output=True,check=True).stdout
offset=0;out=[]
for r in rows:
 end=result.index(b'\n',offset);header=result[offset:end].decode();blob,kind,n=header.split();assert kind=='blob'
 offset=end+1;n=int(n);b=result[offset:offset+n];offset+=n+1
 actual=(R/r['path']).read_bytes()
 assert len(b)==r['bytes'] and sha(b)==r['sha256'] and actual==b,r['path']
 out.append(dict(r,git_blob=blob,commit_bytes_and_worktree_match=True))
assert offset==len(result)
outj={'review_subject':{'path':str(P),'sha256':sha(raw)},'candidate_commit':commit,'candidate_tree':tree,'files_verified':len(out),'verified_files':out,'independent_method':'git cat-file --batch exact commit:path, independent SHA256/size and working-file equality; no whole repository or memory payload inventory','result':'EXACT_SUBJECT_MATCH','authority_effect':'NONE'}
(O/'ExactSubjectVerification.json').write_text(json.dumps(outj,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'files_verified':len(out),'result':'EXACT_SUBJECT_MATCH','commit':commit}))
