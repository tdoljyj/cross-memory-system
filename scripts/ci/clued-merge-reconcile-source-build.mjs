// Explicit development-only deterministic registry generation. Not invoked by
// the workflow, not a signing/acceptance/Host qualification operation.
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {hash,canonical,SOURCE_FILE,WORKFLOW_FILE,SOURCE_SCHEMA} from './clued-merge-reconcile-source.mjs';
const yaml=createRequire(new URL('../../apps/clued-cloud/package.json',import.meta.url))('yaml');
const workflow=fs.readFileSync(WORKFLOW_FILE),pin=hash(workflow);
const definition=yaml.parse(workflow.toString()).jobs.reconcile;
const source={schema:SOURCE_SCHEMA,repository:'tdoljyj/cross-memory-system',defaultBranch:'main',
  baseCommit:'75ed720d45fa84ed3455246b9d082ec99c146d60',executionAuthority:false,dispatchAuthority:false,
  productionAuthority:false,runnerHookException:false,hostQualification:'separate_required',
  workflow:{path:WORKFLOW_FILE,sha256:pin},role:{id:'reconcile',definition,sha256:hash(JSON.stringify(canonical(definition)))}};
fs.writeFileSync(SOURCE_FILE,JSON.stringify(source,null,2)+'\n');
console.log(JSON.stringify({workflowSha256:pin,registrySha256:hash(fs.readFileSync(SOURCE_FILE))}));
