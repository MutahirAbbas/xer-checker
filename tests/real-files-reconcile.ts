// TEMPORARY. Parses every .xer in data/ and prints the reconciliation per
// table, the line tally, run time, peak memory and the non-ASCII lines.
// Replaced by src/cli.ts in step 4. Run: npx tsx tests/real-files-reconcile.ts
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseXer } from '../src/parser.ts';

const fileArg = process.argv[2];
if (fileArg === undefined) {
  // One child process per file so "peak memory" is per file, not cumulative.
  const dir = join(process.cwd(), 'data');
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.xer')).sort()) {
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], join(dir, name)], {
      stdio: 'inherit',
    });
    if (r.status !== 0) process.exitCode = r.status ?? 1;
  }
} else {
  if (!checkOne(fileArg)) process.exitCode = 1;
}

function checkOne(path: string): boolean {
  const t0 = performance.now();
  const bytes = readFileSync(path);
  const decoder = new TextDecoder('windows-1252');

  // Count lines that contain any byte above 0x7F, per table, keeping the
  // first two examples of each table. Done on the raw bytes, before decoding.
  const highByTable = new Map<string, { count: number; examples: { line: number; text: string }[] }>();
  let table = '-';
  let lineNo = 1;
  let start = 0;
  let hasHigh = false;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      if (bytes[start] === 0x25 && bytes[start + 1] === 0x54) {
        // "%T" line: remember the table name for the lines that follow
        table = decoder.decode(bytes.subarray(start, i)).replace(/\r$/, '').split('\t')[1] ?? '-';
      }
      if (hasHigh) {
        const entry = highByTable.get(table) ?? { count: 0, examples: [] };
        entry.count++;
        if (entry.examples.length < 2) entry.examples.push({ line: lineNo, text: decoder.decode(bytes.subarray(start, i)) });
        highByTable.set(table, entry);
      }
      lineNo++;
      start = i + 1;
      hasHigh = false;
    } else if (bytes[i] > 0x7f) {
      hasHigh = true;
    }
  }

  const result = parseXer(decoder.decode(bytes));
  const ms = performance.now() - t0;
  const peakMb = process.resourceUsage().maxRSS / 1024;

  let ok = true;
  console.log(`\n=== ${path} ===`);
  console.log(`P6 version: ${result.version}`);
  console.log(`${'table'.padEnd(14)} ${'read'.padStart(8)} ${'kept'.padStart(8)} ${'rejected'.padStart(9)}`);
  let totalRead = 0;
  for (const t of result.tables.values()) {
    totalRead += t.read;
    const adds = t.read === t.rows.length + t.rejected;
    if (!adds) ok = false;
    console.log(
      `${t.name.padEnd(14)} ${String(t.read).padStart(8)} ${String(t.rows.length).padStart(8)} ${String(t.rejected).padStart(9)}${adds ? '' : '  MISMATCH'}`,
    );
  }
  console.log(`%R rows, all tables: ${totalRead}`);
  console.log(`broken rows: ${result.broken.length}`);
  for (const b of result.broken.slice(0, 20)) console.log(`  line ${b.line} [${b.table ?? '-'}]: ${b.reason}`);
  console.log(`warnings: ${result.warnings.length === 0 ? 'none' : ''}`);
  for (const w of result.warnings) console.log(`  ${w}`);

  const { tally } = result;
  const sum = tally.structural + tally.kept + tally.rejected + tally.blank + tally.afterEnd;
  console.log(
    `lines: ${tally.total} = structural ${tally.structural} + kept ${tally.kept} + rejected ${tally.rejected} + blank ${tally.blank} + after %E ${tally.afterEnd} (sum ${sum})${sum === tally.total ? '' : '  MISMATCH'}`,
  );
  if (sum !== tally.total) ok = false;

  let highLines = 0;
  for (const e of highByTable.values()) highLines += e.count;
  console.log(`lines with bytes above 0x7F: ${highLines}`);
  for (const [name, e] of highByTable) {
    console.log(`  ${name}: ${e.count} line(s)`);
    for (const ex of e.examples) {
      const nonAscii = ex.text.split('\t').filter((f) => /[^\x00-\x7F]/.test(f));
      console.log(`    line ${ex.line}: ${nonAscii.map((f) => JSON.stringify(f.slice(0, 60))).join(' | ')}`);
    }
  }
  console.log(`run time: ${(ms / 1000).toFixed(2)} s, peak memory: ${peakMb.toFixed(0)} MB`);
  if (!ok) console.log('RECONCILIATION FAILED');
  return ok;
}
