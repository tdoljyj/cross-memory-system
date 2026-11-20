// E1 of the first-install r4 design (D:/w/tmp/FABLE-first-install-r4-20261120.md section 1): the package's PowerShell scripts are ASCII.
// Windows PowerShell 5.1 reads a script with a BOM as UTF-8 and one without as the system ANSI code page, and the launcher parses the
// package's verify-resident.ps1 from bytes as a third reader; only pure ASCII means the same to all three. The one door is selectTree
// (rollout/fleet/universal.mjs): it refuses a .ps1/.psm1/.psd1 with any other byte, except the two-byte section sign (a frozen text
// carries it). The launcher's reader (Read-VerifySecretHelpers, shared by every Test-SecretsAsVerify call site) is run on the package's
// own verify-resident.ps1 bytes in Windows PowerShell 5.1, with the real function out of the real template.ps1.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as U from '../rollout/fleet/universal.mjs';
import { CLOSURE, RESIDENT } from '../rollout/fleet/facts.mjs';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKOUT = path.resolve(RES, '..', '..');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const windows = process.platform === 'win32';

const closure = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.source-closure/2', paths: [] }));
const base = () => new Map(U.TREE_FILES.map(p => [p, { mode: '100644', oid: null }]));
function fixture(extra) {   // extra: path -> Buffer (a file the package would select)
  const listing = base();
  for (const p of Object.keys(extra)) listing.set(p, { mode: '100644', oid: null });
  const read = async paths => new Map(paths.map(p => [p, p === CLOSURE ? closure : (extra[p] ?? Buffer.alloc(0))]));
  return { listing, read };
}
const PS = `${RESIDENT}/windows/probe.ps1`;
const refused = (p, offset) => e => e.code === 'UNIVERSAL_TREE_PS1_NOT_ASCII' && e.detail?.path === p && e.detail?.offset === offset;

test('E1: the one allowance is the two bytes C2 A7, a constant', () => {
  assert.ok(U.PS1_ALLOWED_MULTIBYTE, 'universal.mjs exports PS1_ALLOWED_MULTIBYTE');
  assert.ok(Object.isFrozen(U.PS1_ALLOWED_MULTIBYTE));
  assert.deepEqual([...U.PS1_ALLOWED_MULTIBYTE], ['c2a7']);
});

test('E1: a script with a BOM is refused, at offset 0', async () => {
  const { listing, read } = fixture({ [PS]: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# ok\n')]) });
  await assert.rejects(U.selectTree(listing, read), refused(PS, 0));
});

test('E1: Chinese text, an ellipsis and stray high bytes are refused, with the offset of the first bad byte', async () => {
  const cases = [
    [Buffer.from('# \u91cd\u65b0\u542f\u52a8\n', 'utf8'), 2],
    [Buffer.from('# a \u2026 b\n', 'utf8'), 4],
    [Buffer.from('ab\xc2cd', 'latin1'), 2],            // C2 not followed by A7
    [Buffer.from('ab\xa7cd', 'latin1'), 2],            // A7 on its own
    [Buffer.concat([Buffer.from('x\u00a7y\u00a7', 'utf8'), Buffer.from([0xc2])]), 6],   // a lone C2 at the end, after two good pairs
    [Buffer.from('a\x00b'), 1], [Buffer.from('a\x1bb'), 1], [Buffer.from('a\x7fb'), 1],   // controls other than tab, LF, CR
  ];
  for (const [bytes, offset] of cases) {
    const { listing, read } = fixture({ [PS]: bytes });
    await assert.rejects(U.selectTree(listing, read), refused(PS, offset), JSON.stringify([...bytes]));
  }
});

test('E1: .psm1, .psd1 and an upper-case .PS1 are scripts too', async () => {
  for (const name of ['m.psm1', 'd.psd1', 'U.PS1']) {
    const p = `${RESIDENT}/windows/${name}`;
    const { listing, read } = fixture({ [p]: Buffer.from('# \u4e2d\n', 'utf8') });
    await assert.rejects(U.selectTree(listing, read), refused(p, 2), name);
  }
});

test('E1: the section sign alone passes, and so do tab, LF, CR and printable ASCII', async () => {
  const all = Buffer.from([...Array(0x5f).keys()].map(i => i + 0x20));
  const { listing, read } = fixture({ [PS]: Buffer.concat([Buffer.from('# \u00a7 5.2 \u00a7\r\n\t', 'utf8'), all, Buffer.from('\n')]) });
  const selected = await U.selectTree(listing, read);
  assert.ok(selected.includes(PS));
});

test('E1: only the package is checked: files of other kinds, and scripts outside the selection, may hold any text', async () => {
  const md = `${RESIDENT}/src/notes.md`, js = `${RESIDENT}/src/note.mjs`, outside = `${RESIDENT}/test/not-packaged.ps1`;
  const text = Buffer.from('# \u4e2d\u6587\n', 'utf8');
  const { listing, read } = fixture({ [md]: text, [js]: Buffer.from('// \u4e2d\u6587\n', 'utf8'), [outside]: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), text]) });
  const selected = await U.selectTree(listing, read);
  assert.ok(selected.includes(md) && selected.includes(js) && !selected.includes(outside));
});

test('E1: of several bad scripts the first in byte order is named', async () => {
  const a = `${RESIDENT}/windows/a-first.ps1`, z = `${RESIDENT}/windows/z-last.ps1`;
  const { listing, read } = fixture({ [z]: Buffer.from('\u4e2d'), [a]: Buffer.from('xy\u4e2d') });
  await assert.rejects(U.selectTree(listing, read), refused(a, 2));
});

// The real tree: the scripts the package really carries, through the real selectTree, from the repository's own files.
function realTree() {
  const out = spawnSync('git', ['-C', CHECKOUT, 'ls-files', '-s', '-z'], { maxBuffer: 1 << 28 });
  assert.equal(out.status, 0, String(out.stderr));
  const listing = new Map();
  for (const rec of out.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t'); const [mode, oid] = rec.slice(0, tab).split(' ');
    listing.set(rec.slice(tab + 1), { mode, oid });
  }
  const read = async paths => new Map(await Promise.all(paths.map(async p => [p, await fs.promises.readFile(path.join(CHECKOUT, ...p.split('/')))])));
  return { listing, read };
}

test('E1: the real tree passes selectTree, and its scripts hold no byte outside ASCII but the section sign', async () => {
  const { listing, read } = realTree();
  const selected = await U.selectTree(listing, read);
  const scripts = selected.filter(p => /\.(?:ps1|psm1|psd1)$/i.test(p));
  assert.ok(scripts.includes(`${RESIDENT}/windows/verify-resident.ps1`) && scripts.length > 10, `${scripts.length} scripts`);
  for (const [p, b] of await read(scripts)) {
    assert.ok(!b.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${p} has a BOM`);
    assert.ok(!/[\x80-\xff]/.test(b.toString('latin1').replaceAll('\xc2\xa7', '')), `${p} holds a high byte other than the section sign`);
  }
});

// The target scene: the launcher's reader on the package's own bytes of verify-resident.ps1, in Windows PowerShell 5.1.
const DRIVER = `param($Template, $Stage)
$ErrorActionPreference = 'Stop'
$U8 = New-Object Text.UTF8Encoding($false)
$tk = $null; $er = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($U8.GetString([IO.File]::ReadAllBytes($Template)), [ref]$tk, [ref]$er)
if ($er.Count) { throw 'TEMPLATE_PARSE_ERRORS' }
$fn = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Read-VerifySecretHelpers' }, $true))
if ($fn.Count -ne 1) { throw 'READER_NOT_IN_TEMPLATE' }
. ([scriptblock]::Create($fn[0].Extent.Text))
$codes = @(); $count = -1
try { $count = @(Read-VerifySecretHelpers).Count } catch { $codes += ('SECRET_CHECK_FAILED:' + $_.Exception.Message) }
[ordered]@{ codes = $codes; count = $count } | ConvertTo-Json -Compress
`;

test('E1 target: the real launcher reader takes verify-resident.ps1\'s helpers (4 functions, 2 assignments) from the package\'s bytes in PowerShell 5.1',
  { skip: windows ? false : 'Windows PowerShell 5.1 only' }, async t => {
    const { listing, read } = realTree();
    const verify = `${RESIDENT}/windows/verify-resident.ps1`;
    assert.ok((await U.selectTree(listing, read)).includes(verify));
    const bytes = (await read([verify])).get(verify);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1ascii-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stage = path.join(dir, 'stage'); fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'verify-resident.ps1'), bytes);
    fs.writeFileSync(path.join(dir, 'driver.ps1'), DRIVER);
    const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'driver.ps1'),
      path.join(RES, 'reinstall', 'launcher', 'template.ps1'), stage], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)), { codes: [], count: 6 });
  });

test('E1 target: every Test-SecretsAsVerify call site goes through the one reader', () => {
  const tpl = fs.readFileSync(path.join(RES, 'reinstall', 'launcher', 'template.ps1'), 'utf8');
  const body = tpl.slice(tpl.indexOf('function Test-SecretsAsVerify'), tpl.indexOf('function Test-CurrentRootCarryShape'));
  assert.match(body, /Read-VerifySecretHelpers/);
  assert.ok(!/ParseInput/.test(body), 'Test-SecretsAsVerify no longer parses verify itself');
  assert.equal([...tpl.matchAll(/Test-SecretsAsVerify;/g)].length, 3);
  assert.ok(fs.readFileSync(path.join(RES, 'reinstall', 'launcher', 'finish-uninstall.ps1'), 'utf8').includes('Test-SecretsAsVerify'));
});

// DESK addition (r4 audit, "same kind of gap"): the other two places that read a packaged script's bytes, parse them and take
// functions out. Their real extraction code (the lines of template.ps1 New-FleetRegistrar and of export-role-image.ps1 between the
// parse and the dot-source) is cut out of the real files and run on the package's own companion-headless.ps1 bytes. They are
// inline code, not functions, so the lines themselves are the unit; a negative control (the same bytes behind a BOM) must fail them.
const SEGMENT_DRIVER = `param($Source, $Headless, $StartPattern)
$ErrorActionPreference = 'Stop'
$U8 = New-Object Text.UTF8Encoding($false)
$lines = @($U8.GetString([IO.File]::ReadAllBytes($Source)) -split "\`n")
$from = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match $StartPattern })
if ($from.Count -ne 1) { throw ('SEGMENT_START_NOT_FOUND:' + $from.Count) }
$to = @($from[0]..($lines.Count - 1) | Where-Object { $lines[$_].Contains('foreach ($n in @($asg) + @($defs)) { . ([scriptblock]::Create') })[0]
$segment = ($lines[$from[0]..$to] -join "\`n")
$files = @{ 'companion-headless.ps1' = $Headless }
$tk = $null; $er = $null; $codes = @()
try { . ([scriptblock]::Create($segment)) } catch { $codes += $_.Exception.Message }
[ordered]@{ codes = $codes; sha256Helper = [bool](Get-Command Get-CompanionSha256 -ErrorAction SilentlyContinue); lines = ($to - $from[0] + 1) } | ConvertTo-Json -Compress
`;
const SEGMENTS = [['reinstall/launcher/template.ps1 (New-FleetRegistrar)', ['reinstall', 'launcher', 'template.ps1'], '^[ ]*[$]tk = [$]null; [$]er = [$]null; [$]ast = .*companion-headless[.]ps1', true],
  ['reinstall/tools/export-role-image.ps1', ['reinstall', 'tools', 'export-role-image.ps1'], '^[ ]*[$]hast = .*companion-headless[.]ps1', false]];   // the export tool checks no parse error: behind a BOM it still finds the functions (the parser recovers)
for (const [label, parts, start, refusesBom] of SEGMENTS) {
  test(`E1 audit: ${label} takes the 5 build functions and 4 variables out of the package's companion-headless.ps1 (a BOM is refused where parse errors are checked)`,
    { skip: windows ? false : 'Windows PowerShell 5.1 only' }, async t => {
      const { listing, read } = realTree();
      const headless = `${RESIDENT}/windows/companion-headless.ps1`;
      assert.ok((await U.selectTree(listing, read)).includes(headless));
      const bytes = (await read([headless])).get(headless);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1ascii-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      fs.writeFileSync(path.join(dir, 'driver.ps1'), SEGMENT_DRIVER);
      const run = (name, data) => {
        const file = path.join(dir, name); fs.writeFileSync(file, data);
        const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'driver.ps1'),
          path.join(RES, ...parts), file, start], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
        assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
        return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
      };
      const good = run('good.ps1', bytes);
      assert.deepEqual([good.codes, good.sha256Helper], [[], true]);
      assert.ok(good.lines >= 6 && good.lines <= 12, `${good.lines} lines taken`);
      const bom = run('bom.ps1', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
      if (refusesBom) assert.equal(bom.codes.length, 1, 'behind a BOM the same lines refuse');
    });
}
