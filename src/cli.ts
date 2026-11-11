// cli.ts: the only file that touches the file system.
// Reads .xer files, decodes them as windows-1252, parses, runs the checks,
// prints the results and writes one HTML report.
//
//   npx tsx src/cli.ts [--high-float-days N] [--report PATH] [file.xer ...]
//
// With no files it reads every .xer in data/ in name order.
// Exit 0 when the tool did its job, even if the schedules have problems.
// Exit 1 when it could not: no files, a file that cannot be read, a tally
// that does not reconcile, checks that could not run, or bad arguments.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseXer, type ParseResult } from './parser.ts';
import { runChecks, DEFAULT_HIGH_FLOAT_DAYS, type CheckResult } from './checks.ts';
import { renderReport, type FileReport } from './report.ts';

const DATA_DIR = 'data';
const DEFAULT_REPORT = 'report.html';
const BROKEN_ROWS_SHOWN = 50;

const USAGE = `usage: npx tsx src/cli.ts [--high-float-days N] [--report PATH] [file.xer ...]
  --high-float-days N   flag float above N working days (default ${DEFAULT_HIGH_FLOAT_DAYS})
  --report PATH         where to write the HTML report (default ${DEFAULT_REPORT})
  file.xer ...          files to check (default: every .xer in ${DATA_DIR}/)`;

type Options = { highFloatDays: number; reportPath: string; paths: string[] };

/** Returns the options, or an error message. */
function parseArgs(argv: string[]): Options | string {
  const options: Options = { highFloatDays: DEFAULT_HIGH_FLOAT_DAYS, reportPath: DEFAULT_REPORT, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--high-float-days') {
      const value = argv[++i] ?? '';
      if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) return `--high-float-days needs a positive number, got "${value}"`;
      options.highFloatDays = Number(value);
    } else if (arg === '--report') {
      const value = argv[++i] ?? '';
      if (value === '') return '--report needs a path';
      options.reportPath = value;
    } else if (arg.startsWith('-')) {
      return `unknown option ${arg}`;
    } else {
      options.paths.push(arg);
    }
  }
  return options;
}

/** "CCA_R03_dt_24Oct11SC.xer" -> "CCA R03": the name without extension, first two underscore-separated parts. */
function labelFor(path: string): string {
  return basename(path, '.xer').split('_').slice(0, 2).join(' ');
}

function main(argv: string[]): number {
  const options = parseArgs(argv);
  if (typeof options === 'string') {
    console.error(options);
    console.error(USAGE);
    return 1;
  }

  let paths = options.paths;
  if (paths.length === 0) {
    let names: string[];
    try {
      names = readdirSync(DATA_DIR).filter((n) => n.toLowerCase().endsWith('.xer')).sort();
    } catch (e) {
      console.error(`cannot read ${DATA_DIR}/: ${(e as Error).message}`);
      return 1;
    }
    if (names.length === 0) {
      console.error(`no .xer files in ${DATA_DIR}/`);
      return 1;
    }
    paths = names.map((n) => join(DATA_DIR, n));
  }

  const problems: string[] = []; // reasons for a non-zero exit
  const files: FileReport[] = [];
  const decoder = new TextDecoder('windows-1252');

  for (const path of paths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (e) {
      problems.push(`cannot read ${path}: ${(e as Error).message}`);
      continue;
    }
    const parsed = parseXer(decoder.decode(bytes));
    const checks = runChecks(parsed, { highFloatDays: options.highFloatDays });
    files.push({ fileName: basename(path), label: labelFor(path), parsed, checks });
    problems.push(...printFile(path, parsed, checks, options.highFloatDays));
  }

  if (files.length > 0) {
    writeFileSync(options.reportPath, renderReport(files, { highFloatDays: options.highFloatDays }));
    console.log(`\nwrote ${options.reportPath} (${files.length} file${files.length === 1 ? '' : 's'})`);
  }

  if (problems.length > 0) {
    console.error('\nexit 1:');
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  return 0;
}

/** Prints one file's results. Returns the problems that make the exit code non-zero. */
function printFile(path: string, parsed: ParseResult, checks: CheckResult, highFloatDays: number): string[] {
  const problems: string[] = [];
  console.log(`\n=== ${path} ===`);
  console.log(`P6 version: ${parsed.version ?? 'unknown'} (exported ${parsed.exportDate ?? 'unknown'})`);

  // Row tally: the three tables the checks use, then everything.
  const col = (s: string | number, w: number) => String(s).padStart(w);
  console.log(`${'table'.padEnd(12)} ${col('read', 8)} ${col('kept', 8)} ${col('rejected', 9)}`);
  for (const name of ['TASK', 'TASKPRED', 'CALENDAR']) {
    const t = parsed.tables.get(name);
    if (t === undefined) console.log(`${name.padEnd(12)} ${col('(absent)', 8)}`);
    else console.log(`${name.padEnd(12)} ${col(t.read, 8)} ${col(t.kept, 8)} ${col(t.rejected, 9)}`);
  }
  const all = { read: 0, kept: 0, rejected: 0 };
  for (const t of parsed.tables.values()) {
    all.read += t.read;
    all.kept += t.kept;
    all.rejected += t.rejected;
    if (t.read !== t.kept + t.rejected) problems.push(`${path}: table ${t.name} does not reconcile: read ${t.read} != kept ${t.kept} + rejected ${t.rejected}`);
  }
  console.log(`${'All tables'.padEnd(12)} ${col(all.read, 8)} ${col(all.kept, 8)} ${col(all.rejected, 9)}`);

  const { tally } = parsed;
  const sum = tally.structural + tally.kept + tally.rejected + tally.blank + tally.afterEnd;
  console.log(`lines: ${tally.total} = structural ${tally.structural} + kept ${tally.kept} + rejected ${tally.rejected} + blank ${tally.blank} + after %E ${tally.afterEnd}`);
  if (sum !== tally.total) problems.push(`${path}: line tally does not reconcile: ${tally.total} lines, buckets sum to ${sum}`);

  if (checks.ok) {
    const s = checks.summary;
    console.log('checks:');
    console.log(`  complete tasks (skipped): ${s.completeSkipped}`);
    console.log(`  incomplete tasks:         ${s.incompleteTasks}`);
    console.log(`  no predecessor:           ${s.noPredecessor}`);
    console.log(`  no successor:             ${s.noSuccessor}`);
    console.log(`  negative float:           ${s.negativeFloat}`);
    console.log(`  high float over ${highFloatDays} days: ${s.highFloat}`);
    console.log(`  blank float not evaluated: ${s.blankFloatNotEvaluated}`);
    console.log(`  calendar fallback used:   ${s.calendarFallbackUsed}`);
  } else {
    console.log(`checks: not run (${checks.error})`);
    problems.push(`${path}: ${checks.error}`);
  }

  console.log(`broken rows: ${parsed.broken.length}`);
  for (const b of parsed.broken.slice(0, BROKEN_ROWS_SHOWN)) console.log(`  line ${b.line} [${b.table ?? '-'}]: ${b.reason}`);
  if (parsed.broken.length > BROKEN_ROWS_SHOWN) console.log(`  ... showing ${BROKEN_ROWS_SHOWN} of ${parsed.broken.length}`);

  console.log(`warnings: ${parsed.warnings.length === 0 ? 'none' : ''}`);
  for (const w of parsed.warnings) console.log(`  ${w}`);

  return problems;
}

process.exitCode = main(process.argv.slice(2));
