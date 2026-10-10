// Counts only bounded npm debug HTTP events. No URL, package name, path or
// credential is retained in the result. This is not package-cache inventory.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const MAX_BYTES=5*1024*1024;
export function npmCacheObservation(text,{readComplete=true}={}) {
  const result={schema:'clued.npm-cache-observation/1',source_kind:'npm_debug_http_events',
    denominator_kind:'http_get_cache_event_entries',
    npm_version:null,exit_code:null,source_exported:false,complete:false,
    get_events:0,non_get_events:0,failed_get_events:0,unknown_http_events:0,hits:0,misses:0,revalidated:0,stale:0,skipped:0,updated:0,
    unknown_get_cache_status:0,retry_marker_entries:0,max_attempt_observed:null,request_cache_hit_ratio:null};
  if(typeof text!=='string' || Buffer.byteLength(text)>5*1024*1024)
    return {...result,reason:'debug input missing or exceeds bound'};
  const lines=text.split(/\r?\n/),serials=new Set();let duplicate=false,ci=0,exits=0,nextSerial=0,gap=false;
  for(const line of lines) {
    if(line.length>65536)return {...result,reason:'debug line exceeds bound'};
    const numbered=/^(\d+)\s+(.+)$/.exec(line);if(!numbered)continue;
    if(serials.has(numbered[1]))duplicate=true;serials.add(numbered[1]);
    if(Number(numbered[1])!==nextSerial || String(nextSerial)!==numbered[1])gap=true;
    nextSerial++;
    const message=numbered[2];
    const version=/^info using npm@([0-9]+\.[0-9]+\.[0-9]+)\b/.exec(message);
    if(version)result.npm_version=version[1];
    if(/^verbose title npm ci$/.test(message))ci++;
    const exit=/^verbose exit (-?\d+)$/.exec(message);
    if(exit){exits++;result.exit_code=Number(exit[1]);}
    const event=/^http (cache|fetch)\s+(.+)$/.exec(message);if(!event)continue;
    if(event[1]==='fetch') {
      const method=/^([A-Z]+) /.exec(event[2]);
      if(!method){result.unknown_http_events++;continue;}
      if(method[1]!=='GET'){result.non_get_events++;continue;}
      if(!/^GET \d{3} /.test(event[2]))result.failed_get_events++;
    }
    result.get_events++;
    const retry=/\s+attempt #?(\d+)(?:\s|$)/.exec(event[2]);
    if(retry) {
      const attempts=Number(retry[1]);
      if(!Number.isSafeInteger(attempts) || attempts<1 || attempts>1000)
        return {...result,reason:'request attempt counter outside bound'};
      if(attempts>1)result.retry_marker_entries++;
      result.max_attempt_observed=Math.max(result.max_attempt_observed??0,attempts);
    }
    const status=/\(cache (hit|miss|revalidated|stale|skip|updated)\)$/.exec(event[2]);
    if(!status){result.unknown_get_cache_status++;continue;}
    const key={hit:'hits',miss:'misses',revalidated:'revalidated',stale:'stale',skip:'skipped',updated:'updated'}[status[1]];
    result[key]++;
  }
  result.complete=readComplete===true && text.endsWith('\n') && ci===1 && exits===1 && !duplicate && !gap &&
    result.npm_version!==null && result.exit_code===0;
  if(!result.complete)result.reason='not a complete successful npm ci debug log';
  else if(result.unknown_get_cache_status || result.unknown_http_events)result.reason='unrecognized HTTP cache statuses';
  else if(!result.get_events)result.reason='no observed HTTP GET cache events';
  else result.request_cache_hit_ratio=result.hits/result.get_events;
  return result;
}

export function observationDirectory(env) {
  if(!env.RUNNER_TEMP || !/^\d+$/.test(env.GITHUB_RUN_ID??'') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT??'') ||
    !/^[A-Za-z0-9_-]+$/.test(env.GITHUB_JOB??''))throw Error('job observation identity missing');
  return path.resolve(env.RUNNER_TEMP,`clued-npm-debug-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.GITHUB_JOB}`);
}

// Read one completed invocation from this job's dedicated debug directory.
// No fallback to HOME/cache logs; an install failure cannot yield a hit ratio.
export function readJobObservation(env,io=fs) {
  const missing=reason=>({...npmCacheObservation(null),reason});
  try {
    if(env.NPM_INSTALL_OUTCOME!=='success')return missing('install did not succeed');
    const directory=observationDirectory(env);
    if(path.resolve(env.npm_config_logs_dir??'')!==directory)return missing('job debug directory differs');
    const dirInfo=io.lstatSync(directory);
    if(!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || path.dirname(io.realpathSync(directory))!==io.realpathSync(env.RUNNER_TEMP))
      return missing('job debug directory is not a direct regular child');
    const files=io.readdirSync(directory);
    if(files.length!==1 || !/^[A-Za-z0-9_.-]+-debug-0\.log$/.test(files[0]))return missing('debug invocation missing, rotated or ambiguous');
    const file=path.join(directory,files[0]),listed=io.lstatSync(file);
    if(!listed.isFile() || listed.isSymbolicLink() || listed.nlink!==1 || listed.size>MAX_BYTES)return missing('debug file is not bounded and regular');
    const fd=io.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try {
      const before=io.fstatSync(fd);
      if(before.dev!==listed.dev || before.ino!==listed.ino || !before.isFile() || before.nlink!==1 || before.size>MAX_BYTES)
        return missing('debug identity changed before read');
      const buffer=Buffer.alloc(MAX_BYTES+1);let size=0;
      while(size<=MAX_BYTES) {
        const bytes=io.readSync(fd,buffer,size,buffer.length-size,null);if(bytes===0)break;size+=bytes;
      }
      const after=io.fstatSync(fd),atPath=io.lstatSync(file);
      if(size>MAX_BYTES || size!==before.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs ||
        after.nlink!==1 || after.ino!==atPath.ino || after.dev!==atPath.dev || atPath.isSymbolicLink())
        return missing('debug file changed or exceeded bounds');
      const raw=buffer.subarray(0,size),text=raw.toString('utf8');
      if(!Buffer.from(text).equals(raw))return missing('debug encoding differs');
      return npmCacheObservation(text);
    } finally {io.closeSync(fd);}
  } catch {return missing('job debug log unavailable');}
}

export function main(env=process.env) {
  const observation=readJobObservation(env);
  // Only counters and fixed diagnostic text leave this reader. Observation
  // failure is telemetry unknown, never a replacement for install's outcome.
  console.log(JSON.stringify({schema:'clued.npm-cache-job/1',run_id:/^\d+$/.test(env.GITHUB_RUN_ID??'')?env.GITHUB_RUN_ID:null,
    attempt:/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT??'')?env.GITHUB_RUN_ATTEMPT:null,
    job:/^[A-Za-z0-9_-]+$/.test(env.GITHUB_JOB??'')?env.GITHUB_JOB:null,
    install_outcome:['success','failure','cancelled','skipped'].includes(env.NPM_INSTALL_OUTCOME)?env.NPM_INSTALL_OUTCOME:'unknown',observation}));
  return 0;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
