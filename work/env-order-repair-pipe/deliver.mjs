import fs from 'node:fs';import path from 'node:path';import {validateMessage} from './message.mjs';
// Called only with the exclusive fixed attempt directory and its fixed child pipe.
export function archiveAndSend(prefix,notice,sequence,stdin,done){
 const filename=path.join(prefix,'message-'+sequence+'.staging.json');
 const stat=fs.lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024+1)throw Error('FIXED_REGULAR_MESSAGE_FILE');
 const bytes=fs.readFileSync(filename);validateMessage(bytes,notice,sequence);
 const fd=fs.openSync(path.join(prefix,'message-'+sequence+'.raw'),'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 stdin.write(bytes,done);return bytes.length;
}
