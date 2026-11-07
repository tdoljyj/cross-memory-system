import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Consumer identity, not a secret or a Host qualification. A different
// execution Host/epoch requires accepted recovery of the same operation
// journal before a successor Source is enabled; matching runner labels do not.
export const CONTROLLER_IDENTITY_SHA256='272f30c6be4d557aaa02c7aff043ece7cfad91b298c2a146d431bdcf59394e4c';
export const JOURNAL_EPOCH='80c2240a-fafa-4f1c-9d53-63918adc1e33';
export function controllerFingerprint({hostname=os.hostname(),machineGuid}={}){
  if(machineGuid===undefined){
    const answer=execFileSync('C:\\Windows\\System32\\reg.exe',
      ['query','HKLM\\SOFTWARE\\Microsoft\\Cryptography','/v','MachineGuid'],{encoding:'utf8',windowsHide:true});
    machineGuid=/MachineGuid\s+REG_SZ\s+([a-f0-9-]{36})/i.exec(answer)?.[1];
  }
  if(typeof hostname!=='string'||!hostname||!/^[a-f0-9-]{36}$/i.test(machineGuid??''))throw Error('RECONCILE_CONTROLLER_IDENTITY_UNREADABLE');
  return createHash('sha256').update(JSON.stringify([hostname.toUpperCase(),machineGuid.toLowerCase()])).digest('hex');
}
export function assertControllerIdentity(observed=controllerFingerprint()){
  if(observed!==CONTROLLER_IDENTITY_SHA256)throw Error('RECONCILE_CONTROLLER_IDENTITY_MISMATCH');
  return {controllerIdentitySha256:CONTROLLER_IDENTITY_SHA256,journalEpoch:JOURNAL_EPOCH};
}
