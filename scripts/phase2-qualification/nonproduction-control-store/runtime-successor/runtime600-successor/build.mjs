// Existing empty runtime: replace only two exact functions, preserving all tables/ACLs/history.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const here=new URL('./',import.meta.url),prior=new URL('../budget-reservation-successor/install.candidate.sql',import.meta.url);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),raw=fs.readFileSync(prior);
assert.equal(hash(raw),'8f732dd4013a18adde33a254631cdd5a04022f300d4c0a13d05dffbf36f97285');
const text=raw.toString('utf8'),functions=[...text.matchAll(/create function clued_control\.(\w+)\([\s\S]*?\$\$;/g)].map(m=>({name:m[1],sql:m[0]}));
const changed=functions.filter(f=>/\b180\b/.test(f.sql));
assert.deepEqual(changed.map(f=>f.name),['reserve_execution_budget','reserve_gate']);
const priorBodies=changed.map(f=>({name:f.name,sql:f.sql,body:f.sql.slice(f.sql.indexOf('as $$')+5,-3)}));
for(const f of priorBodies)assert(f.body.startsWith('\n'));
const rootSource=fs.readFileSync(new URL('../../install.candidate.sql',here));
const rootFunctions=[...rootSource.toString('utf8').matchAll(/create function clued_control\.(\w+)\([\s\S]*?\$\$;/g)].map(m=>({name:m[1],sql:m[0]}));
assert.deepEqual(rootFunctions.map(f=>f.name),['deny_mutation','append_event','read_root']);
const snapshots={prior_install_sha256:hash(raw),original_root_install_sha256:hash(rootSource),source:'Exact existing Root source plus accepted/deployed 8f732 runtime source (14 functions); root independently retains actual pg_get_functiondef/ACL snapshots before applying',functions:[...rootFunctions,...functions].map(f=>({name:f.name,source_sha256:hash(f.sql),sql:f.sql})),authority_effect:'NONE'};
fs.writeFileSync(new URL('PriorInstalledFunctionSources.json',here),JSON.stringify(snapshots,null,2)+'\n');
const checks=priorBodies.map(f=>` if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='clued_control.${f.name}(text,text)'::regprocedure) is distinct from '${hash(f.body)}' then raise exception 'prior_function_drift_${f.name}'; end if;`).join('\n');
const guard=`-- Same approved control domain, no installation or data migration. Root runs this in one transaction.
do $$ declare r jsonb; begin
 if current_setting('clued_control.target_project',true) is distinct from 'uscrdifznmlvczcekqpw' then raise exception 'wrong_control_project'; end if;
 perform 1 from clued_control.current_head where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for share;
 r:=clued_control.read_root('ctr_414bd3c724264a83894b0c55cf2ab878');
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or r->>'generation_id' is distinct from 'ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12' or r->>'sequence' is distinct from '2' or clock_timestamp()>='2026-09-09T09:28:59Z'::timestamptz then raise exception 'existing_root_window_or_generation_changed'; end if;
 lock table clued_control.execution_binding,clued_control.execution_current,clued_control.execution_events,clued_control.gate_attempts,clued_control.control_objects in share row exclusive mode;
 if exists(select 1 from clued_control.execution_binding) or exists(select 1 from clued_control.execution_current) or exists(select 1 from clued_control.execution_events) or exists(select 1 from clued_control.gate_attempts) or exists(select 1 from clued_control.control_objects) then raise exception 'runtime_not_empty_successor_requires_review'; end if;
${checks}
end $$;
`;
const replacements=changed.map(f=>f.sql.replace('create function','create or replace function').replaceAll(/\b180\b/g,'600'));
assert.equal((changed.map(f=>f.sql).join('\n').match(/\b180\b/g)||[]).length,4);
const sql=guard+'\n'+replacements.join('\n\n')+'\n';
fs.writeFileSync(new URL('alter.candidate.sql',here),sql);
fs.writeFileSync(new URL('ChangeSet.json',here),JSON.stringify({state:'PREPARED_NOT_APPLIED',prior_install_sha256:hash(raw),changed_functions:changed.map(f=>f.name+'(text,text)'),changes:['reserve_execution_budget exact seconds180->600, cumulative ceiling arithmetic and once-only charge180->600','reserve_gate complete authorization window ceiling180->600'],unchanged:['All original tables/rows/triggers/RLS/owners/ACLs and other function definitions','Prior actual budget1500 seconds and287700424 bytes; 7200 total/1GiB/one active or pending allocation','Typed key, exact raw/hash, prior committed budget, independent generations, UNKNOWN retained and no refund','Owner absolute expiry2026-09-09T09:28:59Z'],requires:'Root transaction wraps fixed project setting, precise pre/post actual14-function/security/Root and empty-row checks; independent acceptance precedes application',authority_effect:'NONE'},null,2)+'\n');
console.log(JSON.stringify({alter_sha256:hash(sql),original_functions:functions.length,changed_functions:changed.map(f=>f.name),authority_effect:'NONE'}));
