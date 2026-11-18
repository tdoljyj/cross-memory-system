// 在源码检出中重建 v8 的发布门 pin、差异和清单。运行时发布包不包含此工具。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const predecessor = '82f86da3deef41063c5668a30df5c34d77bd010d';
const stages = 'payload/release/existing-release-entry-v1/v3/existing-stages.mjs';
const release = 'payload/release/existing-release-entry-v1/v3-host/release-once.mjs';
const patch = 'v7-to-v8-executable.patch';
const git = (...args) => execFileSync('git', args, { cwd: directory });
const read = name => readFileSync(join(directory, name));
const write = (name, data) => writeFileSync(join(directory, name), data);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const entry = name => {
  const bytes = read(name);
  return { bytes: bytes.length, sha256: sha(bytes) };
};
const json = (name, data) => write(name, JSON.stringify(data, null, 2) + '\n');
const v7 = name => git('show', predecessor + ':./' + name);

function replacePin(name, pattern, value) {
  const source = read(name).toString('utf8');
  if (!pattern.test(source)) throw new Error('找不到 pin 所在位置 ' + name);
  write(name, source.replace(pattern, (_match, prefix) => prefix + value));
}

function generate() {
  const manifestBytes = v7('package-manifest.json');
  const freezeBytes = v7('source-freeze.json');
  const manifest = JSON.parse(manifestBytes);
  const freeze = JSON.parse(freezeBytes);
  if (manifest.revision !== 7 || freeze.packageManifestSha256 !== sha(manifestBytes)) {
    throw new Error('v7 前序清单不匹配');
  }
  for (const [name, pinned] of Object.entries(manifest.files)) {
    if (name !== stages && name !== release && entry(name).sha256 !== pinned.sha256) {
      throw new Error('v8 范围外的可执行文件已改变 ' + name);
    }
  }
  replacePin(stages, /('apps\/clued-cloud\/scripts\/production-release-gate\.mjs':')[a-f0-9]{64}/,
    sha(read('../production-release-gate.mjs')));
  write(patch, git('diff', '--no-ext-diff', '--no-color', '--full-index', '--relative', '-U1',
    predecessor, '--', stages, release));
  manifest.revision = 8;
  manifest.previousPackageManifestSha256 = sha(manifestBytes);
  manifest.onlyExecutableDelta = '固定状态制发布门，保留部署前凭据，部署后按投影状态验收';
  for (const name of [stages, release]) manifest.files[name] = entry(name);
  json('package-manifest.json', manifest);

  const manifestSha = entry('package-manifest.json').sha256;
  const offline = JSON.parse(v7('offline-source-checks.json'));
  const checker = offline.checks.offlineChecksScript;
  replacePin(checker, /(manifestHash===')[a-f0-9]{64}/, manifestSha);
  offline.revision = 8;
  offline.packageManifestSha256 = manifestSha;
  offline.checks.offlineChecksScriptSha256 = entry(checker).sha256;
  offline.checks.result = 'NOT_RUN: v8 安装后由获授权的发布身份在真实 Host 验证';
  json('offline-source-checks.json', offline);

  freeze.revision = 8;
  freeze.predecessorSourceFreezeSha256 = sha(freezeBytes);
  freeze.packageManifestSha256 = manifestSha;
  for (const name of [...Object.keys(freeze.sourceFiles), 'prepare-v8.mjs', patch].sort()) {
    freeze.sourceFiles[name] = entry(name);
  }
  json('source-freeze.json', freeze);
  console.log('v8 源码冻结 SHA-256 ' + entry('source-freeze.json').sha256);
}

if (process.argv.length === 3 && process.argv[2] === '--write') generate();
else {
  console.error('用法：node prepare-v8.mjs --write');
  process.exitCode = 2;
}
