// Runs src/cli.ts as a child process, the way a user would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.ts');
const fixture = join(root, 'tests', 'fixture.xer');
// tsx's loader by absolute path, so the CLI also runs from a temp working directory.
const tsxFlags = ['--require', join(root, 'node_modules/tsx/dist/preflight.cjs'), '--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href];

function run(args: string[], cwd = root) {
  const r = spawnSync(process.execPath, [...tsxFlags, cli, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const tempDir = () => mkdtempSync(join(tmpdir(), 'xer-cli-'));

test('fixture: exit 0, every broken row printed, report written where asked', () => {
  const report = join(tempDir(), 'out.html');
  const r = run([fixture, '--report', report]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('P6 version: 6.0 (exported 2026-11-11)'));
  assert.ok(r.stdout.includes('TASK               15       11         4'));
  assert.ok(r.stdout.includes('TASKPRED           11        8         3'));
  assert.ok(r.stdout.includes('CALENDAR            4        3         1'));
  assert.ok(r.stdout.includes('All tables         30       22         8'));
  assert.ok(r.stdout.includes('lines: 42 = structural 8 + kept 22 + rejected 11 + blank 0 + after %E 1'));
  assert.ok(r.stdout.includes('high float over 44 days: 2'));
  assert.ok(r.stdout.includes('blank float not evaluated: 1'));
  assert.ok(r.stdout.includes('calendar fallback used:   3'));
  assert.ok(r.stdout.includes('broken rows: 11'));
  for (const line of [2, 3, 9, 23, 24, 25, 26, 27, 38, 39, 40]) assert.ok(r.stdout.includes(`  line ${line} [`), `line ${line}`);
  assert.ok(r.stdout.includes('line 2 [-]: %R data row before any %T table line'));
  assert.ok(r.stdout.includes('line 40 [TASKPRED]: pred_task_id 11 refers to a rejected TASK row'));
  assert.ok(r.stdout.includes('  1 line(s) after %E, first at line 42'));
  assert.ok(r.stdout.includes(`wrote ${report} (1 file)`));
  assert.equal(r.stderr, '');
  assert.ok(readFileSync(report, 'utf8').includes('1 file read. 11 rows rejected. 6 findings.'));
});

test('--high-float-days changes the threshold', () => {
  const r = run([fixture, '--high-float-days', '4', '--report', join(tempDir(), 'out.html')]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('high float over 4 days: 4'));
});

test('no arguments: reads data/ in the working directory and writes report.html there', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'data'));
  copyFileSync(fixture, join(dir, 'data', 'b_second.xer'));
  copyFileSync(fixture, join(dir, 'data', 'a_first.xer'));
  const r = run([], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('=== data/a_first.xer ===') < r.stdout.indexOf('=== data/b_second.xer ==='), 'name order');
  assert.ok(r.stdout.includes('wrote report.html (2 files)'));
  assert.ok(readFileSync(join(dir, 'report.html'), 'utf8').includes('2 files read. 22 rows rejected. 12 findings.'));
});

test('exit 1: no .xer files, or no data/ at all', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'data'));
  const empty = run([], dir);
  assert.equal(empty.status, 1);
  assert.ok(empty.stderr.includes('no .xer files in data/'));
  assert.ok(!existsSync(join(dir, 'report.html')));
  const missing = run([], tempDir());
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes('cannot read data/'));
});

test('exit 1: a file that cannot be read, but the other file is still checked and reported', () => {
  const report = join(tempDir(), 'out.html');
  const r = run([join(tempDir(), 'nope.xer'), fixture, '--report', report]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('cannot read'));
  assert.ok(r.stdout.includes('broken rows: 11'));
  assert.ok(readFileSync(report, 'utf8').includes('1 file read.'));
});

test('exit 1: checks could not run, report still written and says so', () => {
  const dir = tempDir();
  const bad = join(dir, 'nofloat.xer');
  writeFileSync(bad, 'ERMHDR\t7.0\r\n%T\tTASK\r\n%F\ttask_id\ttask_code\ttask_name\ttask_type\tstatus_code\tclndr_id\r\n%R\t1\tA\tA\tTT_Task\tTK_NotStart\tC\r\n%T\tTASKPRED\r\n%F\ttask_id\tpred_task_id\r\n%E\r\n');
  const report = join(dir, 'out.html');
  const r = run([bad, '--report', report]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('checks: not run (cannot run checks, missing: column TASK.total_float_hr_cnt)'));
  assert.ok(r.stderr.includes('missing: column TASK.total_float_hr_cnt'));
  assert.ok(readFileSync(report, 'utf8').includes('Checks not run:'));
});

test('exit 1: bad arguments', () => {
  const bad = run(['--high-float-days', 'abc']);
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes('--high-float-days needs a positive number'));
  assert.ok(bad.stderr.includes('usage:'));
  assert.equal(run(['--bogus']).status, 1);
  assert.equal(run(['--high-float-days', '0']).status, 1);
  assert.equal(run([fixture, '--report']).status, 1);
});
