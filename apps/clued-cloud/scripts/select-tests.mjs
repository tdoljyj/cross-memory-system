// Content-driven test selection for apps/clued-cloud.
//
// Audit 2026-10-06 P1-6 (Clued Task 5077b641): package.json ran hand-maintained
// test lists and many tests were referenced by no script or workflow. This
// script classifies every top-level tests/*.test.mjs by content instead: a test
// is "db" when it, or any file it imports transitively inside the tests
// directory, imports embedded-postgres; everything else is "unit". tests/v2-red
// keeps its own suite (test:v2:red) and helper files are never tests.
//
// Usage: node scripts/select-tests.mjs <unit|db|all> [--list] [--] [node --test args]
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runNodeTests } from "./run-tests.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = path.join(APP_ROOT, "tests");
const PACKAGE = "embedded-postgres";
const MODES = new Set(["unit", "db", "all"]);
const USAGE = "usage: node scripts/select-tests.mjs <unit|db|all> [--list] [--] [extra node --test args]";

// Module specifiers of static import / export-from statements, side-effect
// imports and dynamic import() calls, with single or double quotes.
export const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function importSpecifiers(source) {
  const specifiers = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

export function importsEmbeddedPostgres(source) {
  return importSpecifiers(source).some((spec) => spec === PACKAGE || spec.startsWith(`${PACKAGE}/`));
}

// Relative (./ or ../) imports of `file`, resolved against it and kept only
// when they land inside `testsDir`. Existence is checked by the caller.
export function resolveLocalImports(file, source, testsDir = TESTS_DIR) {
  const root = path.resolve(testsDir);
  const targets = new Set();
  for (const spec of importSpecifiers(source)) {
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    const target = path.resolve(path.dirname(file), spec);
    if (target.startsWith(root + path.sep)) targets.add(target);
  }
  return [...targets];
}

function readSource(file, cache) {
  if (!cache.has(file)) {
    let source = null;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      source = null; // missing target or a directory
    }
    cache.set(file, source);
  }
  return cache.get(file);
}

function needsDatabase(testFile, root, cache) {
  const visited = new Set();
  const stack = [testFile];
  while (stack.length > 0) {
    const file = stack.pop();
    if (visited.has(file)) continue; // cycle guard
    visited.add(file);
    const source = readSource(file, cache);
    if (source === null) continue;
    if (importsEmbeddedPostgres(source)) return true;
    stack.push(...resolveLocalImports(file, source, root));
  }
  return false;
}

export function classifyTests(testsDir = TESTS_DIR) {
  const root = path.resolve(testsDir);
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join(root, entry.name))
    .sort();
  const cache = new Map();
  const result = { unit: [], db: [] };
  for (const file of files) result[needsDatabase(file, root, cache) ? "db" : "unit"].push(file);
  return result;
}

async function main(argv) {
  const [mode, ...rest] = argv;
  if (!MODES.has(mode)) {
    console.error(USAGE);
    return 2;
  }
  const separator = rest.indexOf("--");
  const options = separator === -1 ? rest : rest.slice(0, separator);
  const extraArgs = [...options.filter((arg) => arg !== "--list"), ...(separator === -1 ? [] : rest.slice(separator + 1))];
  const { unit, db } = classifyTests(TESTS_DIR);
  const selected = mode === "unit" ? unit : mode === "db" ? db : [...unit, ...db].sort();
  if (selected.length === 0) {
    console.error(`select-tests: no ${mode} test files found under tests/`);
    return 1;
  }
  const relative = (file) => path.relative(APP_ROOT, file).split(path.sep).join("/");
  if (options.includes("--list")) {
    // "all" labels each file with its class; "unit" and "db" print bare paths.
    const label = (file) => (mode === "all" ? `${db.includes(file) ? "db" : "unit"}\t` : "");
    process.stdout.write(selected.map((file) => `${label(file)}${relative(file)}\n`).join(""));
    return 0;
  }
  let status = 0;
  for (const args of nodeTestRuns(mode, { unit, db }, extraArgs, relative)) {
    let code;
    try {
      code = await runNodeTests(args, { cwd: APP_ROOT });
    } catch (error) {
      console.error(`select-tests: ${error.message}`);
      return 1;
    }
    if (code !== 0) status = code;
    if (code >= 128) break; // a cancelled suite must not start another one
  }
  return status;
}

// The node --test invocations for a mode. Unit tests run without
// --test-force-exit: that flag exits once the tests known so far have
// finished, and under CPU load it silently skipped later tests (a file with
// 53 tests ran 28). Database tests keep it because embedded PostgreSQL
// fixtures can hold the event loop open; "all" runs the two sets separately.
export function nodeTestRuns(mode, { unit, db }, extraArgs = [], toPath = (file) => file) {
  const runs = [];
  if ((mode === "unit" || mode === "all") && unit.length > 0) {
    runs.push(["--test", ...extraArgs, ...unit.map(toPath)]);
  }
  if ((mode === "db" || mode === "all") && db.length > 0) {
    runs.push(["--test", "--test-force-exit", ...extraArgs, ...db.map(toPath)]);
  }
  return runs;
}

// Run the CLI only when this file is the entry point. The ESM loader resolves
// symlinks in import.meta.url, so compare real paths rather than URLs.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
