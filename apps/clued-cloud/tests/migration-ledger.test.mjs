import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LEDGER_CONTRACT, TRANSFORMS, applyTransform, baselineVersion, buildLedger, characterLength,
  compareLedgerWithHistory, evaluateLedger, fileVersion, historyOnlyDirectory, historyRowMd5,
  ledgerPath, listPendingMigrations, matchTransform, md5, migrateTextProblem, migrationsDirectory,
  readHistoricalThrough, readLedger, readSqlDirectory, verifyLedger,
} from '../scripts/migration-ledger.mjs';

const appDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(appDirectory, 'scripts', 'migration-ledger.mjs');
// Files up to this version are history in the fixture; later ones may be pending.
const BASELINE = '20260105000000';

function row(version, name, text, source, transform = 'identical') {
  const stored = applyTransform(text, transform);
  return { version, name, statements_md5: md5(stored), statements_length: characterLength(stored),
    source, transform };
}

function fixture() {
  const migrations = {
    '20260101000000_alpha.sql': 'select 1;\n',
    '20260102000000_beta.sql': 'select 2;\n-- two lines\n',
    '20260103000000_gamma.sql': 'select 3;\n',
    '20260105000000_delta.sql': 'select 5;\n',
    '20260108000000_kappa.sql': 'select 8;\n',
  };
  const historyOnly = {
    '20260104000000_epsilon.sql': 'select 4;\n',
    '20260106000000_delta.sql': 'select 55;\n',
  };
  const rows = [
    row('20260101000000', 'alpha', migrations['20260101000000_alpha.sql'],
      'migrations/20260101000000_alpha.sql'),
    row('20260102120000', 'beta', migrations['20260102000000_beta.sql'],
      'migrations/20260102000000_beta.sql', 'crlf'),
    row('20260104000000', 'epsilon', historyOnly['20260104000000_epsilon.sql'],
      'history-only/20260104000000_epsilon.sql'),
    row('20260106000000', 'delta', historyOnly['20260106000000_delta.sql'],
      'history-only/20260106000000_delta.sql'),
    row('20260109000000', 'kappa', migrations['20260108000000_kappa.sql'],
      'migrations/20260108000000_kappa.sql'),
  ];
  const ledger = {
    contract: LEDGER_CONTRACT,
    history_through: '20260109000000',
    row_count: rows.length,
    rows,
    repository_only: [
      { file: 'migrations/20260103000000_gamma.sql', status: 'never_applied', reason: 'never applied' },
      { file: 'migrations/20260105000000_delta.sql', status: 'diverged_from_production',
        reason: 'production holds another text' },
    ],
    known_deviations: [{ kind: 'schema', name: 'x_test', note: 'kept' }],
  };
  return { migrations, historyOnly, ledger, historicalThrough: BASELINE };
}

function historyOf(ledger) {
  return ledger.rows.map(({ version, name, statements_md5 }) => ({ version, name, statements_md5 }));
}

function compare(state, history) {
  return compareLedgerWithHistory({ ...state, history });
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

test('file names, character lengths and the migrate text checks', () => {
  assert.equal(fileVersion('202608230001_clued_continuity.sql'), '20260823000100');
  assert.equal(fileVersion('20260823154017_x.sql'), '20260823154017');
  assert.equal(fileVersion('2026082315401_thirteen.sql'), null);
  assert.equal(fileVersion('not_a_migration.sql'), null);
  assert.equal(characterLength('a\u{1F600}b'), 3);
  assert.equal(baselineVersion({ source_migration: '20260924110000_x.sql' }), '20260924110000');
  assert.equal(migrateTextProblem('select 1;\n'), null);
  assert.equal(migrateTextProblem(''), 'empty');
  assert.equal(migrateTextProblem('select 1;'), 'no_final_newline');
  assert.equal(migrateTextProblem('select 1;\r\n'), 'forbidden_character');
  assert.equal(migrateTextProblem('select\x01 1;\n'), 'forbidden_character');
  assert.equal(migrateTextProblem('copy t from stdin;\n1\n\\.\n'), 'copy_terminator_line');
});

test('a history row hashes its one statements element, or carries its md5', () => {
  assert.equal(historyRowMd5({ statements: ['select 1;'] }), md5('select 1;'));
  assert.equal(historyRowMd5({ statements: ['select 1;', 'select 2;'] }), null);
  assert.equal(historyRowMd5({ statements: [] }), null);
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
  broken.migrations['20260104120000_backdated.sql'] = 'select 7;\n';
  broken.migrations['not-a-migration.sql'] = 'select 0;\n';
  broken.historyOnly['20260108000000_unused.sql'] = 'select 8;\r\n';
  const errors = verifyLedger(broken);
  for (const expected of [
    'ledger_row_count_mismatch:5',
    'ledger_source_mismatch:20260101000000_alpha',
    'ledger_source_missing:migrations/20260199000000_missing.sql',
    'ledger_duplicate_version:20260101000000',
    'ledger_rows_not_sorted:20260101000000',
    'ledger_source_shared:migrations/20260101000000_alpha.sql',
    'repository_only_reason_missing:migrations/20260103000000_gamma.sql',
    'migration_double_listed:migrations/20260101000000_alpha.sql',
    'historical_migration_not_in_ledger:20260104120000_backdated.sql',
    'invalid_migration_filename:not-a-migration.sql',
    'history_only_unreferenced:20260108000000_unused.sql',
    'history_only_contains_cr:20260108000000_unused.sql',
  ]) assert.ok(errors.includes(expected), `${expected} in ${errors.join(', ')}`);
});

test('verifyLedger checks lengths, history_through and the release baseline it is given', () => {
  const lengths = fixture();
  lengths.ledger.rows[2].statements_length = 999;
  assert.deepEqual(verifyLedger(lengths), ['ledger_length_mismatch:20260104000000_epsilon']);
  const through = fixture();
  through.ledger.history_through = '20260108000000';
  assert.deepEqual(verifyLedger(through), ['ledger_row_after_history_through:20260109000000_kappa']);
  const missing = fixture();
  delete missing.ledger.history_through;
  assert.deepEqual(verifyLedger(missing), ['history_through_invalid']);
  const noBaseline = fixture();
  delete noBaseline.historicalThrough;
  const errors = verifyLedger(noBaseline);
  assert.ok(errors.includes('release_baseline_invalid'));
});

test('a migration file after the release baseline that no row carries is pending, in any order', () => {
  const state = fixture();
  state.migrations['20260110000000_first.sql'] = 'select 10;\n';
  state.migrations['20260107000000_older_than_newest_row.sql'] = 'select 11;\n';
  assert.deepEqual(verifyLedger(state), []);
  assert.deepEqual(listPendingMigrations(state),
    ['20260107000000_older_than_newest_row.sql', '20260110000000_first.sql']);
});

test('a pending file migrate mode could never apply is refused up front', () => {
  for (const [filename, text, problem] of [
    ['202601100000_twelve_digits.sql', 'select 1;\n', 'filename'],
    ['20260110000000_alpha.sql', 'select 12;\n', 'name_recorded'],
    ['20260110000000_no_newline.sql', 'select 13;', 'no_final_newline'],
    ['20260110000000_crlf.sql', 'select 14;\r\n', 'forbidden_character'],
  ]) {
    const state = fixture();
    state.migrations[filename] = text;
    assert.deepEqual(verifyLedger(state), [`pending_migration_not_migratable:${filename}:${problem}`], filename);
  }
  const twice = fixture();
  twice.migrations['20260110000000_zeta.sql'] = 'select 15;\n';
  twice.migrations['20260111000000_zeta.sql'] = 'select 16;\n';
  assert.deepEqual(verifyLedger(twice), [
    'pending_migration_not_migratable:20260110000000_zeta.sql:name_duplicate',
    'pending_migration_not_migratable:20260111000000_zeta.sql:name_duplicate',
  ]);
});

test('a history-only copy of a migration file means the ledger was exported from a checkout that lacked the file', () => {
  const state = fixture();
  state.migrations['20260110000000_zeta.sql'] = 'select 4;\n';
  const errors = verifyLedger(state);
  assert.ok(errors.includes('history_only_duplicates_migration:history-only/20260104000000_epsilon.sql:20260110000000_zeta.sql'),
    errors.join(', '));
});

test('verifyLedger ties a diverged repository file to the history-only text production holds', () => {
  const state = fixture();
  state.ledger.rows = state.ledger.rows.filter((candidate) => candidate.name !== 'delta');
  state.ledger.row_count = state.ledger.rows.length;
  delete state.historyOnly['20260106000000_delta.sql'];
  assert.deepEqual(verifyLedger(state),
    ['repository_only_divergence_unrecorded:migrations/20260105000000_delta.sql']);
  const misnamed = fixture();
  misnamed.ledger.rows[2] = row('20260104000000', 'epsilon', 'select 55;\n',
    'history-only/20260106000000_delta.sql', 'append_crlf');
  const errors = verifyLedger(misnamed);
  assert.ok(errors.includes('history_only_name_mismatch:history-only/20260106000000_delta.sql'));
  assert.ok(errors.includes('history_only_transform_not_identical:history-only/20260106000000_delta.sql'));
  assert.deepEqual(verifyLedger({ ledger: { contract: 'other' }, migrations: {}, historyOnly: {} }),
    ['ledger_contract_invalid']);
});

test('compareLedgerWithHistory passes when production history and the ledger hold the same rows', () => {
  const state = fixture();
  const history = historyOf(state.ledger);
  history[0] = { version: '20260101000000', name: 'alpha', statements: ['select 1;\n'] };
  assert.deepEqual(compare(state, history), { errors: [], warnings: [], missingRows: [] });
});

test('a newer row exactly as migrate mode records it for a pending file is a warning with the row to add', () => {
  const state = fixture();
  state.migrations['20260110000000_zeta.sql'] = 'select 9;\n';
  const report = compare(state, [...historyOf(state.ledger),
    { version: '20260110120000', name: 'zeta', statements: ['select 9;\n'] }]);
  assert.deepEqual(report, { errors: [], warnings: ['ledger_missing_row:20260110120000_zeta'],
    missingRows: [{ version: '20260110120000', name: 'zeta', statements_md5: md5('select 9;\n'),
      statements_length: 10, source: 'migrations/20260110000000_zeta.sql', transform: 'identical' }] });
});

test('rows migrate mode would not record are errors, even when a file carries their text', () => {
  const base = fixture();
  base.migrations['20260110000000_zeta.sql'] = 'select 9;\n';
  const cases = [
    // The pending file applied from Windows with CRLF endings.
    [[{ version: '20260111000000', name: 'zeta', statements: ['select 9;\r\n'] }],
      ['production_row_not_from_migrate:20260111000000_zeta']],
    // A file's text under another name.
    [[{ version: '20260111000000', name: 'zeta_by_hand', statements: ['select 9;\n'] }],
      ['production_row_not_from_migrate:20260111000000_zeta_by_hand']],
    // A file a ledger row already carries, applied again.
    [[{ version: '20260111000000', name: 'alpha', statements: ['select 1;\n'] }],
      ['production_row_not_from_migrate:20260111000000_alpha']],
    // The repository text of a diverged file re-applied under its recorded name.
    [[{ version: '20260111000000', name: 'delta', statements: ['select 5;\n'] }],
      ['production_row_not_from_migrate:20260111000000_delta']],
    // A never-applied historical file applied by hand.
    [[{ version: '20260111000000', name: 'gamma', statements: ['select 3;\n'] }],
      ['production_row_not_from_migrate:20260111000000_gamma']],
    // The pending file recorded twice.
    [[{ version: '20260111000000', name: 'zeta', statements: ['select 9;\n'] },
      { version: '20260112000000', name: 'zeta', statements: ['select 9;\n'] }],
      ['production_row_not_from_migrate:20260111000000_zeta', 'production_row_not_from_migrate:20260112000000_zeta']],
    // A text no file carries.
    [[{ version: '20260111000000', name: 'eta', statements: ['select 10;\n'] }],
      ['production_row_not_in_repository:20260111000000_eta']],
  ];
  for (const [extra, expected] of cases) {
    const report = compare(base, [...historyOf(base.ledger), ...extra]);
    assert.deepEqual(report.warnings, [], JSON.stringify(extra));
    assert.deepEqual(report.errors, expected, JSON.stringify(extra));
  }
});

test('a production row up to history_through that the ledger lacks is an error, which catches a removed row or a reverted ledger', () => {
  const state = fixture();
  state.migrations['20260110000000_zeta.sql'] = 'select 9;\n';
  const history = [...historyOf(state.ledger),
    { version: '20260105120000', name: 'zeta', statements: ['select 9;\n'] }];
  assert.deepEqual(compare(state, history).errors, ['production_row_missing_from_ledger:20260105120000_zeta']);
  // Dropping the newest ledger row while keeping history_through.
  const dropped = fixture();
  dropped.ledger.rows.pop();
  dropped.ledger.row_count = dropped.ledger.rows.length;
  assert.deepEqual(compare(dropped, historyOf(fixture().ledger)).errors,
    ['production_row_missing_from_ledger:20260109000000_kappa']);
});

test('compareLedgerWithHistory reports rows missing from production, changed texts, renames and malformed rows', () => {
  const state = fixture();
  const history = historyOf(state.ledger).slice(1);
  history[0] = { version: '20260102120000', name: 'beta_renamed', statements_md5: md5('x') };
  history[1] = { version: '20260104000000', name: 'epsilon' };
  history.push({ version: '20260110000000', name: 'split', statements: ['x', 'y'] }, null);
  const report = compare(state, history);
  assert.deepEqual(report.errors, [
    'production_row_renamed:20260102120000_beta_renamed',
    'production_statements_changed:20260102120000_beta_renamed',
    'production_row_without_statements:20260104000000_epsilon',
    'production_row_multi_statement:20260110000000_split',
    'production_row_invalid:undefined_undefined',
    'ledger_row_not_in_production:20260101000000_alpha',
  ]);
  assert.deepEqual(compareLedgerWithHistory({ ledger: { contract: LEDGER_CONTRACT }, history: [] }).errors,
    ['ledger_contract_invalid']);
});

test('evaluateLedger, what the release gate runs, blocks an invalid committed ledger even when production matches it', () => {
  const state = fixture();
  state.historyOnly['20260104000000_epsilon.sql'] = 'select 44;\n';
  const report = evaluateLedger({ ...state, history: historyOf(state.ledger) });
  assert.deepEqual(report.errors, ['ledger_source_mismatch:20260104000000_epsilon']);
  const clean = fixture();
  clean.migrations['20260110000000_zeta.sql'] = 'select 9;\n';
  const migrated = evaluateLedger({ ...clean, history: [...historyOf(clean.ledger),
    { version: '20260110120000', name: 'zeta', statements: ['select 9;\n'] }] });
  assert.deepEqual(migrated.errors, []);
  assert.deepEqual(migrated.warnings, ['ledger_missing_row:20260110120000_zeta']);
  assert.deepEqual(migrated.pending, ['20260110000000_zeta.sql']);
});

test('out-of-order applies: the newer pending file is recorded, the older one stays pending, by hand or by export', () => {
  const state = fixture();
  state.migrations['20260110000000_older.sql'] = 'select 20;\n';
  state.migrations['20260111000000_newer.sql'] = 'select 21;\n';
  assert.deepEqual(verifyLedger(state), []);
  const history = [...historyOf(state.ledger),
    { version: '20260112000000', name: 'newer', statements: ['select 21;\n'] }];
  const report = compare(state, history);
  assert.deepEqual(report.errors, []);
  // Lifecycle step 3 by hand: add the printed row, set row_count and history_through.
  const added = structuredClone(state.ledger);
  added.rows.push(...report.missingRows);
  added.row_count = added.rows.length;
  added.history_through = report.missingRows.at(-1).version;
  assert.deepEqual(verifyLedger({ ...state, ledger: added }), []);
  assert.deepEqual(compare({ ...state, ledger: added }, history), { errors: [], warnings: [], missingRows: [] });
  assert.deepEqual(listPendingMigrations({ ...state, ledger: added }), ['20260110000000_older.sql']);
  // Or regenerate: the result verifies and the older file stays pending.
  const exported = buildLedger({ history, migrations: state.migrations, historyOnly: state.historyOnly,
    previous: state.ledger, exportedAt: '2026-10-07T00:00:00Z' });
  assert.deepEqual(exported.errors, []);
  assert.equal(exported.ledger.history_through, '20260112000000');
  assert.deepEqual(verifyLedger({ ...state, ledger: exported.ledger }), []);
  assert.deepEqual(listPendingMigrations({ ...state, ledger: exported.ledger }), ['20260110000000_older.sql']);
  // The older file applied later is again a warning until recorded.
  const later = [...history, { version: '20260113000000', name: 'older', statements: ['select 20;\n'] }];
  assert.deepEqual(compare({ ...state, ledger: exported.ledger }, later).warnings,
    ['ledger_missing_row:20260113000000_older']);
});

test('export removes a never-applied file from repository_only once a row carries it', () => {
  const state = fixture();
  const history = [...historyOf(state.ledger),
    { version: '20260111000000', name: 'gamma', statements: ['select 3;\n'] }];
  const exported = buildLedger({ history, migrations: state.migrations, historyOnly: state.historyOnly,
    previous: state.ledger, exportedAt: 'now' });
  assert.deepEqual(exported.errors, []);
  assert.deepEqual(exported.ledger.repository_only.map((entry) => entry.file),
    ['migrations/20260105000000_delta.sql']);
  assert.deepEqual(verifyLedger({ ...state, ledger: exported.ledger }), []);
});

test('buildLedger maps rows to files by content, prefers the same-named file, and writes the rest to history-only', () => {
  const migrations = {
    '20260101000000_alpha_copy.sql': 'select 1;\n',
    '20260101000001_alpha.sql': 'select 1;\n',
    '20260102000000_beta.sql': 'select 2;\n',
  };
  const history = [
    { version: '20260103000000', name: 'gamma', statements: ['select 3;\n'] },
    { version: '20260102120000', name: 'beta', statements: ['select 2;\n\r\n'] },
    { version: '20260101000000', name: 'alpha', statements: ['select 1;\n'] },
    { version: '20260104000000', name: 'delta', statements_md5: md5('select 4;\n'), statements_length: 10 },
    { version: '20260105000000', name: 'epsilon', statements_md5: md5('select 5;\n') },
    { version: '20260106000000', name: 'split', statements: ['select 6;', 'select 7;'] },
  ];
  const previous = { database_project: 'clued-prod',
    repository_only: [{ file: 'migrations/x.sql', status: 'never_applied', reason: 'r' }],
    known_deviations: [{ kind: 'schema', name: 's', note: 'n' }] };
  const result = buildLedger({ history, migrations, previous, exportedAt: '2026-10-07T00:00:00Z',
    historyOnly: { '20260104000000_delta.sql': 'select 4;\n', '20260105000000_epsilon.sql': 'select 55;\n' } });
  assert.deepEqual(result.errors, ['history_only_text_differs:20260105000000_epsilon.sql',
    'history_row_multi_statement:20260106000000_split']);
  assert.deepEqual(result.ledger.rows.map((entry) => [entry.version, entry.source, entry.transform,
    entry.statements_length]), [
    ['20260101000000', 'migrations/20260101000001_alpha.sql', 'identical', 10],
    ['20260102120000', 'migrations/20260102000000_beta.sql', 'append_crlf', 12],
    ['20260103000000', 'history-only/20260103000000_gamma.sql', 'identical', 10],
    ['20260104000000', 'history-only/20260104000000_delta.sql', 'identical', 10],
  ]);
  assert.deepEqual(result.newHistoryOnly, { '20260103000000_gamma.sql': 'select 3;\n' });
  assert.equal(result.ledger.row_count, 4);
  assert.equal(result.ledger.history_through, '20260104000000');
  assert.deepEqual(result.ledger.repository_only, previous.repository_only);
  assert.deepEqual(result.ledger.known_deviations, previous.known_deviations);
  const needsText = buildLedger({ history: [{ version: '20260106000000', name: 'zeta', statements_md5: md5('z') }],
    migrations, exportedAt: 'now' });
  assert.deepEqual(needsText.errors, ['history_row_needs_statements:20260106000000_zeta']);
});

test('the committed ledger is valid against this checkout and records the 2026-10-07 production history', async () => {
  const ledger = await readLedger(ledgerPath);
  const migrations = await readSqlDirectory(migrationsDirectory);
  const historyOnly = await readSqlDirectory(historyOnlyDirectory);
  const historicalThrough = await readHistoricalThrough();
  assert.deepEqual(verifyLedger({ ledger, migrations, historyOnly, historicalThrough }), []);
  assert.ok(ledger.rows.length >= 202, 'ledger carries the 2026-10-07 production history');
  assert.ok(ledger.rows.some((entry) => entry.version === '20261007003804' &&
    entry.name === 'storage_connections_display_name'), 'newest row at export time');
  // Each row's recorded transform is the first one that reproduces its md5 from its file.
  for (const entry of ledger.rows) {
    const text = entry.source.startsWith('history-only/')
      ? historyOnly[entry.source.slice('history-only/'.length)]
      : migrations[entry.source.slice('migrations/'.length)];
    assert.equal(matchTransform(text, entry.statements_md5), entry.transform, entry.version);
  }
});

test('the CLI verifies offline and compares a history export, failing on drift', () => {
  const verify = spawnSync(process.execPath, [script, 'verify'], { cwd: appDirectory, encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /migration ledger ok: \d+ production rows, \d+ repository-only files, \d+ pending/);

  const temp = mkdtempSync(path.join(os.tmpdir(), 'clued-ledger-'));
  try {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const history = historyOf(ledger);
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
