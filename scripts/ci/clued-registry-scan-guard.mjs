// Registration guard (Task b7765949): registering a workflow Source must never add a
// gitleaks finding. The registries embed workflow text (clued-gated-proof-profiles.json
// as plaintext /3 lines, clued-gated-proof-role-specs.json as one escaped line per `run`
// step), so a Source that holds a curl command and a `--user a:b` option in reach of the
// multi-line curl rules would make the registration commit itself a finding, which in turn
// needs a reviewed fingerprint, which changes the pinned scan inputs, which needs another
// registration: the registration loop. This module runs the upstream rules over the exact
// bytes about to be committed, so the loop is cut before the commit instead of after the scan.
//
// The rules are gitleaks v8.30.1 (the pinned scanner image), unchanged. They are never
// relaxed, never allow-listed by path or fingerprint here. The port to JS: Go's `\z` is `$`
// (no m flag); Go's `.` is every character but LF, so `.` becomes `[^\n]` (JS `.` also stops at
// CR, U+2028 and U+2029); the header rule's inline `(?i)` becomes the `i` flag for the whole
// expression. The port is deliberately stricter than the scanner where they differ (the `i`
// flag reaches the command and option names, JS `\s` also takes NBSP, and the scanner's
// entropy and stop-word filters are not applied), so a registration the guard passes is one the
// scanner passes; a registration it refuses may need a look, never a fingerprint.
//
//   node scripts/ci/clued-registry-scan-guard.mjs [file ...]   (default: both registries)
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

// Go regexp `.` is any character except LF; keep that meaning in JS (outside character classes).
const goDots = source => {
  let out = '', inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { out += c + source[++i]; continue; }
    if (inClass) { if (c === ']') inClass = false; out += c; continue; }
    if (c === '[') { inClass = true; out += c; continue; }
    out += c === '.' ? '[^\\n]' : c;
  }
  return out;
};

export const SCANNER_RULES = Object.freeze([
  Object.freeze({id: 'curl-auth-user', regex: goDots(String.raw`\bcurl\b(?:.*|.*(?:[\r\n]{1,2}.*){1,5})[ \t\n\r](?:-u|--user)(?:=|[ \t]{0,5})("(:[^"]{3,}|[^:"]{3,}:|[^:"]{3,}:[^"]{3,})"|'([^:']{3,}:[^']{3,})'|((?:"[^"]{3,}"|'[^']{3,}'|[\w$@.-]+):(?:"[^"]{3,}"|'[^']{3,}'|[\w$\{}@.-]+)))(?:\s|$)`), flags: 'g'}),
  Object.freeze({id: 'curl-auth-header', regex: goDots(String.raw`\bcurl\b(?:.*?|.*?(?:[\r\n]{1,2}.*?){1,5})[ \t\n\r](?:-H|--header)(?:=|[ \t]{0,5})(?:"(?:Authorization:[ \t]{0,5}(?:Basic[ \t]([a-z0-9+/]{8,}={0,3})|(?:Bearer|(?:Api-)?Token)[ \t]([\w=~@.+/-]{8,})|([\w=~@.+/-]{8,}))|(?:(?:X-(?:[a-z]+-)?)?(?:Api-?)?(?:Key|Token)):[ \t]{0,5}([\w=~@.+/-]{8,}))"|'(?:Authorization:[ \t]{0,5}(?:Basic[ \t]([a-z0-9+/]{8,}={0,3})|(?:Bearer|(?:Api-)?Token)[ \t]([\w=~@.+/-]{8,})|([\w=~@.+/-]{8,}))|(?:(?:X-(?:[a-z]+-)?)?(?:Api-?)?(?:Key|Token)):[ \t]{0,5}([\w=~@.+/-]{8,}))')(?:\B|\s|$)`), flags: 'gi'}),
]);

export const REGISTRY_FILES = Object.freeze([
  'scripts/ci/clued-gated-proof-profiles.json',
  'scripts/ci/clued-gated-proof-role-specs.json',
]);

// The rules backtrack on very long single lines (the legacy one-line Source form is exactly that).
// A line this long is refused outright instead of being scanned for seconds; the /3 codec caps a
// Source line at 65536 bytes and the registries' own lines are far below this.
export const MAX_LINE_CHARS = 262144;

/** Every rule match in `text`: [{rule, line}] with 1-based start lines. Never returns the matched text (it may look like a credential). */
export function scannerMatches(text) {
  if (typeof text !== 'string') throw new TypeError('scannerMatches needs a string');
  const out = [];
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo++;
    if (line.length > MAX_LINE_CHARS) out.push({rule: 'line-too-long', line: lineNo});
  }
  if (out.length) return out;
  for (const {id, regex, flags} of SCANNER_RULES) {
    for (const match of text.matchAll(new RegExp(regex, flags))) {
      let line = 1;
      for (let i = text.indexOf('\n'); i !== -1 && i < match.index; i = text.indexOf('\n', i + 1)) line++;
      out.push({rule: id, line});
    }
  }
  return out.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export class RegistryScannerMatchError extends Error {
  constructor(findings) {
    const where = findings.map(f => `${f.file}:${f.line} ${f.rule}`).join(', ');
    const tooLong = findings.every(f => f.rule === 'line-too-long');
    super('REGISTRY_SCANNER_MATCH: ' + where + (tooLong
      ? `. A line is longer than the guard's scan limit (${MAX_LINE_CHARS} characters), so it was not scanned; store the Source as separate lines (/3) instead.`
      : '. Registering this Source would itself be a gitleaks finding (registration loop). Do not add a reviewed' +
        ' fingerprint or an ignore: keep the curl command and the --user/-H option of one command apart in the' +
        ' workflow (more than five lines in /3 profile lines; in different run steps for role specs), or write the' +
        ' value so it is not a literal user:password pair, then register again. The guard is stricter than the' +
        ' scanner (no entropy or stop-word filter, case-insensitive header rule): if the pair is a variable' +
        ' reference rather than a literal, check it against the pinned scanner, never with a fingerprint.'));
    this.name = 'RegistryScannerMatchError';
    this.code = 'REGISTRY_SCANNER_MATCH';
    this.findings = findings;
  }
}

/** `files` is {name: text}. Throws RegistryScannerMatchError naming rule and line, never the text. */
export function assertRegistryScannerClean(files) {
  const findings = [];
  for (const [file, text] of Object.entries(files)) {
    for (const match of scannerMatches(text)) findings.push({file, ...match});
  }
  if (findings.length) throw new RegistryScannerMatchError(findings);
}

function main(argv) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const names = argv.length ? argv : REGISTRY_FILES;
  const files = Object.fromEntries(names.map(name => [name, fs.readFileSync(argv.length ? name : root + name, 'utf8')]));
  try {
    assertRegistryScannerClean(files);
  } catch (error) {
    if (error.code !== 'REGISTRY_SCANNER_MATCH') throw error;
    process.stderr.write(error.message + '\n');
    return 1;
  }
  process.stdout.write(`registry scan guard: ${names.length} file(s), no curl-auth match\n`);
  return 0;
}

const sameFile = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
if (process.argv[1] && sameFile(fs.realpathSync(fileURLToPath(import.meta.url)), fs.realpathSync(process.argv[1]))) {
  process.exitCode = main(process.argv.slice(2));
}
