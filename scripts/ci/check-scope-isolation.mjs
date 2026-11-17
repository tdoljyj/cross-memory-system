// Required by resident-node's scope-isolation-guard.test.mjs. Discovery follows policy definitions,
// including new keys; there is no allow-list of the four historical limits.
export function checkScopeIsolation(policy, tests) {
  const required = new Set();
  const lines = policy.split(/\r?\n/);
  const reference = /\b((?:p\.)?(?:limits|park|breaker\.network)|n)\.(\w+)/g;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] + '\n' + (lines[i + 1] ?? '');
    const refs = [...text.matchAll(reference)];
    for (let j = 0; j < refs.length && refs[j].index <= lines[i].length; j++) {
      const m = refs[j], tail = text.slice(m.index + m[0].length, refs[j + 1]?.index ?? text.length);
      const prefix = m[1] === 'n' ? 'breaker.network' : m[1].replace(/^p\./, '');
      if (/perPr|perHead/i.test(m[2]) || /\bper\s+(?:PR(?:\s+commit)?|head)\b/i.test(tail)) required.add(`${prefix}.${m[2]}`);
    }
  }
  const covered = new Set();
  // A marker must be a real line comment immediately attached to a Node test declaration.
  for (const source of tests) for (const m of source.matchAll(/^\s*\/\/\s*scope-isolation:\s*([\w.]+)\s*\r?\n\s*test\(/gm)) covered.add(m[1]);
  return { required: [...required].sort(), missing: [...required].filter(k => !covered.has(k)).sort() };
}
