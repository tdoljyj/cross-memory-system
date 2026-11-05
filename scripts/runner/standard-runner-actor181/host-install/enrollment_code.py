"""Candidate standard-account installer; default preview, no scheduler writes.

The accepted root broker supplies an immutable request. Only this S4U account
creates its own new private installation. No admin enrollment/owner repair.
"""
import argparse, ctypes, hashlib, importlib.util, json, os, pathlib, socket, subprocess, sys, threading, time
ROOT=pathlib.Path(r'C:\ProgramData\CluedCacheInstallSelf211')
REGISTRY='f8f3ee9711689993b5a9d663961c72b70b1b1dc7c13dd0252d7ec5e2fe5a2d9a'
COMPONENT='cee184416d253fbdd42b47b6d21b1629c3703beacd4d918f75ae531926ae8a8a'
PINS={"config/ci-resource-maintenance.json":"ff191ef4b70bedfa35183a156775c4441563de6417eb509d5065ec1979051517","scripts/ci/self-hosted/resource-maintenance/README.md":"3bf73beae47c2d3a3a813c2da29c50a473ffece4dc023a633723924bcd36455f","scripts/ci/self-hosted/resource-maintenance/enroll.py":"1065b8a01c52eb1249a1b282df6ceef2fb396eb4fc29fa6705c4c1263e6571b1","scripts/ci/self-hosted/resource-maintenance/maintenance.py":"b4a4946f3e2252ec173d90fce7659d0f35c55c1dbee07949951c8a33f17fc8d8","scripts/ci/self-hosted/resource-maintenance/probe.py":"94a2917c9f1f9a15bbe806a0bd90b2a37b7a17dff9501be2010c511cc88bd8f1","scripts/ci/self-hosted/resource-maintenance/producer.py":"65708765edb2ca593b685ab59159894d3690bd04f45ea1518db074584ee92cfd","scripts/ci/self-hosted/resource-maintenance/schedule.py":"d772148106aa3f132cccbc1e4b62cdb2d7068e5a16a2a54fb796b655951acdab","scripts/ci/self-hosted/resource-maintenance/security.py":"932567b1fc5d753b7b29561991ac0ab3a8502f31edfad0fb5109b5b5d2083209","scripts/ci/self-hosted/resource-maintenance/test_maintenance.py":"77b490df6dedd6b68d42e1d735920c3a8241c6195606c1b57f8e38a0ab07b40f","scripts/ci/self-hosted/resource-maintenance/test_producer.py":"d3fc91eca4bdb64cf5a392c7a69fa5ddbdc64f93013cf8f84c39f382c9ddce19","scripts/ci/self-hosted/resource-maintenance/test_schedule_probe.py":"2f5e5913f660c1c3bcc554108a28ac4b238f5fa0c21bbdc102062e9e192c3cc2"}

def require(ok, code):
 if not ok:raise ValueError(code)
def pairs(rows):
 result={}
 for key,value in rows:require(key not in result,'DUPLICATE_JSON_KEY');result[key]=value
 return result
def load(path,limit=65536):
 with pathlib.Path(path).open('rb') as stream:data=stream.read(limit+1)
 require(len(data)<=limit,'JSON_BOUND');return json.loads(data,object_pairs_hook=pairs)
def digest(path,limit=8388608):
 with pathlib.Path(path).open('rb') as stream:data=stream.read(limit+1)
 require(len(data)<=limit,'FILE_BOUND');return hashlib.sha256(data).hexdigest()
def write_new(path,row):
 data=json.dumps(row,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
 require(len(data)<=16384,'EVIDENCE_BOUND')
 with pathlib.Path(path).open('xb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
def verify11(root):
 root=pathlib.Path(root)
 for name,pin in PINS.items():
  path=root/name
  for item in (path,*path.parents):
   st=item.lstat();require(not item.is_symlink() and not getattr(st,'st_file_attributes',0)&0x400,'SOURCE_REPARSE')
  require(digest(path)==pin,'SOURCE_RAW_PIN')
def module(root):
 tool=pathlib.Path(root)/'scripts/ci/self-hosted/resource-maintenance'
 sys.path.insert(0,str(tool))
 spec=importlib.util.spec_from_file_location('maintenance',tool/'maintenance.py');m=importlib.util.module_from_spec(spec);sys.modules['maintenance']=m;spec.loader.exec_module(m);return m
def validate_request(r,path):
 keys={'schema','node_id','host','expected_sid','python','python_sha256','pythonw','pythonw_sha256','home','source_staging','output_dir','release_path','nonce'}
 require(type(r) is dict and set(r)==keys,'REQUEST_FIELDS')
 require(all(type(r[x]) is str and not any(c in r[x] for c in '\r\n\0') for x in keys),'REQUEST_TEXT')
 require(r['schema']=='clued.windows-maintenance-install-request181/1','REQUEST_SCHEMA')
 import re
 require(re.fullmatch('[a-z0-9][a-z0-9-]{0,62}',r['node_id']) and re.fullmatch('[0-9a-f]{32}',r['nonce']),'REQUEST_SUBJECT')
 require(path==ROOT/'Control'/r['node_id']/'request.json' and pathlib.Path(r['source_staging'])==ROOT/'Stage/Source1.0.1' and pathlib.Path(r['output_dir'])==ROOT/'Outputs'/r['node_id'] and pathlib.Path(r['release_path'])==ROOT/'Control'/r['node_id']/'release.json','REQUEST_LAYOUT')
 require(socket.gethostname().casefold()==r['host'].casefold(),'REQUEST_HOST')
 return r
class Journal:
 def __init__(self,root,node,nonce):self.root=pathlib.Path(root);self.node=node;self.nonce=nonce;self.sequence=0
 def event(self,phase,**fields):
  self.sequence+=1;write_new(self.root/('%02d-%s.json'%(self.sequence,phase)),dict(schema='clued.windows-maintenance-install-phase181/1',node_id=self.node,nonce=self.nonce,phase=phase,at=time.time(),**fields))
 def invoke(self,phase,argv):
  self.event(phase+'-start',pid=os.getpid());process=None;meta={key:dict(observed_bytes=0,sha256=hashlib.sha256(),eof=False,over=False) for key in ('stdout','stderr')};failure=None
  try:
   process=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   def pump(stream,key):
    row=meta[key]
    try:
     while True:
      chunk=stream.read(4096)
      if not chunk:row['eof']=True;break
      row['observed_bytes']+=len(chunk)
      if row['observed_bytes']>1048576:row['over']=True;break
      row['sha256'].update(chunk)
    finally:stream.close()
   threads=[threading.Thread(target=pump,args=(getattr(process,key),key),daemon=True) for key in meta]
   for thread in threads:thread.start()
   deadline=time.monotonic()+180
   while process.poll() is None:
    if any(x['over'] for x in meta.values()) or time.monotonic()>deadline:failure='COMMAND_BOUND';process.kill();break
    time.sleep(.02)
   process.wait(timeout=5)
   for thread in threads:thread.join(2)
   require(process.returncode==0 and failure is None and all(x['eof'] and not x['over'] for x in meta.values()),'COMMAND_FAILED')
  except BaseException as error:
   failure=failure or type(error).__name__
   if process is not None and process.poll() is None:
    process.kill()
    try:process.wait(timeout=5)
    except subprocess.TimeoutExpired:pass
  finally:
   streams={key:dict(observed_bytes=row['observed_bytes'],sha256=row['sha256'].hexdigest(),eof=row['eof'],incomplete=not row['eof'] or row['over'],hash_scope='bounded_prefix' if row['over'] else 'observed_stream') for key,row in meta.items()}
   self.event(phase+'-end',pid=process.pid if process else None,exit_code=process.poll() if process else None,streams=streams,failure_code=failure,automatic_retry=False)
  require(failure is None,'PHASE_FAILED_PRESERVE_EVIDENCE')
def enroll_captured211(request_path,request_sha):
 require(os.name=='nt' and type(request_path) is str and type(request_sha) is str,'WINDOWS_CAPTURED_REQUEST_REQUIRED')
 path=pathlib.Path(request_path);require(digest(path,16384)==request_sha,'REQUEST_HASH');r=validate_request(load(path,16384),path)
 verify11(r['source_staging']);m=module(r['source_staging']);require(m.owner_identity()==r['expected_sid'],'ACTUAL_STANDARD_ACCOUNT_SID')
 require(pathlib.Path(sys.executable)==pathlib.Path(r['python']) and digest(sys.executable,134217728)==r['python_sha256'] and digest(r['pythonw'],134217728)==r['pythonw_sha256'],'ACTUAL_INTERPRETER')
 journal=Journal(r['output_dir'],r['node_id'],r['nonce']);journal.event('identity',pid=os.getpid(),sid=r['expected_sid'],elevated=0)
 try:
  import winreg
  with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+r['expected_sid']) as key:home,_=winreg.QueryValueEx(key,'ProfileImagePath')
  require(pathlib.Path(os.path.expandvars(home))==pathlib.Path(r['home']),'PROFILELIST_HOME')
  home=pathlib.Path(r['home']);m.checked_dir(home,owned=False);parent=home/'.clued-cache-maintenance';source=parent/'source-1.0.1';managed=parent/'managed-runner-builds'
  require(not os.path.lexists(parent),'PRIVATE_PARENT_COLLISION');m.private_dir(parent);journal.event('private-parent-created',owner=r['expected_sid'])
  m.private_dir(source)
  for name,pin in PINS.items():
   dest=source/name;m.private_dir(dest.parent)
   with (pathlib.Path(r['source_staging'])/name).open('rb') as inp,dest.open('xb') as out:
    data=inp.read(8388609);require(len(data)<=8388608 and hashlib.sha256(data).hexdigest()==pin,'SOURCE_COPY_PIN');out.write(data);out.flush();os.fsync(out.fileno())
  verify11(source);journal.event('source-11-copied',file_count=11,component_sha256=COMPONENT)
  tool=source/'scripts/ci/self-hosted/resource-maintenance';registry=source/'config/ci-resource-maintenance.json'
  journal.invoke('enroll',[r['python'],'-I','-B',str(tool/'enroll.py'),'--registry',str(registry),'--registry-sha256',REGISTRY,'--node-id',r['node_id'],'--root',str(managed)])
  verify11(source);m.checked_dir(source);m.checked_dir(managed)
  binding=managed/'binding.json';xml=managed/'scheduler'/('clued-cache-'+r['node_id']+'.xml')
  write_new(pathlib.Path(r['output_dir'])/'ready.json',dict(schema='clued.windows-maintenance-installer-ready181/1',node_id=r['node_id'],nonce=r['nonce'],pid=os.getpid(),parent_pid=os.getppid(),sid=r['expected_sid'],elevated=0,source_11_match=True,binding_sha256=digest(binding),scheduler_xml_sha256=digest(xml),maintenance_worker_qualified=False))
  require(m.owner_identity()==r['expected_sid'],'ACTOR_IDENTITY_CHANGED')
  journal.event('enrollment-terminal211',exit_code=0,temporary_installer_task_created=False)
  return dict(schema='clued.self-maintenance-enrollment211/1',status='ENROLLED_SCHEDULER_NOT_INSTALLED',node_id=r['node_id'],nonce=r['nonce'],pid=os.getpid(),sid=r['expected_sid'],binding_sha256=digest(binding),scheduler_xml_sha256=digest(xml),worker_qualified=False,automatic_retry=False)
 except BaseException:
  journal.event('actor-failed211',exit_code=None,status='STOP_PRESERVE_EVIDENCE',automatic_retry=False)
  raise
if __name__=='__main__':
 print(json.dumps(dict(schema='clued.self-maintenance-enrollment211/1',status='PREVIEW_CAPTURED_INSTALL_PURPOSE_REQUIRED',writes=False,task_registration=False)))
