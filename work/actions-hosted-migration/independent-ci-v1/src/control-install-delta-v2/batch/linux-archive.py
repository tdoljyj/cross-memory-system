# Fixed public protocol archive. No key/token, execution, signing or qualification.
import os,sys,json,stat,hashlib,ctypes
from pathlib import Path
ROOT=Path('/var/lib/clued-independent-ci/formal-spool')
if os.geteuid()!=0 or len(sys.argv)!=2 or len(sys.argv[1])!=64 or any(c not in '0123456789abcdef' for c in sys.argv[1]):raise SystemExit('FIXED_ARCHIVE_SUBJECT_REQUIRED')
jobid=sys.argv[1]
if hashlib.sha256(Path('/usr/bin/python3.12').read_bytes()).hexdigest()!='e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f':raise SystemExit('FIXED_PUBLIC_PYTHON_PIN_REQUIRED')
for p in [Path('/var'),Path('/var/lib'),Path('/var/lib/clued-independent-ci'),ROOT,ROOT/'incoming',ROOT/'outgoing']:
 s=p.lstat()
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise SystemExit('PROTECTED_PUBLIC_ARCHIVE_ROOT_REQUIRED')
def read(p):
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_size<1 or s.st_size>1048576:raise SystemExit('PUBLIC_PROTOCOL_FILE_REQUIRED')
  b=os.read(fd,s.st_size+1);z=p.lstat()
  if len(b)!=s.st_size or (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)!=(z.st_dev,z.st_ino,z.st_size,z.st_mtime_ns):raise SystemExit('PUBLIC_PROTOCOL_CHANGED')
  return s,b
 finally:os.close(fd)
issue=json.loads(read(ROOT/'incoming/issue.json')[1]);result=json.loads(read(ROOT/'outgoing/result.json')[1])
if issue.get('job',{}).get('id')!=jobid or result.get('envelope',{}).get('payload',{}).get('subject',{}).get('id')!=jobid:raise SystemExit('EXACT_PREVIOUS_JOB_REQUIRED')
lock=json.loads(read(ROOT/'outgoing/active.lock')[1]);pid=lock.get('pid')
if type(pid)!=int or pid<1:raise SystemExit('ACTUAL_PREVIOUS_WORKER_PID_REQUIRED')
try:os.kill(pid,0)
except ProcessLookupError:pass
else:raise SystemExit('PREVIOUS_WORKER_NOT_PROVED_TERMINAL')
rows=[]
for folder,kinds in [('incoming',['issue']+['response-%02d'%n for n in range(1,33)]),('outgoing',['result']+['challenge-%02d'%n for n in range(1,33)])]:
 allowed={n+suffix for n in kinds for suffix in ['.json','.ready.json']}|({'active.lock'} if folder=='outgoing' else set())
 for p in (ROOT/folder).iterdir():
  if p.name not in allowed:raise SystemExit('UNKNOWN_LINUX_PROTOCOL_LEAF_PRESERVED')
 for n in kinds:
  a,b=ROOT/folder/(n+'.json'),ROOT/folder/(n+'.ready.json');ea,eb=a.exists(),b.exists()
  if ea!=eb:raise SystemExit('HALF_PROTOCOL_PAIR_PRESERVED')
  if ea:
   sa,raw=read(a);sb,m=read(b);marker=json.loads(m)
   if marker.get('bytes')!=len(raw) or marker.get('sha256')!=hashlib.sha256(raw).hexdigest() or marker.get('contract')!='clued.independent-ci.complete-public-file/1':raise SystemExit('COMPLETE_PROTOCOL_MARKER_REQUIRED')
   rows.extend([(a,sa),(b,sb)])
rows.append((ROOT/'outgoing/active.lock',read(ROOT/'outgoing/active.lock')[0]))
archive=ROOT/('archive-'+jobid);archive.mkdir(mode=0o700)
lib=ctypes.CDLL(None,use_errno=True);rename=lib.renameat2;rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
for folder in ['incoming','outgoing']:(archive/folder).mkdir(mode=0o700)
for src,before in rows:
 dst=archive/src.relative_to(ROOT)
 if rename(-100,os.fsencode(src),-100,os.fsencode(dst),1)!=0:raise OSError(ctypes.get_errno(),'NOREPLACE_ARCHIVE_REFUSED')
 after=dst.lstat()
 if (before.st_dev,before.st_ino,before.st_mode,before.st_uid,before.st_gid,before.st_size)!=(after.st_dev,after.st_ino,after.st_mode,after.st_uid,after.st_gid,after.st_size):raise SystemExit('ARCHIVED_IDENTITY_CHANGED')
for d in [archive/'incoming',archive/'outgoing',archive,ROOT/'incoming',ROOT/'outgoing',ROOT]:
 fd=os.open(d,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
print(json.dumps({'status':'EXACT_PUBLIC_PROTOCOL_ARCHIVED','jobId':jobid,'files':len(rows),'qualificationIssued':False,'automaticRetryAllowed':False}))
