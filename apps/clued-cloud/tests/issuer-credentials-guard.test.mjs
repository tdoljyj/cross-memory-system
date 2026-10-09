import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const INSERT=/insert\s+into\s+(?:clued_private\.)?(?:authorization_issuers_v12|storage_oauth_apps_v1)\b/i;
test('tests inserting synthetic issuer credentials use the explicit disposable fixture or a historical boundary',async()=>{
  const missing=[];let count=0;
  for(const file of await fs.readdir(path.join(root,'tests'))){
    if(!file.endsWith('.mjs'))continue;
    const source=await fs.readFile(path.join(root,'tests',file),'utf8');
    if(!file.includes('-db.')&&!file.includes('.fixture.')&&!/embedded-postgres/.test(source))continue;
    if(!INSERT.test(source))continue;count++;
    if(!/allowTestIssuerCredentials|issuer-credentials: \S/.test(source))missing.push(file);
  }
  assert.ok(count>25,'the issuer fixture scan found the established tests');
  assert.deepEqual(missing,[]);
});
test('test-only issuer credential grants never enter production migrations or the Worker',async()=>{
  for(const dir of ['supabase/migrations','worker'])for(const file of await fs.readdir(path.join(root,dir))){
    if(!/\.(sql|ts|mjs)$/.test(file))continue;
    assert.doesNotMatch(await fs.readFile(path.join(root,dir,file),'utf8'),/test_issuer_credential_v1|allowTestIssuerCredentials/,file);
  }
});
test('evaluators inserting synthetic issuers explicitly stage and activate credentials',async()=>{
  const missing=[];let count=0;
  async function scan(dir){
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isDirectory()){await scan(file);continue;}
      if(!/\.(mjs|sql)$/.test(entry.name))continue;
      const source=await fs.readFile(file,'utf8');
      if(!INSERT.test(source))continue;count++;
      if(!/issuer_credential_stage_v1/.test(source)||!/issuer_credential_activate_v1/.test(source))missing.push(path.relative(root,file));
      assert.doesNotMatch(source,/test_issuer_credential_v1|allowTestIssuerCredentials/,file);
    }
  }
  await scan(path.join(root,'evals'));
  assert.ok(count>0,'the scan found the real Information Flow issuer setup');
  assert.deepEqual(missing,[]);
});
