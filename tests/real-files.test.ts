// The two public .xer files in data/ against the reference numbers from an
// independent scan. If a number here changes, find the task that differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXer, type ParseResult } from '../src/parser.ts';
import { runChecks, type Finding } from '../src/checks.ts';

const decoder = new TextDecoder('windows-1252');
const load = (name: string) => parseXer(decoder.decode(readFileSync(new URL(`../data/${name}`, import.meta.url))));
const cca = load('CCA_R03_dt_24Oct11SC.xer');
const expressway = load('Expressway_Project.xer');

const totalRows = (p: ParseResult) => [...p.tables.values()].reduce((n, t) => n + t.read, 0);
const counts = (p: ParseResult, name: string) => {
  const t = p.tables.get(name)!;
  return [t.read, t.kept, t.rejected];
};
const extreme = (findings: Finding[], check: Finding['check'], pick: 'min' | 'max') =>
  findings.filter((f) => f.check === check).reduce((a, b) => ((pick === 'min' ? b.floatDays! < a.floatDays! : b.floatDays! > a.floatDays!) ? b : a));

test('CCA R03: parse matches the reference numbers, 0 broken rows', () => {
  assert.equal(cca.version, '6.0');
  assert.equal(totalRows(cca), 403177);
  assert.deepEqual(counts(cca, 'TASK'), [16146, 16146, 0]);
  assert.deepEqual(counts(cca, 'TASKPRED'), [47286, 47286, 0]);
  assert.deepEqual(counts(cca, 'CALENDAR'), [2, 2, 0]);
  assert.deepEqual(cca.tables.get('CALENDAR')!.rows.map((r) => r.fields['day_hr_cnt']), ['8', '8']);
  assert.deepEqual(cca.broken, []);
  assert.deepEqual(cca.warnings, []);
  const t = cca.tally;
  assert.equal(t.total, t.structural + t.kept + t.rejected + t.blank + t.afterEnd);
});

test('CCA R03: checks match the reference numbers', () => {
  const r = runChecks(cca);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.summary, {
    incompleteTasks: 14555,
    completeSkipped: 1591,
    noPredecessor: 0,
    noSuccessor: 2,
    negativeFloat: 552,
    highFloat: 9009,
    blankFloatNotEvaluated: 0,
    calendarFallbackUsed: 0,
  });
  const worst = extreme(r.findings, 'negative_float', 'min');
  assert.deepEqual([worst.task_code, worst.floatDays, worst.line], ['MGNMI00M07M0', -104, 1407]);
  const highest = extreme(r.findings, 'high_float', 'max');
  assert.deepEqual([highest.task_code, highest.floatDays!.toFixed(1)], ['DV10GZ03351R2', '528.5']);
});

test('Expressway: parse matches the reference numbers, 0 broken rows', () => {
  assert.equal(expressway.version, '7.0');
  assert.equal(totalRows(expressway), 8551);
  assert.deepEqual(counts(expressway, 'TASK'), [823, 823, 0]);
  assert.deepEqual(counts(expressway, 'TASKPRED'), [1094, 1094, 0]);
  assert.deepEqual(counts(expressway, 'CALENDAR'), [2, 2, 0]);
  assert.deepEqual(expressway.tables.get('CALENDAR')!.rows.map((r) => r.fields['day_hr_cnt']), ['9', '9']);
  assert.deepEqual(expressway.broken, []);
  assert.deepEqual(expressway.warnings, []);
});

test('Expressway: checks match the reference numbers', () => {
  const r = runChecks(expressway);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.summary, {
    incompleteTasks: 823,
    completeSkipped: 0,
    noPredecessor: 46,
    noSuccessor: 64,
    negativeFloat: 0,
    highFloat: 785,
    blankFloatNotEvaluated: 0,
    calendarFallbackUsed: 0,
  });
  assert.equal(extreme(r.findings, 'high_float', 'max').floatDays, 1074);
});

test('Expressway: 785 high-float tasks with its 9-hour calendar, 787 if 8 hours were assumed', () => {
  // Same parse result without the CALENDAR table: every task takes the 8-hour fallback.
  const without: ParseResult = { ...expressway, tables: new Map(expressway.tables) };
  without.tables.delete('CALENDAR');
  const r = runChecks(without);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.summary.highFloat, 787);
  assert.equal(r.summary.calendarFallbackUsed, 823);
});
