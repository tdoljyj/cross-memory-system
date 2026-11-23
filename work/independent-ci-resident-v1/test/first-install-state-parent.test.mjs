// r13 HALT (Fable ruling 0e418483, option 戊): the first install made C:\ProgramData\CluedIndependentCI\state only as a side effect of
// migrate-acl.ps1's CreateDirectory("state\v2", ds), and Windows PowerShell 5.1 gives the intermediate folder the same DACL, so state itself
// carried (A;OICI;0x1301bf;;;clued-control): the generic helper's Validate (FormalPublicBoundaryV2.cs:270, the Parents chain of StateV2)
// refused it with UNTRUSTED_PUBLIC_MUTATION_RIGHT_REFUSED before ready, and the first role probe HALTed. The fix: install-resident.ps1's
// rule state-parent-acl owns state's DACL (step before source-v2-acl; verify-resident.ps1 runs the same rule as SYSTEM in an upgrade).
// End to end on an offline fixture under TEMP, real files only (the shared fixture, first-install-fixture.mjs): the host
// preparation's ci-root step, the broker folders, the installer's own state-parent-acl rule, the real migrate-acl.ps1 -Apply, the
// installer's Set-CompanionSpoolAcl written to disk, then the real FormalPublicBoundaryV2.cs compiled (the generic helper's file list of
// test-pure-v2.ps1:13) and its own DangerFor and WriterAllowed run on every "allow, not inherit-only" ACE of each of the six targets of
// :270 and every folder of its chain inside the CI root (the test account's own fixture entries aside; owner BA and the two folders above
// the CI root cannot be made by a test). Windows PowerShell 5.1, not elevated; nothing of the machine is changed.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { COMPANION, CONTROLLER, INSTALL, MIGRATE, OPERATOR, POWERSHELL, PRELUDE as BASE, RESIDENT, SIX_CHAINS, STRANGER, ciRoot, formalBoundary, load, ps, psLiteral, skip, tempDir } from './first-install-fixture.mjs';

const STATE = 'C:\\ProgramData\\CluedIndependentCI\\state';
// the shared prelude (first-install-fixture.mjs: $webExt, $me, Set-Dacl, Dacl, Restore-Mine) and:
// state's DACL as the fixture reads it: the fixture account's own entries taken out by SID (Windows writes the built-in Administrator as
// LA, not as its SID), the rest compared by the installer's own Get-DaclShape (the order of the entries is not what the DACL grants, and
// DirectorySecurity sorts them by SID when it writes the fixture's entry).
const PRELUDE = `${BASE}function Get-FixtureFreeState([string]$sddl, [string]$sid, [string]$terminal) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  for ($i = $raw.DiscretionaryAcl.Count - 1; $i -ge 0; $i--) { if ($raw.DiscretionaryAcl[$i].SecurityIdentifier.Value -ceq $sid) { $raw.DiscretionaryAcl.RemoveAce($i) } }
  $dacl = $raw.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
  [ordered]@{ dacl = $dacl; terminal = ((Get-DaclShape $dacl) -ceq (Get-DaclShape $terminal)) }
}
`;
// The installer's state-parent-acl rule, by exact name (the functions verify-resident.ps1 loads too).
const STATE_RULE = ['Get-DaclShape', 'Get-StateParentSddl', 'Get-StateParentTarget', 'Get-StateParentState', 'Invoke-StateParentAcl'];

// The shared fixture (first-install-fixture.mjs: the host's ci-root step), the broker folders, migrate-acl.ps1 -OfflineFixtureRoot,
// then the step order of install-resident.ps1: [state-parent-acl] -> source-v2-acl -> companion-account's Set-CompanionSpoolAcl.
const firstInstall = (root, { stateStep }) => `${PRELUDE}
${ciRoot(root)}
${load(INSTALL, ['Get-CompanionSpoolSddl', 'Set-CompanionSpoolAcl', ...(stateStep ? STATE_RULE : [])])}
$bds = New-Object Security.AccessControl.DirectorySecurity; $bds.SetSecurityDescriptorSddlForm('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $me + ')')
foreach ($d in @('resident', 'resident\\broker', 'resident\\broker\\requests', 'resident\\broker\\responses')) { [void][IO.Directory]::CreateDirectory((Join-Path $fx $d), $bds) }
$stateDir = Join-Path $fx 'state'
$stateStep = $null
${stateStep ? `# step state-parent-acl, as install-resident.ps1 runs it (the owner BA left out: a test account cannot set it)
$sp = Get-StateParentState $stateDir ${psLiteral(CONTROLLER)}
$sp.sddl = $sp.sddl -replace '^O:BAG:BA', ''
$stateStep = Invoke-StateParentAcl $sp ${psLiteral(CONTROLLER)}
# the fixture's own entry so that migrate-acl (this account, offline) can make state\\v2 under it; the chain check below sets it aside
Set-Dacl $stateDir ((Dacl $stateDir) + '(A;;FA;;;' + $me + ')')` : ''}
$a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${psLiteral(MIGRATE)}, '-ResidentSid', ${psLiteral(RESIDENT)}, '-OwnerSid', ${psLiteral(OPERATOR)}, '-ControllerSid', ${psLiteral(CONTROLLER)}, '-OfflineFixtureRoot', $fx, '-Apply')
$migrate = (& ${psLiteral(POWERSHELL)} @a | Out-String).Trim().Split([char]10)[-1] | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw ('MIGRATE_FAILED:' + $migrate.code) }
foreach ($leaf in @('incoming', 'outgoing')) { Set-CompanionSpoolAcl (Join-Path $fx ('formal-spool\\' + $leaf)) ${psLiteral(OPERATOR)} ${psLiteral(COMPANION)} }
# The generic helper's own rule on the six chains (first-install-fixture.mjs formalBoundary).
${formalBoundary}$stateDacl = $(if ($stateStep) { Get-FixtureFreeState (Dacl $stateDir) $me ${psLiteral(TERMINAL_DACL)} } else { $null })
Restore-Mine @($fx, $stateDir)
ConvertTo-Json -Depth 6 -Compress -InputObject ([ordered]@{ migrate = $migrate.status; checked = $checked; refused = $refused; stateStep = $stateStep; stateDacl = $stateDacl })`;

// as Windows reads it back (AI set; Get-DaclShape compares without it)
const TERMINAL_DACL = `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;0x1301bf;;;${CONTROLLER})(A;;0x1200a9;;;${CONTROLLER})`;

// Without state-parent-acl (the install as it was until r13): the helper's rule refuses exactly one ACE on the whole chain, the
// controller's write on state itself, made by migrate-acl's CreateDirectory. This also shows the check below can see a refusal.
test('r13 cause: without state-parent-acl, the helper\'s rule refuses state itself, and nothing else on the six chains', { skip, timeout: 600_000 }, (t) => {
  const r = ps(firstInstall(path.join(tempDir(t, 'r13-cause-'), 'ci'), { stateStep: false }));
  assert.equal(r.migrate, 'SOURCE_V2_ACL_MIGRATED');
  assert.deepEqual([...r.checked].sort(), SIX_CHAINS);
  assert.deepEqual(r.refused, [{ path: STATE, sid: CONTROLLER, mask: '0x1301bf', inherited: false }], JSON.stringify(r.refused));
});

// With it: state is made by the rule with the production DACL (DESIGN.md section 8, the TURING fix of 2026-10-21), migrate-acl only adds
// state\v2 under it, and the whole chain of all six targets passes the helper's rule.
test('r13 fix: the first install\'s state-parent-acl makes state, and the helper\'s rule passes every folder of the six chains', { skip, timeout: 600_000 }, (t) => {
  const r = ps(firstInstall(path.join(tempDir(t, 'r13-fix-'), 'ci'), { stateStep: true }));
  assert.equal(r.migrate, 'SOURCE_V2_ACL_MIGRATED');
  assert.deepEqual([...r.checked].sort(), SIX_CHAINS);
  assert.deepEqual(r.refused, [], JSON.stringify(r.refused));
  assert.equal(r.stateStep.action, 'create'); assert.equal(r.stateStep.wrote, true); assert.equal(r.stateStep.before, null);
  assert.equal(r.stateDacl.terminal, true, `state carries the production DACL after migrate-acl: ${r.stateDacl.dacl}`);
});

// The installer runs the rule as its own step, before source-v2-acl, with the plan's path and the receipt's record.
test('install-resident.ps1: step state-parent-acl runs the rule on <CiRoot>\\state before source-v2-acl and records it', { skip, timeout: 120_000 }, () => {
  const r = ps(`${PRELUDE}
$tokens = $null; $errors = $null; $ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(INSTALL)}, [ref]$tokens, [ref]$errors)
$steps = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Step' -and $n.CommandElements.Count -eq 3 }, $true) | ForEach-Object { $_.CommandElements[1].Extent.Text.Trim("'") })
$body = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Step' -and $n.CommandElements.Count -eq 3 -and $n.CommandElements[1].Extent.Text -ceq "'state-parent-acl'" }, $true))
$plan = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Build-Plan' }, $true))[0].Extent.Text
ConvertTo-Json -Compress -InputObject ([ordered]@{ steps = $steps; body = @($body | ForEach-Object { $_.CommandElements[2].Extent.Text }); plan = $plan.Contains(${psLiteral("stateParent = [ordered]@{ path = (Join-Path $CiRoot 'state'); sddl = (Get-StateParentSddl $ControllerSid)")}) })`);
  const at = name => r.steps.indexOf(name);
  assert.ok(at('state-parent-acl') > at('directories') && at('state-parent-acl') < at('source-v2-acl'), JSON.stringify(r.steps));
  assert.equal(r.body.length, 1);
  assert.match(r.body[0], /\$sp = Get-StateParentState \$plan\.stateParent\.path \$ControllerSid\s+\$script:receipt\.stateParentAcl = Invoke-StateParentAcl \$sp \$ControllerSid/);
  assert.equal(r.plan, true, 'the plan names the path and the DACL the rule makes');
});

// The rule's cases on real NTFS (folders this account owns, so it may set any DACL on them).
const rule = (root, body) => ps(`${PRELUDE}
${load(INSTALL, STATE_RULE)}
$root = ${psLiteral(root)}; [void][IO.Directory]::CreateDirectory($root)
$C = ${psLiteral(CONTROLLER)}
$made = New-Object 'Collections.Generic.List[string]'
function New-State([string]$name, [string]$dacl) {
  $s = Join-Path $root $name; [void][IO.Directory]::CreateDirectory($s); $made.Add($s)
  # v1's own subfolder that inherits from state, and Source v2's protected one (as migrate-acl makes it)
  $e = Join-Path $s 'effects'; [void][IO.Directory]::CreateDirectory($e); $made.Add($e); Set-Dacl $e 'D:AI'
  $v = Join-Path $s 'v2'; [void][IO.Directory]::CreateDirectory($v); $made.Add($v); Set-Dacl $v ('D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $C + ')(A;OICI;FA;;;' + $me + ')')
  Set-Dacl $s $dacl; $s
}
function Try-Rule([string]$s) { try { $p = Get-StateParentState $s $C; $p.sddl = $p.sddl -replace '^O:BAG:BA', ''; Invoke-StateParentAcl $p $C } catch { $_.Exception.Message } }
$out = [ordered]@{}
${body}
Restore-Mine @($made)
ConvertTo-Json -Depth 6 -Compress -InputObject $out`);

test('rule: a wide state (the controller writes on state itself) converges to inherit-only plus a read entry; its children keep what they inherit', { skip, timeout: 300_000 }, (t) => {
  const r = rule(path.join(tempDir(t, 'r13-wide-'), 'r'), `
$s = New-State 'wide' ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $C + ')')
$child = @((Dacl (Join-Path $s 'effects')), (Dacl (Join-Path $s 'v2')))
$out.first = Try-Rule $s; $out.after = Dacl $s
$out.childKept = ((Dacl (Join-Path $s 'effects')) -ceq $child[0]) -and ((Dacl (Join-Path $s 'v2')) -ceq $child[1])
$out.second = Try-Rule $s; $out.afterSecond = Dacl $s
$out.shape = (Get-DaclShape $out.after) -ceq (Get-DaclShape (Get-StateParentSddl $C))`);
  assert.equal(r.first.action, 'converge'); assert.equal(r.first.wrote, true);
  assert.equal(r.shape, true, `${r.after}: exactly the production DACL`);
  assert.equal(r.childKept, true, 'the inheritable entries are unchanged, so every child inherits what it did');
  assert.equal(r.second.action, 'none'); assert.equal(r.second.wrote, false); assert.equal(r.afterSecond, r.after);
});

test('rule: a state that already passes is not written; a missing one is made with the production DACL', { skip, timeout: 300_000 }, (t) => {
  const r = rule(path.join(tempDir(t, 'r13-same-'), 'r'), `
$s = New-State 'terminal' (((Get-StateParentSddl $C) -replace '^O:BAG:BA', '') -replace '^D:P', 'D:PAI')
$before = Dacl $s; $out.terminal = Try-Rule $s; $out.terminalSame = (Dacl $s) -ceq $before
# the production DACL with one more read-only entry of another account (the helper's rule lets it through): kept as it is
$s2 = New-State 'reader' ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;0x1301bf;;;' + $C + ')(A;;0x1200a9;;;' + $C + ')(A;OICI;0x1200a9;;;${STRANGER})')
$before2 = Dacl $s2; $out.reader = Try-Rule $s2; $out.readerSame = (Dacl $s2) -ceq $before2
$m = Join-Path $root 'missing'; $made.Add($m); $out.missing = Try-Rule $m
$out.missingShape = (Get-DaclShape (Dacl $m)) -ceq (Get-DaclShape (Get-StateParentSddl $C))`);
  assert.equal(r.terminal.action, 'none'); assert.equal(r.terminal.wrote, false); assert.equal(r.terminalSame, true);
  assert.equal(r.reader.action, 'none'); assert.equal(r.reader.wrote, false); assert.equal(r.readerSame, true);
  assert.equal(r.missing.action, 'create'); assert.equal(r.missing.wrote, true); assert.equal(r.missingShape, true);
});

test('rule: another account that can write, a controller write it does not own, a link or a change since the plan: refused, nothing written', { skip, timeout: 300_000 }, (t) => {
  const r = rule(path.join(tempDir(t, 'r13-refuse-'), 'r'), `
$cases = [ordered]@{
  stranger = ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $C + ')(A;;0x1301bf;;;${STRANGER})')
  strangerDelete = ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;0x1301bf;;;' + $C + ')(A;;0x1200a9;;;' + $C + ')(A;;0x10000;;;${STRANGER})')
  everyone = ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;WD)')
  nullDacl = 'D:NO_ACCESS_CONTROL'
}
foreach ($k in @($cases.Keys)) { $s = New-State $k $cases[$k]; $before = Dacl $s; $out[$k] = [ordered]@{ result = (Try-Rule $s); same = ((Dacl $s) -ceq $before) } }
$target = New-State 'target' ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $C + ')')
$link = Join-Path $root 'link'; New-Item -ItemType Junction -Path $link -Value $target | Out-Null
$before = Dacl $target; $out.link = [ordered]@{ result = (Try-Rule $link); same = ((Dacl $target) -ceq $before) }
[IO.Directory]::Delete($link)
$s = New-State 'changed' ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $C + ')')
$p = Get-StateParentState $s $C; Set-Dacl $s ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $C + ')'); $before = Dacl $s
$out.changed = [ordered]@{ result = $(try { Invoke-StateParentAcl $p $C } catch { $_.Exception.Message }); same = ((Dacl $s) -ceq $before) }`);
  for (const k of ['stranger', 'strangerDelete', 'everyone', 'nullDacl', 'link', 'changed']) {
    assert.equal(typeof r[k].result, 'string', `${k}: ${JSON.stringify(r[k])}`);
    assert.equal(r[k].same, true, `${k}: nothing written`);
  }
  for (const k of ['stranger', 'strangerDelete', 'everyone', 'nullDacl', 'link']) assert.match(r[k].result, /^STATE_PARENT_ACL_REFUSED:/, k);
  assert.match(r.stranger.result, new RegExp(`OTHER_WRITER:${STRANGER}`));
  assert.equal(r.changed.result, 'STATE_PARENT_ACL_CHANGED_SINCE_PLAN');
});

// The hosted Windows runner (run 45055934390, job 137311039345) runs as the built-in Administrator (RID 500 of the machine's domain), which
// Windows writes as the alias LA, not as its SID; and DirectorySecurity (the fixture's Set-Dacl) sorts explicit allow entries by SID once
// one sorts before the controller's, swapping the controller's two entries. Both are the fixture's own doing, not the rule's: here on
// real NTFS, the rule makes state, the fixture appends its entry for such an account, and the read must still find the production DACL.
test('fixture read: the fixture account as the built-in Administrator (alias LA) or sorting before the controller still reads as the production DACL', { skip, timeout: 300_000 }, (t) => {
  const r = rule(path.join(tempDir(t, 'r13-hosted-'), 'r'), `
$la = $me.Substring(0, $me.LastIndexOf('-')) + '-500'
$s = Join-Path $root 'state'; $made.Add($s); $p = Get-StateParentState $s $C; $p.sddl = $p.sddl -replace '^O:BAG:BA', ''; [void](Invoke-StateParentAcl $p $C)
$base = Dacl $s
foreach ($x in @($la, 'S-1-5-21-1-2-3-500')) { Set-Dacl $s ($base + '(A;;FA;;;' + $x + ')'); $out[$x] = Get-FixtureFreeState (Dacl $s) $x ${psLiteral(TERMINAL_DACL)} }
# the exact DACL the hosted runner read back (its LA is this machine's LA here)
$out.hostedLog = Get-FixtureFreeState ${psLiteral(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FA;;;LA)(A;;0x1200a9;;;${CONTROLLER})(A;OICIIO;0x1301bf;;;${CONTROLLER})`)} $la ${psLiteral(TERMINAL_DACL)}`);
  for (const [k, v] of Object.entries(r)) assert.equal(v.terminal, true, `${k}: ${v.dacl}`);
  assert.equal(Object.keys(r).length, 3);
});
