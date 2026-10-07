import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyTests, importsEmbeddedPostgres, resolveLocalImports } from "../scripts/select-tests.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
// Assembled at runtime so this file's own source never contains the package
// name and the selector keeps classifying it as a unit test.
const PACKAGE = ["embedded", "postgres"].join("-");

function writeTree(root, files) {
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
}

test("importsEmbeddedPostgres matches every supported import form", () => {
  for (const source of [
    `import EmbeddedPostgres from "${PACKAGE}";`,
    `import EmbeddedPostgres from '${PACKAGE}'`,
    `import {\n  Options,\n} from "${PACKAGE}";`,
    `import "${PACKAGE}";`,
    `export { default } from '${PACKAGE}';`,
    `export * from "${PACKAGE}";`,
    `const mod = await import("${PACKAGE}");`,
    `const mod = await import( '${PACKAGE}' );`,
  ]) assert.ok(importsEmbeddedPostgres(source), source);
  for (const source of [
    'import fs from "node:fs";',
    `// ${PACKAGE} is mentioned here but never imported`,
    `const name = "${PACKAGE}";`,
    `import pg from "${PACKAGE}-client";`,
  ]) assert.equal(importsEmbeddedPostgres(source), false, source);
});

test("resolveLocalImports keeps only relative targets inside the tests directory", () => {
  const file = path.join(TESTS_DIR, "example.test.mjs");
  const source = [
    'import a from "./a.fixture.mjs";',
    "import b from '../scripts/b.mjs';",
    'import c from "node:fs";',
    'const d = await import("./fixtures/d.mjs");',
    'export * from "./a.fixture.mjs";',
  ].join("\n");
  assert.deepEqual(resolveLocalImports(file, source, TESTS_DIR), [
    path.join(TESTS_DIR, "a.fixture.mjs"),
    path.join(TESTS_DIR, "fixtures", "d.mjs"),
  ]);
});

test("classifyTests follows relative imports transitively and terminates on cycles", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "select-tests-"));
  try {
    writeTree(root, {
      "a.test.mjs": "export const a = 1;\n",
      "b-db.test.mjs": `import EmbeddedPostgres from '${PACKAGE}';\n`,
      "c.test.mjs": 'import { helper } from "./helper.fixture.mjs";\n',
      "helper.fixture.mjs": `import EmbeddedPostgres from "${PACKAGE}";\nexport const helper = EmbeddedPostgres;\n`,
      "d.test.mjs": 'const nested = await import("./nested.mjs");\n',
      "nested.mjs": `import '${PACKAGE}';\n`,
      "e.test.mjs": 'import fs from "node:fs";\n',
      "x.test.mjs": 'import "./y.mjs";\nimport "./missing.mjs";\n',
      "y.mjs": 'export * from "./x.test.mjs";\n',
      "v2-red/z.test.mjs": `import EmbeddedPostgres from "${PACKAGE}";\n`,
    });
    const { unit, db } = classifyTests(root);
    for (const file of [...unit, ...db]) assert.ok(path.isAbsolute(file), file);
    const names = (files) => files.map((file) => path.relative(root, file));
    assert.deepEqual(names(unit), ["a.test.mjs", "e.test.mjs", "x.test.mjs"]);
    assert.deepEqual(names(db), ["b-db.test.mjs", "c.test.mjs", "d.test.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifyTests partitions the real tests directory", () => {
  const { unit, db } = classifyTests(TESTS_DIR);
  const expected = readdirSync(TESTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join(TESTS_DIR, entry.name))
    .sort();
  assert.ok(unit.length > 0 && db.length > 0);
  assert.deepEqual([...unit, ...db].sort(), expected);
  const dbSet = new Set(db);
  assert.equal(unit.filter((file) => dbSet.has(file)).length, 0);
  for (const file of expected) {
    if (importsEmbeddedPostgres(readFileSync(file, "utf8"))) assert.ok(dbSet.has(file), `${path.basename(file)} must be a db test`);
  }
  assert.ok(unit.includes(fileURLToPath(import.meta.url)));
});
