// parser.ts: XER text in, tables + broken rows out.
// Pure: no fs, no process. The caller decodes the bytes (windows-1252) and
// passes the text in.

/** One kept data row: its 1-based line number and its fields by column name. */
export type Row = {
  line: number;
  fields: Record<string, string>;
};

/** One table from the file, with the reconciliation counters. */
export type Table = {
  name: string;
  columns: string[];
  rows: Row[]; // kept rows, stored only for the tables in STORED_TABLES
  read: number; // every %R line seen for this table
  kept: number; // %R lines of this table that passed every rule
  rejected: number; // %R lines of this table that were rejected
};

/** Only these tables keep their row objects. Every other table is validated
 *  and counted line by line but not stored, to keep memory down. */
export const STORED_TABLES = new Set(['TASK', 'TASKPRED', 'CALENDAR']);

/** A line the parser could not trust. `table` is null for lines outside any table. */
export type BrokenRow = {
  table: string | null;
  line: number;
  reason: string;
};

/** Every line of the file lands in exactly one of these buckets. */
export type LineTally = {
  total: number;
  structural: number; // ERMHDR, %T, %F, %E
  kept: number;
  rejected: number;
  blank: number;
  afterEnd: number; // lines after %E
};

export type ParseResult = {
  version: string | null; // from ERMHDR, second field
  exportDate: string | null; // from ERMHDR, third field
  tables: Map<string, Table>; // in file order
  broken: BrokenRow[]; // in line order
  warnings: string[]; // file-level
  tally: LineTally;
};

const NUMBER = /^-?\d+(\.\d+)?$/;

/** True only for a plain decimal number. Empty string is NOT a number. */
export function isNumber(s: string): boolean {
  return NUMBER.test(s);
}

export function parseXer(text: string): ParseResult {
  const lines = text.split('\n');
  // A file that ends with a newline splits into a trailing empty string
  // that is not a real line. Drop it so line counts match `wc -l`.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const tables = new Map<string, Table>();
  const broken: BrokenRow[] = [];
  const warnings: string[] = [];
  const tally: LineTally = { total: lines.length, structural: 0, kept: 0, rejected: 0, blank: 0, afterEnd: 0 };

  let version: string | null = null;
  let exportDate: string | null = null;
  let current: Table | null = null;
  const keptTaskIds = new Map<string, number>(); // task_id -> line it was kept at
  const rejectedTaskIds = new Set<string>(); // ids of TASK rows we threw away
  let endLine: number | null = null;

  const reject = (table: string | null, line: number, reason: string) => {
    broken.push({ table, line, reason });
    tally.rejected++;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i];
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (endLine !== null) {
      tally.afterEnd++;
      continue;
    }
    if (line.trim() === '') {
      tally.blank++;
      continue;
    }

    const fields = line.split('\t');
    const kind = fields[0];

    if (kind === 'ERMHDR') {
      version = fields[1] ?? null;
      exportDate = fields[2] ?? null;
      tally.structural++;
    } else if (kind === '%E') {
      endLine = lineNo;
      tally.structural++;
    } else if (kind === '%T') {
      const name = fields[1] ?? '';
      current = tables.get(name) ?? { name, columns: [], rows: [], read: 0, kept: 0, rejected: 0 };
      tables.set(name, current);
      tally.structural++;
    } else if (kind === '%F') {
      if (current === null) {
        reject(null, lineNo, '%F field header before any %T table line');
      } else {
        current.columns = fields.slice(1);
        tally.structural++;
      }
    } else if (kind === '%R') {
      if (current === null) {
        reject(null, lineNo, '%R data row before any %T table line');
        continue;
      }
      current.read++;
      const values = fields.slice(1);
      let reason: string | null = null;
      if (current.columns.length === 0) {
        reason = 'data row before any %F field header';
      } else if (values.length !== current.columns.length) {
        reason = `has ${values.length} fields, header has ${current.columns.length}`;
      }
      let row: Record<string, string> = {};
      if (reason === null) {
        for (let c = 0; c < current.columns.length; c++) row[current.columns[c]] = values[c];
        reason = rowProblem(current.name, row, keptTaskIds);
      }
      if (reason !== null) {
        current.rejected++;
        reject(current.name, lineNo, reason);
        if (current.name === 'TASK' && row['task_id']) rejectedTaskIds.add(row['task_id']);
      } else {
        current.kept++;
        tally.kept++;
        if (STORED_TABLES.has(current.name)) current.rows.push({ line: lineNo, fields: row });
        if (current.name === 'TASK') keptTaskIds.set(row['task_id'], lineNo);
      }
    } else {
      reject(null, lineNo, `unknown line type "${kind.slice(0, 20)}"`);
    }
  }

  // Second pass: a link only counts if both ends are kept tasks. Done after
  // the whole file is read so the order of tables does not matter.
  const links = tables.get('TASKPRED');
  if (links) {
    const kept: Row[] = [];
    for (const row of links.rows) {
      const reason = linkProblem(row.fields, keptTaskIds, rejectedTaskIds);
      if (reason === null) {
        kept.push(row);
      } else {
        links.rejected++;
        links.kept--;
        tally.kept--;
        reject('TASKPRED', row.line, reason);
      }
    }
    links.rows = kept;
  }
  broken.sort((a, b) => a.line - b.line);

  if (version === null) warnings.push('no ERMHDR line: P6 version unknown');
  if (endLine === null) {
    warnings.push('no %E line: file may be cut off');
  } else if (tally.afterEnd > 0) {
    warnings.push(`${tally.afterEnd} line(s) after %E, first at line ${endLine + 1}`);
  }

  return { version, exportDate, tables, broken, warnings, tally };
}

/** Per-row rules for the tables we check. Returns a reason, or null if the row is fine. */
function rowProblem(table: string, row: Record<string, string>, keptTaskIds: Map<string, number>): string | null {
  if (table === 'TASK') {
    const id = row['task_id'] ?? '';
    if (id === '') return 'empty task_id';
    const first = keptTaskIds.get(id);
    if (first !== undefined) return `task_id ${id} already seen at line ${first} (first one kept)`;
    const float = row['total_float_hr_cnt'] ?? '';
    if (float !== '' && !isNumber(float)) return `non-numeric total_float_hr_cnt "${float}"`;
  }
  if (table === 'CALENDAR') {
    const hours = row['day_hr_cnt'] ?? '';
    if (hours !== '' && !isNumber(hours)) return `non-numeric day_hr_cnt "${hours}"`;
  }
  return null;
}

/** A TASKPRED row must point at two kept tasks. */
function linkProblem(
  row: Record<string, string>,
  keptTaskIds: Map<string, number>,
  rejectedTaskIds: Set<string>,
): string | null {
  for (const col of ['task_id', 'pred_task_id']) {
    const id = row[col] ?? '';
    if (keptTaskIds.has(id)) continue;
    if (rejectedTaskIds.has(id)) return `${col} ${id} refers to a rejected TASK row, not a kept task`;
    return `${col} ${id} not in this file (possibly an external link)`;
  }
  return null;
}
