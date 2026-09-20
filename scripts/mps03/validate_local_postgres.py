"""Run MPS-03 bridge checks in a disposable, network-isolated PostgreSQL container."""
import argparse, base64, hashlib, json, pathlib, subprocess, sys, time, uuid

REPO=pathlib.Path(__file__).resolve().parents[2]
ap=argparse.ArgumentParser()
ap.add_argument('--mps02a-sql',type=pathlib.Path,required=True)
ap.add_argument('--mps02b-sql',type=pathlib.Path,required=True)
ap.add_argument('--compat-shim',action='store_true',help='test-only shim for the nonstandard pg_catalog.jsonb_object_length used by the supplied MPS-02B SQL')
ap.add_argument('--image',default='postgres:17.6')
args=ap.parse_args()
sys.path.insert(0,str(REPO/'development'/'mps'))
from mps03.mps02b_pg_gateway import PgMPS02BStore

container='clued-mps03-review-'+uuid.uuid4().hex[:12]
def docker(*args,input=None):
    return subprocess.run(['docker',*args],input=input,text=True,capture_output=True,timeout=45)
def sql(source,variables=None):
    command=['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-A','-t','-q','-v','ON_ERROR_STOP=1']
    for key,value in (variables or {}).items():
        command += ['-v',key+'='+base64.b64encode(value.encode()).decode()]
    p=docker(*command,input=source)
    if p.returncode: raise RuntimeError((p.stderr or p.stdout)[-1500:])
    lines=[line.strip() for line in p.stdout.splitlines() if line.strip()]
    return lines[-1] if lines else ''

start=docker('run','-d','--name',container,'--network','none','-e','POSTGRES_PASSWORD=local-review-only',args.image)
if start.returncode: raise RuntimeError(start.stderr)
try:
    for attempt in range(80):
        try:
            logs=docker('logs',container)
            initialized='PostgreSQL init process complete; ready for start up.' in (logs.stdout+logs.stderr)
            if initialized and sql('select 1;') == '1': break
        except RuntimeError:
            pass
        time.sleep(.1)
    else: raise RuntimeError('PostgreSQL did not become ready')
    sql('create role anon; create role authenticated; create schema extensions; create schema auth; create table auth.users(id uuid primary key); insert into auth.users values (\'00000000-0000-0000-0000-000000000001\');')
    source_hashes={}
    for source in [args.mps02a_sql,args.mps02b_sql]:
        raw=source.read_bytes(); source_hashes[source.name]=hashlib.sha256(raw).hexdigest()
        sql(raw.decode('utf-8-sig'))
    if args.compat_shim:
        # Local-only compatibility for the supplied MPS-02B source; never a
        # claim that the unmodified formal SQL passes on this PostgreSQL image.
        sql('create function pg_catalog.jsonb_object_length(jsonb) returns integer language sql immutable strict as $$ select count(*)::integer from pg_catalog.jsonb_object_keys($1) $$;')
    store=PgMPS02BStore.__new__(PgMPS02BStore)
    store.user_id='00000000-0000-0000-0000-000000000001'
    store.authority_domain='mps03-local-review'
    store.native_principal='native-review'; store.agent_principal='agent-review'
    store.native_secret='native-gateway-review-secret'; store.agent_secret='agent-gateway-review-secret'
    store.sessions={}
    store._psql=sql
    store._assert_primitives()
    native=store.create_session('NATIVE',store.native_secret)['session_token']
    agent=store.create_session('THIRD_PARTY_AGENT_HOST',store.agent_secret)['session_token']
    created=store.create_object(native,'Review object',{'value':1},'review-create-001')
    replay=store.create_object(native,'Review object',{'value':1},'review-create-001')
    if replay != created: raise AssertionError('create replay changed')
    conflicting=store.create_object(native,'Review object',{'value':99},'review-create-001')
    if conflicting.get('error')!='IDEMPOTENCY_CONFLICT': raise AssertionError('different create payload replayed')
    oid=created['object_id']
    sql("""update clued_private.mps_authorization_states
set authorization_generation = case
 when stable_request_principal_id='agent-review' and action='read' then 2
 when stable_request_principal_id='agent-review' and action='propose' then 3
 when stable_request_principal_id='native-review' and action='read' then 4
 when stable_request_principal_id='native-review' and action='update' then 5
 else authorization_generation end
where object_id='"""+oid+"' and action in ('read','propose','update');")
    observed=store.read_object(agent,oid)
    if observed['read_state_stamp']['authorization_generation']!=2 or observed['state_stamp']['authorization_generation']!=3: raise AssertionError('Agent read/propose generations were not separated')
    native_observed=store.read_object(native,oid)
    if native_observed['read_state_stamp']['authorization_generation']!=4 or native_observed['state_stamp']['authorization_generation']!=5: raise AssertionError('Native read/update generations were not separated')
    proposal=store.create_proposal(agent,oid,{'value':2},observed['state_stamp'])
    committed=store.confirm_proposal(native,oid,proposal['proposal_id'],native_observed['state_stamp'],'review-confirm-001')
    confirmed_replay=store.confirm_proposal(native,oid,proposal['proposal_id'],native_observed['state_stamp'],'review-confirm-001')
    if committed != confirmed_replay: raise AssertionError('confirm replay changed')
    latest=store.read_object(agent,oid)
    if latest['revision_id']!=committed['revision_id'] or latest['adoption_id']!=committed['adoption_id']: raise AssertionError('cross-entry Current mismatch')
    if latest['body']!={'value':2}: raise AssertionError('Current body mismatch')
    stale=store.create_proposal(agent,oid,{'value':3},observed['state_stamp'])
    if stale.get('error')!='STALE_CONTEXT_REQUIRES_REFRESH': raise AssertionError('stale proposal accepted')
    altered=dict(latest['state_stamp']); altered['workflow_instance_version']=-1
    if store.create_proposal(agent,oid,{'value':3},altered).get('error')!='STALE_CONTEXT_REQUIRES_REFRESH': raise AssertionError('altered stamp accepted')
    second=store.create_proposal(agent,oid,{'value':3},latest['state_stamp'])
    native_latest=store.read_object(native,oid)
    second_commit=store.confirm_proposal(native,oid,second['proposal_id'],native_latest['state_stamp'],'review-confirm-002')
    if second_commit['revision_id']==committed['revision_id']: raise AssertionError('later mutation did not advance Current')
    if store.create_object(native,'Review object',{'value':1},'review-create-001')!=created: raise AssertionError('create replay changed after later Current')
    if store.confirm_proposal(native,oid,proposal['proposal_id'],native_observed['state_stamp'],'review-confirm-001')!=committed: raise AssertionError('confirm replay changed after later Current')
    before_interleave=store.read_object(agent,oid)
    pending=store.create_proposal(agent,oid,{'value':4},before_interleave['state_stamp'])
    native_before_interleave=store.read_object(native,oid)
    original_json=store._json
    interleaved={'done':False}
    def commit_between_pack_and_revision(query,variables=None):
        answer=original_json(query,variables)
        if not interleaved['done'] and 'mps_issue_context_pack' in query and variables and variables.get('action')=='read':
            interleaved['done']=True
            store._json=original_json
            try:
                store.confirm_proposal(native,oid,pending['proposal_id'],native_before_interleave['state_stamp'],'review-confirm-003')
            finally:
                store._json=commit_between_pack_and_revision
        return answer
    store._json=commit_between_pack_and_revision
    try:
        consistent_old_read=store._read_for(store.agent_principal,oid,'read')
    finally:
        store._json=original_json
    if not interleaved['done'] or consistent_old_read['revision_id']!=second_commit['revision_id'] or consistent_old_read['body']!={'value':3}: raise AssertionError('concurrent read mixed stamp and body')
    if store.read_object(agent,oid)['body']!={'value':4}: raise AssertionError('interleaved confirmation did not advance Current')
    before=int(sql('select count(*) from clued_private.mps_objects;'))
    sql("create or replace function clued_private.mps_commit_mutation(p_authority_domain_id text,p_stable_request_principal_id text,p_request_id text,p_input jsonb) returns jsonb language sql as $$ select '{\"status\":\"conflict\",\"error\":\"INJECTED_CONFLICT\"}'::jsonb $$;")
    try:
        store.create_object(native,'Rollback check',{'value':4},'review-rollback-001')
        raise AssertionError('noncommitted create returned normally')
    except RuntimeError as error:
        if 'MPS03_CREATE_NOT_COMMITTED' not in str(error): raise
    if int(sql('select count(*) from clued_private.mps_objects;'))!=before: raise AssertionError('noncommitted create left a bootstrap object')
    print(json.dumps({'qualification':'ISOLATED_LOCAL_POSTGRES_WITH_MPS02B_COMPAT_SHIM' if args.compat_shim else 'ISOLATED_LOCAL_POSTGRES_UNMODIFIED_SOURCES','source_sha256':source_hashes,'all_pass':True,'same_create_outcome_after_later_current':True,'same_confirm_outcome_after_later_current':True,'different_payload_conflict':True,'agent_sees_new_current':True,'stale_agent_proposal_rejected':True,'altered_agent_stamp_rejected':True,'distinct_allowed_action_generations':True,'interleaved_read_keeps_stamp_and_body_together':True,'noncommitted_create_rolled_back':True,'container_removed_on_exit':True},indent=2))
finally:
    docker('rm','-f',container)
