// Node test reporter for the known-failure rule of the required test checks
// (Task 2a5fdb66; scripts/ci/ci-required-selection.mjs). It is loaded from the
// trusted base checkout with --test-reporter=<this file> and writes one JSON
// line per event it keeps:
//   {"type":"fail","file":<abs>,"path":[names...],"failure_type":...,"fingerprint":...}
//   {"type":"pass","file":<abs>,"path":[names...]}
//   {"type":"summary","counts":{...},"success":bool}   (the run's own summary)
// Every test:fail counts: a test, a suite, a hook (failure_type hookFailed), a
// parent that throws after its subtests, a file that fails to load. A parent
// that failed only because a subtest failed (subtestsFailed) is left out: the
// subtest carries the failure. The fingerprint identifies why a test failed,
// so a known test failing for another reason is a new failure.
import { createHash } from 'node:crypto';

// The failure's message with what varies between runs and machines removed:
// absolute paths, temporary names, hex digests, numbers and durations.
export function normalizeFailure(message) {
  return String(message ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/file:\/\/\/?[^\s'"`)\]]+/g, '<path>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`)\]\\/:]+){2,}[\\/]?/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, 4000);
}

export function failureFingerprint(error) {
  const cause = error?.cause ?? error;
  const text = `${error?.failureType ?? ''}\n${cause?.code ?? ''}\n${normalizeFailure(cause?.message ?? cause)}`;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export default async function* reporter(source) {
  const stacks = new Map();
  const pathOf = (data) => {
    const stack = stacks.get(data.file) ?? [];
    return [...stack.slice(0, data.nesting), data.name];
  };
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === 'test:start') {
      const stack = stacks.get(data.file) ?? [];
      stack.length = data.nesting;
      stack[data.nesting] = data.name;
      stacks.set(data.file, stack);
    } else if (event.type === 'test:fail') {
      const error = data.details?.error;
      if (error?.failureType === 'subtestsFailed') continue;
      yield `${JSON.stringify({ type: 'fail', file: data.file ?? null, path: pathOf(data), failure_type: error?.failureType ?? null,
        fingerprint: failureFingerprint(error) })}\n`;
    } else if (event.type === 'test:pass') {
      yield `${JSON.stringify({ type: 'pass', file: data.file ?? null, path: pathOf(data) })}\n`;
    } else if (event.type === 'test:summary' && data.file === undefined) {
      yield `${JSON.stringify({ type: 'summary', counts: data.counts ?? null, success: data.success === true })}\n`;
    }
  }
}
