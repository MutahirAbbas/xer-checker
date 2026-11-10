import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXer, isNumber } from '../src/parser.ts';

// tests/fixture.xer is hand-made: 42 CRLF lines, one of each broken row type.
const fixtureBytes = readFileSync(new URL('./fixture.xer', import.meta.url));
const fixture = new TextDecoder('windows-1252').decode(fixtureBytes);

test('fixture is CRLF and the parser strips the CR', () => {
  assert.ok(fixture.includes('\r\n'));
  const r = parseXer(fixture);
  assert.equal(r.tables.get('CALENDAR')!.rows[0].fields['day_hr_cnt'], '8');
});

test('version and export date come from ERMHDR', () => {
  assert.equal(parseXer(fixture).version, '6.0');
  assert.equal(parseXer(fixture).exportDate, '2026-11-11');
  assert.equal(parseXer('ERMHDR\t7.0\n%E\n').exportDate, null);
});

test('per-table read = kept + rejected, with exact counts', () => {
  const r = parseXer(fixture);
  const counts = [...r.tables.values()].map((t) => [t.name, t.read, t.rows.length, t.rejected]);
  assert.deepEqual(counts, [
    ['CALENDAR', 4, 3, 1],
    ['TASK', 15, 11, 4],
    ['TASKPRED', 11, 8, 3],
  ]);
  for (const t of r.tables.values()) assert.equal(t.read, t.rows.length + t.rejected, t.name);
});

test('every broken row, with exact line numbers and reasons', () => {
  const r = parseXer(fixture);
  const got = r.broken.map((b) => [b.line, b.table, b.reason]);
  assert.deepEqual(got, [
    [2, null, '%R data row before any %T table line'],
    [3, null, '%F field header before any %T table line'],
    [9, 'CALENDAR', 'non-numeric day_hr_cnt "eight"'],
    [23, 'TASK', 'empty task_id'],
    [24, 'TASK', 'task_id 2 already seen at line 13 (first one kept)'],
    [25, 'TASK', 'non-numeric total_float_hr_cnt "lots"'],
    [26, 'TASK', 'has 5 fields, header has 7'],
    [27, null, 'unknown line type "this line is not a k"'],
    [38, 'TASKPRED', 'pred_task_id 999 not in this file (possibly an external link)'],
    [39, 'TASKPRED', 'task_id 998 not in this file (possibly an external link)'],
    [40, 'TASKPRED', 'pred_task_id 11 refers to a rejected TASK row, not a kept task'],
  ]);
});

test('duplicate task_id: the first row is kept, the later one rejected', () => {
  const task2 = parseXer(fixture).tables.get('TASK')!.rows.find((r) => r.fields['task_id'] === '2')!;
  assert.equal(task2.line, 13);
  assert.equal(task2.fields['task_code'], 'A200');
});

test('columns are found by name, not position', () => {
  // In the fixture task_code is column 1 and task_id is column 2, unlike the real files.
  const first = parseXer(fixture).tables.get('TASK')!.rows[0];
  assert.equal(first.fields['task_id'], '1');
  assert.equal(first.fields['task_code'], 'A100');
  assert.equal(first.fields['clndr_id'], 'C8');
});

test('kept TASK ids in file order, blank float kept as unknown', () => {
  const rows = parseXer(fixture).tables.get('TASK')!.rows;
  assert.deepEqual(
    rows.map((r) => r.fields['task_id']),
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '13'],
  );
  assert.equal(rows[6].fields['total_float_hr_cnt'], '');
});

test('kept links are exactly the six good pairs', () => {
  const rows = parseXer(fixture).tables.get('TASKPRED')!.rows;
  assert.deepEqual(
    rows.map((r) => `${r.fields['pred_task_id']}->${r.fields['task_id']}`),
    ['1->2', '2->3', '3->4', '4->5', '4->9', '9->10', '4->13', '13->5'],
  );
});

test('warnings: data after %E', () => {
  const r = parseXer(fixture);
  assert.deepEqual(r.warnings, ['1 line(s) after %E, first at line 42']);
});

test('line tally: every line lands in exactly one bucket', () => {
  const { tally } = parseXer(fixture);
  assert.deepEqual(tally, { total: 42, structural: 8, kept: 22, rejected: 11, blank: 0, afterEnd: 1 });
  assert.equal(tally.total, tally.structural + tally.kept + tally.rejected + tally.blank + tally.afterEnd);
});

test('warning when %E is missing, no warning for ERMHDR when present', () => {
  const r = parseXer('ERMHDR\t7.0\r\n%T\tTASK\r\n%F\ttask_id\r\n%R\t1\r\n');
  assert.deepEqual(r.warnings, ['no %E line: file may be cut off']);
  assert.equal(r.tables.get('TASK')!.rows.length, 1);
});

test('warning when ERMHDR is missing', () => {
  const r = parseXer('%T\tTASK\r\n%F\ttask_id\r\n%E\r\n');
  assert.equal(r.version, null);
  assert.deepEqual(r.warnings, ['no ERMHDR line: P6 version unknown']);
});

test('%R before the table has a %F header is rejected', () => {
  const r = parseXer('ERMHDR\t7.0\n%T\tTASK\n%R\t1\n%F\ttask_id\n%R\t2\n%E\n');
  assert.deepEqual(r.broken, [{ table: 'TASK', line: 3, reason: 'data row before any %F field header' }]);
  assert.equal(r.tables.get('TASK')!.read, 2);
  assert.equal(r.tables.get('TASK')!.rows.length, 1);
});

test('blank lines are ignored and counted', () => {
  const r = parseXer('ERMHDR\t7.0\r\n\r\n%T\tTASK\r\n%F\ttask_id\r\n   \r\n%R\t1\r\n%E\r\n');
  assert.equal(r.tally.blank, 2);
  assert.equal(r.broken.length, 0);
});

test('a link is rejected when its task is in another file', () => {
  const r = parseXer('%T\tTASKPRED\n%F\ttask_id\tpred_task_id\n%R\t5\t6\n%E\n');
  assert.equal(r.tables.get('TASKPRED')!.rows.length, 0);
  assert.equal(r.broken[0].reason, 'task_id 5 not in this file (possibly an external link)');
});

test('isNumber: plain decimals only, empty string is not a number', () => {
  for (const ok of ['0', '8', '-1', '16.0', '-104.5', '1074']) assert.equal(isNumber(ok), true, ok);
  for (const bad of ['', ' 8', '8 ', '1.', '.5', '1e3', 'eight', '1,000', '+1', 'NaN']) {
    assert.equal(isNumber(bad), false, JSON.stringify(bad));
  }
});

test('tables other than TASK, TASKPRED and CALENDAR are counted but not stored', () => {
  const r = parseXer('%T\tPROJECT\n%F\tproj_id\n%R\t1\n%R\t2\n%T\tTASK\n%F\ttask_id\n%R\t5\n%E\n');
  const project = r.tables.get('PROJECT')!;
  assert.deepEqual([project.read, project.kept, project.rejected, project.rows.length], [2, 2, 0, 0]);
  assert.equal(r.tables.get('TASK')!.rows.length, 1);
  assert.equal(r.tally.kept, 3);
});
