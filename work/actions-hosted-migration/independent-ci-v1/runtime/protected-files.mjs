// Extracted from the frozen one-shot runtime. The ACL helper holds and checks
// the same ancestors and reads secrets through the checked Windows handle.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const INSTALL_ROOT = process.platform === 'win32' ? 'C:\\ProgramData\\CluedIndependentCI' : '/etc/clued-independent-ci';
export const APP_KEY_FILE = process.platform === 'win32' ? 'C:\\ProgramData\\CluedControl\\trusted\\controller-checks-app.pem' : '/etc/clued-control/trusted/controller-checks-app.pem';
const stop = code => { throw Object.assign(new Error(code), { code }); };
export const regular = async file => {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) stop('unsafe_installation_file');
  return stat;
};

// controllerSid: the node profile's controller account (Source v2: the record's acceptance `node`, design §9 C1). On
// Windows verify-install-acl.ps1 refuses a secret read without it; the Source carries no controller SID of its own.
export async function readProtected(file, { secret = false, secretRoot = null, controllerSid = null } = {}) {
  if (secret && process.platform === 'win32') {
    try {
      const { stdout } = await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./verify-install-acl.ps1', import.meta.url)),
          '-LiteralTarget', file, '-ReadFile', '-SecretRoot', secretRoot, '-ProtectedRoot', path.dirname(secretRoot), ...(controllerSid ? ['-ControllerSid', controllerSid] : [])],
        { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
      return Buffer.from(stdout.trim(), 'base64').toString('utf8');
    } catch { stop('secret_file_boundary_unconfirmed'); }
  }
  await regular(file);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) stop('unsafe_installation_file');
    if (secret && (stat.uid !== 0 || stat.mode & 0o077)) stop('secret_file_boundary_unconfirmed');
    const same = actual => actual.dev === stat.dev && actual.ino === stat.ino && actual.birthtimeMs === stat.birthtimeMs;
    if (!same(await regular(file))) stop('installation_file_replaced');
    const bytes = await handle.readFile('utf8');
    if (!same(await regular(file))) stop('installation_file_replaced');
    return bytes;
  } finally { await handle.close(); }
}

export async function readPublicJson(file) {
  try { return JSON.parse(await readProtected(file)); } catch { stop('installation_file_unreadable'); }
}

// Untrusted public exchange only. Source/config/secret reads must never call
// this function. The fixed SCM/installation launcher also holds the spool
// ancestors against replacement for the entire single service invocation.
// Per-file identity and the signature/nonce/request digest are still required.
export async function readSignedExchange(spool, filename) {
  if (!['isolation-result.json', 'admitted-result.json'].includes(filename)) stop('exchange_leaf_refused');
  const directory = path.join(spool, 'results'), file = path.join(directory, filename);
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    if ((await fsp.lstat(cursor)).isSymbolicLink()) stop('exchange_link_refused');
    if (cursor === path.dirname(cursor)) break;
  }
  const bytes = await readProtected(file);
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    if ((await fsp.lstat(cursor)).isSymbolicLink()) stop('exchange_link_refused');
    if (cursor === path.dirname(cursor)) break;
  }
  try { return JSON.parse(bytes); } catch { stop('exchange_json_invalid'); }
}

export async function assertProtectedPaths(root, files, state = false, optionalFile = null) {
  if (optionalFile !== null) {
    // 先核父目录，只有叶文件缺失才能沿用安装记录。
    await assertProtectedPaths(root, [path.dirname(optionalFile)], state);
    try { await fsp.lstat(optionalFile); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    files = [...files, optionalFile];
  }
  const checked = new Set();
  for (const file of [root, ...files]) {
    for (let cursor = file; ; cursor = path.dirname(cursor)) {
      if ((await fsp.lstat(cursor)).isSymbolicLink()) stop('installation_link_refused');
      checked.add(cursor);
      if (cursor === path.dirname(cursor)) break;
    }
  }
  if (process.platform === 'win32') {
    const script = fileURLToPath(new URL(state ? './verify-spool-acl.ps1' : './verify-install-acl.ps1', import.meta.url));
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    for (const target of [root, ...files]) {
      const boundary = target === APP_KEY_FILE ? path.dirname(path.dirname(APP_KEY_FILE)) : root;
      try {
        await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', script,
          '-LiteralTarget', target, '-ProtectedRoot', boundary, ...(state ? ['-AllowControllerWrite'] : [])],
        { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
      } catch { stop('installation_acl_unqualified'); }
    }
  } else {
    for (const target of checked) {
      const stat = await fsp.lstat(target);
      if (stat.uid !== 0 && !(state && stat.uid === process.getuid()) || stat.mode & 0o022) stop('installation_acl_unqualified');
    }
  }
  if (optionalFile !== null) return true;
}
