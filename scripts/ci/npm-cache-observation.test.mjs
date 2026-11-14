import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {npmCacheObservation,readJobObservation,observationDirectory} from './npm-cache-observation.mjs';
const log=events=>['0 info using npm@11.6.0','1 verbose title npm ci',
  ...events.map((message,i)=>`${i+2} ${message}`),`${events.length+2} verbose exit 0`,''].join('\n');
test('GET cache events have explicit denominators and never retain sensitive source text',()=>{
  const source=log(['http cache https://user:synthetic-secret@registry.invalid/private.tgz 1ms (cache hit)',
    'http fetch GET 200 https://registry.invalid/other 20ms (cache miss)',
    'http fetch GET 304 https://registry.invalid/third 3ms attempt #2 (cache revalidated)',
    'http fetch POST 200 https://registry.invalid/audit 5ms (cache skip)']);
  const value=npmCacheObservation(source);
  assert.equal(value.complete,true);assert.equal(value.get_events,3);assert.equal(value.non_get_events,1);
  assert.equal(value.hits,1);assert.equal(value.misses,1);assert.equal(value.revalidated,1);
  assert.equal(value.retry_marker_entries,1);assert.equal(value.request_cache_hit_ratio,1/3);
  assert.equal(JSON.stringify(value).includes('synthetic-secret'),false);
  assert.equal(JSON.stringify(value).includes('registry.invalid'),false);
  const failed=npmCacheObservation(log(['http fetch GET https://registry.invalid/npm attempt 1 failed with ENOTCACHED']));
  assert.equal(failed.get_events,1);assert.equal(failed.non_get_events,0);assert.equal(failed.failed_get_events,1);
  assert.equal(failed.request_cache_hit_ratio,null);
});
test('failed, partial, unknown, empty or ambiguous logs never establish cache hit ratio',()=>{
  const source=log(['http cache https://registry.invalid/a 1ms (cache hit)']);
  for(const value of [npmCacheObservation(source,{readComplete:false}),npmCacheObservation(source.slice(0,-1)),
    npmCacheObservation(source.replace('verbose exit 0','verbose exit 1')),
    npmCacheObservation(source.replace('verbose title npm ci','verbose title npm install')),
    npmCacheObservation(source+'2 http cache https://registry.invalid/a 1ms (cache hit)\n'),
    npmCacheObservation(log(['http fetch GET 200 https://registry.invalid/a 1ms (cache future)'])),
    npmCacheObservation(log([])),npmCacheObservation(null),npmCacheObservation('x'.repeat(5*1024*1024+1))])
    assert.equal(value.request_cache_hit_ratio,null);
  const multibyte=npmCacheObservation(log(['verbose '+ '\u6d4b'.repeat(21846)]));
  assert.equal(multibyte.complete,false);assert.equal(multibyte.reason,'debug line exceeds bound');
});

function fixture(t) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'npm-observation-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const env={RUNNER_TEMP:temp,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'trusted-self-hosted',NPM_INSTALL_OUTCOME:'success'};
  env.npm_config_logs_dir=observationDirectory(env);
  fs.mkdirSync(env.npm_config_logs_dir);
  const file=path.join(env.npm_config_logs_dir,'2026-10-10T21_00_00-debug-0.log');
  fs.writeFileSync(file,log(['http cache https://synthetic-secret@registry.invalid/a 1ms (cache hit)']));
  return {env,file};
}
test('job collector reads only the unique regular debug log and emits counters',t=>{
  const {env}=fixture(t);const result=readJobObservation(env);
  assert.equal(result.complete,true);assert.equal(result.request_cache_hit_ratio,1);
  assert.equal(result.denominator_kind,'http_get_cache_event_entries');
  assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|registry.invalid|npm-observation-/);
});
test('failed/skipped install, wrong directory, missing, rotated or invalid logs remain unknown',t=>{
  const {env,file}=fixture(t);
  for(const changed of [{NPM_INSTALL_OUTCOME:'failure'},{NPM_INSTALL_OUTCOME:'skipped'},{NPM_INSTALL_OUTCOME:'cancelled'},
    {npm_config_logs_dir:env.RUNNER_TEMP},{GITHUB_RUN_ATTEMPT:'../2'},{GITHUB_JOB:'../../cache'}])
    assert.equal(readJobObservation({...env,...changed}).request_cache_hit_ratio,null);
  fs.writeFileSync(file.replace('debug-0','debug-1'),'rotation');
  assert.equal(readJobObservation(env).request_cache_hit_ratio,null);
  fs.unlinkSync(file.replace('debug-0','debug-1'));
  fs.writeFileSync(file,Buffer.from([255,254,253]));
  assert.equal(readJobObservation(env).request_cache_hit_ratio,null);
  fs.truncateSync(file,5*1024*1024+1);
  assert.equal(readJobObservation(env).request_cache_hit_ratio,null);
  fs.unlinkSync(file);assert.equal(readJobObservation(env).request_cache_hit_ratio,null);
});
test('links and changed file handles cannot provide a cache ratio',t=>{
  const {env}=fixture(t);
  const linked={...fs,lstatSync:file=>{const s=fs.lstatSync(file);return s.isFile()?Object.assign(Object.create(Object.getPrototypeOf(s)),s,{nlink:2}):s;}};
  assert.equal(readJobObservation(env,linked).request_cache_hit_ratio,null);
  let reads=0;const changed={...fs,fstatSync:fd=>{const s=fs.fstatSync(fd);return ++reads===2?Object.assign(Object.create(Object.getPrototypeOf(s)),s,{mtimeMs:s.mtimeMs+1}):s;}};
  assert.equal(readJobObservation(env,changed).request_cache_hit_ratio,null);
});
test('missing serials and retry markers never imply unique request/retry totals',()=>{
  const source=log(['http fetch GET https://registry.invalid/a attempt 2 failed with ETIMEDOUT',
    'http fetch GET 200 https://registry.invalid/a 20ms attempt #3 (cache miss)']);
  const result=npmCacheObservation(source);
  assert.equal(result.retry_marker_entries,2);assert.equal(result.max_attempt_observed,3);
  assert.equal(result.request_cache_hit_ratio,null);
  assert.equal(npmCacheObservation(source.replace('2 http','9 http')).complete,false);
});

