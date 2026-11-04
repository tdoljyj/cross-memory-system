import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const require=createRequire(import.meta.url);
const YAML=require('yaml');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const workflow='.github/workflows/clued-g4-database.yml';
const registry=JSON.parse(fs.readFileSync(path.join(root,'scripts/ci/clued-gated-proof-profiles.json'),'utf8'));
const record=registry.workflows[workflow];
// The registry stores workflow bytes as source_yaml_lines (clued-workflow-profile-codec); older records carry source_yaml.
const yamlOf=source=>source.source_yaml??source.source_yaml_lines.join('\n');
const candidates=[record,...(record.accepted_sources??[])]
  .filter(source=>yamlOf(source).includes('image_source=fallback-cache'));
const digest='sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929';
const primary='postgres@'+digest;
const fallback='public.ecr.aws/docker/library/postgres@'+digest;
const bash=process.platform==='win32'
  ? path.join(process.env.ProgramFiles??'C:/Program Files','Git/bin/bash.exe') : 'bash';

// These functions intercept every external command in the actual registered
// YAML step. No Docker daemon, network pull, database or production test runs.
const intercept=String.raw`
docker() {
  local command="$1"
  shift
  case "$command" in
    image)
      [[ "$1" == inspect && "$#" == 2 ]] || return 91
      printf 'inspect %s\n' "$2" >> "$CALL_LOG"
      [[ "$DOCKER_UNAVAILABLE" != 1 ]] || return 127
      if [[ "$2" == "$PRIMARY_EXPECTED" ]]; then
        [[ "$CACHE_PRIMARY" == 1 ]]
      elif [[ "$2" == "$FALLBACK_EXPECTED" ]]; then
        [[ "$CACHE_FALLBACK" == 1 ]]
      elif [[ -n "$UNRELATED_CACHE" && "$2" == "$UNRELATED_CACHE" ]]; then
        return 0
      else
        return 91
      fi
      ;;
    pull)
      [[ "$#" == 1 ]] || return 91
      printf 'pull %s\n' "$1" >> "$CALL_LOG"
      [[ "$DOCKER_UNAVAILABLE" != 1 ]] || return 127
      if [[ "$1" == "$PRIMARY_EXPECTED" ]]; then
        [[ "$PULL_PRIMARY" == 1 ]]
      elif [[ "$1" == "$FALLBACK_EXPECTED" ]]; then
        [[ "$PULL_FALLBACK" == 1 ]]
      else
        return 91
      fi
      ;;
    info)
      [[ "$#" == 2 && "$1" == --format ]] || return 91
      printf 'info\n' >> "$CALL_LOG"
      printf 'mock-daemon / mock-name\n'
      ;;
    *) return 91 ;;
  esac
}
node() {
  [[ "$#" == 3 && "$1" == scripts/run-tests.mjs &&
     "$2" == --test && "$3" == tests/production-backup-scope-db.test.mjs ]] || return 92
  printf 'test %s\n' "$CLUED_BACKUP_TEST_IMAGE" >> "$CALL_LOG"
  return "$TEST_EXIT"
}
`;

function execute(script,scenario) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clued-pg-image-cache-'));
  const log=path.join(dir,'calls.log');
  const callPath=process.platform==='win32'
    ? log.replaceAll('\\','/').replace(/^([A-Za-z]):/,(all,drive)=>'/'+drive.toLowerCase()) : log;
  try {
    const result=spawnSync(bash,['-e','-c',intercept+'\n'+script],{
      encoding:'utf8',timeout:10000,
      env:{...process.env,CALL_LOG:callPath,PRIMARY_EXPECTED:primary,FALLBACK_EXPECTED:fallback,
        CACHE_PRIMARY:'0',CACHE_FALLBACK:'0',PULL_PRIMARY:'0',PULL_FALLBACK:'0',
        DOCKER_UNAVAILABLE:'0',TEST_EXIT:'0',...scenario.env}
    });
    assert.ifError(result.error);
    assert.equal(result.signal,null);
    const calls=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split(/\r?\n/):[];
    return {...result,calls};
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

test('PostgreSQL cache regression uses both actual registered G4 backup steps',()=>{
  assert.equal(require('yaml/package.json').version,'2.9.0');
  assert.ok(candidates.length>0,'missing registered cache-fix candidate');
  for(const source of candidates) {
    const parsed=YAML.parse(yamlOf(source));
    const steps=Object.values(parsed.jobs).flatMap(job=>(job.steps??[])
      .filter(step=>step.name==='Verify actual PostgreSQL17 production backup coverage'));
    assert.equal(steps.length,2,source.workflow_blob);
    assert.equal(steps[0].run,steps[1].run);
  }
});

const scenarios=[
  {name:'primary exact cache',env:{CACHE_PRIMARY:'1'},image:primary,pulls:[]},
  {name:'both exact caches prefer primary',env:{CACHE_PRIMARY:'1',CACHE_FALLBACK:'1'},image:primary,pulls:[]},
  {name:'alternate exact cache works with network unavailable',env:{CACHE_FALLBACK:'1'},image:fallback,pulls:[]},
  {name:'both miss and primary pull succeeds',env:{PULL_PRIMARY:'1'},image:primary,pulls:[primary]},
  {name:'primary pull fails and alternate pull succeeds',env:{PULL_FALLBACK:'1'},image:fallback,pulls:[primary,fallback]},
  {name:'both pulls fail',env:{},exit:1,pulls:[primary,fallback]},
  {name:'Docker unavailable',env:{DOCKER_UNAVAILABLE:'1'},exit:127,pulls:[primary,fallback]},
  // Neither an unrelated digest nor postgres:latest satisfies an exact inspect.
  {name:'unrelated cached image cannot substitute the pin',env:{UNRELATED_CACHE:'postgres:latest'},exit:1,pulls:[primary,fallback]},
  {name:'coverage test failure propagates without another pull',env:{CACHE_FALLBACK:'1',TEST_EXIT:'23'},image:fallback,exit:23,pulls:[]}
];

for(const source of candidates) {
  const parsed=YAML.parse(yamlOf(source));
  for(const [jobId,job] of Object.entries(parsed.jobs)) {
    const step=(job.steps??[]).find(item=>item.name==='Verify actual PostgreSQL17 production backup coverage');
    if(!step)continue;
    for(const scenario of scenarios) test('registered G4 '+jobId+': '+scenario.name,()=>{
      const result=execute(step.run,scenario);
      assert.equal(result.status,scenario.exit??0,result.stderr);
      assert.deepEqual(result.calls.filter(call=>call.startsWith('pull ')),
        scenario.pulls.map(image=>'pull '+image));
      assert.deepEqual(result.calls.filter(call=>call.startsWith('test ')),
        scenario.image?['test '+scenario.image]:[]);
      if(scenario.env.CACHE_PRIMARY!=='1')assert.deepEqual(result.calls.slice(0,2),
        ['inspect '+primary,'inspect '+fallback]);
      else assert.equal(result.calls[0],'inspect '+primary);
    });
  }
}
