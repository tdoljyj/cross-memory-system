// Offline checks for the v6-host package. Run on the Linux Host as the publisher
// (uid 995, so protectedBytes and the derived-config writer run as in a release):
//   node offline-checks-v6.mjs <v6-dir> <v5-dir>
// Reads the installed public context for its sourcePins, derives the PDF config
// with the v6 function, writes it once under APP/.wrangler with a probe name,
// runs `wrangler deploy --dry-run` on it (no upload, no credential), compares
// the output with the verified artifact and removes the probe file.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const [v6,v5]=process.argv.slice(2);
const hash=b=>createHash('sha256').update(b).digest('hex');
const results=[];const check=(name,ok,detail='')=>results.push({name,ok:!!ok,detail:String(detail).slice(0,300)});
const files=['install-once.mjs','payload/release/existing-release-entry-v1/fixed-currentness-ports.mjs','payload/release/existing-release-entry-v1/v3/existing-stages.mjs','payload/release/existing-release-entry-v1/v3-host/host-files.mjs','payload/release/existing-release-entry-v1/v3-host/release-once.mjs','payload/release/linux-process-manager.mjs','payload/release/verify-currentness-external.mjs'];
const RELEASE='payload/release/existing-release-entry-v1/v3-host/release-once.mjs';
for(const f of files){const r=spawnSync(process.execPath,['--check',path.join(v6,f)],{encoding:'utf8'});check('syntax:'+f,r.status===0,r.stderr.trim());}
for(const f of files.filter(f=>f!==RELEASE))check('unchanged-from-v5:'+f,fs.readFileSync(path.join(v6,f)).equals(fs.readFileSync(path.join(v5,f))));
const m=JSON.parse(fs.readFileSync(path.join(v6,'package-manifest.json'),'utf8'));
for(const f of files)check('manifest:'+f,m.files[f]?.sha256===hash(fs.readFileSync(path.join(v6,f)))&&m.files[f].bytes===fs.statSync(path.join(v6,f)).size);
check('revision 6 after v5',m.revision===6&&m.previousPackageManifestSha256==='590f00f3776391e81ed01f29f64de03ca65fd77aa0d1ccd8003abff8cc75a512');
const stages=fs.readFileSync(path.join(v6,'payload/release/existing-release-entry-v1/v3/existing-stages.mjs'),'utf8');
check('existing-stages still pins v5 manager',stages.includes(`[MANAGER,'${m.files['payload/release/linux-process-manager.mjs'].sha256}']`)&&m.files['payload/release/linux-process-manager.mjs'].sha256==='b961dfc06794336f38f47d4f8f5d7c6a2724aee6ba5bac4ff69090ef30842f70');
const release=fs.readFileSync(path.join(v6,RELEASE),'utf8');
check('no --no-build argument left',!release.includes("'--no-build'"));
check('pdf-deploy uses derived config',release.includes("run('pdf-deploy',[wr,'deploy','--config',PDF_RELEASE_CONFIG],{env:cf()});"));
check('derived before grant',release.indexOf('writePdfReleaseConfig(c);')>0&&release.indexOf('writePdfReleaseConfig(c);')<release.indexOf("'grant-before-deploy'"));
for(const [f,expect] of [[RELEASE,'DISABLED'],['install-once.mjs','DISABLED']]){
 const r=spawnSync(process.execPath,[path.join(v6,f)],{encoding:'utf8',cwd:v6});check('default disabled:'+f,r.stdout.includes(`"status":"${expect}"`),r.stdout.trim());
}
const {pdfReleaseConfig}=await import(path.join(v6,RELEASE));
const c=JSON.parse(fs.readFileSync('/etc/clued-production-release/existing-release.json','utf8'));
const bytes=pdfReleaseConfig(c);
check('derived config equals dry-run-proven bytes',hash(bytes)==='a2659ea88a6e02468fa34a19a3bbb0b9a3bc8830eb39da6b16c21e0af2bfcb49',hash(bytes));
const derived=JSON.parse(bytes.toString('utf8')),orig=JSON.parse(fs.readFileSync('/srv/clued-production-release/source/apps/clued-cloud/wrangler.pdf-extractor.jsonc','utf8'));
const strip=o=>{const x={...o};delete x.build;delete x.$schema;delete x.main;return JSON.stringify(x);};
check('derived differs only in build/$schema/main',strip(derived)===strip(orig)&&!('build' in derived)&&derived.main==='../dist/pdf-extractor/index.js');
const wrong=v=>{try{pdfReleaseConfig({...c,sourcePins:{...c.sourcePins,'apps/clued-cloud/wrangler.pdf-extractor.jsonc':v}});return 'PASS';}catch(e){return e.code;}};
check('changed pin refused',wrong('0'.repeat(64))==='PDF_CONFIG_PIN_REQUIRED');
check('missing pin refused',wrong(undefined)==='PDF_CONFIG_PIN_REQUIRED');
// Dry-run of the exact derived bytes, as the publisher.
const APP='/srv/clued-production-release/source/apps/clued-cloud',probe=APP+'/.wrangler/pdf-extractor.v6probe.json';
const tmp=fs.mkdtempSync('/var/lib/clued-production-release/publisher-tmp/v6probe-');
fs.writeFileSync(probe,bytes,{flag:'wx',mode:0o600});
const env={PATH:'/opt/clued-production-release-runtime:/usr/bin:/bin',HOME:'/var/lib/clued-production-release/publisher-home',TMPDIR:'/var/lib/clued-production-release/publisher-tmp',LANG:'C',LC_ALL:'C',NODE_OPTIONS:'',NODE_PATH:'',XDG_CONFIG_HOME:'/var/lib/clued-production-release/publisher-home',WRANGLER_LOG_PATH:tmp+'/wrangler.log'};
const r=spawnSync(process.execPath,[APP+'/node_modules/wrangler/bin/wrangler.js','deploy','--config','.wrangler/pdf-extractor.v6probe.json','--dry-run','--outdir',tmp+'/out'],{cwd:APP,env,encoding:'utf8',timeout:300000});
fs.unlinkSync(probe);
const out=path.join(tmp,'out','index.js');
check('wrangler dry-run of derived config exits 0',r.status===0,(r.stderr||'').slice(-200));
check('dry-run upload equals verified artifact',fs.existsSync(out)&&fs.readFileSync(out).equals(fs.readFileSync(APP+'/dist/pdf-extractor/index.js')));
check('probe removed, .wrangler empty again',fs.readdirSync(APP+'/.wrangler').length===0,fs.readdirSync(APP+'/.wrangler').join(','));
const pass=results.every(x=>x.ok);
process.stdout.write(JSON.stringify({contract:'clued.existing-release-v6-host-offline-checks/1',uid:process.getuid(),packageManifestSha256:hash(fs.readFileSync(path.join(v6,'package-manifest.json'))),releaseOnceSha256:m.files[RELEASE].sha256,checks:results.length,pass,results},null,1)+'\n');
process.exitCode=pass?0:1;
