// 在源码检出中重建 v9 的 pin、差异和清单。运行时发布包不包含此工具。
// v9 只改 pin：发布门（Cron 周期等待窗、数据库客户端超时）与 currentness
// 校验脚本（--production 只核验写证据，--publish 最后写 G6 证明）的新字节，
// 以及因此变化的管理器、外部校验器两处原始校验脚本 pin 和本地 pin（Fable 1121）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const predecessor = '5cb8b217453cd2a6e65cb019d245a1277bdf075c';
const stages = 'payload/release/existing-release-entry-v1/v3/existing-stages.mjs';
const manager = 'payload/release/linux-process-manager.mjs';
const external = 'payload/release/verify-currentness-external.mjs';
const template = 'currentness-manager.template.json';
const patch = 'v8-to-v9-executable.patch';
const changed = [stages, manager, external];
const git = (...args) => execFileSync('git', args, { cwd: directory, maxBuffer: 16 * 1024 * 1024 });
const read = name => readFileSync(join(directory, name));
const write = (name, data) => writeFileSync(join(directory, name), data);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// The id git gives the file once committed as text: the tests rebuild the
// predecessors from the patch and compare these ids with CRLF read as LF.
const blob = bytes => {
  const text = Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'));
  return createHash('sha1').update(`blob ${text.length}\0`).update(text).digest('hex');
};
const entry = name => {
  const bytes = read(name);
  return { bytes: bytes.length, sha256: sha(bytes) };
};
const json = (name, data) => write(name, JSON.stringify(data, null, 2) + '\n');
const v8 = name => git('show', predecessor + ':./' + name);

function replacePin(name, pattern, value) {
  const source = read(name).toString('utf8');
  const matches = source.match(new RegExp(pattern.source, 'g')) ?? [];
  if (matches.length !== 1) throw new Error('pin 位置不唯一 ' + name + ' ' + pattern);
  write(name, source.replace(pattern, (_match, prefix) => prefix + value));
}

function generate() {
  const manifestBytes = v8('package-manifest.json');
  const freezeBytes = v8('source-freeze.json');
  const manifest = JSON.parse(manifestBytes);
  const freeze = JSON.parse(freezeBytes);
  if (manifest.revision !== 8 || freeze.packageManifestSha256 !== sha(manifestBytes)) {
    throw new Error('v8 前序清单不匹配');
  }
  // Start from the v8 bytes, so a second run gives the same result.
  for (const name of changed) {
    if (sha(v8(name)) !== manifest.files[name].sha256) throw new Error('v8 字节不符 ' + name);
    write(name, v8(name));
  }
  for (const [name, pinned] of Object.entries(manifest.files)) {
    if (!changed.includes(name) && entry(name).sha256 !== pinned.sha256) {
      throw new Error('v9 范围外的可执行文件已改变 ' + name);
    }
  }
  const verifier = sha(read('../verify-currentness-transport.mjs'));
  replacePin(manager, /(hash\(bytes\)!==')[a-f0-9]{64}/, verifier);
  replacePin(external, /(export const ORIGINAL_VERIFIER_SHA256=')[a-f0-9]{64}/, verifier);
  replacePin(stages, /('apps\/clued-cloud\/scripts\/verify-currentness-transport\.mjs':')[a-f0-9]{64}/, verifier);
  replacePin(stages, /('apps\/clued-cloud\/scripts\/production-release-gate\.mjs':')[a-f0-9]{64}/,
    sha(read('../production-release-gate.mjs')));
  replacePin(stages, /(\[EXTERNAL,')[a-f0-9]{64}/, entry(external).sha256);
  replacePin(stages, /(\[MANAGER,')[a-f0-9]{64}/, entry(manager).sha256);
  const templateText = v8(template).toString('utf8');
  if (templateText.split(manifest.files[manager].sha256).length !== 2) throw new Error('模板中的管理器 pin 不唯一');
  write(template, templateText.replace(manifest.files[manager].sha256, entry(manager).sha256));

  // git's own index line names the raw blob of the CRLF manager; name the
  // text blob instead, as every earlier patch of this package does.
  const diff = git('diff', '--no-ext-diff', '--no-color', '--full-index', '--relative', '-U1',
    predecessor, '--', ...changed).toString('utf8').replaceAll('\r', '');
  write(patch, diff.split(/^(?=diff --git )/m).map((section) => {
    const name = /^diff --git a\/(\S+) /.exec(section)?.[1];
    if (!changed.includes(name)) throw new Error('意外的差异段 ' + name);
    return section.replace(/^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m, `index ${blob(v8(name))}..${blob(read(name))}`);
  }).join(''));

  manifest.revision = 9;
  manifest.previousPackageManifestSha256 = sha(manifestBytes);
  manifest.onlyExecutableDelta = '只改 pin：发布门按 Cron 周期等待并限时连接，currentness 校验与 G6 证明写入分开（Fable 1121）';
  for (const name of changed) manifest.files[name] = entry(name);
  json('package-manifest.json', manifest);

  const manifestSha = entry('package-manifest.json').sha256;
  const offline = JSON.parse(v8('offline-source-checks.json'));
  const checker = offline.checks.offlineChecksScript;
  replacePin(checker, /(manifestHash===')[a-f0-9]{64}/, manifestSha);
  offline.revision = 9;
  offline.packageManifestSha256 = manifestSha;
  offline.checks.offlineChecksScriptSha256 = entry(checker).sha256;
  offline.checks.result = 'NOT_RUN: v9 安装后由获授权的发布身份在真实 Host 验证';
  json('offline-source-checks.json', offline);

  freeze.revision = 9;
  freeze.predecessorSourceFreezeSha256 = sha(freezeBytes);
  freeze.packageManifestSha256 = manifestSha;
  for (const name of [...Object.keys(freeze.sourceFiles), 'prepare-v9.mjs', patch].sort()) {
    freeze.sourceFiles[name] = entry(name);
  }
  json('source-freeze.json', freeze);
  console.log('v9 源码冻结 SHA-256 ' + entry('source-freeze.json').sha256);
}

if (process.argv.length === 3 && process.argv[2] === '--write') generate();
else {
  console.error('用法：node prepare-v9.mjs --write');
  process.exitCode = 2;
}
