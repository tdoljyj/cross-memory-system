// The lock on wall-clock reads in test fixtures (task ce2e5c1a, step 2; FABLE-drill-vm-frozen-clock-20261121 §2 and its DESK
// postscript). Three CI reds had one shape: a fixture took the real time once, a later comparison read the real time again, and
// the verdict depended on how much real time passed between the two -- green on a fast host, red on a slow one
// (drill-vm.test.mjs wslWorld, now in drill-vm-fixtures.mjs, CI run 44746396297; native-claim-observation-retry and
// stale-facts-production-wiring, run 44895513321).
//
// scanClockLock(entries) reads the given test files and the test-directory modules they import (relative imports, any depth)
// and returns one finding per place of these shapes:
//   load     the real clock is read when the file loads: at module top level, in a describe()/suite() body, an IIFE or a
//            callback a load-time call runs at once (map, forEach, a Promise executor...), or by a load-time call of a module
//            function (this file's or an imported test helper's) that reads it -- in its body or in a default parameter
//            (drill-vm's wslWorld calling idleHostStatus()). The value ages while the tests before it run.
//   before   the same in a before() hook (once per file; it ages the same way).
//   mixed    a module-level function that takes a fake clock (a parameter named clock, now or clk, destructured or not) also
//            calls the real clock, itself or through a module function whose body calls it: the fixture then stamps with one
//            clock what the code under test judges with the other. Using the real clock as that clock (`Date.now` passed as a
//            value, uncalled) is one clock and allowed.
// A read is a call of Date.now(), Date() without new, new Date with no argument, performance.now(), process.hrtime(),
// process.uptime() or Temporal.Now.*; for a default parameter also the bare reference Date.now / performance.now (the
// function then calls it). Not counted, and why:
//   - reads in a test body, or in a function only tests call: they run when the test runs (default parameters too);
//   - text in strings and templates: a PowerShell snippet runs in its own process when the test runs (drill-vm-part4.test.mjs pins
//     those reads, and the ps() of drill-vm-fixtures.mjs fixes Get-DrillTime);
//   - new Date(x) with an argument, and method calls x.now() of an object that is not the global clock (a fake clock).
// Limits, by design (a lexer, not a type checker): a function reached only through an object, a method or a variable is not
// followed, and a call that passes the argument a clocked default would take still counts for "load".
import fs from 'node:fs';
import path from 'node:path';

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'instanceof', 'yield', 'await']);
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'await', 'yield', 'new']);
// Callbacks these calls run later (once per test, on an event, on a timer): a read in them is not a load-time read.
const DEFERRED_CALLEES = new Set(['test', 'it', 'todo', 'skip', 'only', 'after', 'afterEach', 'beforeEach', 'on', 'once',
  'addListener', 'addEventListener', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'nextTick', 'then', 'catch',
  'finally', 'createServer', 'method', 'fn', 'mock']);
const LOAD_BODIES = new Set(['describe', 'suite']);
const ONCE_HOOKS = new Set(['before']);
const CLOCK_PARAMS = new Set(['clock', 'now', 'clk']);
const ASI_STARTERS = new Set(['const', 'let', 'var', 'function', 'test', 'import', 'export', 'class', 'if', 'for', 'async']);

// Tokens: { t: 'id' | 'num' | 'str' | 'tpl' | 'regex' | 'p', v, line }. A template is '`', its text chunks ('tpl') and
// '`end'; ${ opens a bracket that '}$' closes.
export function tokenize(src) {
  const out = []; let i = 0, line = 1; const modes = [];
  const regexAllowed = () => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.t === 'id') return KEYWORDS_BEFORE_REGEX.has(p.v);
    return p.t === 'p' && ![')', ']', '`end', '}$'].includes(p.v);
  };
  const template = () => { // i is just after a backtick, or after the } that closes a ${
    let text = ''; const start = line;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { text += src.slice(i, i + 2); if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '`') { out.push({ t: 'tpl', v: text, line: start }, { t: 'p', v: '`end', line }); i++; return; }
      if (c === '$' && src[i + 1] === '{') { out.push({ t: 'tpl', v: text, line: start }, { t: 'p', v: '${', line }); modes.push('${'); i += 2; return; }
      if (c === '\n') line++;
      text += c; i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2), end = e < 0 ? src.length : e + 2;
      line += (src.slice(i, end).match(/\n/g) ?? []).length; i = end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out.push({ t: 'str', v: src.slice(i + 1, j), line }); i = j + 1; continue;
    }
    if (c === '`') { out.push({ t: 'p', v: '`', line }); i++; template(); continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      j++; while (j < src.length && /[a-z]/i.test(src[j])) j++;
      out.push({ t: 'regex', v: src.slice(i, j), line }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < src.length && /[\w$]/.test(src[j])) j++; out.push({ t: 'id', v: src.slice(i, j), line }); i = j; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) { let j = i; while (j < src.length && /[\w.]/.test(src[j])) j++; out.push({ t: 'num', v: src.slice(i, j), line }); i = j; continue; }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    if (['...', '===', '!==', '**=', '>>>', '<<=', '>>=', '&&=', '||=', '??='].includes(three)) { out.push({ t: 'p', v: three, line }); i += 3; continue; }
    if (['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '**', '<<', '>>'].includes(two)) { out.push({ t: 'p', v: two, line }); i += 2; continue; }
    if (c === '{') { modes.push('{'); out.push({ t: 'p', v: '{', line }); i++; continue; }
    if (c === '}') { const m = modes.pop(); out.push({ t: 'p', v: m === '${' ? '}$' : '}', line }); i++; if (m === '${') template(); continue; }
    out.push({ t: 'p', v: c, line }); i++;
  }
  return out;
}

const OPEN = { '(': ')', '[': ']', '{': '}', '${': '}$', '`': '`end' };
const CLOSE = new Set(Object.values(OPEN));

// match[i]: the bracket paired with bracket i; parent[i]: the innermost open bracket around token i.
function brackets(tokens) {
  const match = new Array(tokens.length).fill(-1), parent = new Array(tokens.length).fill(-1), stack = [];
  tokens.forEach((tok, i) => {
    parent[i] = stack.length ? stack[stack.length - 1] : -1;
    if (tok.t !== 'p') return;
    if (OPEN[tok.v]) stack.push(i);
    else if (CLOSE.has(tok.v) && stack.length) { const o = stack.pop(); match[o] = i; match[i] = o; parent[i] = stack.length ? stack[stack.length - 1] : -1; }
  });
  return { match, parent };
}

// Functions: { params: [from, to], body: [from, to] (token ranges, inclusive), start, name, callee, iife, method }.
function functions(tokens, { match, parent }) {
  const fns = [];
  const endOfExpression = (from) => { // an arrow's expression body: up to , or ; or the enclosing close, or a new statement
    const base = parent[from];
    for (let k = from; k < tokens.length; k++) {
      const tok = tokens[k];
      if (tok.t === 'p' && OPEN[tok.v] && match[k] > k) { k = match[k]; if (k + 1 < tokens.length && parent[k + 1] !== base) return k; continue; }
      if (parent[k] !== base) return k - 1;
      if (tok.t === 'p' && [',', ';'].includes(tok.v)) return k - 1;
      const next = tokens[k + 1];
      if (next && next.line > tok.line && next.t === 'id' && ASI_STARTERS.has(next.v)) return k;
    }
    return tokens.length - 1;
  };
  const nameBefore = (k) => { // const NAME = [async] <function at k>
    let j = k - 1; if (tokens[j]?.v === 'async') j--;
    if (tokens[j]?.v === '=' && tokens[j - 1]?.t === 'id' && ['const', 'let', 'var'].includes(tokens[j - 2]?.v)) return tokens[j - 1].v;
    return null;
  };
  const calleeOf = (k) => { // the call whose argument list directly holds the function that starts at k
    const p = parent[k];
    if (p < 0 || tokens[p].v !== '(') return null;
    const before = tokens[p - 1];
    return before?.t === 'id' && !CONTROL.has(before.v) ? before.v : null;
  };
  const iifeOf = (start, end) => { const p = parent[start]; return p >= 0 && tokens[p].v === '(' && match[p] === end + 1 && tokens[match[p] + 1]?.v === '('; };
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t === 'id' && tok.v === 'function' && tokens[k - 1]?.v !== '.') {
      let j = k + 1; if (tokens[j]?.v === '*') j++;
      let name = null; if (tokens[j]?.t === 'id') { name = tokens[j].v; j++; }
      if (tokens[j]?.v !== '(' || tokens[match[j] + 1]?.v !== '{') continue;
      const pe = match[j], bs = pe + 1, start = tokens[k - 1]?.v === 'async' ? k - 1 : k;
      fns.push({ params: [j, pe], body: [bs, match[bs]], start, name: name ?? nameBefore(start), callee: calleeOf(start), iife: iifeOf(start, match[bs]) });
    } else if (tok.t === 'p' && tok.v === '=>') {
      let ps, pe;
      if (tokens[k - 1]?.v === ')') { pe = k - 1; ps = match[pe]; } else if (tokens[k - 1]?.t === 'id') { ps = pe = k - 1; } else continue;
      const start = tokens[ps - 1]?.v === 'async' ? ps - 1 : ps;
      const body = tokens[k + 1]?.v === '{' ? [k + 1, match[k + 1]] : [k + 1, endOfExpression(k + 1)];
      fns.push({ params: [ps, pe], body, start, name: nameBefore(start), callee: calleeOf(start), iife: iifeOf(start, body[1]) });
    } else if (tok.t === 'id' && !CONTROL.has(tok.v) && tokens[k + 1]?.v === '(' && tokens[match[k + 1] + 1]?.v === '{'
      && !['.', 'function'].includes(tokens[k - 1]?.v) && parent[k] >= 0 && tokens[parent[k]].v === '{') {
      const pe = match[k + 1], bs = pe + 1; // a method: name(params) { body } in an object literal or a class body
      fns.push({ params: [k + 1, pe], body: [bs, match[bs]], start: k, name: tok.v, callee: null, iife: false, method: true });
    }
  }
  return fns;
}

function clockReads(tokens) {
  const reads = [];
  for (let k = 0; k < tokens.length; k++) {
    const [a, b, c, d] = [tokens[k], tokens[k + 1], tokens[k + 2], tokens[k + 3]];
    if (a.t !== 'id' || ['.', '?.'].includes(tokens[k - 1]?.v)) continue;
    if ((a.v === 'Date' || a.v === 'performance') && b?.v === '.' && c?.v === 'now') reads.push({ at: k, what: `${a.v}.now${d?.v === '(' ? '()' : ''}`, call: d?.v === '(' });
    else if (a.v === 'Date' && b?.v === '(' && tokens[k - 1]?.v !== 'new') reads.push({ at: k, what: 'Date()', call: true });
    else if (a.v === 'new' && b?.v === 'Date' && (c?.v !== '(' || d?.v === ')')) reads.push({ at: k, what: 'new Date()', call: true });
    else if (a.v === 'process' && b?.v === '.' && ['hrtime', 'uptime'].includes(c?.v)) reads.push({ at: k, what: `process.${c.v}()`, call: true });
    else if (a.v === 'Temporal' && b?.v === '.' && c?.v === 'Now') reads.push({ at: k, what: 'Temporal.Now', call: true });
  }
  return reads;
}

const inside = (k, [from, to]) => k >= from && k <= to;

// One module: its tokens, functions, reads and relative imports; the clock facts come after its imports are known.
function parse(file, src) {
  const tokens = tokenize(src), b = brackets(tokens), fns = functions(tokens, b), reads = clockReads(tokens);
  const imports = [];
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].t !== 'id' || tokens[k].v !== 'import' || ['.', '?.'].includes(tokens[k - 1]?.v) || ['(', '.'].includes(tokens[k + 1]?.v)) continue;
    let j = k + 1; const names = [];
    for (; j < tokens.length && !(tokens[j].t === 'id' && tokens[j].v === 'from') && tokens[j].t !== 'str'; j++) {
      if (tokens[j].t === 'id' && tokens[j + 1]?.v !== 'as' && !['type', 'as'].includes(tokens[j].v)) names.push(tokens[j].v);
    }
    const spec = tokens[j]?.t === 'str' ? tokens[j].v : tokens[j + 1]?.v;
    if (typeof spec === 'string' && spec.startsWith('.')) imports.push({ spec, names });
  }
  return { file, tokens, fns, reads, imports };
}

function clockFacts(mod, imported) {
  const { file, tokens, fns, reads } = mod;
  const around = (k) => fns.filter(f => inside(k, f.body) || inside(k, f.params)).sort((x, y) => y.start - x.start);
  const topLevel = (f) => around(f.start).every(g => g === f);
  const deferred = (f) => f.method || f.name || (f.callee ? DEFERRED_CALLEES.has(f.callee) : !f.iife);
  // How the code at token k runs: 'load', 'before', or 'later' (when something calls the function it is in).
  const when = (k) => {
    for (const f of around(k)) {
      if (inside(k, f.params) && !inside(k, f.body)) return 'later';
      if (f.iife || LOAD_BODIES.has(f.callee)) continue;
      if (ONCE_HOOKS.has(f.callee)) return 'before';
      if (deferred(f)) return 'later';
    }
    return 'load';
  };
  // Within function f, does token k run when f runs (not in a callback f only hands on)?
  const runsWith = (k, f) => around(k).every(g => g === f || !deferred(g) || g.callee && !DEFERRED_CALLEES.has(g.callee));
  const callsIn = (f, range = f.body) => tokens.flatMap((tok, k) => tok.t === 'id' && ['(', '`'].includes(tokens[k + 1]?.v) && !['.', '?.'].includes(tokens[k - 1]?.v)
    && inside(k, range) && runsWith(k, f) ? [{ name: tok.v, line: tok.line }] : []);
  const named = new Map(fns.filter(f => f.name && !f.method && topLevel(f)).map(f => [f.name, f]));
  const ext = (n, kind) => imported.get(n)?.[kind].has(n);
  // body: module functions whose body calls the real clock (directly or through another such function).
  const body = new Set([...named].filter(([, f]) => reads.some(r => r.call && inside(r.at, f.body) && runsWith(r.at, f))).map(([n]) => n));
  for (let grew = true; grew;) {
    grew = false;
    for (const [n, f] of named) if (!body.has(n) && callsIn(f).some(c => body.has(c.name) || ext(c.name, 'body'))) { body.add(n); grew = true; }
  }
  // call: what a call of the function may read -- its body, or a default parameter that reads or is the clock.
  const call = new Set(body);
  for (const [n, f] of named) if (reads.some(r => inside(r.at, f.params) && !inside(r.at, f.body) && around(r.at)[0] === f)
    || callsIn(f, f.params).some(c => call.has(c.name) || ext(c.name, 'call'))) call.add(n);
  for (let grew = true; grew;) {
    grew = false;
    for (const [n, f] of named) if (!call.has(n) && callsIn(f).some(c => call.has(c.name) || ext(c.name, 'call'))) { call.add(n); grew = true; }
  }
  const findings = [];
  for (const r of reads.filter(r => r.call)) { const w = when(r.at); if (w !== 'later') findings.push({ file, line: tokens[r.at].line, shape: w, what: r.what }); }
  tokens.forEach((tok, k) => {
    if (tok.t !== 'id' || !['(', '`'].includes(tokens[k + 1]?.v) || ['.', '?.', 'function'].includes(tokens[k - 1]?.v)) return;
    if (!(call.has(tok.v) || ext(tok.v, 'call')) || named.get(tok.v)?.params[0] === k + 1) return;
    const w = when(k); if (w !== 'later') findings.push({ file, line: tok.line, shape: w, what: `${tok.v}() reads the clock` });
  });
  for (const f of fns.filter(f => topLevel(f) && !f.method)) {
    const names = tokens.slice(f.params[0], f.params[1] + 1).filter((tok, i) => tok.t === 'id'
      && !['=', '.', ':'].includes(tokens[f.params[0] + i - 1]?.v) && tokens[f.params[0] + i + 1]?.v !== ':').map(t => t.v);
    if (!names.some(n => CLOCK_PARAMS.has(n))) continue;
    for (const r of reads.filter(r => r.call && inside(r.at, f.body))) findings.push({ file, line: tokens[r.at].line, shape: 'mixed', what: r.what, fn: f.name });
    for (const c of tokens.flatMap((tok, k) => tok.t === 'id' && tokens[k + 1]?.v === '(' && !['.', '?.'].includes(tokens[k - 1]?.v) && inside(k, f.body)
      && (body.has(tok.v) || ext(tok.v, 'body')) ? [{ name: tok.v, line: tok.line }] : [])) {
      findings.push({ file, line: c.line, shape: 'mixed', what: `${c.name}() reads the clock`, fn: f.name });
    }
  }
  return { findings, body, call };
}

const isTestModule = (file) => file.split(/[\\/]/).includes('test');

export function scanClockLock(entries) {
  const facts = new Map();
  const load = (file) => {
    if (facts.has(file)) return facts.get(file);
    facts.set(file, null); // a cycle reads as no facts
    const mod = parse(file, fs.readFileSync(file, 'utf8'));
    const imported = new Map();
    for (const imp of mod.imports) {
      const target = path.resolve(path.dirname(file), imp.spec);
      const got = isTestModule(target) && fs.existsSync(target) ? load(target) : null;
      if (got) for (const n of imp.names) imported.set(n, got);
    }
    const result = clockFacts(mod, imported);
    facts.set(file, result);
    return result;
  };
  for (const entry of entries) load(path.resolve(entry));
  return [...facts.values()].flatMap(f => f?.findings ?? []).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// A suite's test files: the *.test.mjs directly in the directory, as the suites' {tests:<dir>} expands them.
export const testFilesIn = (dir) => fs.readdirSync(dir).filter(n => n.endsWith('.test.mjs')).sort().map(n => path.join(dir, n));

// How a finding reads in a failure, relative to base; and what to do about one.
export const shownFinding = (f, base) => `${path.relative(base, f.file).split(path.sep).join('/')}:${f.line} ${f.shape} ${f.what}${f.fn ? ` in ${f.fn}` : ''}`;
export const CLOCK_LOCK_FIX = 'A fixture built when its file loads takes a constant (T0, or a far-future constant for a deadline), never the real time; '
  + 'a fixture that takes a clock reads time only from it (pass Date.now itself as that clock when a test wants the real one).';
