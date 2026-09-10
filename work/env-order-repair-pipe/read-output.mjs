import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import crypto from 'node:crypto';import {describeStderrArchive} from './stderr-archive.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url)),[ga,op,offsetText]=process.argv.slice(2),offset=Number(offsetText);
if(process.argv.length!==5||!/^ga_[a-f0-9]{32}$/.test(ga)||!['CREATE','START','GRR'].includes(op)||!/^(0|[1-9][0-9]*)$/.test(offsetText)||!Number.isSafeInteger(offset))throw Error('FIXED_CAPTURE_READ_ONLY_INPUT');
const file=path.resolve(dir,'../qualification-live',ga+'.'+op+'.env-order-repair-pipe600.stdout.raw'),b=fs.readFileSync(file);
if(b.length>2*1024*1024||offset>b.length)throw Error('BOUNDED_ORIGINAL_STDOUT');
const end=b.lastIndexOf(10)+1;if(end<offset)throw Error('NO_CAPTURE_TRUNCATION');
const stderr_archive=describeStderrArchive(file.replace(/\.stdout\.raw$/,'.stderr.raw'));
const complete=b.subarray(offset,end),text=new TextDecoder('utf-8',{fatal:true}).decode(complete);
process.stdout.write(JSON.stringify({stderr_archive,output:text,next_offset:end,observed_size:b.length,complete_bytes:complete.length,sha256:crypto.createHash('sha256').update(complete).digest('hex'),path:file}));