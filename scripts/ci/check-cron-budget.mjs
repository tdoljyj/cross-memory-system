#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MIN_INTERVAL = 10;
const MINUTES_PER_DAY = 24 * 60;
const DAY_MS = MINUTES_PER_DAY * 60 * 1000;
const ALLOWLIST = 'scripts/ci/cron-budget-allowlist.json';
const MONTHS = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ');
const WEEKDAYS = 'SUN MON TUE WED THU FRI SAT'.split(' ');
const WRANGLER = /(?:^|\/)wrangler[^/]*\.jsonc$/;
const MIGRATION = /(?:^|\/)migrations\/[^/]+\.sql$/;

function parseJsonc(source) {
  // Match complete strings first so comments and commas inside them stay intact.
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
  const json = source.replace(/^\uFEFF/, '').replace(tokens, (token) => token.startsWith('"') ? token : ' ');
  return JSON.parse(json.replace(/"(?:\\[\s\S]|[^"\\])*"|,(?=\s*[\]}])/g, (token) => token === ',' ? '' : token));
}

function cronField(text, min, max, names = []) {
  function number(value) {
    const index = names.indexOf(value);
    const result = index >= 0 ? min + index : /^\d+$/.test(value) ? Number(value) : NaN;
    if (!(result >= min && result <= max)) throw new Error(`invalid cron value ${JSON.stringify(value)}`);
    return result;
  }
  const values = new Set();
  for (const item of text.toUpperCase().split(',')) {
    const match = /^(\*|[A-Z0-9]+)(?:-([A-Z0-9]+))?(?:\/(\d+))?$/.exec(item);
    if (!match || (match[1] === '*' && match[2])) throw new Error(`unsupported cron field ${JSON.stringify(text)}`);
    const [, start, end, stride] = match;
    const first = start === '*' ? min : number(start);
    const last = end ? number(end) : start === '*' || stride ? max : first;
    const step = Number(stride ?? 1);
    if (last < first || !Number.isSafeInteger(step) || step < 1) throw new Error(`invalid cron field ${JSON.stringify(text)}`);
    for (let value = first; value <= last; value += step) values.add(value);
  }
  return values;
}

function dateMatches(cron, date) {
  if (!cron.months.has(date.getUTCMonth() + 1)) return false;
  const day = cron.days.has(date.getUTCDate()) || (cron.lastDay && new Date(+date + DAY_MS).getUTCDate() === 1);
  const weekday = cron.weekdays.has(date.getUTCDay());
  return cron.requireBothDays ? day && weekday : day || weekday;
}

function someCalendarDay(matches) {
  // Gregorian dates (including their weekdays) repeat after 400 years.
  const end = Date.UTC(2400, 0, 1);
  for (let day = Date.UTC(2000, 0, 1); day < end; day += DAY_MS) {
    if (matches(new Date(day))) return true;
  }
  return false;
}

function parseCron(schedule, pgCron = false) {
  if (typeof schedule !== 'string') throw new Error('expected a cron string');
  const fields = schedule.trim().split(/\s+/);
  if (pgCron && /^(?:[1-9]|[1-5][0-9])\s+seconds?$/.test(schedule.trim())) return { tooFast: true, seconds: true };
  if (fields.length !== 5) throw new Error('expected a five-field cron expression');
  const [minute, hour, day, month, weekday] = fields;
  const minutes = cronField(minute, 0, 59);
  const hours = cronField(hour, 0, 23);
  const lastDay = pgCron && day === '$';
  const cron = {
    times: [...hours].flatMap((value) => [...minutes].map((min) => value * 60 + min)).sort((a, b) => a - b),
    months: cronField(month, 1, 12, MONTHS),
    days: lastDay ? new Set() : cronField(day, 1, 31),
    weekdays: new Set([...cronField(weekday, pgCron ? 0 : 1, 7, WEEKDAYS)].map((value) => pgCron ? value % 7 : value - 1)),
    // Both dialects use OR when both day fields are restricted. Vixie cron
    // also treats a leading wildcard with a step as a wildcard for this rule.
    requireBothDays: pgCron ? day.startsWith('*') || weekday.startsWith('*') : day === '*' || weekday === '*',
    lastDay,
  };
  const { times } = cron;
  cron.tooFast = times.some((time, index) => index > 0 && time - times[index - 1] < MIN_INTERVAL)
    || (MINUTES_PER_DAY - times.at(-1) + times[0] < MIN_INTERVAL
      && someCalendarDay((date) => dateMatches(cron, date) && dateMatches(cron, new Date(+date + DAY_MS))));
  return cron;
}

function sharedMinute(left, right) {
  if (left.seconds || right.seconds) return true;
  const times = new Set(left.times);
  return right.times.some((time) => times.has(time))
    && someCalendarDay((date) => dateMatches(left, date) && dateMatches(right, date));
}

// Keep strings and nested comments opaque. Only DO/routine bodies (and literal
// EXECUTE statements) are scanned as SQL inside a string token.
function sqlTokens(source, firstLine = 1) {
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

function callArguments(tokens, open) {
  const args = [[]];
  let depth = 0;
  for (let index = open + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'code') {
      if (token.value === ')' && depth === 0) return args;
      if (token.value === ',' && depth === 0) {
        args.push([]);
        continue;
      }
      if (token.value === '(' || token.value === '[') depth += 1;
      if (token.value === ')' || token.value === ']') depth -= 1;
    }
    args.at(-1).push(token);
  }
  throw new Error('unclosed cron call');
}

function literal(tokens) {
  return tokens?.length === 1 && tokens[0].kind === 'literal' ? tokens[0].value : undefined;
}

function* registrations(source, firstLine) {
  if (!/\bcron\b/i.test(source)) return;
  const tokens = sqlTokens(source, firstLine);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'literal') {
      const previous = tokens[index - 1];
      if (previous?.kind === 'code' && ['do', 'as', 'execute'].includes(previous.value)) {
        yield* registrations(token.value, token.line);
      }
      continue;
    }
    if (token.value !== 'cron') continue;
    const [dot, method, open] = tokens.slice(index + 1, index + 4);
    if (dot?.kind === 'code' && dot.value === '.' && method?.kind !== 'literal'
        && ['schedule', 'unschedule'].includes(method?.value) && open?.kind === 'code' && open.value === '(') {
      const args = callArguments(tokens, index + 3);
      yield { method: method.value, args, line: token.line };
    }
  }
}

function readAllowlist() {
  const data = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  const entries = new Map();
  for (const [type, rows] of Object.entries({ wrangler: data.wrangler, pgCron: data.pgCron, collisionPeers: data.collisionPeers ?? [] })) {
    if (!Array.isArray(rows)) throw new Error(`${ALLOWLIST}: expected a ${type} array`);
    for (const row of rows) {
      const target = type === 'wrangler' ? row.config : row.job;
      const pattern = type === 'wrangler' ? WRANGLER : MIGRATION;
      const date = new Date(row.expiresOn);
      if (typeof row.file !== 'string' || !pattern.test(row.file) || typeof target !== 'string' || !target
          || typeof row.schedule !== 'string' || (type !== 'collisionPeers' && (
            typeof row.owner !== 'string' || !row.owner.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(row.expiresOn)
            || Number.isNaN(+date) || date.toISOString().slice(0, 10) !== row.expiresOn))) {
        throw new Error(`${ALLOWLIST}: invalid ${type} entry ${JSON.stringify(row)}`);
      }
      const key = JSON.stringify([row.file, target, row.schedule]);
      if (entries.has(key)) throw new Error(`${ALLOWLIST}: duplicate exception ${key}`);
      entries.set(key, { ...row, collisionPeer: type === 'collisionPeers' });
    }
  }
  return entries;
}

function checkBudget(files, allowlist, today) {
  const errors = [];
  const exceptions = new Set();
  const activeJobs = new Map();
  const legacyRegistrations = new Set();
  const exemption = (file, target, schedule) => allowlist.get(JSON.stringify([file, target, schedule]));
  function exempt(item) {
    if (!item.exception) return false;
    const { owner, expiresOn } = item.exception;
    if (today >= expiresOn) {
      errors.push(`${item.label}: cron budget exception expired on ${expiresOn} (owner ${owner})`);
      return false;
    }
    exceptions.add(`${item.label} (owner ${owner}, expires ${expiresOn})`);
    return true;
  }

  for (const file of files.filter((name) => WRANGLER.test(name))) {
    try {
      const config = parseJsonc(readFileSync(file, 'utf8'));
      const scopes = [['triggers.crons', config.triggers?.crons],
        ...Object.entries(config.env ?? {}).map(([name, env]) => [`env.${name}.triggers.crons`, env.triggers?.crons])];
      for (const [key, crons] of scopes) {
        const label = `${file}: ${key}`;
        if (crons === undefined || (Array.isArray(crons) && crons.length === 0)) continue;
        if (!Array.isArray(crons) || crons.length !== 1) {
          errors.push(`${label}: expected exactly one cron when triggers are enabled`);
          continue;
        }
        try {
          const [schedule] = crons;
          if (parseCron(schedule).tooFast && !exempt({ label, exception: exemption(file, key, schedule) })) {
            errors.push(`${label}: ${JSON.stringify(schedule)} runs less than ${MIN_INTERVAL} minutes apart`);
          }
        } catch (error) {
          errors.push(`${label}: ${error.message}`);
        }
      }
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }

  // Replay named declarations in migration order for collision and expiry.
  // Still reject any newly introduced high-frequency registration, even if
  // another statement in the same change removes it.
  for (const file of files.filter((name) => MIGRATION.test(name)).sort()) {
    try {
      for (const { method, args, line } of registrations(readFileSync(file, 'utf8'))) {
        const location = `${file}:${line}`;
        if (method === 'unschedule') {
          const name = literal(args[0]);
          if (args.length === 1 && name !== undefined) activeJobs.delete(name);
          continue;
        }
        const named = args.length === 3;
        const name = named ? literal(args[0]) : undefined;
        const schedule = literal(args[named ? 1 : 0]);
        if (![2, 3].includes(args.length) || schedule === undefined || (named && !name)) {
          errors.push(`${location}: cron.schedule requires a literal schedule and, for named jobs, a literal job name`);
          continue;
        }
        const label = `${location}: ${name ?? '(unnamed job)'}`;
        try {
          const cron = parseCron(schedule, true);
          const exception = exemption(file, name, schedule);
          // One literal declaration gets the exception, even if another call repeats it in the same migration.
          const grandfathered = exception && !legacyRegistrations.has(exception);
          if (grandfathered) legacyRegistrations.add(exception);
          if (cron.tooFast && (!grandfathered || exception.collisionPeer)) {
            errors.push(`${label}: ${JSON.stringify(schedule)} runs less than ${MIN_INTERVAL} minutes apart`);
          }
          activeJobs.set(name ?? Symbol(), { label, cron, collisionPeer: grandfathered && exception.collisionPeer,
            exception: grandfathered && !exception.collisionPeer ? exception : undefined });
        } catch (error) {
          errors.push(`${label}: ${error.message}`);
        }
      }
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }

  const jobs = [...activeJobs.values()].map((job) => ({ ...job, exempt: exempt(job) }));
  for (const [index, job] of jobs.entries()) {
    for (const other of jobs.slice(0, index)) {
      // A compliant historical peer gets no exemption of its own. Only its
      // known overlap with a still-exempt legacy job is grandfathered.
      const legacyCollision = (job.exempt && (other.exempt || other.collisionPeer)) || (other.exempt && job.collisionPeer);
      if (!legacyCollision && sharedMinute(job.cron, other.cron)) {
        errors.push(`${job.label} runs in the same minute as ${other.label}`);
      }
    }
  }
  return { errors, exceptions };
}

try {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*wrangler*.jsonc', ':(glob)**/migrations/*.sql'],
    { encoding: 'utf8' }).split('\0').filter(Boolean);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(new Date());
  const { errors, exceptions } = checkBudget(files, readAllowlist(), today);
  for (const item of exceptions) console.log(`cron-budget: temporary exception: ${item}`);
  if (errors.length) {
    for (const error of errors) console.error(`cron-budget: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`cron-budget: passed (${files.length} files, ${exceptions.size} active temporary exceptions)`);
  }
} catch (error) {
  console.error(`cron-budget: ${error.message}`);
  process.exitCode = 1;
}
