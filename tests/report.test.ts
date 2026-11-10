import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXer } from '../src/parser.ts';
import { runChecks } from '../src/checks.ts';
import { renderReport, shareCaption, barWidth, formatDays, escapeHtml, type FileReport } from '../src/report.ts';

const fixtureText = new TextDecoder('windows-1252').decode(readFileSync(new URL('./fixture.xer', import.meta.url)));

function fileReport(text: string, label = 'Fixture', fileName = 'fixture.xer'): FileReport {
  const parsed = parseXer(text);
  return { fileName, label, parsed, checks: runChecks(parsed) };
}
const render = (files: FileReport[]) => renderReport(files, { highFloatDays: 44 });
const fixtureHtml = render([fileReport(fixtureText)]);

/** The HTML between two markers, so an assertion can be scoped to one part of the page. */
function between(html: string, start: string, end: string): string {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `markers not found: ${start} .. ${end}`);
  return html.slice(a, b);
}

test('fixture: headline and intro come from the results', () => {
  assert.ok(fixtureHtml.includes('1 file read. 11 rows rejected. 6 findings.'));
  assert.ok(fixtureHtml.includes('Every row in the file was read and accounted for.'));
  assert.ok(fixtureHtml.includes('High float threshold: 44 working days.'));
  assert.ok(fixtureHtml.includes('out of 10 incomplete tasks in Fixture.'));
});

test('fixture: chart cells show count, caption and exact bar width', () => {
  const row = (title: string, next: string) => between(fixtureHtml, `>${title}</div>`, `>${next}</div>`);
  const noPred = row('No predecessor', 'No successor');
  assert.ok(noPred.includes('>1</span>'));
  assert.ok(noPred.includes('10% of incomplete tasks'));
  assert.ok(noPred.includes('width: 10.00%;'));
  assert.ok(row('No successor', 'Negative float').includes('20% of incomplete tasks'));
  assert.ok(row('Negative float', 'High float').includes('10% of incomplete tasks'));
  assert.ok(row('High float', 'Broken rows').includes('20% of incomplete tasks'));
  // 11 rejected lines out of 22 kept + 11 rejected = 33 data lines
  const broken = between(fixtureHtml, '>Broken rows</div>', '>Files</h2>');
  assert.ok(broken.includes('>11</span>'));
  assert.ok(broken.includes('33% of rows read'));
  assert.ok(broken.includes('width: 33.33%;'));
});

test('fixture: file panel rows and row tally', () => {
  const panel = between(fixtureHtml, '<section', '</section>');
  assert.ok(panel.includes('fixture.xer · P6 6.0 · exported 2026-11-11'));
  const value = (key: string) => between(panel, `>${key}</span>`, '</div>').replace(/.*text-align: right">/, '').replace('</span>', '');
  assert.equal(value('Tasks'), '11');
  assert.equal(value('Links'), '8');
  assert.equal(value('Not started / active / complete'), '9 / 1 / 1');
  assert.equal(value('Calendars (hours per day)'), '3 (8 h, 0 h, blank)');
  assert.equal(value('Completed tasks skipped'), '1');
  assert.equal(value('Blank float, not evaluated'), '1');
  assert.equal(value('Calendar fallback to 8 h'), '3');
  const tally = between(panel, '<tbody>', '</tbody>').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  assert.equal(tally, '|All tables|30|22|8|TASK|15|11|4|TASKPRED|11|8|3|CALENDAR|4|3|1|Lines outside any table|–|–|3|');
});

test('fixture: all 11 broken rows with line numbers and escaped reasons, plus the warning', () => {
  const section = between(fixtureHtml, '>Broken rows</h2>', '>Assumptions</h2>');
  const rows = section.match(/<tr>/g)?.length ?? 0;
  assert.equal(rows, 12, 'header row + 11 broken rows');
  for (const line of [2, 3, 9, 23, 24, 25, 26, 27, 38, 39, 40]) {
    assert.ok(section.includes(`>${line}</td>`), `line ${line}`);
  }
  assert.ok(section.includes('non-numeric day_hr_cnt &quot;eight&quot;'));
  assert.ok(section.includes('unknown line type &quot;this line is not a k&quot;'));
  assert.ok(section.includes('pred_task_id 999 not in this file (possibly an external link)'));
  assert.ok(section.includes('>–</td>'), 'lines outside any table show a dash');
  assert.ok(section.includes('All 11 broken rows in Fixture'));
  assert.ok(section.includes('Fixture: 1 line(s) after %E, first at line 42'));
});

test('fixture: example findings are the worst per check, first in file order on a tie', () => {
  const table = between(fixtureHtml, '>Example findings</h2>', '>Broken rows</h2>');
  const rows = [...table.matchAll(/<tr>(.*?)<\/tr>/g)].slice(1).map((m) => '|' + m[1].replace(/<\/td>/g, '|').replace(/<[^>]+>/g, ''));
  assert.deepEqual(rows, [
    '|No predecessor|Fixture|A600|No links at all||17|',
    '|No successor|Fixture|A600|No links at all||17|',
    '|Negative float|Fixture|A300|Negative float|−10.0 d|14|',
    '|High float|Fixture|A400|High float|50.0 d|15|', // A900 ties at 50.0 d on line 20; A400 comes first
  ]);
});

// Inline file builder for the special cases.
function inline(opts: { taskName?: string; floatColumn?: string; status?: string; noTasks?: boolean }): string {
  const floatCol = opts.floatColumn ?? 'total_float_hr_cnt';
  const lines = [
    'ERMHDR\t7.0\t2020-01-01',
    '%T\tCALENDAR',
    '%F\tclndr_id\tday_hr_cnt',
    '%R\tC\t8',
    '%T\tTASK',
    `%F\ttask_id\ttask_code\ttask_name\ttask_type\tstatus_code\t${floatCol}\tclndr_id`,
    ...(opts.noTasks ? [] : [`%R\t1\tT1\t${opts.taskName ?? 'Task one'}\tTT_Task\t${opts.status ?? 'TK_NotStart'}\t-80\tC`]),
    '%T\tTASKPRED',
    '%F\ttask_id\tpred_task_id',
    '%E',
  ];
  return lines.join('\r\n') + '\r\n';
}

test('text from the file is HTML-escaped', () => {
  const html = render([fileReport(inline({ taskName: 'Pump <A> & "B"' }), 'Lab <X>', 'a<b>.xer')]);
  assert.ok(html.includes('Pump &lt;A&gt; &amp; &quot;B&quot;'));
  assert.ok(!html.includes('Pump <A>'));
  assert.ok(html.includes('Lab &lt;X&gt;'));
  assert.ok(html.includes('a&lt;b&gt;.xer'));
  assert.ok(!html.includes('<X>'));
});

test('checks that could not run: error shown, cells say "not run", never 0', () => {
  const html = render([fileReport(inline({ floatColumn: 'float_hours' }), 'Broken')]);
  assert.ok(html.includes('Checks not run: cannot run checks, missing: column TASK.total_float_hr_cnt'));
  assert.ok(html.includes('0 rows rejected. 0 findings.'));
  for (const [title, next] of [['No predecessor', 'No successor'], ['No successor', 'Negative float'], ['Negative float', 'High float'], ['High float', 'Broken rows']]) {
    const row = between(html, `>${title}</div>`, `>${next}</div>`);
    assert.ok(row.includes('>not run</span>'), title);
    assert.ok(row.includes('>–</span>'), title);
    assert.ok(!row.includes('none found'), title);
    assert.ok(!row.includes('>0</span>'), title);
  }
  assert.ok(html.includes('checks not run for Broken'));
  const panel = between(html, '<section', '</section>');
  assert.equal((panel.match(/>not run</g) ?? []).length, 3);
});

test('zero denominators: no division, plain caption, no bar', () => {
  // Every task complete: 0 incomplete tasks.
  const allComplete = render([fileReport(inline({ status: 'TK_Complete' }))]);
  const row = between(allComplete, '>No predecessor</div>', '>No successor</div>');
  assert.ok(row.includes('>0</span>'));
  assert.ok(row.includes('no incomplete tasks'));
  assert.ok(!row.includes('min-width: 4px'), 'no bar');
  assert.ok(allComplete.includes('out of 0 incomplete tasks in Fixture.'));
  // A file with no data lines at all: 0 rows read.
  const empty = render([fileReport('ERMHDR\t7.0\r\n%E\r\n')]);
  const broken = between(empty, '>Broken rows</div>', '>Files</h2>');
  assert.ok(broken.includes('no rows read'));
  assert.ok(!broken.includes('NaN'));
  assert.ok(!empty.includes('NaN'));
});

test('two files: both/either wording, labels in the intro, second colour', () => {
  const html = render([fileReport(fixtureText, 'One'), fileReport(inline({}), 'Two')]);
  assert.ok(html.includes('2 files read.'));
  assert.ok(html.includes('Every row in both files was read'));
  assert.ok(html.includes('out of 10 incomplete tasks in One and 1 in Two.'));
  assert.ok(html.includes('background: #8a8a8a'));
  assert.ok(!html.includes('None found in either file.'), 'fixture has broken rows');
  assert.ok(render([fileReport(inline({}), 'A'), fileReport(inline({}), 'B')]).includes('None found in either file.'));
});

test('the same input gives the same report', () => {
  assert.equal(render([fileReport(fixtureText)]), fixtureHtml);
  assert.ok(!/20\d\d-\d\d-\d\dT/.test(fixtureHtml), 'no timestamp');
});

test('shareCaption and barWidth boundaries; share never exceeds 100%', () => {
  const n = 'incomplete tasks';
  assert.equal(shareCaption(0, 100, n), 'none found');
  assert.equal(shareCaption(1, 2000, n), `under 0.1% of ${n}`); // 0.05%
  assert.equal(shareCaption(1, 1000, n), `0.1% of ${n}`);
  assert.equal(shareCaption(99, 1000, n), `9.9% of ${n}`);
  assert.equal(shareCaption(100, 1000, n), `10% of ${n}`);
  assert.equal(shareCaption(9009, 14555, n), `62% of ${n}`);
  assert.equal(shareCaption(46, 823, n), `5.6% of ${n}`);
  assert.equal(shareCaption(5, 0, n), `no ${n}`);
  assert.equal(shareCaption(33, 33, 'rows read'), '100% of rows read');
  assert.equal(barWidth(0, 100), null);
  assert.equal(barWidth(5, 0), null);
  assert.equal(barWidth(46, 823), '5.59%');
  assert.equal(barWidth(2, 14555), '0.01%');
  // The share can never exceed 100%: count is always a subset of the denominator.
  for (const [count, denominator] of [[33, 33], [11, 33], [14555, 14555], [1, 1]]) {
    assert.ok(parseFloat(barWidth(count, denominator)!) <= 100);
    assert.ok(!shareCaption(count, denominator, n).match(/^1\d\d\.|^[2-9]\d\d/));
  }
});

test('formatDays and escapeHtml', () => {
  assert.equal(formatDays(-104), '−104.0 d');
  assert.equal(formatDays(528.5), '528.5 d');
  assert.equal(formatDays(1074), '1,074.0 d');
  assert.equal(formatDays(-0.0625), '−0.1 d');
  assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});
