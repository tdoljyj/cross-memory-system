import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validatePackage } from "./validate-package.mjs";

const sourceRoot = fileURLToPath(new URL("./", import.meta.url));
const appId = "asdk_app_6ad0cb1db0c48191a97bd2bd158836e3";
const legacyAppId = "asdk_app_6a9f92f8ec908191a9ef87838c60177f";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kooyumi-package-"));
  t.after(async () => {
    assert(resolve(root).startsWith(resolve(tmpdir()) + "/") || resolve(root).startsWith(resolve(tmpdir()) + "\\"));
    await rm(root, { recursive: true, force: true });
  });
  await cp(sourceRoot, root, { recursive: true });
  return root;
}

test("clean source contains only the registered BeamingFace app and retains the local package identity", async () => {
  assert.deepEqual(await validatePackage(sourceRoot, "1.0.7"), {
    version: "1.0.7", registeredApps: 1, appIds: [appId], mcpServers: [],
  });
  const manifest = JSON.parse(await readFile(join(sourceRoot, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "dev-6a9f92f8ec908191a9ef87838c60177f");
  assert.equal(manifest.apps, "./.app.json");
  assert.equal(Object.hasOwn(manifest, "mcpServers"), false);
  assert.deepEqual(JSON.parse(await readFile(join(sourceRoot, ".app.json"), "utf8")), {
    apps: { kooyumi: { id: appId } },
  });
});

test("the old registered Clued app ID is rejected", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, ".app.json"), JSON.stringify({ apps: { kooyumi: { id: legacyAppId } } }));
  await assert.rejects(validatePackage(root, "1.0.7"), /only the registered BeamingFace app/);
});

test("multiple aliases are rejected even when they reference the same registered app", async (t) => {
  for (const aliasId of [appId, legacyAppId]) {
    const root = await fixture(t);
    await writeFile(join(root, ".app.json"), JSON.stringify({
      apps: { kooyumi: { id: appId }, clued: { id: aliasId } },
    }));
    await assert.rejects(validatePackage(root, "1.0.7"), /only the registered BeamingFace app/);
  }
});

test("app declarations have no additional fields or alternate aliases", async (t) => {
  for (const declaration of [
    { apps: { kooyumi: { id: appId, optional: true } } },
    { apps: { other: { id: appId } } },
    { apps: { kooyumi: { id: appId } }, mcpServers: {} },
  ]) {
    const root = await fixture(t);
    await writeFile(join(root, ".app.json"), JSON.stringify(declaration));
    await assert.rejects(validatePackage(root, "1.0.7"), /only the registered BeamingFace app/);
  }
});

test("residual compatibility or portable MCP files fail the exact inventory", async (t) => {
  for (const filename of [".mcp.json", "mcp.json"]) {
    const root = await fixture(t);
    await writeFile(join(root, filename), JSON.stringify({
      mcpServers: { kooyumi: { type: "http", url: "https://kooyumi.pixelgrav.com/mcp" } },
    }));
    await assert.rejects(validatePackage(root, "1.0.7"), /Package file set/);
  }
});

test("manifest direct MCP and Skill dependencies fail validation", async (t) => {
  for (const extra of [
    { mcpServers: "./.mcp.json" },
    { mcpServers: { kooyumi: { type: "http", url: "https://kooyumi.pixelgrav.com/mcp" } } },
    { skills: "./skills" },
  ]) {
    const root = await fixture(t);
    const path = join(root, ".codex-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...manifest, ...extra }));
    await assert.rejects(validatePackage(root, "1.0.7"), /Unexpected plugin fields/);
  }
});

test("an extra bundled Skill fails the exact package inventory", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "skills/clued"), { recursive: true });
  await writeFile(join(root, "skills/clued/SKILL.md"), "---\nname: clued\ndescription: Fixture only\n---\n");
  await assert.rejects(validatePackage(root, "1.0.7"), /Package file set/);
});
