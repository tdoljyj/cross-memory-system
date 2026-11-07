// L4 of optimisation plan bf57ff10: the Linux generation point of the provenance attestation.
// Called by linux-worker.mjs right AFTER the signed result has been written to the mailbox, best effort: any failure here is
// swallowed there and changes nothing (the result, its record name, its format and every verifier are untouched). It signs a DSSE
// envelope over an in-toto Statement v1 / SLSA Provenance v1 with the EXISTING result key (the key signActualBridgeResult loads
// from the same fixed role policy; no new secret, no new key) and writes it create-only into the local Linux receipt directory,
// outside the formal spool (so the spool's name allow-lists and archive tools never see it). It never goes to a transparency log.
import fs from 'node:fs/promises';
import {createPublicKey} from 'node:crypto';
import {protectedPath} from '../qualification-v2.mjs';
import {loadFixedRolePolicy} from '../formal-fixed-role-policy-v3/policy.mjs';
import {takeAcceptedBridgeContext} from './boundary.mjs';
import {buildStatement,statementBytes,validateStatementV1} from '../../src/provenance-v1/statement.mjs';
import {signDsse} from '../../src/provenance-v1/dsse.mjs';
import {writeProvenance,LINUX_PROVENANCE_DIR} from '../../src/provenance-v1/store.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};

// Pure: the signed DSSE envelope for one signed result. `key` is the PEM/Buffer private key already matched to the role's public key.
export function provenanceEnvelope({issue,signed,observation,config,key}){
  check(signed?.envelope&&signed.envelope.keyId===config.keyId&&signed.envelope.payload?.runtimeId===config.runtimeIdentity,'PROVENANCE_RESULT_AUTHORITY_CHANGED');
  const statement=buildStatement({job:issue.job,envelope:signed.envelope,observation});
  validateStatementV1(statement);
  return signDsse({body:statementBytes(statement),privateKey:key,keyId:config.keyId});
}

const production={
  loadPolicy:job=>loadFixedRolePolicy(job),
  readKey:async file=>{await protectedPath(file,{privateFile:true});return fs.readFile(file);},
  dir:LINUX_PROVENANCE_DIR,
  prepareDir:async dir=>{await fs.mkdir(dir,{recursive:true,mode:0o700});await protectedPath(dir,{directory:true});},
};
export async function emitProvenance(context,issue,observation,signed,ports=production){
  if(ports===production){takeAcceptedBridgeContext(context);check(context.side==='linux','ACTUAL_LINUX_SIGNER_CONTEXT_REQUIRED');}
  const{config,publicKey}=await ports.loadPolicy(issue.job);
  const key=await ports.readKey(config.signingKeyFile);
  check(createPublicKey(key).asymmetricKeyType==='ed25519'&&createPublicKey(key).export({type:'spki',format:'der'}).equals(createPublicKey(publicKey).export({type:'spki',format:'der'})),'EXISTING_RESULT_KEY_CHANGED');
  const envelope=provenanceEnvelope({issue,signed,observation,config,key});
  await ports.prepareDir(ports.dir);
  return writeProvenance({dir:ports.dir,job:issue.job,envelope});
}
