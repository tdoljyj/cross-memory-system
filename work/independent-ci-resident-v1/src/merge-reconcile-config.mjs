import {check} from './canonical.mjs';
export const MERGE_RECONCILE_REPO='tdoljyj/cross-memory-system';
// Exact reviewed candidate, never caller-supplied Source or Host authority.
export const MERGE_RECONCILE_WORKFLOW_SHA256='11d4b72a9f330801bdb44d3bd8a5b6c411cd328b02a6946ab9ada7485ec7dbf3';
export function validateMergeReconcileConfig(value){
  if(value===undefined||value===null)return Object.freeze({enabled:false});
  check(typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1
    &&Object.keys(value)[0]==='enabled'&&typeof value.enabled==='boolean','COMPANION_MERGE_RECONCILE_CONFIG_INVALID');
  return Object.freeze({enabled:value.enabled});
}
