import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { argv, Companion, COMPANION_CONFIG_CONTRACT, validateCompanionConfig } from '../src/companion.mjs';
import { TEST_NODE, TEST_NODE_SHA } from './helpers.mjs';

const BATCH='0123456789abcdef-0123456789ab';
const cfg=validateCompanionConfig({contract:COMPANION_CONFIG_CONTRACT,node:TEST_NODE,nodeProfileSha256:TEST_NODE_SHA,
  wslExe:'C:\\Program Files\\WSL\\wsl.exe',powershellExe:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  relayScript:'C:\\x\\relay-public.ps1',bundleScript:'C:\\x\\build-bundle.ps1',windowsSpool:'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution:'Ubuntu-24.04',bridgeManifestSha256:'b'.repeat(64),linuxTool:'/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux'});
const probe=argv(cfg).linuxTool('quiescence',BATCH);
const code=probe[probe.indexOf('-c')+1];
const quiet={linuxUnitsInactive:true,containersZero:true};
const noProof={linuxUnitsInactive:false,containersZero:false};
const tool='/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux';
const jobsArgv=['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager','--plain','--full',
  'clued-ci-worker@*.service','clued-ci-wsprep@*.service','clued-ci-archive@*.service'];

// Execute the ACTUAL fixed Python program locally, replacing subprocess.run
// with a stand-in before exec. Neither command is ever started: no WSL,
// systemctl, Linux tool, task, CI, filesystem fixture or network is used.
const driver=String.raw`import base64,contextlib,io,json,subprocess,sys,types
source=base64.b64decode(sys.argv[1]).decode('utf-8')
cases=json.loads(sys.argv[2])
results=[]
for case in cases:
    calls=[]
    def run(args,**kwargs):
        calls.append({'args':args,'shell':kwargs.get('shell',False),'timeout':kwargs.get('timeout')})
        if args[0]=='/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux':
            value=case.get('root',{})
            default=json.dumps({'linuxUnitsInactive':True,'containersZero':True})
        elif args[0]=='/usr/bin/systemctl':
            value=case.get('jobs',{})
            default=''
            if case.get('queuedJobVanishesAfterRoot'):
                default='' if any(c['args'][0]=='/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' for c in calls) else '17 clued-ci-worker@'+'a'*64+'.service start waiting\n'
        else:
            raise AssertionError('UNEXPECTED_PROCESS')
        if value.get('throws'):
            raise subprocess.TimeoutExpired(args,1)
        text='x'*value['outputBytes'] if 'outputBytes' in value else value.get('stdout',default)
        return types.SimpleNamespace(returncode=value.get('code',0),stdout=text,stderr=value.get('stderr',''))
    subprocess.run=run
    sys.argv=['probe','quiescence','--batch','0123456789abcdef-0123456789ab']
    capture=io.StringIO()
    status=0
    with contextlib.redirect_stdout(capture):
        try:
            exec(compile(source,'<actual-fixed-quiescence-probe>','exec'),{'__name__':'__main__'})
        except SystemExit as error:
            status=error.code
    results.append({'code':status,'answer':json.loads(capture.getvalue()),'calls':calls})
print(json.dumps(results))`;

function evaluate(cases){
  const r=spawnSync('python',['-I','-c',driver,Buffer.from(code).toString('base64'),JSON.stringify(cases)],
    {encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024});
  assert.equal(r.error,undefined);
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stderr,'');
  return JSON.parse(r.stdout);
}

test('one fixed isolated WSL probe, validated batch argv, two fixed read-only subprocesses and no shell',()=>{
  assert.deepEqual(probe.slice(0,probe.indexOf('-c')+1),[cfg.wslExe,'--distribution',cfg.distribution,'--user','root','--exec',
    '/usr/bin/env','-i','PATH=/usr/bin:/bin','LANG=C','LC_ALL=C','/usr/bin/python3','-I','-c']);
  assert.deepEqual(probe.slice(-3),['quiescence','--batch',BATCH]);
  assert.throws(()=>argv(cfg).linuxTool('quiescence',BATCH+';id'),{code:'COMPANION_TOOL_ARGS_INVALID'});
  const [r]=evaluate([{}]);
  assert.equal(r.code,0);
  assert.deepEqual(r.answer,{...quiet,pendingJobsQuiet:true});
  assert.deepEqual(r.calls.map(c=>c.args),[jobsArgv,[tool,'quiescence','--batch',BATCH]]);
  assert.ok(r.calls.every(c=>c.shell===false));
  assert.deepEqual(r.calls.map(c=>c.timeout),[5,20]);
});

test('inactive and empty cgroups cannot hide a dependency-waiting worker, wsprep or archive job',()=>{
  const units=[`clued-ci-worker@${'a'.repeat(64)}.service`,`clued-ci-wsprep@${BATCH}.service`,`clued-ci-archive@${BATCH}_rearm-unknown-failure.service`];
  const cases=units.flatMap(unit=>['waiting','running'].map(state=>({jobs:{stdout:`123 ${unit} start ${state}\n`}})));
  for(const r of evaluate(cases)){
    assert.equal(r.code,0);
    assert.deepEqual(r.answer,{...noProof,pendingJobsQuiet:false},'do not even ask an inactive-only root probe after finding a pending job');
    assert.equal(r.calls.length,1);
  }
});

test('known unrelated system jobs do not block the original CI unit scope; every related job type does',()=>{
  const kinds=['start','verify-active','stop','reload','reload-or-start','restart','try-restart','try-reload','nop'];
  const cases=[{jobs:{stdout:'12 docker.service start waiting\n13 apt-daily.timer start running\n14 clued-ci-unrelated@abc.service start waiting\n'}},
    ...kinds.map(kind=>({jobs:{stdout:`15 clued-ci-worker@${'a'.repeat(64)}.service ${kind} waiting\n`}}))];
  const results=evaluate(cases);
  assert.equal(results[0].answer.pendingJobsQuiet,true);
  for(const r of results.slice(1))assert.equal(r.answer.pendingJobsQuiet,false);
});

test('query errors, missing proof and unknown/truncated/duplicate output fail closed without disclosing text',()=>{
  const invalidJobs=['JOB UNIT TYPE STATE\n','No jobs running.\n','SECRET_RAW_OUTPUT\n','1 nonsense start waiting\n',
    `1 clued-ci-worker@${'a'.repeat(64)}.service start\n`,
    `1 clued-ci-worker@${'a'.repeat(64)}.service mystery waiting\n`,
    `1 clued-ci-worker@${'a'.repeat(64)}.service start mystery\n`,
    '1 clued-ci-worker@A.service start waiting\n','1 clued-ci-worker@x\u2026.service start waiting\n',
    '4294967296 docker.service start waiting\n','0 docker.service start waiting\n',
    '1 docker.service start waiting\n1 other.service start running\n'];
  const cases=[...invalidJobs.map(stdout=>({jobs:{stdout}})),{jobs:{code:1,stdout:'',stderr:'SECRET_ERROR'}},
    {jobs:{stderr:'SECRET_WARNING'}},{jobs:{throws:true}},{jobs:{outputBytes:262145}},
    {root:{code:1,stderr:'SECRET_ROOT_ERROR'}},{root:{throws:true}},{root:{stdout:'SECRET_ROOT_STDOUT'}},
    {root:{stdout:JSON.stringify({linuxUnitsInactive:'true',containersZero:true})}},
    {root:{stdout:JSON.stringify({linuxUnitsInactive:true})}},{root:{stdout:JSON.stringify({linuxUnitsInactive:true,containersZero:'true'})}},
    {root:{stdout:'[]'}},{root:{stderr:'SECRET_ROOT_WARNING'}},{root:{outputBytes:1048577}}];
  for(const r of evaluate(cases)){
    assert.equal(r.code,2);
    assert.deepEqual(r.answer,{...noProof,pendingJobsQuiet:false});
    assert.doesNotMatch(JSON.stringify(r),/SECRET_/);
  }
});

test('a nominal zero exit with an unconfirmed reader tree, refusal, timeout or stderr never grants quiet',async()=>{
  for(const extra of [{tree:'unconfirmed'},{tree:'unknown'},{refused:'JOB_HOST_UNCONFIRMED'},
    ...[0,false,'',1,{},[]].map(refused=>({refused})),
    ...[true,'true',null,1,0,'',{},[]].map(timedOut=>({timedOut})),{stderr:'SECRET_ERROR'}]){
    const c=new Companion({cfg,mailbox:null,clock:()=>0,run:async()=>({code:0,stdout:JSON.stringify({...quiet,pendingJobsQuiet:true}),...extra})});
    assert.deepEqual(await c.quiescence(BATCH),noProof);
  }
  for(const extra of [{},{timedOut:false},{refused:null},{timedOut:false,refused:null}]){
    const c=new Companion({cfg,mailbox:null,clock:()=>0,run:async()=>({code:0,stdout:JSON.stringify({...quiet,pendingJobsQuiet:true}),...extra})});
    assert.deepEqual(await c.quiescence(BATCH),quiet);
  }
});

test('normal busy/container proof is preserved; a failed jobs query never starts the root query',()=>{
  const results=evaluate([{root:{stdout:JSON.stringify({linuxUnitsInactive:false,containersZero:true})}},
    {root:{stdout:JSON.stringify({linuxUnitsInactive:true,containersZero:false})}},{jobs:{code:1}}]);
  assert.deepEqual(results[0].answer,{linuxUnitsInactive:false,containersZero:true,pendingJobsQuiet:true});
  assert.deepEqual(results[1].answer,{linuxUnitsInactive:true,containersZero:false,pendingJobsQuiet:true});
  assert.equal(results[2].calls.length,1);
  assert.deepEqual(results[2].calls[0].args,jobsArgv);
});

test('an existing dependency-waiting start cannot disappear after an earlier quiet snapshot and falsely grant quiet',()=>{
  // Old root-first order: root sees inactive/empty, its queued start then runs,
  // list-jobs is empty, and that stale true/true would pass. With jobs first,
  // the existing job is observed before that transition and root is not called.
  const [r]=evaluate([{queuedJobVanishesAfterRoot:true}]);
  assert.deepEqual(r.answer,{...noProof,pendingJobsQuiet:false});
  assert.equal(r.calls.length,1);
  assert.deepEqual(r.calls[0].args,jobsArgv);
});

test('companion keeps its public two-boolean proof shape, requires jobs confirmation and makes one transport read',async()=>{
  const answers=[{...quiet,pendingJobsQuiet:true},{...quiet,pendingJobsQuiet:false},quiet,
    {...quiet,pendingJobsQuiet:'true'},{...quiet,pendingJobsQuiet:true,raw:'SECRET'},
    {...quiet,pendingJobsQuiet:true,linuxUnitsInactive:1}];
  for(const [i,answer] of answers.entries()){
    const calls=[];
    const c=new Companion({cfg,mailbox:null,clock:()=>0,run:async a=>{calls.push(a);return {code:0,stdout:JSON.stringify(answer)};}});
    assert.deepEqual(await c.quiescence(BATCH),i===0?quiet:noProof);
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0],probe);
  }
});
