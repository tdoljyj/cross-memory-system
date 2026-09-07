#!/usr/bin/env python3
"""Fail-closed Phase2 v0.2.7 Candidate/Manifest/Provenance/ProductIncrementInput gate."""
import argparse, hashlib, json, os, re, sys, tempfile, zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

SHA=re.compile(r'^[0-9a-f]{64}$')
GATES=(('candidate_identity','GATE-01 Candidate Identity'),('manifest_integrity','GATE-02 Manifest Integrity'),('provenance','GATE-03 Provenance'),('product_increment_input','GATE-04 ProductIncrementInput'))
class VError(Exception): pass
def req(v,msg):
    if not v: raise VError(msg)
def dup(pairs):
    d={}
    for k,v in pairs:
        req(k not in d,f'duplicate JSON key: {k}')
        d[k]=v
    return d
def jbytes(b,label):
    try: return json.loads(b.decode('utf-8'),object_pairs_hook=dup)
    except Exception as e: raise VError(f'{label}: invalid UTF-8 JSON: {e}')
def jfile(p,label):
    req(p.is_file(),f'{label}: missing file: {p}')
    return jbytes(p.read_bytes(),label)
def sha_file(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1<<20),b''): h.update(b)
    return h.hexdigest()
def sha_stream(f):
    h=hashlib.sha256(); n=0
    for b in iter(lambda:f.read(1<<20),b''): n+=len(b); h.update(b)
    return n,h.hexdigest()
def digest(v,label):
    req(isinstance(v,str) and SHA.fullmatch(v),f'{label}: invalid SHA-256')
    return v
def rel(v,label):
    req(isinstance(v,str) and v and '\\' not in v,f'{label}: invalid path')
    p=PurePosixPath(v); req(not p.is_absolute() and all(x not in ('','.','..') for x in p.parts),f'{label}: unsafe path {v!r}')
    return v
def count(o,k,label):
    v=o.get(k)
    if isinstance(v,list): return len(v)
    req(isinstance(v,int) and not isinstance(v,bool) and v>=0,f'{label}.{k}: invalid count')
    return v

def zip_identity(path,ident,label,check_name=True):
    name=ident.get('filename') or ident.get('file')
    if check_name and name: req(path.name==name,f'{label}: filename mismatch')
    eb=ident.get('bytes'); em=ident.get('members'); es=digest(ident.get('sha256'),label+'.sha256')
    req(isinstance(eb,int) and eb>=0 and isinstance(em,int) and em>=0,f'{label}: invalid bytes/members')
    req(path.stat().st_size==eb,f'{label}: bytes mismatch actual={path.stat().st_size} expected={eb}')
    req(sha_file(path)==es,f'{label}: SHA-256 mismatch')
    with zipfile.ZipFile(path) as z:
        req(len(z.infolist())==em,f'{label}: members mismatch actual={len(z.infolist())} expected={em}')
        req(z.testzip() is None,f'{label}: ZIP CRC/decompression failure')
    return {'bytes':eb,'members':em,'sha256':es}

class Pack:
    def __init__(self,path): self.path=path; self.z=None; self.root=None; self.files={}; self.members=0
    def open(self):
        self.z=zipfile.ZipFile(self.path); infos=self.z.infolist(); self.members=len(infos)
        names=[i.filename for i in infos]; req(len(names)==len(set(names)),'candidate ZIP has duplicate member names')
        roots=set()
        for i in infos:
            req('\\' not in i.filename and not i.filename.startswith('/'),'candidate ZIP has unsafe member path')
            parts=PurePosixPath(i.filename).parts; req('..' not in parts,'candidate ZIP has traversal member')
            if not i.is_dir(): req(len(parts)>=2,'candidate file is outside root'); roots.add(parts[0])
        req(len(roots)==1,f'candidate ZIP must have one root, found {sorted(roots)}'); self.root=next(iter(roots))+'/'
        for i in infos:
            if i.is_dir(): continue
            req(i.filename.startswith(self.root),'candidate file outside root')
            r=rel(i.filename[len(self.root):],'candidate member'); req(r not in self.files,f'duplicate relative member {r}'); self.files[r]=i
        return self
    def close(self):
        if self.z: self.z.close()
    def read(self,p):
        p=rel(p,'candidate path'); req(p in self.files,f'missing candidate member: {p}'); return self.z.read(self.files[p])
    def json(self,p): return jbytes(self.read(p),p)
    def blob(self,d,label):
        req(isinstance(d,dict),f'{label}: expected object'); p=rel(d.get('path'),label+'.path'); req(p in self.files,f'{label}: missing {p}')
        eb=d.get('bytes'); es=digest(d.get('sha256'),label+'.sha256'); req(isinstance(eb,int) and eb>=0,f'{label}: invalid bytes')
        i=self.files[p]; req(i.file_size==eb,f'{label}: bytes mismatch for {p}')
        with self.z.open(i) as f: n,s=sha_stream(f)
        req(n==eb and s==es,f'{label}: digest mismatch for {p}'); return {'path':p,'bytes':n,'sha256':s}

def candidate_gate(cand,identity,ctx):
    ident=jfile(identity,'candidate identity'); req(isinstance(ident,dict),'candidate identity must be object')
    for k in ('candidate','bytes','members','sha256'): req(k in ident,f'candidate identity missing {k}')
    req(cand.is_file(),f'candidate bytes unavailable: {cand}'); req(cand.name==ident['candidate'],'candidate filename mismatch')
    req(isinstance(ident['bytes'],int) and ident['bytes']>0 and isinstance(ident['members'],int) and ident['members']>0,'candidate identity invalid bytes/members')
    req(cand.stat().st_size==ident['bytes'],f'candidate bytes mismatch actual={cand.stat().st_size} expected={ident["bytes"]}')
    actual=sha_file(cand); req(actual==digest(ident['sha256'],'candidate identity.sha256'),f'candidate SHA mismatch actual={actual}')
    req(zipfile.is_zipfile(cand),'candidate is not ZIP'); p=Pack(cand).open(); ctx['pack']=p
    req(p.members==ident['members'],f'candidate members mismatch actual={p.members} expected={ident["members"]}')
    if ident.get('root_prefix') is not None: req(p.root==ident['root_prefix'],f'candidate root mismatch actual={p.root} expected={ident["root_prefix"]}')
    req(p.z.testzip() is None,'candidate ZIP CRC/decompression failure'); ctx['identity']=ident
    return {'candidate':cand.name,'bytes':cand.stat().st_size,'members':p.members,'file_members':len(p.files),'sha256':actual,'root_prefix':p.root}

def parse_sums(b):
    try: text=b.decode('utf-8')
    except Exception as e: raise VError(f'SHA256SUMS.txt invalid UTF-8: {e}')
    out={}
    for no,line in enumerate(text.splitlines(),1):
        if not line: continue
        req('  ' in line,f'SHA256SUMS.txt:{no}: malformed'); s,p=line.split('  ',1); digest(s,f'SHA256SUMS.txt:{no}'); p=rel(p,f'SHA256SUMS.txt:{no}'); req(p not in out,f'SHA256SUMS duplicate {p}'); out[p]=s
    return out

def manifest_gate(ctx):
    p=ctx['pack']; req('PACK_MANIFEST.json' in p.files and 'SHA256SUMS.txt' in p.files,'root manifest/checksum missing')
    m=p.json('PACK_MANIFEST.json'); entries=m.get('files'); req(isinstance(entries,list) and entries,'PACK_MANIFEST.json.files missing')
    dec={}
    for n,e in enumerate(entries):
        req(isinstance(e,dict),f'manifest entry {n} not object'); rp=rel(e.get('path'),f'manifest[{n}].path'); req(rp not in ('PACK_MANIFEST.json','SHA256SUMS.txt'),'manifest self-lists root metadata'); req(rp not in dec,f'duplicate manifest path {rp}'); digest(e.get('sha256'),f'manifest[{n}].sha256'); req(isinstance(e.get('bytes'),int) and e['bytes']>=0,f'manifest[{n}].bytes invalid'); dec[rp]=e
    actual=set(p.files)-{'PACK_MANIFEST.json','SHA256SUMS.txt'}; un=sorted(actual-set(dec)); miss=sorted(set(dec)-actual)
    req(not un,'PACK_MANIFEST.json does not cover actual payload members: '+', '.join(un[:20])); req(not miss,'PACK_MANIFEST.json references missing members: '+', '.join(miss[:20]))
    for rp,e in dec.items(): p.blob(e,f'manifest[{rp}]')
    sums=parse_sums(p.read('SHA256SUMS.txt')); expected=set(p.files)-{'SHA256SUMS.txt'}; un=sorted(expected-set(sums)); stale=sorted(set(sums)-expected)
    req(not un,'SHA256SUMS.txt does not cover actual members: '+', '.join(un[:20])); req(not stale,'SHA256SUMS.txt references missing members: '+', '.join(stale[:20]))
    for rp in expected:
        with p.z.open(p.files[rp]) as f: _,s=sha_stream(f)
        req(s==sums[rp],f'SHA256SUMS mismatch for {rp}')
        if rp in dec: req(s==dec[rp]['sha256'],f'manifest/checksum disagreement for {rp}')
    return {'manifest_entries':len(dec),'actual_payload_members':len(actual),'sha256sum_entries':len(sums),'coverage':'EXACT'}

def extract_member(z,member,dest):
    req(member in z.namelist(),f'nested archive member missing: {member}'); h=hashlib.sha256(); n=0
    with z.open(member) as src, dest.open('wb') as out:
        for b in iter(lambda:src.read(1<<20),b''): n+=len(b); h.update(b); out.write(b)
    return n,h.hexdigest()
def extract_pack(p,rp,dest):
    req(rp in p.files,f'missing candidate archive member: {rp}'); h=hashlib.sha256(); n=0
    with p.z.open(p.files[rp]) as src, dest.open('wb') as out:
        for b in iter(lambda:src.read(1<<20),b''): n+=len(b); h.update(b); out.write(b)
    return n,h.hexdigest()

def provenance_gate(ctx,tmp):
    p=ctx['pack']; prov=p.json('data/SourceProvenance.json'); lock=p.json('data/SourceLock.json'); pred=p.json('data/PredecessorPackageBinding.json'); mp=p.json('data/MappingAcceptanceIntake.json'); subj=p.json('data/ReviewSubjectContract.json')
    binds=prov.get('archive_bindings'); copies=prov.get('source_copies'); req(isinstance(binds,list) and binds and isinstance(copies,list) and copies,'SourceProvenance bindings/copies missing')
    archives={}
    for i,b in enumerate(binds):
        r=rel(b.get('path'),f'archive_bindings[{i}].path'); p.blob(b,f'archive_bindings[{i}]'); out=tmp/('outer-'+hashlib.sha256(r.encode()).hexdigest()[:12]+'.zip'); extract_pack(p,r,out); req(zipfile.is_zipfile(out),f'provenance archive is not ZIP: {r}'); archives[r]=out
    pi=pred.get('sole_direct_predecessor'); req(isinstance(pi,dict),'sole direct predecessor missing'); req(pi==lock.get('direct_architecture_predecessor')==subj.get('sole_direct_predecessor'),'direct predecessor identity disagreement')
    ar=rel(pred.get('archive_path'),'predecessor.archive_path'); nm=rel(pred.get('nested_zip_member'),'predecessor.nested_zip_member'); req(ar in archives,'predecessor archive not provenance-bound'); po=tmp/pi['filename']
    with zipfile.ZipFile(archives[ar]) as z: extract_member(z,nm,po)
    pr=zip_identity(po,pi,'sole direct architecture predecessor')
    mi=mp.get('candidate'); req(isinstance(mi,dict) and mi==lock.get('mapping_design_input'),'mapping identity disagreement'); maps=[x for x in archives if 'mapping' in x.lower()]; req(len(maps)==1,f'expected one mapping review archive, found {maps}'); mo=tmp/mi['filename']
    with zipfile.ZipFile(archives[maps[0]]) as z:
        matches=[x for x in z.namelist() if PurePosixPath(x).name==mi['filename']]; req(len(matches)==1,f'mapping candidate resolves {len(matches)} times'); extract_member(z,matches[0],mo)
    mr=zip_identity(mo,mi,'accepted mapping design input')
    dd=mp.get('decision'); req(isinstance(dd,dict),'mapping acceptance decision binding missing'); dr=p.blob(dd,'mapping acceptance decision'); d=p.json(dd['path']); req(d.get('id')==mp.get('decision_id'),'mapping acceptance decision id mismatch'); dc=d.get('candidate',{}); req(dc.get('filename')==mi.get('filename'),'mapping decision candidate filename mismatch')
    for k in ('bytes','members','sha256'): req(dc.get(k)==mi.get(k),f'mapping decision candidate {k} mismatch')
    req(d.get('scope')==mp.get('accepted_scope'),'mapping acceptance scope mismatch')
    seen=set(); cache={}; verified=0
    for i,c in enumerate(copies):
        rp=rel(c.get('path'),f'source_copies[{i}].path'); req(rp not in seen,f'duplicate source copy {rp}'); seen.add(rp); p.blob(c,f'source_copies[{i}]'); oa=rel(c.get('origin_archive'),f'source_copies[{i}].origin_archive'); req(oa in archives,f'unbound origin archive {oa}'); cur=archives[oa]; chain=c.get('nested_zip_members'); req(isinstance(chain,list) and len(chain)<=4,f'source_copies[{i}] bad nested chain'); keyparts=[]
        for depth,nested in enumerate(chain):
            nested=rel(nested,f'source_copies[{i}].nested_zip_members[{depth}]'); keyparts.append(nested); key=(oa,tuple(keyparts))
            if key not in cache:
                out=tmp/('nested-'+hashlib.sha256(repr(key).encode()).hexdigest()[:16]+'.zip')
                with zipfile.ZipFile(cur) as z: extract_member(z,nested,out)
                req(zipfile.is_zipfile(out),f'nested provenance member not ZIP: {nested}'); cache[key]=out
            cur=cache[key]
        om=rel(c.get('origin_member'),f'source_copies[{i}].origin_member')
        with zipfile.ZipFile(cur) as z:
            req(om in z.namelist(),f'origin member missing: {om}')
            with z.open(om) as f: n,s=sha_stream(f)
        req(n==c.get('bytes') and s==c.get('sha256'),f'origin bytes/SHA mismatch for {rp}'); verified+=1
    return {'archive_bindings_verified':len(binds),'source_copies_verified_against_package_and_origin':verified,'direct_predecessor':pr,'mapping_design_input':mr,'mapping_acceptance_decision':dr,'reference_resolution':'PASS'}

def sameid(a,b,label):
    for k in ('bytes','members','sha256'): req(a.get(k)==b.get(k),f'{label}: {k} mismatch')
def product_gate(ctx,tmp):
    p=ctx['pack']; x=p.json('data/ProductIncrementIntake.json'); required={'id':str,'state':str,'candidate':dict,'external_acceptance':dict,'preserved_components':list,'requirements':int,'product_unexecuted_cases':int,'license_design_examples':int,'impact_groups':int,'design_consumers':int,'product_phases':int,'actual_runtime_consumers_bound':int,'retained_conditions':list,'retained_open_decisions':list,'historical_intake_ref':str,'mapping_v043_scope_ref':str}
    for k,t in required.items(): req(k in x and isinstance(x[k],t) and not(t is int and isinstance(x[k],bool)),f'ProductIncrementIntake.{k} invalid')
    c=x['candidate']; p.blob(c,'ProductIncrementIntake.candidate'); cp=rel(c.get('path'),'ProductIncrementIntake.candidate.path'); req(isinstance(c.get('members'),int) and c['members']>0,'product candidate members invalid'); out=tmp/PurePosixPath(cp).name; extract_pack(p,cp,out); zr=zip_identity(out,{'filename':out.name,'bytes':c['bytes'],'members':c['members'],'sha256':c['sha256']},'exact product candidate')
    res=c.get('resolution'); req(isinstance(res,dict) and isinstance(res.get('verification'),dict),'product candidate resolution missing'); sameid(c,res['verification'],'candidate vs resolution.verification'); req(res.get('archive_path')==cp,'product candidate resolution path mismatch')
    a=x['external_acceptance']; ar=p.blob(a,'ProductIncrementIntake.external_acceptance'); ao=p.json(a['path']); req(ao.get('id')==a.get('id') and ao.get('decision')==a.get('decision'),'product acceptance id/decision mismatch'); ac=ao.get('candidate'); req(isinstance(ac,dict),'product acceptance candidate missing'); req((ac.get('file') or ac.get('filename'))==out.name,'product acceptance candidate filename mismatch'); sameid(c,ac,'product intake vs acceptance'); req(ao.get('retained_conditions')==x['retained_conditions'] and ao.get('retained_open_decisions')==x['retained_open_decisions'],'product acceptance retained sets mismatch')
    objs={}; seen=set()
    for i,e in enumerate(x['preserved_components']):
        rp=rel(e.get('path'),f'preserved_components[{i}].path'); req(rp not in seen,f'duplicate preserved component {rp}'); seen.add(rp); p.blob(e,f'preserved_components[{i}]'); objs[PurePosixPath(rp).name]=p.json(rp)
    need=('Requirements.json','AcceptanceSpecifications.json','CoCreationPermissionMatrix.json','ImpactAndDependencyMap.json','RequirementImpactConsumerTrace.json','ReviewConditionsCarryForward.json','OpenDecisionsAndEnablement.json'); req(all(isinstance(objs.get(n),dict) for n in need),'required preserved ProductIncrementInput component missing')
    req(count(objs['Requirements.json'],'requirements','Requirements.json')==x['requirements'],'requirements count mismatch'); req(count(objs['AcceptanceSpecifications.json'],'cases','AcceptanceSpecifications.json')==x['product_unexecuted_cases'] and objs['AcceptanceSpecifications.json'].get('count')==x['product_unexecuted_cases'],'acceptance cases count mismatch'); req(count(objs['CoCreationPermissionMatrix.json'],'cases','CoCreationPermissionMatrix.json')==x['license_design_examples'],'license examples count mismatch'); req(count(objs['ImpactAndDependencyMap.json'],'impacts','ImpactAndDependencyMap.json')==x['impact_groups'] and count(objs['ImpactAndDependencyMap.json'],'phases','ImpactAndDependencyMap.json')==x['product_phases'],'impact/phase count mismatch'); req(count(objs['RequirementImpactConsumerTrace.json'],'rows','RequirementImpactConsumerTrace.json')==x['requirements'] and objs['RequirementImpactConsumerTrace.json'].get('actual_consumers_bound')==x['actual_runtime_consumers_bound'],'trace/runtime-consumer count mismatch'); req(count(objs['ReviewConditionsCarryForward.json'],'conditions','ReviewConditionsCarryForward.json')==len(x['retained_conditions']),'retained conditions count mismatch'); req(count(objs['OpenDecisionsAndEnablement.json'],'items','OpenDecisionsAndEnablement.json')==len(x['retained_open_decisions']),'open decisions count mismatch'); req(x['design_consumers']==x['impact_groups'],'design_consumer count mismatch')
    for k in ('historical_intake_ref','mapping_v043_scope_ref'): rp=rel(x[k],'ProductIncrementIntake.'+k); req(rp in p.files,f'{k} does not resolve'); p.json(rp)
    return {'intake_id':x['id'],'intake_state':x['state'],'candidate':zr,'external_acceptance':ar,'preserved_components_verified':len(x['preserved_components']),'requirements':x['requirements'],'unexecuted_cases':x['product_unexecuted_cases'],'license_design_examples':x['license_design_examples'],'impact_groups':x['impact_groups'],'product_phases':x['product_phases'],'actual_runtime_consumers_bound':x['actual_runtime_consumers_bound'],'reference_resolution':'PASS'}

def now(): return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def write_receipt(path,r):
    path.parent.mkdir(parents=True,exist_ok=True); t=path.with_suffix(path.suffix+'.tmp'); t.write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n',encoding='utf-8'); os.replace(t,path)
def run(cand,ident,receipt):
    r={'schema':'clued.phase2-v027-ci-gate-receipt/v1','generated_at_utc':now(),'repository':os.getenv('GITHUB_REPOSITORY'),'commit_sha':os.getenv('GITHUB_SHA'),'workflow':os.getenv('GITHUB_WORKFLOW'),'workflow_ref':os.getenv('GITHUB_WORKFLOW_REF'),'run_id':os.getenv('GITHUB_RUN_ID'),'run_attempt':os.getenv('GITHUB_RUN_ATTEMPT'),'candidate_path':str(cand),'identity_path':str(ident),'gates':{},'overall':'FAIL'}; ctx={}; candidate_ok=False
    with tempfile.TemporaryDirectory(prefix='phase2-v027-') as td:
        tmp=Path(td)
        for key,title in GATES:
            started=now()
            if key!='candidate_identity' and not candidate_ok: r['gates'][key]={'gate':title,'status':'SKIPPED','reason':'candidate_identity_failed','started_at_utc':started}; write_receipt(receipt,r); continue
            try:
                if key=='candidate_identity': d=candidate_gate(cand,ident,ctx); candidate_ok=True; r['candidate']=d
                elif key=='manifest_integrity': d=manifest_gate(ctx)
                elif key=='provenance': d=provenance_gate(ctx,tmp)
                else: d=product_gate(ctx,tmp)
                r['gates'][key]={'gate':title,'status':'PASS','started_at_utc':started,'completed_at_utc':now(),'details':d}; print(f'{title}: PASS')
            except Exception as e:
                r['gates'][key]={'gate':title,'status':'FAIL','started_at_utc':started,'completed_at_utc':now(),'error_type':type(e).__name__,'error':str(e)}; print(f'{title}: FAIL: {e}',file=sys.stderr)
                if key=='candidate_identity': candidate_ok=False
            write_receipt(receipt,r)
        if ctx.get('pack'): ctx['pack'].close()
    r['overall']='PASS' if all(r['gates'].get(k,{}).get('status')=='PASS' for k,_ in GATES) else 'FAIL'; r['completed_at_utc']=now(); write_receipt(receipt,r); print(json.dumps({'overall':r['overall'],'gates':{k:r['gates'][k]['status'] for k,_ in GATES}},ensure_ascii=False)); return 0 if r['overall']=='PASS' else 1

def main():
    a=argparse.ArgumentParser(); a.add_argument('--candidate',required=True,type=Path); a.add_argument('--identity',required=True,type=Path); a.add_argument('--receipt',required=True,type=Path); x=a.parse_args(); return run(x.candidate,x.identity,x.receipt)
if __name__=='__main__': sys.exit(main())
