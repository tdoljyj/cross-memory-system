// verify-resident.ps1's verdict (Task 018da927 b). With `$_.ok -eq 'unreadable'` a passing check ($true on the left turns the
// string into $true) counted as unreadable, so every failure was reported as RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED. The
// behaviour is run by windows/test-resident-windows.ps1 (section 4g); this holds the text on every OS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('verify-resident.ps1 asks for an elevated run only for the string unreadable', async () => {
  const text = await fs.readFile(new URL('../windows/verify-resident.ps1', import.meta.url), 'utf8');
  assert.ok(text.includes("Where-Object { $_.ok -is [string] -and $_.ok -ceq 'unreadable' }"));
  assert.ok(!/\$_\.ok -eq 'unreadable'/.test(text));
  assert.ok(text.includes('$verdict = Get-VerifyVerdict $checks') && text.includes('exit $verdict.exit'));
  const harness = await fs.readFile(new URL('../windows/test-resident-windows.ps1', import.meta.url), 'utf8');
  assert.ok(harness.includes("'RESIDENT_VERIFICATION_FAILED', 1, 'a-failure-is-not-run-elevated'"));
});
