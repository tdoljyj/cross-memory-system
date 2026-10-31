// Node test reporter for the known-failure rule of the required test checks
// (Task 2a5fdb66; scripts/ci/ci-required-selection.mjs). It is loaded from the
// trusted base checkout with --test-reporter=<this file> and writes one JSON
// line per event it keeps:
//   {"type":"fail","file":<abs>,"path":[names...],"failure_type":...,"fingerprint":...}
//   {"type":"pass","file":<abs>,"path":[names...]}
//   {"type":"summary","counts":{...},"success":bool}   (the run's own summary)
// Every test:fail counts: a test, a suite, a hook (failure_type hookFailed), a
// parent that throws after its subtests, a file that fails to load. So does
// an error from asynchronous activity after a test ended (an uncaught
// exception or unhandled rejection), which Node reports only as a diagnostic.
// Left out: a parent that failed only because a subtest failed
// (subtestsFailed; the subtest carries the failure) and a todo test (Node
// does not fail the run for it). The fingerprint identifies why a test
// failed, so a known test failing for another reason is a new failure.
import { createHash } from 'node:crypto';

const ASYNC_AFTER_END = /generated asynchronous activity after the test ended|triggered an? (?:uncaughtException|unhandledRejection) event/;

// The failure's message with what varies between runs and machines removed:
// absolute paths and file URLs, line:column positions, hex digests, durations,
// timestamps and long numbers (ids, ports, times). Small numbers stay, so
// "expected 23, got 22" and "expected 24, got 22" are different failures.
export function normalizeFailure(message) {
  return String(message ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/file:\/\/\/?[^\s'"`)\]]+/g, '<path>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`)\]\\/:]+){2,}[\\/]?/g, '<path>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?/g, '<time>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/:\d+:\d+\b/g, ':<line>')
    .replace(/\b\d+(?:\.\d+)?\s?ms\b/g, '<ms>')
    .replace(/\b\d{5,}(?:\.\d+)?\b/g, '<n>')
    .replace(/\b\d+\.\d{3,}\b/g, '<n>')
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
      if (error?.failureType === 'subtestsFailed' || (data.todo !== undefined && data.todo !== false)) continue;
      yield `${JSON.stringify({ type: 'fail', file: data.file ?? null, path: pathOf(data), failure_type: error?.failureType ?? null,
        fingerprint: failureFingerprint(error) })}\n`;
    } else if (event.type === 'test:diagnostic' && data.file && ASYNC_AFTER_END.test(String(data.message ?? ''))) {
      const message = String(data.message);
      const test = /Test "([^"]*)"/.exec(message)?.[1] ?? '<file>';
      yield `${JSON.stringify({ type: 'fail', file: data.file, path: ['<async activity after the test ended>', test],
        failure_type: 'asyncActivityAfterTest', fingerprint: failureFingerprint({ failureType: 'asyncActivityAfterTest', message }) })}\n`;
    } else if (event.type === 'test:pass') {
      yield `${JSON.stringify({ type: 'pass', file: data.file ?? null, path: pathOf(data) })}\n`;
    } else if (event.type === 'test:summary' && data.file === undefined) {
      yield `${JSON.stringify({ type: 'summary', counts: data.counts ?? null, success: data.success === true })}\n`;
    }
  }
}
