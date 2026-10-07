import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LEDGER_CONTRACT, TRANSFORMS, applyTransform, buildLedger, compareLedgerWithHistory,
  historyOnlyDirectory, historyRowMd5, ledgerPath, matchTransform, md5, migrationsDirectory,
  readLedger, readSqlDirectory, verifyLedger,
} from '../scripts/migration-ledger.mjs';

const appDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(appDirectory, 'scripts', 'migration-ledger.mjs');

function fixture() {
  const migrations = {
    '20260101000000_alpha.sql': 'select 1;\n',
    '20260102000000_beta.sql': 'select 2;\n-- two lines\n',
    '20260103000000_gamma.sql': 'select 3;\n',
    '20260105000000_delta.sql': 'select 5;\n',
  };
  const historyOnly = { '20260104000000_epsilon.sql': 'select 4;\n' };
  const ledger = {
    contract: LEDGER_CONTRACT,
    rows: [
      { version: '20260101000000', name: 'alpha', statements_md5: md5('select 1;\n'),
        source: 'migrations/20260101000000_alpha.sql', transform: 'identical' },
      { version: '20260102120000', name: 'beta', statements_md5: md5('select 2;\r\n-- two lines\r\n'),
        source: 'migrations/20260102000000_beta.sql', transform: 'crlf' },
      { version: '20260104000000', name: 'epsilon', statements_md5: md5('select 4;\n'),
        source: 'history-only/20260104000000_epsilon.sql', transform: 'identical' },
      { version: '20260106000000', name: 'delta', statements_md5: md5('select 5;\n'),
        source: 'history-only/20260106000000_delta.sql', transform: 'identical' },
    ],
    repository_only: [
      { file: 'migrations/20260103000000_gamma.sql', status: 'never_applied', reason: 'never applied' },
      { file: 'migrations/20260105000000_delta.sql', status: 'diverged_from_production',
        reason: 'production holds another text' },
    ],
    known_deviations: [{ kind: 'schema', name: 'x_test', note: 'kept' }],
  };
  historyOnly['20260106000000_delta.sql'] = 'select 5;\n';
  return { migrations, historyOnly, ledger };
}

test('transforms reproduce every recorded production text shape and are recognized back', () => {
  const text = 'a\nb\n';
  assert.deepEqual(TRANSFORMS.map((transform) => applyTransform(text, transform)),
    ['a\nb\n', 'a\nb\n\r\n', 'a\nb', 'a\r\nb\r\n', 'a\r\r\nb\r\r\n']);
  assert.equal(applyTransform('a\r\nb', 'crlf'), 'a\r\nb');
  assert.equal(applyTransform('a', 'strip_final_newline'), 'a');
  for (const transform of TRANSFORMS) {
    assert.equal(matchTransform(text, md5(applyTransform(text, transform))), transform);
  }
  assert.equal(matchTransform(text, md5('other')), null);
  assert.throws(() => applyTransform(text, 'lf'), /unknown_transform:lf/);
});

test('a history row hashes its statements joined by newline, or carries its md5', () => {
  assert.equal(historyRowMd5({ statements: ['select 1;', 'select 2;'] }), md5('select 1;\nselect 2;'));
  assert.equal(historyRowMd5({ statements_md5: 'ab'.repeat(16) }), 'ab'.repeat(16));
  assert.equal(historyRowMd5({}), null);
});

test('verifyLedger accepts a ledger whose rows, repository-only files and history-only texts all resolve', () => {
  assert.deepEqual(verifyLedger(fixture()), []);
});

test('verifyLedger names every inconsistency between the ledger and the files', () => {
  const broken = fixture();
  broken.ledger.rows[0].statements_md5 = md5('changed');
  broken.ledger.rows[1].source = 'migrations/20260199000000_missing.sql';
  broken.ledger.rows.push({ version: '20260101000000', name: 'alpha_again',
    statements_md5: md5('x'), source: 'migrations/20260101000000_alpha.sql', transform: 'identical' });
  broken.ledger.repository_only[0].reason = ' ';
  broken.ledger.repository_only.push({ file: 'migrations/20260101000000_alpha.sql',
    status: 'never_applied', reason: 'listed and carried' });
  broken.migrations['20260107000000_orphan.sql'] = 'select 7;\n';
  broken.migrations['not-a-migration.sql'] = 'select 0;\n';
  broken.historyOnly['20260108000000_unused.sql'] = 'select 8;\r\n';
  const errors = verifyLedger(broken);
  for (const expected of [
    'ledger_source_mismatch:20260101000000_alpha',
    'ledger_source_missing:migrations/20260199000000_missing.sql',
    'ledger_duplicate_version:20260101000000',
    'ledger_rows_not_sorted:20260101000000',
    'ledger_source_shared:migrations/20260101000000_alpha.sql',
    'repository_only_reason_missing:migrations/20260103000000_gamma.sql',
    'migration_double_listed:migrations/20260101000000_alpha.sql',
    'migration_not_in_ledger:20260107000000_orphan.sql',
    'invalid_migration_filename:not-a-migration.sql',
    'migration_not_in_ledger:not-a-migration.sql',
    'history_only_unreferenced:20260108000000_unused.sql',
    'history_only_contains_cr:20260108000000_unused.sql',
  ]) assert.ok(errors.includes(expected), `${expected} in ${errors.join(', ')}`);
});

test('verifyLedger ties a diverged repository file to the history-only text production holds', () => {
  const state = fixture();
  state.ledger.rows = state.ledger.rows.filter((row) => row.name !== 'delta');
  delete state.historyOnly['20260106000000_delta.sql'];
  assert.deepEqual(verifyLedger(state),
    ['repository_only_divergence_unrecorded:migrations/20260105000000_delta.sql']);
  const misnamed = fixture();
  misnamed.ledger.rows[2].source = 'history-only/20260106000000_delta.sql';
  misnamed.ledger.rows[2].statements_md5 = md5('select 5;\n');
  misnamed.ledger.rows[2].transform = 'append_crlf';
  misnamed.ledger.rows[2].statements_md5 = md5('select 5;\n\r\n');
  const errors = verifyLedger(misnamed);
  assert.ok(errors.includes('history_only_name_mismatch:history-only/20260106000000_delta.sql'));
  assert.ok(errors.includes('history_only_transform_not_identical:history-only/20260106000000_delta.sql'));
  assert.deepEqual(verifyLedger({ ledger: { contract: 'other' }, migrations: {}, historyOnly: {} }),
    ['ledger_contract_invalid']);
});

function historyOf(ledger) {
  return ledger.rows.map(({ version, name, statements_md5 }) => ({ version, name, statements_md5 }));
}

test('compareLedgerWithHistory passes when production history and the ledger hold the same rows', () => {
  const { ledger, migrations } = fixture();
  const history = historyOf(ledger);
  history[0] = { version: '20260101000000', name: 'alpha', statements: ['select 1;\n'] };
  assert.deepEqual(compareLedgerWithHistory({ ledger, history, migrations }),
    { errors: [], warnings: [], missingRows: [] });
});

test('a production row the ledger lacks is a warning with the row to add when a migration file carries it', () => {
  const { ledger, migrations } = fixture();
  migrations['20260109000000_zeta.sql'] = 'select 9;\n';
  const history = [...historyOf(ledger),
    { version: '20260109120000', name: 'zeta', statements: ['select 9;\n'] },
    { version: '20260110000000', name: 'eta', statements: ['select 10;\n'] }];
  const report = compareLedgerWithHistory({ ledger, history, migrations });
  assert.deepEqual(report.warnings, ['ledger_missing_row:20260109120000_zeta']);
  assert.deepEqual(report.missingRows, [{ version: '20260109120000', name: 'zeta',
    statements_md5: md5('select 9;\n'), statements_length: 10,
    source: 'migrations/20260109000000_zeta.sql', transform: 'identical' }]);
  assert.deepEqual(report.errors, ['production_row_not_in_repository:20260110000000_eta']);
});

test('compareLedgerWithHistory reports rows missing from production, changed texts, renames and multi-statement rows', () => {
  const { ledger, migrations } = fixture();
  const history = historyOf(ledger).slice(1);
  history[0] = { version: '20260102120000', name: 'beta_renamed', statements: ['x', 'y'] };
  history[1] = { version: '20260104000000', name: 'epsilon' };
  const report = compareLedgerWithHistory({ ledger, history, migrations });
  assert.deepEqual(report.errors, [
    'production_row_multi_statement:20260102120000_beta_renamed',
    'production_row_renamed:20260102120000_beta_renamed',
    'production_statements_changed:20260102120000_beta_renamed',
    'production_row_without_statements:20260104000000_epsilon',
    'ledger_row_not_in_production:20260101000000_alpha',
  ]);
});

test('buildLedger maps rows to files by content, prefers the same-named file, and writes the rest to history-only', () => {
  const migrations = {
    '20260101000000_alpha.sql': 'select 1;\n',
    '20260101000001_alpha_copy.sql': 'select 1;\n',
    '20260102000000_beta.sql': 'select 2;\n',
  };
  const history = [
    { version: '20260103000000', name: 'gamma', statements: ['select 3;\n'] },
    { version: '20260102120000', name: 'beta', statements: ['select 2;\n\r\n'] },
    { version: '20260101000000', name: 'alpha', statements: ['select 1;\n'] },
    { version: '20260104000000', name: 'delta', statements_md5: md5('select 4;\n') },
    { version: '20260105000000', name: 'epsilon', statements_md5: md5('select 5;\n') },
  ];
  const previous = { database_project: 'clued-prod', repository_only: [{ file: 'x', status: 'never_applied', reason: 'r' }],
    known_deviations: [{ kind: 'schema', name: 's', note: 'n' }] };
  const result = buildLedger({ history, migrations, previous, exportedAt: '2026-10-07T00:00:00Z',
    historyOnly: { '20260104000000_delta.sql': 'select 4;\n', '20260105000000_epsilon.sql': 'select 55;\n' } });
  assert.deepEqual(result.errors, ['history_only_text_differs:20260105000000_epsilon.sql']);
  assert.deepEqual(result.ledger.rows.map((row) => [row.version, row.source, row.transform]), [
    ['20260101000000', 'migrations/20260101000000_alpha.sql', 'identical'],
    ['20260102120000', 'migrations/20260102000000_beta.sql', 'append_crlf'],
    ['20260103000000', 'history-only/20260103000000_gamma.sql', 'identical'],
    ['20260104000000', 'history-only/20260104000000_delta.sql', 'identical'],
  ]);
  assert.deepEqual(result.newHistoryOnly, { '20260103000000_gamma.sql': 'select 3;\n' });
  assert.equal(result.ledger.row_count, 4);
  assert.deepEqual(result.ledger.repository_only, previous.repository_only);
  assert.deepEqual(result.ledger.known_deviations, previous.known_deviations);
  const needsText = buildLedger({ history: [{ version: '20260106000000', name: 'zeta', statements_md5: md5('z') }],
    migrations, exportedAt: 'now' });
  assert.deepEqual(needsText.errors, ['history_row_needs_statements:20260106000000_zeta']);
});

test('the committed ledger resolves every production row and every migration file of this checkout', async () => {
  const ledger = await readLedger(ledgerPath);
  const migrations = await readSqlDirectory(migrationsDirectory);
  const historyOnly = await readSqlDirectory(historyOnlyDirectory);
  assert.deepEqual(verifyLedger({ ledger, migrations, historyOnly }), []);
  assert.equal(ledger.row_count, ledger.rows.length);
  assert.ok(ledger.rows.length >= 202, 'ledger carries the 2026-10-07 production history');
  // The checkout's own migration files, read as production history, agree with the ledger.
  const history = ledger.rows.map(({ version, name, statements_md5 }) => ({ version, name, statements_md5 }));
  assert.deepEqual(compareLedgerWithHistory({ ledger, history, migrations }).errors, []);
});

test('the CLI verifies offline and compares a history export, failing on drift', () => {
  const verify = spawnSync(process.execPath, [script, 'verify'], { cwd: appDirectory, encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /migration ledger ok: \d+ production rows/);

  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-ledger-'));
  try {
    const ledger = JSON.parse(spawnSync(process.execPath, ['-e',
      'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))', ledgerPath],
    { encoding: 'utf8' }).stdout);
    const history = ledger.rows.map(({ version, name, statements_md5 }) => ({ version, name, statements_md5 }));
    const same = path.join(temp, 'same.json');
    writeFileSync(same, JSON.stringify(history));
    const ok = spawnSync(process.execPath, [script, 'compare', '--history', same],
      { cwd: appDirectory, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /matches production history/);

    const drifted = path.join(temp, 'drifted.json');
    writeFileSync(drifted, JSON.stringify([...history.slice(1),
      { version: '20991231235959', name: 'applied_by_hand', statements: ['select 42;'] }]));
    const bad = spawnSync(process.execPath, [script, 'compare', '--history', drifted],
      { cwd: appDirectory, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /production_row_not_in_repository:20991231235959_applied_by_hand/);
    assert.match(bad.stderr, new RegExp(`ledger_row_not_in_production:${history[0].version}_${history[0].name}`));
    assert.match(bad.stderr, /migration_ledger_drift:2/);

    const usage = spawnSync(process.execPath, [script], { cwd: appDirectory, encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
