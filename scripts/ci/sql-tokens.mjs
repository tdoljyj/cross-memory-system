// The SQL tokenizer of the migration checks: check-cron-budget.mjs (pg_cron
// registrations) and apps/clued-cloud/scripts/migration-size-gate.mjs (the
// capacity gate before migrate mode) read migrations through this one copy.
//
// Keep strings and nested comments opaque: a literal is one token, and the
// caller decides which literals it reads again as SQL (check-cron-budget.mjs:
// DO and routine bodies and literal EXECUTE; the capacity gate: DO bodies and
// literal EXECUTE). Every token carries the line it starts on.
export function sqlTokens(source, firstLine = 1) {
  const tokens = [];
  const pattern = /\s+|--[^\r\n]*|\/\*|[eE]'(?:''|\\[\s\S]|[^'\\])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$|[A-Za-z_][\w$]*|[^\s]/gy;
  let line = firstLine;
  while (pattern.lastIndex < source.length) {
    const [start] = pattern.exec(source);
    let raw = start;
    let token;
    if (start === '/*') {
      const content = pattern.lastIndex;
      const comments = /\/\*|\*\//g;
      comments.lastIndex = content;
      let depth = 1;
      for (let part; depth && (part = comments.exec(source));) depth += part[0] === '/*' ? 1 : -1;
      if (depth) throw new Error(`unclosed SQL comment at line ${line}`);
      pattern.lastIndex = comments.lastIndex;
      raw = source.slice(content, pattern.lastIndex);
    } else if (start.startsWith('$') && start.length > 1) {
      const content = pattern.lastIndex;
      const end = source.indexOf(start, content);
      if (end < 0) throw new Error(`unclosed dollar quote at line ${line}`);
      token = { kind: 'literal', value: source.slice(content, end), line };
      pattern.lastIndex = end + start.length;
      raw = source.slice(content, end);
    } else if (start.startsWith("'")) {
      token = { kind: 'literal', value: start.slice(1, -1).replaceAll("''", "'"), line };
    } else if (/^e'/i.test(start)) {
      token = { kind: 'literal', value: start.slice(2, -1).replaceAll("''", "'"), line };
      if (token.value.includes('\\')) token.kind = 'escaped literal';
    } else if (start.startsWith('"')) {
      token = { kind: 'identifier', value: start.slice(1, -1).replaceAll('""', '"'), line };
    } else if (!/^\s|^--/.test(start)) {
      token = { kind: 'code', value: start.toLowerCase(), line };
    }
    if (token) tokens.push(token);
    line += raw.split('\n').length - 1;
  }
  return tokens;
}
