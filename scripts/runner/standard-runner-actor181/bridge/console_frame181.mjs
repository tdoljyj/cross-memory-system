// Tool-console transport only. The owned PS child keeps original bounded JSONL
// over Node ChildProcess pipes. These <72-column lines prevent ConPTY wrapping
// from changing the original request bytes/hash. No authorization lives here.
export function makeConsoleEmitter(output=process.stdout){let seq=0;return value=>{const raw=Buffer.from(typeof value==='string'?value:JSON.stringify(value),'utf8');if(raw.length>16384||raw.includes(10)||raw.includes(13)||++seq>2048)throw Error('CONSOLE_FRAME_BOUND');const encoded=raw.toString('base64'),count=Math.ceil(encoded.length/40);for(let i=0;i<count;i++)output.write(`B181|${String(seq).padStart(4,'0')}|${String(i+1).padStart(3,'0')}/${String(count).padStart(3,'0')}|${encoded.slice(i*40,(i+1)*40)}\n`);};}
