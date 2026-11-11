// report.ts: per-file parse and check results in, one HTML string out.
// Pure: no fs, no process, no clock. Same input, same bytes.
// Layout, colours, type and wording follow the approved design.
import type { ParseResult, BrokenRow } from './parser.ts';
import { FALLBACK_DAY_HOURS, type CheckName, type CheckResult, type Finding } from './checks.ts';

export type FileReport = {
  fileName: string; // "CCA_R03_dt_24Oct11SC.xer"
  label: string; // "CCA R03"
  parsed: ParseResult;
  checks: CheckResult;
};

export type ReportOptions = {
  highFloatDays: number;
};

export const BROKEN_ROWS_PER_FILE = 50;
const NAME_MAX = 60;
const FILE_COLOURS = ['#111111', '#8a8a8a', '#c4c4c4'];

const CHECKS: { name: CheckName; title: string; describe: (o: ReportOptions) => string }[] = [
  { name: 'no_predecessor', title: 'No predecessor', describe: () => 'Nothing is linked before the task, so nothing controls when it starts.' },
  { name: 'no_successor', title: 'No successor', describe: () => 'Nothing is linked after the task, so a delay would not show anywhere.' },
  { name: 'negative_float', title: 'Negative float', describe: () => 'The task is already late against a required date.' },
  { name: 'high_float', title: 'High float', describe: (o) => `More than ${o.highFloatDays} working days of slack, which often points to missing or weak logic.` },
];

// ---------- small helpers ----------

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const num = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

/** "−104.0 d", "1,074.0 d". A real minus sign, one decimal, thousands separators. */
export function formatDays(days: number): string {
  const abs = Math.abs(days).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${days < 0 ? '−' : ''}${abs} d`;
}

/** The caption next to a chart number. `noun` is "incomplete tasks" or "rows read". */
export function shareCaption(count: number, denominator: number, noun: string): string {
  if (denominator === 0) return `no ${noun}`;
  if (count === 0) return 'none found';
  const share = (count / denominator) * 100;
  if (share < 0.1) return `under 0.1% of ${noun}`;
  if (share >= 10) return `${Math.round(share)}% of ${noun}`;
  return `${share.toFixed(1)}% of ${noun}`;
}

/** The share as a CSS percentage with two decimals, or null when there is no bar to draw. */
export function sharePercent(count: number, denominator: number): string | null {
  if (denominator === 0 || count === 0) return null;
  return `${((count / denominator) * 100).toFixed(2)}%`;
}

/** "the file", "both files", "all 3 files" */
function filesPhrase(n: number, one: string, two: string, many: (n: number) => string): string {
  return n === 1 ? one : n === 2 ? two : many(n);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// ---------- the report ----------

export function renderReport(files: FileReport[], options: ReportOptions): string {
  const rowsRejected = files.reduce((n, f) => n + f.parsed.tally.rejected, 0);
  const findingsTotal = files.reduce((n, f) => n + (f.checks.ok ? f.checks.findings.length : 0), 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>XER schedule check report</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<style>
body{margin:0;background:#fafafa}
a{color:#111111}a:hover{color:#5f5f5f}
</style>
</head>
<body>
<div style="font-family: Manrope, system-ui, sans-serif; background: #fafafa; color: #111111; padding: 72px 24px 96px">
<div style="max-width: 1040px; margin: 0 auto">
<header>
<div style="font-family: 'Geist Mono', ui-monospace, monospace; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #5f5f5f">XER schedule check</div>
<h1 style="margin: 14px 0 0; font-size: 44px; line-height: 1.1; font-weight: 600; letter-spacing: -0.02em; color: #111111; max-width: 820px">${plural(files.length, 'file', 'files')} read. ${plural(rowsRejected, 'row', 'rows')} rejected. ${plural(findingsTotal, 'finding', 'findings')}.</h1>
<p style="margin: 18px 0 0; font-size: 16px; line-height: 1.55; color: #5f5f5f; max-width: 640px">Every row in ${filesPhrase(files.length, 'the file', 'both files', (n) => `all ${n} files`)} was read and accounted for. The checks cover incomplete tasks only. High float threshold: ${options.highFloatDays} working days.</p>
</header>
${chartSection(files, options)}
${filesSection(files)}
${examplesSection(files)}
${brokenSection(files)}
${assumptionsSection()}
</div>
</div>
</body>
</html>
`;
}

// ---------- findings by check ----------

function chartSection(files: FileReport[], options: ReportOptions): string {
  const parts = files.map((f, i) => {
    if (!f.checks.ok) return `checks not run for ${escapeHtml(f.label)}`;
    const n = num(f.checks.summary.incompleteTasks);
    return i === 0 ? `${n} incomplete tasks in ${escapeHtml(f.label)}` : `${n} in ${escapeHtml(f.label)}`;
  });
  const outOf = joinAnd(parts);

  const rows = CHECKS.map((check) =>
    chartRow(
      check.title,
      check.describe(options),
      files.map((f, i) => {
        if (!f.checks.ok) return chartCell(f.label, colour(i), null, 'not run');
        const count = f.checks.summary[summaryKey(check.name)];
        return chartCell(f.label, colour(i), count, shareCaption(count, f.checks.summary.incompleteTasks, 'incomplete tasks'));
      }),
    ),
  );
  rows.push(
    chartRow(
      'Broken rows',
      'Rows the parser could not read with confidence.',
      files.map((f, i) => {
        const count = f.parsed.tally.rejected;
        return chartCell(f.label, colour(i), count, shareCaption(count, f.parsed.tally.kept + f.parsed.tally.rejected, 'rows read'));
      }),
    ),
  );

  return `<div style="margin: 72px 0 8px"><h2 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em; color: #111111">Findings by check</h2><p style="margin: 8px 0 0; font-size: 14px; line-height: 1.5; color: #5f5f5f; max-width: 640px">How many tasks each check flagged in each file, out of ${outOf}. One task can appear under more than one check.</p></div>

${chartFigure(files)}
<div style="margin-top: 28px; border-bottom: 1px solid #e4e4e4">
${rows.join('\n')}
</div>`;
}

/** "a", "a and b", "a, b and c" */
function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ---------- the bar chart: plain HTML and CSS ----------

/** One bar of the chart: its count label and, when there is something to draw, its height. */
type Bar = { label: string; height: string | null };

function bars(files: FileReport[], check: CheckName | 'broken_rows'): Bar[] {
  return files.map((f) => {
    if (check === 'broken_rows') {
      const count = f.parsed.tally.rejected;
      return { label: num(count), height: sharePercent(count, f.parsed.tally.kept + f.parsed.tally.rejected) };
    }
    if (!f.checks.ok) return { label: '–', height: null };
    const count = f.checks.summary[summaryKey(check)];
    return { label: num(count), height: sharePercent(count, f.checks.summary.incompleteTasks) };
  });
}

function chartFigure(files: FileReport[]): string {
  const groups: { title: string; bars: Bar[] }[] = [
    ...CHECKS.map((c) => ({ title: c.title, bars: bars(files, c.name) })),
    { title: 'Broken rows', bars: bars(files, 'broken_rows') },
  ];

  // Spoken version for screen readers: each check with the count per file.
  const spoken = groups.map(
    (g) => `${g.title}: ${joinAnd(g.bars.map((b, i) => (b.label === '–' ? `not run in ${files[i].label}` : `${b.label} in ${files[i].label}`)))}.`,
  );
  const ariaLabel = escapeHtml(`Bar chart. ${spoken.join(' ')}`);

  const legend = files
    .map(
      (f, i) =>
        `<span style="display: inline-flex; align-items: center; gap: 8px"><span aria-hidden="true" style="display: inline-block; width: 12px; height: 12px; background: ${colour(i)}"></span>${escapeHtml(f.label)}</span>`,
    )
    .join('\n');

  const axis = [100, 75, 50, 25, 0]
    .map(
      (pct) =>
        `<span style="position: absolute; right: 10px; top: ${100 - pct}%; transform: translateY(-50%); font-family: 'Geist Mono', ui-monospace, monospace; font-size: 12px; color: #5f5f5f">${pct}%</span>`,
    )
    .join('');
  const gridlines = [0, 25, 50, 75]
    .map((top) => `<div style="position: absolute; left: 0; right: 0; top: ${top}%; height: 1px; background: #e4e4e4"></div>`)
    .join('');

  const columns = (g: { bars: Bar[] }) =>
    g.bars
      .map((b, i) => {
        const bar = b.height === null ? '' : `<div style="width: 100%; height: ${b.height}; min-height: 2px; background: ${colour(i)}"></div>`;
        const labelColour = b.height === null ? '#5f5f5f' : '#111111';
        return `<div style="width: 36px; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center"><span style="font-family: 'Geist Mono', ui-monospace, monospace; font-size: 12px; white-space: nowrap; margin-bottom: 6px; color: ${labelColour}">${b.label}</span>${bar}</div>`;
      })
      .join('');
  const groupHtml = groups
    .map((g) => `<div style="flex: 1 1 0; min-width: 0; height: 100%; display: flex; justify-content: center; align-items: flex-end; gap: 8px">${columns(g)}</div>`)
    .join('');
  const categories = groups
    .map((g) => `<div style="flex: 1 1 0; min-width: 0; text-align: center; font-size: 13px; font-weight: 500; color: #111111; padding: 0 4px">${g.title}</div>`)
    .join('');

  return `<figure style="margin: 28px 0 0; border: 1px solid #e4e4e4; background: #ffffff; padding: 28px">
<figcaption style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 10px 28px">
<span style="font-size: 16px; font-weight: 600; color: #111111">Share flagged by each check</span>
<span style="display: inline-flex; flex-wrap: wrap; gap: 6px 22px; font-size: 13px; color: #111111">
${legend}
</span>
</figcaption>
<div style="overflow-x: auto">
<div role="img" aria-label="${ariaLabel}" style="min-width: 560px; padding-top: 44px">
<div style="display: flex">
<div style="position: relative; flex: 0 0 52px; height: 280px">${axis}</div>
<div style="position: relative; flex: 1 1 auto; min-width: 0; height: 280px; border-bottom: 1px solid #111111">${gridlines}
<div style="position: absolute; left: 0; right: 0; top: 0; height: 100%; display: flex">${groupHtml}</div>
</div>
</div>
<div style="display: flex; margin: 12px 0 0 52px">${categories}</div>
</div>
</div>
<p style="margin: 20px 0 0; font-size: 13px; line-height: 1.5; color: #5f5f5f">Bar height is the share of incomplete tasks, or of rows read for broken rows. The number above each bar is the count.</p>
</figure>`;
}

function summaryKey(check: CheckName): 'noPredecessor' | 'noSuccessor' | 'negativeFloat' | 'highFloat' {
  switch (check) {
    case 'no_predecessor':
      return 'noPredecessor';
    case 'no_successor':
      return 'noSuccessor';
    case 'negative_float':
      return 'negativeFloat';
    case 'high_float':
      return 'highFloat';
  }
}

const colour = (i: number) => FILE_COLOURS[i % FILE_COLOURS.length];

function chartRow(title: string, description: string, cells: string[]): string {
  return `<div style="display: flex; flex-wrap: wrap; gap: 24px 40px; padding: 28px 0; border-top: 1px solid #e4e4e4">
<div style="flex: 1.2 1 260px; min-width: 0">
<div style="font-size: 18px; font-weight: 600; color: #111111">${title}</div>
<div style="font-size: 14px; line-height: 1.5; color: #5f5f5f; margin-top: 6px; max-width: 320px">${description}</div>
</div>
${cells.join('\n')}
</div>`;
}

/** count null means the check did not run: the number slot shows a dash. */
function chartCell(label: string, colour: string, count: number | null, caption: string): string {
  return `<div style="flex: 1 1 220px; min-width: 0">
<div style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #5f5f5f"><span aria-hidden="true" style="display: inline-block; width: 8px; height: 8px; background: ${colour}"></span>${escapeHtml(label)}</div>
<div style="display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-top: 8px">
<span style="font-size: 36px; line-height: 1; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: #111111">${count === null ? '–' : num(count)}</span>
<span style="font-size: 14px; color: #5f5f5f">${caption}</span>
</div>
</div>`;
}

// ---------- files ----------

function filesSection(files: FileReport[]): string {
  return `<div style="margin: 72px 0 8px"><h2 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em; color: #111111">Files</h2></div>
<div style="display: flex; flex-wrap: wrap; gap: 24px; margin-top: 20px">
${files.map((f, i) => filePanel(f, colour(i))).join('\n')}
</div>`;
}

function filePanel(file: FileReport, colour: string): string {
  const { parsed, checks } = file;
  const tasks = parsed.tables.get('TASK')?.rows ?? [];
  const links = parsed.tables.get('TASKPRED');
  const calendars = parsed.tables.get('CALENDAR');

  const status = { TK_NotStart: 0, TK_Active: 0, TK_Complete: 0 };
  let otherStatus = 0;
  for (const t of tasks) {
    const s = t.fields['status_code'];
    if (s in status) status[s as keyof typeof status]++;
    else otherStatus++;
  }
  let statusText = `${num(status.TK_NotStart)} / ${num(status.TK_Active)} / ${num(status.TK_Complete)}`;
  if (otherStatus > 0) statusText += ` (+ ${num(otherStatus)} other)`;

  let calendarText = 'none';
  if (calendars !== undefined) {
    const hours = [...new Set(calendars.rows.map((c) => c.fields['day_hr_cnt']))].map((h) => (h === '' ? 'blank' : `${escapeHtml(h)} h`));
    calendarText = hours.length === 0 ? num(calendars.rows.length) : `${num(calendars.rows.length)} (${hours.join(', ')})`;
  }

  const notRun = 'not run';
  const rows: [string, string][] = [
    ['Tasks', num(tasks.length)],
    ['Links', num(links?.rows.length ?? 0)],
    ['Not started / active / complete', statusText],
    ['Calendars (hours per day)', calendarText],
    ['Completed tasks skipped', checks.ok ? num(checks.summary.completeSkipped) : notRun],
    ['Blank float, not evaluated', checks.ok ? num(checks.summary.blankFloatNotEvaluated) : notRun],
    [`Calendar fallback to ${FALLBACK_DAY_HOURS} h`, checks.ok ? num(checks.summary.calendarFallbackUsed) : notRun],
  ];
  const rowHtml = rows
    .map(
      ([k, v]) =>
        `<div style="display: flex; justify-content: space-between; gap: 16px; padding: 9px 0; border-top: 1px solid #ececec"><span style="font-size: 13px; color: #5f5f5f">${k}</span><span style="font-family: 'Geist Mono', ui-monospace, monospace; font-size: 13px; color: #111111; text-align: right">${v}</span></div>`,
    )
    .join('');

  const error = checks.ok ? '' : `\n<div style="margin-top: 8px; font-size: 14px; line-height: 1.5; color: #5f5f5f">Checks not run: ${escapeHtml(checks.error)}</div>`;

  return `<section style="flex: 1 1 420px; min-width: 0; border: 1px solid #e4e4e4; background: #ffffff; padding: 28px">
<div style="display: flex; align-items: center; gap: 10px">
<span aria-hidden="true" style="display: inline-block; width: 12px; height: 12px; background: ${colour}"></span>
<h3 style="margin: 0; font-size: 18px; font-weight: 600; color: #111111">${escapeHtml(file.label)}</h3>
</div>
<div style="font-family: 'Geist Mono', ui-monospace, monospace; font-size: 12px; color: #5f5f5f; margin-top: 8px; overflow-wrap: anywhere">${escapeHtml(file.fileName)} · P6 ${escapeHtml(parsed.version ?? 'unknown')} · exported ${escapeHtml(parsed.exportDate ?? 'unknown')}</div>${error}
<div style="margin-top: 20px">${rowHtml}</div>
<div style="font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #5f5f5f; margin: 26px 0 6px">Row tally</div>
${tallyTable(parsed)}
</section>`;
}

function tallyTable(parsed: ParseResult): string {
  const th = (text: string, align: 'left' | 'right') =>
    `<th scope="col" style="text-align: ${align}; font-weight: 500; color: #5f5f5f; padding: 8px 0; border-bottom: 1px solid #111111">${text}</th>`;
  const td = (text: string, align: 'left' | 'right') =>
    `<td style="text-align: ${align}; padding: 8px 0; border-bottom: 1px solid #ececec; color: #111111">${text}</td>`;
  const row = (name: string, read: string, kept: string, rejected: string) =>
    `<tr>${td(name, 'left')}${td(read, 'right')}${td(kept, 'right')}${td(rejected, 'right')}</tr>`;

  const all = { read: 0, kept: 0, rejected: 0 };
  for (const t of parsed.tables.values()) {
    all.read += t.read;
    all.kept += t.kept;
    all.rejected += t.rejected;
  }
  const rows = [row('All tables', num(all.read), num(all.kept), num(all.rejected))];
  for (const name of ['TASK', 'TASKPRED', 'CALENDAR']) {
    const t = parsed.tables.get(name);
    if (t !== undefined) rows.push(row(escapeHtml(name), num(t.read), num(t.kept), num(t.rejected)));
  }
  const outside = parsed.broken.filter((b) => b.table === null).length;
  if (outside > 0) rows.push(row('Lines outside any table', '–', '–', num(outside)));

  return `<div style="overflow-x: auto"><table style="width: 100%; border-collapse: collapse; font-family: 'Geist Mono', ui-monospace, monospace; font-size: 13px"><thead><tr>${th('Table', 'left')}${th('Read', 'right')}${th('Kept', 'right')}${th('Rejected', 'right')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

// ---------- example findings ----------

/** The single worst finding of one check: lowest float for negative, highest for high, first in file order otherwise. */
export function worstFinding(findings: Finding[], check: CheckName): Finding | null {
  let best: Finding | null = null;
  for (const f of findings) {
    if (f.check !== check) continue;
    if (best === null) best = f;
    else if (check === 'negative_float' && f.floatDays! < best.floatDays!) best = f;
    else if (check === 'high_float' && f.floatDays! > best.floatDays!) best = f;
  }
  return best;
}

function examplesSection(files: FileReport[]): string {
  const rows: string[] = [];
  for (const file of files) {
    if (!file.checks.ok) continue;
    for (const check of CHECKS) {
      const f = worstFinding(file.checks.findings, check.name);
      if (f === null) continue;
      rows.push(
        `<tr>${cell(check.title)}${cell(escapeHtml(file.label))}${cell(escapeHtml(f.task_code), 'mono')}${cell(escapeHtml(truncate(f.task_name, NAME_MAX)))}${cell(f.floatDays === null ? '' : formatDays(f.floatDays), 'mono', 'right')}${cell(String(f.line), 'mono', 'right')}</tr>`,
      );
    }
  }

  const heading = `<div style="margin: 72px 0 8px"><h2 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em; color: #111111">Example findings</h2><p style="margin: 8px 0 0; font-size: 14px; line-height: 1.5; color: #5f5f5f; max-width: 640px">The worst finding from each check in each file, with the line in the source file so anyone can look it up.</p></div>`;
  if (rows.length === 0) {
    return `${heading}
<div style="margin-top: 20px; border: 1px solid #e4e4e4; background: #ffffff; padding: 28px">
<div style="font-size: 16px; font-weight: 600; color: #111111">No findings in ${filesPhrase(files.length, 'the file', 'either file', () => 'any file')}.</div>
</div>`;
  }
  const head = `<thead><tr>${header('Check')}${header('File')}${header('Activity ID')}${header('Activity name')}${header('Float', 'right')}${header('Line', 'right')}</tr></thead>`;
  return `${heading}
<div style="margin-top: 20px"><div style="overflow-x: auto; border: 1px solid #e4e4e4; background: #ffffff"><table style="width: 100%; min-width: 760px; border-collapse: collapse; font-size: 13px">${head}<tbody>${rows.join('')}</tbody></table></div></div>`;
}

function header(text: string, align: 'left' | 'right' = 'left'): string {
  return `<th scope="col" style="text-align: ${align}; font-weight: 500; color: #5f5f5f; padding: 12px 16px; border-bottom: 1px solid #111111">${text}</th>`;
}

function cell(html: string, font: 'mono' | 'text' = 'text', align: 'left' | 'right' = 'left'): string {
  const family = font === 'mono' ? `font-family: 'Geist Mono', ui-monospace, monospace;` : '';
  return `<td style="text-align: ${align}; padding: 12px 16px; border-bottom: 1px solid #ececec; color: #111111; ${family}">${html}</td>`;
}

// ---------- broken rows ----------

function brokenSection(files: FileReport[]): string {
  const heading = `<div style="margin: 72px 0 8px"><h2 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em; color: #111111">Broken rows</h2></div>`;
  const anyBroken = files.some((f) => f.parsed.broken.length > 0);

  let body: string;
  if (!anyBroken) {
    body = `<div style="margin-top: 20px; border: 1px solid #e4e4e4; background: #ffffff; padding: 28px">
<div style="font-size: 16px; font-weight: 600; color: #111111">None found in ${filesPhrase(files.length, 'the file', 'either file', () => 'any file')}.</div>
<p style="margin: 10px 0 0; font-size: 14px; line-height: 1.55; color: #5f5f5f; max-width: 720px">Checked on every row: field count against the header, rows outside a table, missing or duplicate task IDs, text in number fields, and links to tasks that are not in the file. When a row fails, it is listed here with file, table, line and reason.</p>
</div>`;
  } else {
    const rows: string[] = [];
    const notes: string[] = [];
    for (const file of files) {
      const broken: BrokenRow[] = file.parsed.broken;
      if (broken.length === 0) continue;
      for (const b of broken.slice(0, BROKEN_ROWS_PER_FILE)) {
        rows.push(
          `<tr>${cell(escapeHtml(file.label))}${cell(b.table === null ? '–' : escapeHtml(b.table), 'mono')}${cell(String(b.line), 'mono', 'right')}${cell(escapeHtml(b.reason))}</tr>`,
        );
      }
      notes.push(
        broken.length > BROKEN_ROWS_PER_FILE
          ? `Showing ${num(BROKEN_ROWS_PER_FILE)} of ${num(broken.length)} broken rows in ${escapeHtml(file.label)}`
          : `All ${plural(broken.length, 'broken row', 'broken rows')} in ${escapeHtml(file.label)}`,
      );
    }
    const head = `<thead><tr>${header('File')}${header('Table')}${header('Line', 'right')}${header('Reason')}</tr></thead>`;
    body = `<div style="margin-top: 20px"><div style="overflow-x: auto; border: 1px solid #e4e4e4; background: #ffffff"><table style="width: 100%; min-width: 760px; border-collapse: collapse; font-size: 13px">${head}<tbody>${rows.join('')}</tbody></table></div></div>
<div style="font-family: 'Geist Mono', ui-monospace, monospace; font-size: 12px; color: #5f5f5f; margin-top: 12px">${notes.join(' · ')}</div>`;
  }

  const warnings: string[] = [];
  for (const file of files) {
    for (const w of file.parsed.warnings) warnings.push(`${escapeHtml(file.label)}: ${escapeHtml(w)}`);
  }
  const warningHtml =
    warnings.length === 0
      ? ''
      : `
<div style="font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #5f5f5f; margin: 26px 0 6px">Warnings</div>
${list(warnings)}`;

  return `${heading}
${body}${warningHtml}`;
}

function list(items: string[]): string {
  const li = items.map((text) => `<li style="padding: 10px 0; border-top: 1px solid #e4e4e4; font-size: 14px; line-height: 1.5; color: #111111">${text}</li>`);
  return `<ul style="list-style: none; margin: 20px 0 0; padding: 0; border-bottom: 1px solid #e4e4e4">${li.join('')}</ul>`;
}

// ---------- assumptions ----------

function assumptionsSection(): string {
  return `<div style="margin: 72px 0 8px"><h2 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em; color: #111111">Assumptions</h2></div>
${list([
  'Completed tasks are skipped in all three checks.',
  'Level-of-effort and WBS summary rows are left out of the link check.',
  'Start milestones may have no predecessor. Finish milestones may have no successor.',
  'Blank float is unknown, not zero. It is counted, never guessed.',
  `Hours become days using each task's own calendar. ${FALLBACK_DAY_HOURS} hours is used only when the calendar is missing or has no usable hours, and that is counted.`,
  'A link to a task that is not in the file does not count as a link.',
])}`;
}
