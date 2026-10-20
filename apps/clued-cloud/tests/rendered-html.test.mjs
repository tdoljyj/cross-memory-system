import assert from "node:assert/strict";
import test from "node:test";

test("production build includes the BeamingFace account entry", async () => {
  // The vinext bundle imports cloudflare:workers and cannot run in Node's ESM
  // loader. The build gate emits the server bundle; this verifies that its
  // compiled account entry still contains the expected content.
  const { readFile, readdir } = await import("node:fs/promises");
  const server = new URL("../dist/server/", import.meta.url);
  const chunks = new URL("./ssr/_next/static/", server);
  const built = [
    await readFile(new URL("index.js", server), "utf8"),
    ...(await Promise.all((await readdir(chunks)).filter((name) => /^page-.*\.js$/.test(name))
      .map((name) => readFile(new URL(name, chunks), "utf8")))),
  ].join("\n");
  assert.ok(/Good finds\./i.test(built));
  assert.ok(/Happy faces\./i.test(built));
  assert.ok(/BeamingFace/.test(built));
  assert.doesNotMatch(built, /Clued by Pixel Gravity/i);
});

test("ships bilingual copy and an eight-character password rule", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  );
  assert.match(source, /const MIN_PASSWORD_LENGTH = 8;/);
  assert.match(source, /minimumPasswordLength:\s*Number\(minimumPasswordMatch\[1\]\)/);
  assert.match(source, /密码至少需要 \$\{minimumPasswordLength\} 个字符。/);
  assert.match(source, /Use at least \$\{minimumPasswordLength\} characters/);
  assert.doesNotMatch(
    source,
    /normalized\.includes\("password"\).*normalized\.includes\("at least"\)/s,
  );
  assert.match(source, /headlineOne: "好的发现，"/);
  assert.match(source, /headlineTwo: "会写在脸上。"/);
  assert.match(source, /headlineOne: "Good finds\."/);
  assert.match(source, /headlineTwo: "Happy faces\."/);
  assert.match(source, /lede: "有趣的内容，好用的应用，还有让人眼前一亮的新玩法。"/);
  assert.match(source, /byline: "Discover × Continue"/);
  assert.doesNotMatch(source, /Clued by Pixel Gravity/);
  assert.match(source, /workViewsTitle: "Current work"/);
  assert.match(source, /workViewsTitle: "当前工作"/);
  assert.doesNotMatch(source, /\/api\/memories/);
  assert.match(source, /\/v1\/records/);
  assert.doesNotMatch(source, /setError\(result\.error\.message\)/);
  assert.match(source, /projectList: "你的项目"/);
  assert.match(source, /project_schema_version: 2/);
  assert.doesNotMatch(source, /certainty_status/);
  assert.doesNotMatch(source, /\/v1\/projects\/observe/);
  assert.match(source, /base_version: project\.version/);
});
