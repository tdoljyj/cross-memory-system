#!/usr/bin/env node
// Structural fail-closed regression only. No GitHub, database, signature or GA.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const file=new URL('./build-root10-stage2-metadata.mjs',import.meta.url);
const raw=fs.readFileSync(file,'utf8'),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const need=(v,m)=>{if(!v)throw Error(m)};
execFileSync(process.execPath,['--check',file.pathname.replace(/^\/(.:)/,'$1')],{stdio:'pipe'});
need(raw.includes('cfg.original_root_publication_path')&&raw.includes('cfg.corrective_source_publication_path'),'DUAL_PUBLICATION_INPUTS_REQUIRED');
need(raw.includes("rootPublication.pr===190")&&raw.includes("root.signature_binding.owner_merge_commit===rootPublication.merge_commit"),'ORIGINAL_PR190_ROOT_BINDING_REQUIRED');
need(raw.includes("sourcePublication.state==='ACTUAL_ROOT10_CORRECTIVE_SOURCE_OWNER_PUBLICATION_VERIFIED'")&&raw.includes("source_ref:{commit:sourcePublication.merge_commit,tree:sourcePublication.tree"),'CORRECTIVE_SOURCE_BINDING_REQUIRED');
need(raw.includes("publication:{commitSha:rootPublication.merge_commit,artifactPath:cfg.reviewer_delegation_repo_path}")&&raw.includes("publication:{commitSha:sourcePublication.merge_commit,artifactPath:cfg.executor_applicability_repo_path}"),'SPLIT_INHERITED_AND_CORRECTIVE_ARTIFACT_PUBLICATIONS');
need(!raw.includes('json(cfg.publication_path)'),'AMBIGUOUS_SINGLE_PUBLICATION_FORBIDDEN');
process.stdout.write(JSON.stringify({state:'DUAL_PUBLICATION_METADATA_BUILDER_LOCAL_PASS',builder_sha256:sha(raw),original_root_pr:190,corrective_source_required:true,network:false,database:false,signature:false,ga:false})+'\n');
