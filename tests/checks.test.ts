import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXer } from '../src/parser.ts';
import { runChecks, type Finding } from '../src/checks.ts';

const fixture = new TextDecoder('windows-1252').decode(readFileSync(new URL('./fixture.xer', import.meta.url)));
const parsedFixture = parseXer(fixture);

function okResult(text: string, options = {}) {
  const r = runChecks(parseXer(text), options);
  assert.equal(r.ok, true, 'ok' in r && !r.ok ? r.error : '');
  if (!r.ok) throw new Error('unreachable');
  return r;
}

const byCheck = (findings: Finding[], check: Finding['check']) => findings.filter((f) => f.check === check);

test('fixture summary: exact counts for every line of the summary', () => {
  const r = runChecks(parsedFixture);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.summary, {
    incompleteTasks: 10,
    completeSkipped: 1,
    noPredecessor: 1,
    noSuccessor: 2,
    negativeFloat: 1,
    highFloat: 2,
    blankFloatNotEvaluated: 1,
    calendarFallbackUsed: 3,
  });
  assert.equal(r.findings.length, 6);
});

test('fixture: which tasks are flagged, with days and line numbers', () => {
  const r = runChecks(parsedFixture);
  if (!r.ok) throw new Error(r.error);
  const short = (f: Finding) => [f.task_code, f.floatDays, f.line];
  assert.deepEqual(byCheck(r.findings, 'no_predecessor').map(short), [['A600', null, 17]]);
  assert.deepEqual(byCheck(r.findings, 'no_successor').map(short), [['A600', null, 17], ['A950', null, 21]]);
  assert.deepEqual(byCheck(r.findings, 'negative_float').map(short), [['A300', -10, 14]]);
  assert.deepEqual(byCheck(r.findings, 'high_float').map(short), [['A400', 50, 15], ['A900', 50, 20]]);
  // Findings are in task file order: task 3 (line 14) comes before task 6 (line 17).
  assert.deepEqual(r.findings.map((f) => f.line), [14, 15, 17, 17, 20, 21]);
  assert.equal(r.findings[0].task_name, 'Negative float');
});

test('fixture: complete, LOE and milestone tasks are not flagged where the rules say so', () => {
  const r = runChecks(parsedFixture);
  if (!r.ok) throw new Error(r.error);
  const codes = r.findings.map((f) => f.task_code);
  assert.ok(!codes.includes('A800'), 'complete task with -400 h must be skipped');
  assert.ok(!codes.includes('A700'), 'LOE task has no links and blank float, must not appear');
  assert.ok(!codes.includes('A100'), 'start milestone may have no predecessor');
  assert.ok(!codes.includes('A500'), 'finish milestone may have no successor');
});

test('highFloatDays option: threshold 4 flags the 5-day tasks too', () => {
  const r = runChecks(parsedFixture, { highFloatDays: 4 });
  if (!r.ok) throw new Error(r.error);
  assert.deepEqual(byCheck(r.findings, 'high_float').map((f) => f.task_code), ['A400', 'A900', 'A950', 'A975']);
  assert.equal(r.summary.highFloat, 4);
});

// Small inline files for the boundaries. One 8-hour calendar, tasks linked
// to each other so the link checks stay quiet.
function tiny(dayHours: string, floats: string[]): string {
  const lines = [
    'ERMHDR\t7.0',
    '%T\tCALENDAR',
    '%F\tclndr_id\tday_hr_cnt',
    `%R\tC\t${dayHours}`,
    '%T\tTASK',
    '%F\ttask_id\ttask_code\ttask_name\ttask_type\tstatus_code\ttotal_float_hr_cnt\tclndr_id',
    ...floats.map((f, i) => `%R\t${i + 1}\tT${i + 1}\tTask ${i + 1}\tTT_Task\tTK_NotStart\t${f}\tC`),
    '%T\tTASKPRED',
    '%F\ttask_id\tpred_task_id',
    ...floats.map((_, i) => `%R\t${i + 1}\t${i === 0 ? floats.length : i}`), // a ring, every task linked
    '%E',
  ];
  return lines.join('\r\n') + '\r\n';
}

test('boundary: exactly 44.0 days is not high, just above is', () => {
  const r = okResult(tiny('8', ['352', '352.5']));
  assert.equal(r.summary.highFloat, 1);
  assert.deepEqual(byCheck(r.findings, 'high_float').map((f) => [f.task_code, f.floatDays]), [['T2', 352.5 / 8]]);
});

test('boundary: exactly 0 is not negative, -0.5 h is', () => {
  const r = okResult(tiny('8', ['0', '-0.5', '-0']));
  assert.equal(r.summary.negativeFloat, 1);
  assert.deepEqual(byCheck(r.findings, 'negative_float').map((f) => f.task_code), ['T2']);
});

test('boundary: 396 h is 44.0 days on a 9-hour calendar, high only if 8 h were assumed', () => {
  assert.equal(okResult(tiny('9', ['396'])).summary.highFloat, 0);
  assert.equal(okResult(tiny('8', ['396'])).summary.highFloat, 1);
});

test('calendar fallback: blank hours, 0 hours and a missing calendar all use 8 and are counted', () => {
  const r = okResult(tiny('', ['400']));
  assert.equal(r.summary.calendarFallbackUsed, 1);
  assert.equal(r.summary.highFloat, 1); // 400 / 8 = 50
  assert.equal(okResult(tiny('0', ['400'])).summary.calendarFallbackUsed, 1);
  const noSuchCalendar = tiny('8', ['400']).replace('%R\tC\t8', '%R\tOTHER\t8');
  assert.equal(okResult(noSuchCalendar).summary.calendarFallbackUsed, 1);
});

test('missing CALENDAR table: not an error, every task takes the fallback', () => {
  const text = tiny('8', ['400', '8']).replace('%T\tCALENDAR\r\n%F\tclndr_id\tday_hr_cnt\r\n%R\tC\t8\r\n', '');
  const r = okResult(text);
  assert.deepEqual([r.summary.calendarFallbackUsed, r.summary.highFloat], [2, 1]);
});

test('missing table or column: an error, never "0 negative float"', () => {
  const noFloat = tiny('8', ['-80']).replace('\ttotal_float_hr_cnt', '\tfloat_hours');
  const r = runChecks(parseXer(noFloat));
  assert.deepEqual(r, { ok: false, error: 'cannot run checks, missing: column TASK.total_float_hr_cnt' });

  const noLinks = runChecks(parseXer('%T\tTASK\n%F\ttask_id\n%R\t1\n%E\n'));
  assert.equal(noLinks.ok, false);
  if (noLinks.ok) return;
  assert.match(noLinks.error, /column TASK\.task_code/);
  assert.match(noLinks.error, /table TASKPRED/);

  const badCalendar = tiny('8', ['8']).replace('%F\tclndr_id\tday_hr_cnt', '%F\tclndr_id\thours');
  assert.deepEqual(runChecks(parseXer(badCalendar)), { ok: false, error: 'cannot run checks, missing: column CALENDAR.day_hr_cnt' });
});

test('a rejected link is not a link', () => {
  // Task 2's only predecessor link points at a task that is not in the file.
  const text = tiny('8', ['8', '8']).replace('%R\t2\t1', '%R\t2\t999');
  const r = okResult(text);
  assert.deepEqual(byCheck(r.findings, 'no_predecessor').map((f) => f.task_code), ['T2']);
  assert.deepEqual(byCheck(r.findings, 'no_successor').map((f) => f.task_code), ['T1']);
});
