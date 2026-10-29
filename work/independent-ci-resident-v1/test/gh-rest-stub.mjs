// A gh stub for the poller's two conditional REST reads (Decision 1b99e7e4): main's ref and the open pulls, answered as
// `gh api --include` prints them, with an ETag and a 304 (exit 1, as gh does) when If-None-Match names the current one.
// `pulls` are given in the pass's shape (gh pr list's names) and answered in the REST shape. Every other argv goes to `other`.
import { createHash } from 'node:crypto';

const tagOf = v => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 40);

export function restAnswer(argv, value) {
  const etag = `W/"${tagOf(value)}"`;
  const i = argv.indexOf('-H');
  if (i >= 0 && argv[i + 1] === `If-None-Match: ${etag}`) return { code: 1, stdout: `HTTP/2.0 304 Not Modified\r\nEtag: "${tagOf(value)}"\r\n\r\n`, stderr: 'gh: HTTP 304' };
  return { code: 0, stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nEtag: ${etag}\r\n\r\n${JSON.stringify(value)}`, stderr: '' };
}

export const restPull = p => ({ number: p.number, head: { sha: p.headRefOid }, base: { sha: p.baseRefOid }, draft: p.isDraft === true, body: p.body, updated_at: p.updatedAt });

export function restPolls(other, { main, pulls }) {
  return async (argv, o) => {
    if (argv.some(a => typeof a === 'string' && a.endsWith('/git/ref/heads/main'))) return restAnswer(argv, { ref: 'refs/heads/main', object: { sha: main() } });
    if (argv.some(a => typeof a === 'string' && a.includes('/pulls?state=open&base=main'))) return restAnswer(argv, pulls().map(restPull));
    return other(argv, o);
  };
}
