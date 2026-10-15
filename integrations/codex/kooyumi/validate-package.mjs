import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = fileURLToPath(new URL("./", import.meta.url));
const files = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "README.md",
  "validate-package.mjs",
  "validate-package.test.mjs",
].sort();

async function inventory(root, prefix = "") {
  const found = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Symbolic links are not package files: ${relative}`);
    if (entry.isDirectory()) {
      assert.equal(relative, ".codex-plugin", `Unexpected package directory: ${relative}`);
      found.push(...await inventory(root, relative));
    } else {
      assert(entry.isFile(), `Unsupported package entry: ${relative}`);
      found.push(relative);
    }
  }
  return found.sort();
}

export async function validatePackage(root, expectedVersion) {
  assert.deepEqual(await inventory(root), files, "Package file set must match the clean source; remove stale .app.json and other extra files");
  const manifest = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["author", "description", "interface", "mcpServers", "name", "version"], "Unexpected plugin fields, including app or Skill dependencies");
  assert.equal(manifest.name, "dev-6a9f92f8ec908191a9ef87838c60177f");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  if (expectedVersion !== undefined) assert.equal(manifest.version, expectedVersion, "Installed version differs from the source version");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.interface.displayName, "Kooyumi");
  const mcp = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp, {
    mcpServers: { kooyumi: { type: "http", url: "https://kooyumi.pixelgrav.com/mcp" } },
  }, "Package must contain only the direct Kooyumi MCP connection");
  return { version: manifest.version, registeredApps: 0, mcpServers: ["kooyumi"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const source = JSON.parse(await readFile(new URL("./.codex-plugin/plugin.json", import.meta.url), "utf8"));
    const result = await validatePackage(resolve(process.argv[2] ?? sourceRoot), source.version);
    console.log(`Kooyumi package valid: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
