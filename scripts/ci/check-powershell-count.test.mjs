import test from 'node:test';
import assert from 'node:assert/strict';
import { bareCountLines } from './check-powershell-count.mjs';

test('a bare pipeline .Count is reported with its line', () => {
  assert.deepEqual(bareCountLines("$a = 1\nif (($x | Where-Object { $_ }).Count) {}"), [2]);
  assert.deepEqual(bareCountLines('(@($s + $n) | Where-Object { $l.Contains($_) }).Count'), [1]);
});

test('wrapped pipelines, plain expressions and regex matches pass', () => {
  assert.deepEqual(bareCountLines('@($x | Where-Object { $_ }).Count'), []);
  assert.deepEqual(bareCountLines('@(@($s + $n) | Where-Object { $l.Contains($_) }).Count'), []);
  assert.deepEqual(bareCountLines('($list).Count; $h.Keys.Count'), []);
  assert.deepEqual(bareCountLines("([regex]::Matches($t, 'a|b')).Count"), []);
});
