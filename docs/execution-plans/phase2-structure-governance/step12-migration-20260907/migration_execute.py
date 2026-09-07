"""Exact-byte migration executor. Authority comes from the existing pinned Freeze.

Originals and a durable journal are stored outside the repository before mutation.
This module contains no business store, Git push, network access, or decision issuer.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import unicodedata
import uuid

HERE=Path(__file__).resolve().parent
HEX=re.compile(r'^[0-9a-f]{64}$')
class MigrationError(RuntimeError):pass
def sha(raw):return hashlib.sha256(raw).hexdigest()
def encode(value):return (json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode('utf8')
def read_exact(path,expected):
    if not isinstance(expected,str) or not HEX.fullmatch(expected):raise MigrationError('invalid expected digest')
    path=Path(path)
    if path.is_symlink() or not path.is_file():raise MigrationError('required regular file missing: '+str(path))
    raw=path.read_bytes()
    if sha(raw)!=expected:raise MigrationError('digest mismatch: '+str(path))
    return raw
def safe(root,name,mutating=False):
    root=Path(root).resolve()
    if not isinstance(name,str) or not name or '\\' in name or '\0' in name:raise MigrationError('invalid relative path')
    rel=PurePosixPath(name)
    if rel.is_absolute() or '..' in rel.parts or ':' in name:raise MigrationError('unsafe relative path')
    path=root.joinpath(*rel.parts)
    if not path.resolve().is_relative_to(root) or path.is_symlink():raise MigrationError('symlink or path escape')
    if mutating and (rel.parts[0] in ['.git','memory','artifacts','apps','cloud','.codex','.agents']):raise MigrationError('protected migration path')
    return path
def file_hash(path):
    if path.is_symlink():raise MigrationError('symlink not allowed')
    if not path.exists():return None
    if not path.is_file():raise MigrationError('expected regular file: '+str(path))
    return sha(path.read_bytes())
def atomic_write(path,raw,mode=None):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.parent/('.clued-migration-'+uuid.uuid4().hex+'.tmp')
    try:
        with open(temporary,'xb') as stream:
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        if mode is not None:os.chmod(temporary,mode)
        os.replace(temporary,path)
    finally:
        if temporary.exists():temporary.unlink()

@contextmanager
def migration_lock(store,repo):
    store=Path(store).resolve();repo=Path(repo).resolve()
    if store.is_relative_to(repo):raise MigrationError('transaction store must be outside repository')
    store.mkdir(parents=True,exist_ok=True)
    lock_name='repo-'+sha(os.path.normcase(str(repo)).encode())+'.lock'
    with open(store/lock_name,'a+b') as stream:
        if stream.tell()==0:stream.write(b'0');stream.flush()
        stream.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError as error:raise MigrationError('another migration/rollback holds the repository lock') from error
        try:yield store
        finally:
            stream.seek(0)
            if os.name=='nt':msvcrt.locking(stream.fileno(),msvcrt.LK_UNLCK,1)
            else:fcntl.flock(stream.fileno(),fcntl.LOCK_UN)

def load_inputs(path,expected):
    raw=read_exact(path,expected);value=json.loads(raw)
    if value.get('format')!='PHASE2_MIGRATION_EXECUTION_INPUTS_V1' or value.get('state')!='READY_FOR_FREEZE_BINDING_NOT_EXECUTED':raise MigrationError('unready execution inputs')
    if value.get('authority_effect')!='NONE':raise MigrationError('execution inputs cannot issue authority')
    if not isinstance(value.get('changes'),list) or not value['changes']:raise MigrationError('empty changes')
    seen=set();paths=set()
    for item in value['changes']:
        key=unicodedata.normalize('NFC',item['path']).casefold()
        if key in seen:raise MigrationError('duplicate/colliding changed path')
        seen.add(key);paths.add(item['path'])
        safe(Path(path).parent,item['path'],True)
        before=item.get('before_sha256');after=item.get('after_sha256')
        for digest in [before,after]:
            if digest is not None and (not isinstance(digest,str) or not HEX.fullmatch(digest)):raise MigrationError('unbound source/target digest')
        if before==after or item.get('phase') not in [0,1,2]:raise MigrationError('invalid/no-op change')
        if after is None and item.get('payload') is not None:raise MigrationError('deletion cannot have payload')
        if after is not None and (not item.get('payload') or item['payload'].get('sha256')!=after):raise MigrationError('payload/after digest mismatch')
    ordered=sorted(value['changes'],key=lambda x:(x['phase'],x['path']))
    if value['changes']!=ordered:raise MigrationError('changes are not in deterministic installation order')
    for item in value['changes']:
        if item.get('mode_source') and item['mode_source'] not in paths:raise MigrationError('mode source is outside declared source set')
    for lock in value.get('immutable_input_locks',[]):
        if lock['path'] in paths:raise MigrationError('immutable input would be modified: self-reference or source drift')
    return value,raw

def validate_freeze(freeze_path,expected_freeze,inputs_path,inputs_sha,repo):
    raw=read_exact(freeze_path,expected_freeze);decision=json.loads(raw)
    if decision.get('type')!='Phase2StructureFreezeDecision' or decision.get('state')!='FROZEN':raise MigrationError('valid existing Phase2StructureFreezeDecision required')
    binding=decision.get('migration_execution_inputs_ref') or {}
    if binding.get('sha256')!=inputs_sha:raise MigrationError('Freeze does not bind exact execution inputs')
    if not isinstance(binding.get('path'),str) or (Path(freeze_path).parent/binding['path']).resolve()!=Path(inputs_path).resolve():raise MigrationError('Freeze execution-input locator mismatch')
    arch=decision.get('architecture_acceptance_ref')
    if isinstance(arch,dict):arch=arch.get('path')
    if not isinstance(arch,str) or not arch:raise MigrationError('architecture acceptance reference required')
    architecture=json.loads(read_exact(Path(freeze_path).parent/arch,decision.get('architecture_acceptance_digest')))
    if architecture.get('type')!='ArchitectureConstitutionAcceptanceDecision' or architecture.get('state')!='ACCEPTED':raise MigrationError('accepted architecture decision required')
    # Tests never manufacture a real project Freeze: this marker confines test decisions.
    if decision.get('fixture_scope_only'):
        if not Path(repo).resolve().is_relative_to((HERE/'fixtures').resolve()) or (Path(repo)/'.git').exists():raise MigrationError('fixture Freeze cannot authorize a real repository')
    return raw

def preflight(inputs,repo,bundle_root):
    repo=Path(repo).resolve();errors=[]
    for lock in inputs.get('immutable_input_locks',[]):
        path=safe(repo,lock['path'])
        if file_hash(path)!=lock['sha256']:errors.append({'path':lock['path'],'reason':'IMMUTABLE_INPUT_DRIFT'})
    for item in inputs['changes']:
        path=safe(repo,item['path'],True);actual=file_hash(path)
        if actual!=item['before_sha256']:errors.append({'path':item['path'],'reason':'SOURCE_OR_TARGET_DRIFT','actual_sha256':actual,'expected_sha256':item['before_sha256']})
        if item['after_sha256'] is not None:
            payload=safe(bundle_root,item['payload']['path'])
            if file_hash(payload)!=item['after_sha256']:errors.append({'path':item['path'],'reason':'PAYLOAD_DRIFT'})
    return {'status':'EXACT_SOURCE_TARGET_INPUTS_MATCH' if not errors else 'NOT_READY','errors':errors,'changed_paths':len(inputs['changes']),'authority_effect':'NONE','repository_writes':0}

def save_state(txn,state):
    atomic_write(txn/'state.json',encode(state))
def append_event(txn,event):
    with open(txn/'events.jsonl','ab') as stream:
        stream.write(encode(event));stream.flush();os.fsync(stream.fileno())

def _rollback(txn,repo,inputs,state):
    """Examine every intended write before touching anything; preserve concurrent edits."""
    candidates=[];errors=[]
    for index in state['intended']:
        item=inputs['changes'][index];path=safe(repo,item['path'],True);actual=file_hash(path)
        if actual not in [item['before_sha256'],item['after_sha256']]:
            errors.append({'path':item['path'],'reason':'CONCURRENT_AFTER_STATE_DRIFT'});continue
        if item['before_sha256'] is not None:
            backup=txn/'backups'/f'{index:04}.bin'
            if file_hash(backup)!=item['before_sha256']:errors.append({'path':item['path'],'reason':'BACKUP_DIGEST_MISMATCH'})
        if actual==item['after_sha256']:candidates.append(index)
    if errors:
        state['status']='ROLLBACK_BLOCKED';state['rollback_errors']=errors;save_state(txn,state)
        append_event(txn,{'event':'ROLLBACK_BLOCKED','errors':errors})
        return {'status':'ROLLBACK_BLOCKED','errors':errors,'transaction':str(txn)}
    state['status']='ROLLING_BACK';save_state(txn,state)
    for index in reversed(candidates):
        item=inputs['changes'][index];path=safe(repo,item['path'],True)
        actual=file_hash(path)
        if actual==item['before_sha256']:continue
        if actual!=item['after_sha256']:raise MigrationError('concurrent change while rolling back: '+item['path'])
        if item['before_sha256'] is None:path.unlink()
        else:
            raw=read_exact(txn/'backups'/f'{index:04}.bin',item['before_sha256'])
            meta=state['before_metadata'][str(index)]
            atomic_write(path,raw,meta['mode'])
            os.utime(path,ns=(meta['atime_ns'],meta['mtime_ns']))
        if file_hash(path)!=item['before_sha256']:raise MigrationError('rollback readback failed')
        append_event(txn,{'event':'PATH_RESTORED','path':item['path'],'sha256':item['before_sha256']})
    for name in sorted(state.get('created_directories',[]),key=lambda x:len(PurePosixPath(x).parts),reverse=True):
        path=safe(repo,name,True)
        if path.is_dir():
            try:path.rmdir()
            except OSError:pass  # Preserve any concurrent content; never recursively remove a directory.
    state['status']='ROLLED_BACK';save_state(txn,state)
    append_event(txn,{'event':'ROLLBACK_COMPLETE','original_input_sha256':state['inputs_sha256']})
    return {'status':'ROLLED_BACK','restored_paths':len(candidates),'transaction':str(txn),'prior_evidence_preserved':True}

def execute(repo,inputs_path,expected_inputs,freeze_path,expected_freeze,store,*,fail_after=None,after_mutation=None):
    repo=Path(repo).resolve();inputs_path=Path(inputs_path).resolve();bundle=inputs_path.parent
    inputs,raw_inputs=load_inputs(inputs_path,expected_inputs)
    raw_freeze=validate_freeze(freeze_path,expected_freeze,inputs_path,expected_inputs,repo)
    with migration_lock(store,repo) as store:
        check=preflight(inputs,repo,bundle)
        if check['errors']:raise MigrationError('preflight rejected: '+json.dumps(check['errors']))
        txn=store/('migration-'+uuid.uuid4().hex);(txn/'backups').mkdir(parents=True)
        atomic_write(txn/'inputs.json',raw_inputs);atomic_write(txn/'freeze.json',raw_freeze)
        state={'status':'PREPARING','repository':str(repo),'inputs_path':str(inputs_path),
          'inputs_sha256':expected_inputs,'freeze_sha256':expected_freeze,'intended':[],'applied':[],
          'before_metadata':{},'created_directories':[],'runtime_authority_effect':'NONE_NEW; existing Freeze only'}
        save_state(txn,state)
        # Durable originals are complete before the first target or source mutation.
        for index,item in enumerate(inputs['changes']):
            path=safe(repo,item['path'],True)
            if file_hash(path)!=item['before_sha256']:raise MigrationError('source changed during backup: '+item['path'])
            if item['before_sha256'] is not None:
                meta=path.stat();original=read_exact(path,item['before_sha256'])
                atomic_write(txn/'backups'/f'{index:04}.bin',original)
                state['before_metadata'][str(index)]={'mode':stat.S_IMODE(meta.st_mode),'atime_ns':meta.st_atime_ns,'mtime_ns':meta.st_mtime_ns}
        state['status']='PREPARED';save_state(txn,state)
        append_event(txn,{'event':'ORIGINALS_DURABLY_PRESERVED','count':len(state['before_metadata']),'inputs_sha256':expected_inputs,'freeze_sha256':expected_freeze})
        try:
            check=preflight(inputs,repo,bundle)
            if check['errors']:raise MigrationError('source/target drift after backup')
            state['status']='APPLYING';save_state(txn,state)
            original_modes={inputs['changes'][int(i)]['path']:m['mode'] for i,m in state['before_metadata'].items()}
            for index,item in enumerate(inputs['changes']):
                path=safe(repo,item['path'],True)
                if file_hash(path)!=item['before_sha256']:raise MigrationError('source/target drift before write: '+item['path'])
                state['intended'].append(index);save_state(txn,state)
                if file_hash(path)!=item['before_sha256']:raise MigrationError('source/target changed after intent: '+item['path'])
                if item['after_sha256'] is None:path.unlink()
                else:
                    raw=read_exact(safe(bundle,item['payload']['path']),item['after_sha256'])
                    parent=path.parent
                    while parent!=repo and not parent.exists():
                        name=parent.relative_to(repo).as_posix()
                        if name not in state['created_directories']:state['created_directories'].append(name)
                        parent=parent.parent
                    save_state(txn,state)
                    mode=original_modes.get(item.get('mode_source'),original_modes.get(item['path'],0o644))
                    atomic_write(path,raw,mode)
                if file_hash(path)!=item['after_sha256']:raise MigrationError('after write readback mismatch')
                state['applied'].append(index);save_state(txn,state)
                append_event(txn,{'event':'PATH_APPLIED','path':item['path'],'before_sha256':item['before_sha256'],'after_sha256':item['after_sha256']})
                if after_mutation:after_mutation(index,txn)
                if fail_after is not None and len(state['applied'])>=fail_after:raise MigrationError('injected fixture failure')
            for lock in inputs.get('immutable_input_locks',[]):
                if file_hash(safe(repo,lock['path']))!=lock['sha256']:raise MigrationError('immutable input changed during migration')
            for item in inputs['changes']:
                if file_hash(safe(repo,item['path'],True))!=item['after_sha256']:raise MigrationError('final after-state changed during migration')
            state['status']='COMPLETED';save_state(txn,state)
            receipt={'status':'MIGRATION_FILE_OPERATIONS_COMPLETED','transaction':str(txn),'inputs_sha256':expected_inputs,'freeze_sha256':expected_freeze,
              'changed_paths':len(inputs['changes']),'after_files':[{'path':x['path'],'sha256':x['after_sha256']} for x in inputs['changes']],
              'authority_effect':'NONE_NEW','scope':'Exact local file operations only; not Step13-21 acceptance, Canonical semantic proof, enforcement or publication.'}
            atomic_write(txn/'receipt.json',encode(receipt));append_event(txn,{'event':'FILE_OPERATIONS_COMPLETED','changed_paths':len(inputs['changes'])})
            return receipt
        except Exception as error:
            state['failure']=str(error)
            try:
                save_state(txn,state);append_event(txn,{'event':'APPLY_FAILED','error':str(error)})
            except OSError:pass  # A full journal volume must not prevent attempting restoration.
            try:result=_rollback(txn,repo,inputs,state)
            except Exception as rollback_error:
                result={'status':'ROLLBACK_REQUIRES_RECOVERY','transaction':str(txn),'errors':[{'reason':str(rollback_error)}]}
                state['status']='ROLLBACK_REQUIRES_RECOVERY';state['rollback_error']=str(rollback_error)
                try:save_state(txn,state)
                except OSError:pass
            result.update({'apply_failed':True,'failure':str(error)})
            return result

def rollback(repo,transaction,expected_inputs,expected_freeze):
    txn=Path(transaction).resolve();repo=Path(repo).resolve()
    with migration_lock(txn.parent,repo):
        inputs,_=load_inputs(txn/'inputs.json',expected_inputs)
        read_exact(txn/'freeze.json',expected_freeze)
        state=json.loads((txn/'state.json').read_text(encoding='utf8'))
        if state['repository']!=str(repo) or state['inputs_sha256']!=expected_inputs or state['freeze_sha256']!=expected_freeze:raise MigrationError('transaction identity mismatch')
        if not isinstance(state.get('intended'),list) or len(set(state['intended']))!=len(state['intended']) or any(type(i) is not int or not 0<=i<len(inputs['changes']) for i in state['intended']):raise MigrationError('invalid transaction path set')
        return _rollback(txn,repo,inputs,state)

def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='mode',required=True)
    check=sub.add_parser('preflight');check.add_argument('--repo',required=True);check.add_argument('--inputs',required=True);check.add_argument('--expected-input-sha',required=True)
    apply=sub.add_parser('apply')
    for name in ['repo','inputs','expected-input-sha','freeze','expected-freeze-sha','transaction-store']:apply.add_argument('--'+name,required=True)
    undo=sub.add_parser('rollback')
    for name in ['repo','transaction','expected-input-sha','expected-freeze-sha']:undo.add_argument('--'+name,required=True)
    args=parser.parse_args()
    try:
        if args.mode=='preflight':
            inputs,_=load_inputs(args.inputs,args.expected_input_sha);result=preflight(inputs,args.repo,Path(args.inputs).resolve().parent)
        elif args.mode=='apply':result=execute(args.repo,args.inputs,args.expected_input_sha,args.freeze,args.expected_freeze_sha,args.transaction_store)
        else:result=rollback(args.repo,args.transaction,args.expected_input_sha,args.expected_freeze_sha)
        print(json.dumps(result,ensure_ascii=False))
        return 1 if result.get('errors') or result.get('apply_failed') or result.get('status')=='ROLLBACK_BLOCKED' else 0
    except (MigrationError,ValueError,OSError,KeyError) as error:
        print(json.dumps({'status':'EXECUTION_REJECTED','error':str(error),'new_authority_issued':False},ensure_ascii=False));return 1
if __name__=='__main__':raise SystemExit(main())
