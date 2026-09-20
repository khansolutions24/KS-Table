import { describe, expect, it } from 'vitest';
import type { ResultColumn, StatementResult } from '@shared/types';
import { feedLine, initialScanState, promptFor, type ConsoleCommand, type ScanState } from '../consoleParser';
import { displayWidth, formatStatementResult, formatTable, formatVertical, rowsSummary } from '../consoleFormat';

function feed(lines: string[], start: ScanState = initialScanState()): { commands: ConsoleCommand[]; state: ScanState } {
  let state = start;
  const commands: ConsoleCommand[] = [];
  for (const l of lines) {
    const r = feedLine(state, l);
    commands.push(...r.commands);
    state = r.state;
  }
  return { commands, state };
}

const col = (name: string, numeric = false): ResultColumn => ({
  name, orgName: name, table: '', orgTable: '', schema: '', typeId: numeric ? 3 : 253, typeName: numeric ? 'INT' : 'VARCHAR',
  flags: 0, length: 0, decimals: 0, charsetNr: 255, binary: false, primaryKey: false, notNull: false, unsigned: false,
  autoIncrement: false, numeric
});

describe('console input', () => {
  it('collects multi-line statements until the delimiter', () => {
    let r = feedLine(initialScanState(), 'SELECT 1,');
    expect(r.commands).toEqual([]);
    expect(promptFor(r.state, 'mysql> ')).toBe('    -> ');
    r = feedLine(r.state, "  'a;b' AS x; SELECT 2\\G SELECT");
    expect(r.commands).toEqual([
      { kind: 'sql', sql: "SELECT 1,\n  'a;b' AS x", vertical: false },
      { kind: 'sql', sql: 'SELECT 2', vertical: true }
    ]);
    expect(r.state.buffer).toBe(' SELECT\n');
  });

  it('tracks open quotes and comments over lines', () => {
    const a = feedLine(initialScanState(), "SELECT 'abc");
    expect(promptFor(a.state, 'mysql> ')).toBe("    '> ");
    const b = feedLine(a.state, "def' /* x;");
    expect(promptFor(b.state, 'mysql> ')).toBe('   /*> ');
    const c = feedLine(b.state, '*/ ; -- comment;');
    expect(c.commands).toEqual([{ kind: 'sql', sql: "SELECT 'abc\ndef' /* x;\n*/", vertical: false }]);
    expect(c.state.buffer).toBe('');
  });

  it('handles DELIMITER, client commands and \\c', () => {
    const { commands, state } = feed([
      'delimiter //',
      'CREATE PROCEDURE p() BEGIN SELECT 1; END//',
      'DELIMITER ;',
      'use `ks_shop`',
      'status',
      'SELECT 1 \\c',
      'help',
      '-- only a comment',
      ';',
      'source x.sql',
      'SELECT 5 \\x'
    ]);
    expect(commands).toEqual([
      { kind: 'client', name: 'delimiter', arg: '//' },
      { kind: 'sql', sql: 'CREATE PROCEDURE p() BEGIN SELECT 1; END', vertical: false },
      { kind: 'client', name: 'delimiter', arg: ';' },
      { kind: 'client', name: 'use', arg: 'ks_shop' },
      { kind: 'client', name: 'status', arg: '' },
      { kind: 'client', name: 'reset', arg: '' },
      { kind: 'client', name: 'help', arg: '' },
      { kind: 'client', name: 'noquery', arg: '' },
      { kind: 'client', name: 'unsupported', arg: 'source' },
      { kind: 'client', name: 'unknown', arg: '\\x' }
    ]);
    expect(state.delimiter).toBe(';');
    expect(state.buffer).toBe('SELECT 5 \n');
  });
});

describe('console output', () => {
  it('formats ASCII tables like the mysql client', () => {
    expect(formatTable([col('id', true), col('name')], [['1', 'Äpfel'], ['12', null]])).toBe(
      ['+----+-------+', '| id | name  |', '+----+-------+', '|  1 | Äpfel |', '| 12 | NULL  |', '+----+-------+'].join('\n')
    );
    expect(displayWidth('漢字a')).toBe(5);
    expect(formatTable([col('x')], [['a\nb'], [new Uint8Array([1, 255]) as unknown as string]])).toContain('| a\\nb   |');
  });

  it('formats vertical output and summaries', () => {
    expect(formatVertical([col('id', true), col('name')], [['1', 'x']])).toBe(
      ['*************************** 1. row ***************************', '  id: 1', 'name: x'].join('\n')
    );
    expect(rowsSummary(0, 3)).toBe('Empty set (0.00 sec)');
    expect(rowsSummary(1, 12)).toBe('1 row in set (0.01 sec)');
    expect(rowsSummary(3, 1500, 2)).toBe('3 rows in set, 2 warnings (1.50 sec)');
  });

  it('formats OK packets, USE and errors', () => {
    const base = { index: 0, startedAt: 0, durationMs: 10 };
    const ok: StatementResult = { ...base, sql: 'UPDATE t SET a = 1', kind: 'ok', affectedRows: 2, warningCount: 1, info: 'Rows matched: 2  Changed: 2  Warnings: 1', warnings: [{ level: 'Warning', code: 1265, message: 'Data truncated' }] };
    expect(formatStatementResult(ok, { vertical: false, showWarnings: true }).text).toBe(
      'Query OK, 2 rows affected, 1 warning (0.01 sec)\nRows matched: 2  Changed: 2  Warnings: 1\nWarning (Code 1265): Data truncated'
    );
    expect(formatStatementResult({ ...base, sql: 'use ks_shop', kind: 'ok', affectedRows: 0 }, { vertical: false, showWarnings: false }).text).toBe('Database changed');
    const err = formatStatementResult(
      { ...base, sql: 'x', kind: 'error', error: { message: "Table 'a.b' doesn't exist", errno: 1146, sqlState: '42S02' } },
      { vertical: false, showWarnings: false }
    );
    expect(err).toEqual({ kind: 'error', text: "ERROR 1146 (42S02): Table 'a.b' doesn't exist" });
  });
});
