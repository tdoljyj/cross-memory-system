import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Match the Binding column probe, row-to-JSON read and direct column SQL in
// fixture literals. A separate authorization or grant expiry is unrelated.
const bindingExpirySql = [
  /\bfrom\s+information_schema\.columns\b(?=[^;]*\btable_name\s*=\s*'clued_agent_bindings')(?=[^;]*\bcolumn_name\s*=\s*'expires_at')/i,
  /\bto_jsonb\(\s*\w+\s*\)\s*->>\s*'expires_at'[^;]*\bfrom\s+(?:public\.)?clued_agent_bindings\b/i,
  /\bselect\s+(?:\w+\.)?expires_at\s+from\s+(?:public\.)?clued_agent_bindings\b/i,
  /\bupdate\s+(?:public\.)?clued_agent_bindings\s+set\s+expires_at\s*=/i,
  /\binsert\s+into\s+(?:public\.)?clued_agent_bindings\s*\([^)]*\bexpires_at\b[^)]*\)/i,
];

function parseFixtureSource(file) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
}

function readsOrWritesLegacyExpiry(node) {
  if (ts.isStringLiteralLike(node) && bindingExpirySql.some((pattern) => pattern.test(node.text))) {
    return true;
  }
  return ts.forEachChild(node, readsOrWritesLegacyExpiry);
}

test("Resource Center fixtures using the legacy Binding expiry are registered for both shapes", () => {
  // Read the executable registry without importing the database test.
  const authority = parseFixtureSource("resource-center-authority-db.test.mjs");
  const registry = authority.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => Array.from(statement.declarationList.declarations))
    .find(({ name }) => ts.isIdentifier(name) && name.text === "LEGACY_EXPIRY_FIXTURES");
  assert.ok(registry?.initializer && ts.isObjectLiteralExpression(registry.initializer),
    "The DB test must declare a literal LEGACY_EXPIRY_FIXTURES registry");
  const registered = registry.initializer.properties.map((entry) => {
    assert.ok(ts.isPropertyAssignment(entry) && ts.isStringLiteral(entry.name),
      "Each legacy expiry fixture must be registered by its filename");
    return entry.name.text;
  }).sort();

  const dependent = readdirSync(new URL(".", import.meta.url))
    .filter((file) => /^resource-center-.*\.fixture\.mjs$/.test(file))
    .filter((file) => readsOrWritesLegacyExpiry(parseFixtureSource(file)))
    .sort();
  assert.deepEqual(registered, dependent, "LEGACY_EXPIRY_FIXTURES must match the fixtures that use clued_agent_bindings.expires_at");
});
