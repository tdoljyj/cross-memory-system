// A node:test reporter that writes one JSON object per event, keeping only the plain fields the gate
// evidence needs (gate-evidence.mjs). Errors are reduced to their message: a TestsStream error carries
// causes and stack frames that are neither stable nor needed as evidence.
export default async function* ndjsonReporter(source) {
  for await (const event of source) {
    if (!['test:start', 'test:pass', 'test:fail', 'test:diagnostic'].includes(event.type)) continue;
    const data = event.data ?? {};
    const error = data.details?.error;
    yield `${JSON.stringify({
      type: event.type,
      name: data.name ?? null,
      nesting: data.nesting ?? 0,
      file: data.file ?? null,
      line: data.line ?? null,
      message: event.type === 'test:diagnostic' ? data.message : undefined,
      skip: data.skip ?? undefined,
      todo: data.todo ?? undefined,
      duration_ms: data.details?.duration_ms ?? undefined,
      error: error ? String(error.cause?.message ?? error.message ?? error).slice(0, 2000) : undefined,
    })}\n`;
  }
}
