// checks.ts: parser result in, findings out. Pure: no fs, no process.
import type { ParseResult, Table } from './parser.ts';

export type CheckName = 'no_predecessor' | 'no_successor' | 'negative_float' | 'high_float';

export type Finding = {
  check: CheckName;
  task_code: string;
  task_name: string;
  floatDays: number | null; // null for the link checks
  line: number;
};

export type Summary = {
  incompleteTasks: number;
  completeSkipped: number;
  noPredecessor: number;
  noSuccessor: number;
  negativeFloat: number;
  highFloat: number;
  blankFloatNotEvaluated: number;
  calendarFallbackUsed: number;
};

export type CheckOptions = {
  highFloatDays?: number; // default 44, from the DCMA 14-point assessment
};

export type CheckResult =
  | { ok: true; findings: Finding[]; summary: Summary }
  | { ok: false; error: string };

export const DEFAULT_HIGH_FLOAT_DAYS = 44;
export const FALLBACK_DAY_HOURS = 8;

const REQUIRED: Record<string, string[]> = {
  TASK: ['task_id', 'task_code', 'task_name', 'task_type', 'status_code', 'total_float_hr_cnt', 'clndr_id'],
  TASKPRED: ['task_id', 'pred_task_id'],
};
const CALENDAR_COLUMNS = ['clndr_id', 'day_hr_cnt'];

export function runChecks(parsed: ParseResult, options: CheckOptions = {}): CheckResult {
  const highFloatDays = options.highFloatDays ?? DEFAULT_HIGH_FLOAT_DAYS;

  // Refuse to run on a file that lacks what the checks need. A file with no
  // float column must never report "0 negative float".
  const missing: string[] = [];
  for (const [name, columns] of Object.entries(REQUIRED)) {
    const table = parsed.tables.get(name);
    if (table === undefined) missing.push(`table ${name}`);
    else missing.push(...missingColumns(table, columns));
  }
  // CALENDAR may be absent (every task then takes the fallback), but if it is
  // present it must have the columns we read.
  const calendar = parsed.tables.get('CALENDAR');
  if (calendar !== undefined) missing.push(...missingColumns(calendar, CALENDAR_COLUMNS));
  if (missing.length > 0) return { ok: false, error: `cannot run checks, missing: ${missing.join(', ')}` };

  const tasks = parsed.tables.get('TASK')!.rows;
  const links = parsed.tables.get('TASKPRED')!.rows;

  // Only kept links count. Both ends of a kept link are kept tasks (the parser
  // rejected the rest).
  const hasPredecessor = new Set<string>();
  const hasSuccessor = new Set<string>();
  for (const link of links) {
    hasPredecessor.add(link.fields['task_id']);
    hasSuccessor.add(link.fields['pred_task_id']);
  }

  // Hours per day by calendar id. Missing, blank or 0 means "use the fallback".
  const dayHours = new Map<string, number>();
  for (const cal of calendar?.rows ?? []) {
    const hours = cal.fields['day_hr_cnt'];
    if (hours !== '' && Number(hours) !== 0) dayHours.set(cal.fields['clndr_id'], Number(hours));
  }

  const findings: Finding[] = [];
  const summary: Summary = {
    incompleteTasks: 0,
    completeSkipped: 0,
    noPredecessor: 0,
    noSuccessor: 0,
    negativeFloat: 0,
    highFloat: 0,
    blankFloatNotEvaluated: 0,
    calendarFallbackUsed: 0,
  };

  for (const task of tasks) {
    const f = task.fields;
    if (f['status_code'] === 'TK_Complete') {
      summary.completeSkipped++;
      continue;
    }
    summary.incompleteTasks++;
    const id = f['task_id'];
    const type = f['task_type'];
    const add = (check: CheckName, floatDays: number | null) => {
      findings.push({ check, task_code: f['task_code'], task_name: f['task_name'], floatDays, line: task.line });
    };

    // Check 1: missing links.
    if (type !== 'TT_LOE' && type !== 'TT_WBS') {
      if (type !== 'TT_Mile' && !hasPredecessor.has(id)) {
        summary.noPredecessor++;
        add('no_predecessor', null);
      }
      if (type !== 'TT_FinMile' && !hasSuccessor.has(id)) {
        summary.noSuccessor++;
        add('no_successor', null);
      }
    }

    // Checks 2 and 3: float. Blank means unknown, so it is not evaluated.
    const floatText = f['total_float_hr_cnt'];
    if (floatText === '') {
      summary.blankFloatNotEvaluated++;
      continue;
    }
    const hours = Number(floatText); // safe: the parser enforced the number regex
    let perDay = dayHours.get(f['clndr_id']);
    if (perDay === undefined) {
      perDay = FALLBACK_DAY_HOURS;
      summary.calendarFallbackUsed++;
    }
    const days = hours / perDay;

    if (hours < 0) {
      summary.negativeFloat++;
      add('negative_float', days);
    }
    if (days > highFloatDays) {
      summary.highFloat++;
      add('high_float', days);
    }
  }

  return { ok: true, findings, summary };
}

function missingColumns(table: Table, columns: string[]): string[] {
  return columns.filter((c) => !table.columns.includes(c)).map((c) => `column ${table.name}.${c}`);
}
