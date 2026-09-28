import assert from "node:assert/strict";

export function batchRequests(payload) {
  const parts = [...payload.matchAll(/Content-ID: <([^>]+)>\r\n\r\nGET ([^\r\n]+) HTTP\/1\.1\r\n/g)];
  assert.ok(parts.length > 0 && parts.length <= 32);
  return parts.map(([,id,path]) => ({id,path}));
}
export function batchReply(parts, options = {}) {
  const boundary = "batch_fixture_123";
  const raw = parts.map(({id,value,status = 200}) => {
    const json = JSON.stringify(value);
    return `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 ${status} Fixture\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}\r\n`;
  }).join("") + `--${boundary}--\r\n`;
  return new Response(options.transform ? options.transform(raw) : raw,
    {headers:{"content-type":`multipart/mixed; boundary=${boundary}`}});
}
