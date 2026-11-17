// Required by resident-node's scope-isolation-guard.test.mjs. Discovery follows policy definitions,
// including new keys; there is no allow-list of the four historical limits.
export function checkScopeIsolation(policy, tests) {
  const required = new Set();
  const aliases = new Map([['p.limits', 'limits'], ['p.park', 'park'], ['n', 'breaker.network']]);
  for (const line of policy.split(/\r?\n/)) {
    for (const m of line.matchAll(/\b(p\.limits|p\.park|n)\.(\w+)/g)) {
      if (/perPr|perHead/i.test(m[2]) || /\bper\s+(?:PR(?:\s+commit)?|head)\b/i.test(line)) required.add(`${aliases.get(m[1])}.${m[2]}`);
    }
  }
  const covered = new Set();
  // A marker must be a real line comment immediately attached to a Node test declaration.
  for (const source of tests) for (const m of source.matchAll(/^\s*\/\/\s*scope-isolation:\s*([\w.]+)\s*\r?\n\s*test\(/gm)) covered.add(m[1]);
  return { required: [...required].sort(), missing: [...required].filter(k => !covered.has(k)).sort() };
}
