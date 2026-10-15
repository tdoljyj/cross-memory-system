import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validatePackage } from "./validate-package.mjs";

const sourceRoot = fileURLToPath(new URL("./", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kooyumi-package-"));
  t.after(async () => {
    assert(resolve(root).startsWith(resolve(tmpdir()) + "/") || resolve(root).startsWith(resolve(tmpdir()) + "\\"));
    await rm(root, { recursive: true, force: true });
  });
  await cp(sourceRoot, root, { recursive: true });
  return root;
}

test("clean source contains one direct MCP and no registered app or Skill", async () => {
  assert.deepEqual(await validatePackage(sourceRoot, "1.0.4"), {
    version: "1.0.4", registeredApps: 0, mcpServers: ["kooyumi"],
  });
});

test("an overlay update retaining the old app reference fails validation", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, ".app.json"), JSON.stringify({ apps: { legacy: { id: "asdk_app_legacy" } } }));
  await assert.rejects(validatePackage(root), /Package file set/);
});

test("manifest app dependencies fail even without an app file", async (t) => {
  const root = await fixture(t);
  const path = join(root, ".codex-plugin/plugin.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.apps = "./.app.json";
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(validatePackage(root), /Unexpected plugin fields/);
});

test("the legacy MCP URL cannot become the default connection", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, ".mcp.json"), JSON.stringify({
    mcpServers: { kooyumi: { type: "http", url: "https://clued.pixelgrav.com/mcp" } },
  }));
  await assert.rejects(validatePackage(root), /only the direct Kooyumi/);
});
