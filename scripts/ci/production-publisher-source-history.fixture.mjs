// Offline immutable predecessor bytes, not live Source authority or metrics.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
export function loadPublisherSourceHistoryFixture() {
  const raw=fs.readFileSync(new URL('./fixtures/production-publisher-source-history.v1.json',import.meta.url));
  if(raw.length>10000)throw Error('PUBLISHER_HISTORY_FILE_TOO_LARGE');
  const v=JSON.parse(raw.toString('utf8'));
  if(v.schema!=='clued.publisher-source-history-fixture/1'||v.commit!=='80bd559f283b7c009cd37f1fbde700b6d6be41ae'||
    v.path!=='scripts/ci/merge-admission-r9-source.json'||v.bytes!==38379||
    v.sha256!=='f2c4ff8a826a96680aaf36ef65faba02ce8a626555e8f44d2eae0346f8b16b28'||
    typeof v.gzip_base64!=='string'||v.gzip_base64.length>8000||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.gzip_base64))throw Error('PUBLISHER_HISTORY_METADATA_INVALID');
  const bytes=gunzipSync(Buffer.from(v.gzip_base64,'base64'),{maxOutputLength:38379});
  if(bytes.length!==38379||createHash('sha256').update(bytes).digest('hex')!==v.sha256)throw Error('PUBLISHER_HISTORY_BYTES_INVALID');
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
