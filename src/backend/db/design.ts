// Load a table structure (TableDesign) from information_schema + SHOW CREATE TABLE.

import type { CheckDef, ColumnMeta, FieldDef, FkAction, ForeignKeyDef, IndexDef, IndexType, TableDesign, TableOptions, TriggerDef } from '@shared/types';
import { defaultTableOptions, newField, newId } from '@shared/defaults';
import { parseEnumValues } from '@shared/sql/quote';
import type { Session } from './sessions';
import { columns, ddl, str, triggers } from './meta';

type Row = Record<string, unknown>;

const unq = (s: string) => s.replace(/``/g, '`');

/** Text between the parenthesis starting at/after `from` and its matching close. */
export function extractParenthesized(text: string, from: number): string {
  const start = text.indexOf('(', from);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\' && q !== '`') i++;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return text.slice(start + 1);
}

/** Remove one pair of parentheses around the whole expression. */
export function stripOuterParens(expr: string): string {
  const t = expr.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  return extractParenthesized(t, 0).length === t.length - 2 ? t.slice(1, -1).trim() : t;
}

export interface ParsedCreateTable {
  columnLines: Map<string, string>;
  indexLines: Map<string, string>;
  checks: CheckDef[];
  optionsText: string;
  partition: string;
}

export function parseCreateTable(sql: string): ParsedCreateTable {
  const lines = sql.split('\n');
  const columnLines = new Map<string, string>();
  const indexLines = new Map<string, string>();
  const checks: CheckDef[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\)/.test(line)) break;
    const t = line.trim().replace(/,$/, '');
    let m: RegExpExecArray | null;
    if ((m = /^`((?:[^`]|``)+)`\s/.exec(t))) {
      columnLines.set(unq(m[1]), t);
    } else if (/^PRIMARY KEY/i.test(t)) {
      indexLines.set('PRIMARY', t);
    } else if ((m = /^(?:UNIQUE |FULLTEXT |SPATIAL )?(?:KEY|INDEX) `((?:[^`]|``)+)`/i.exec(t))) {
      indexLines.set(unq(m[1]), t);
    } else if ((m = /^CONSTRAINT `((?:[^`]|``)+)` CHECK\s*\(/i.exec(t))) {
      const pos = t.search(/CHECK\s*\(/i);
      const inner = extractParenthesized(t, pos);
      checks.push({
        id: newId('k'),
        origName: unq(m[1]),
        name: unq(m[1]),
        expr: stripOuterParens(inner),
        enforced: !/NOT ENFORCED/i.test(t.slice(pos + inner.length))
      });
    }
  }
  const rest = lines.slice(i).join('\n');
  const p = rest.search(/PARTITION BY/i);
  let optionsText = rest;
  let partition = '';
  if (p >= 0) {
    optionsText = rest.slice(0, p).replace(/\/\*!\d+\s*$/, '');
    partition = rest
      .slice(p)
      .replace(/\s*\*\/\s*$/, '')
      .trim();
  }
  return { columnLines, indexLines, checks, optionsText, partition };
}

function parseOptions(text: string, fallbackEngine: string, fallbackCollation: string): TableOptions {
  const o = defaultTableOptions();
  const g = (re: RegExp) => re.exec(text)?.[1] ?? '';
  o.engine = g(/\bENGINE\s*=\s*(\w+)/i) || fallbackEngine;
  o.autoIncrement = g(/\bAUTO_INCREMENT\s*=\s*(\d+)/i);
  o.charset = g(/\b(?:DEFAULT\s+)?(?:CHARSET|CHARACTER SET)\s*=\s*(\w+)/i);
  o.collation = g(/\bCOLLATE\s*=\s*(\w+)/i) || fallbackCollation;
  if (!o.charset && o.collation) o.charset = o.collation.split('_')[0];
  o.rowFormat = g(/\bROW_FORMAT\s*=\s*(\w+)/i).toUpperCase();
  o.avgRowLength = g(/\bAVG_ROW_LENGTH\s*=\s*(\d+)/i);
  o.maxRows = g(/\bMAX_ROWS\s*=\s*(\d+)/i);
  o.minRows = g(/\bMIN_ROWS\s*=\s*(\d+)/i);
  o.keyBlockSize = g(/\bKEY_BLOCK_SIZE\s*=\s*(\d+)/i);
  o.checksum = /\bCHECKSUM\s*=\s*1/i.test(text);
  o.delayKeyWrite = /\bDELAY_KEY_WRITE\s*=\s*1/i.test(text);
  o.packKeys = g(/\bPACK_KEYS\s*=\s*(\w+)/i).toUpperCase() as TableOptions['packKeys'];
  o.statsAutoRecalc = g(/\bSTATS_AUTO_RECALC\s*=\s*(\w+)/i).toUpperCase() as TableOptions['statsAutoRecalc'];
  o.statsPersistent = g(/\bSTATS_PERSISTENT\s*=\s*(\w+)/i).toUpperCase() as TableOptions['statsPersistent'];
  o.statsSamplePages = g(/\bSTATS_SAMPLE_PAGES\s*=\s*(\d+)/i);
  o.tablespace = g(/\bTABLESPACE\s+`?(\w+)`?/i);
  o.compression = g(/\bCOMPRESSION\s*=\s*'(\w+)'/i);
  o.encryption = g(/\bENCRYPTION\s*=\s*'(\w)'/i).toUpperCase() as TableOptions['encryption'];
  o.dataDirectory = g(/\bDATA DIRECTORY\s*=\s*'([^']*)'/i);
  o.indexDirectory = g(/\bINDEX DIRECTORY\s*=\s*'([^']*)'/i);
  o.insertMethod = g(/\bINSERT_METHOD\s*=\s*(\w+)/i).toUpperCase() as TableOptions['insertMethod'];
  o.union = g(/\bUNION\s*=\s*\(([^)]*)\)/i);
  return o;
}

function parseDefault(c: ColumnMeta, mariadb: boolean): Pick<FieldDef, 'defaultKind' | 'defaultValue'> {
  const d = c.defaultValue;
  const extra = c.extra.toLowerCase();
  if (c.generationExpression) return { defaultKind: 'none', defaultValue: '' };
  if (mariadb) {
    if (d === null) return { defaultKind: 'none', defaultValue: '' };
    if (d === 'NULL') return { defaultKind: 'null', defaultValue: '' };
    const q = /^'(.*)'$/s.exec(d);
    if (q) {
      const v = q[1].replace(/''/g, "'").replace(/\\\\/g, '\\');
      return v === '' ? { defaultKind: 'empty', defaultValue: '' } : { defaultKind: 'value', defaultValue: v };
    }
    if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(d)) return { defaultKind: 'value', defaultValue: d };
    return { defaultKind: 'expression', defaultValue: d };
  }
  if (d === null) return c.nullable ? { defaultKind: 'null', defaultValue: '' } : { defaultKind: 'none', defaultValue: '' };
  if (extra.includes('default_generated')) return { defaultKind: 'expression', defaultValue: d };
  if (d === '') return { defaultKind: 'empty', defaultValue: '' };
  if (/^b'[01]*'$/i.test(d) || (/^0x[0-9a-f]*$/i.test(d) && /binary|blob|bit/.test(c.dataType))) {
    return { defaultKind: 'expression', defaultValue: d };
  }
  return { defaultKind: 'value', defaultValue: d };
}

export function fieldFromColumn(c: ColumnMeta, line: string, tableCharset: string, tableCollation: string, mariadb: boolean): FieldDef {
  const type = c.dataType.toUpperCase();
  let length = '';
  let decimals = '';
  let values: string[] = [];
  if (type === 'ENUM' || type === 'SET') values = parseEnumValues(c.columnType);
  else {
    const m = /^\w+\s*\((\d+)(?:\s*,\s*(\d+))?\)/.exec(c.columnType);
    if (m) {
      length = m[1];
      decimals = m[2] ?? '';
    }
  }
  const extra = c.extra.toLowerCase();
  const sameCharset = !c.charset || (c.charset === tableCharset && c.collation === tableCollation);
  return newField({
    origName: c.name,
    name: c.name,
    type,
    length,
    decimals,
    values,
    notNull: !c.nullable,
    ...parseDefault(c, mariadb),
    comment: c.comment,
    autoIncrement: extra.includes('auto_increment'),
    unsigned: /\bunsigned\b/i.test(c.columnType),
    zerofill: /\bzerofill\b/i.test(c.columnType),
    charset: sameCharset ? '' : (c.charset ?? ''),
    collation: sameCharset ? '' : (c.collation ?? ''),
    onUpdateCurrentTimestamp: extra.includes('on update current_timestamp'),
    generated: !!c.generationExpression || extra.includes('generated'),
    generatedExpr: c.generationExpression,
    generatedStored: extra.includes('stored generated') || extra.includes('persistent'),
    invisible: extra.includes('invisible'),
    srid: /\bSRID\s+(\d+)/i.exec(line)?.[1] ?? ''
  });
}

export async function loadTableDesign(s: Session, schema: string, table: string): Promise<TableDesign> {
  const cols = await columns(s, schema, table);
  const stats = await s.rows<Row>(
    'SELECT * FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
    [schema, table]
  );
  const fkRows = await s.rows<Row>(
    `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS refSchema,
            k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol,
            r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [schema, table]
  );
  const info = (
    await s.rows<Row>(
      'SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [schema, table]
    )
  )[0] ?? {};
  const trig = await triggers(s, schema, table);
  const create = await ddl(s, schema, 'table', table);
  const parsed = parseCreateTable(create);
  const options = parseOptions(parsed.optionsText, str(info.engine), str(info.collation));
  const mariadb = s.server.type === 'mariadb';

  const fields = cols.map((c) =>
    fieldFromColumn(c, parsed.columnLines.get(c.name) ?? '', options.charset, options.collation, mariadb)
  );

  // indexes
  const groups = new Map<string, Row[]>();
  for (const r of stats) {
    const name = str(r.INDEX_NAME);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(r);
  }
  let primaryKey: string[] = [];
  const indexes: IndexDef[] = [];
  for (const [name, parts] of groups) {
    parts.sort((a, b) => Number(a.SEQ_IN_INDEX) - Number(b.SEQ_IN_INDEX));
    if (name === 'PRIMARY') {
      primaryKey = parts.map((p) => str(p.COLUMN_NAME));
      continue;
    }
    const first = parts[0];
    const it = str(first.INDEX_TYPE).toUpperCase();
    const type: IndexType =
      it === 'FULLTEXT' ? 'FULLTEXT' : it === 'SPATIAL' ? 'SPATIAL' : Number(first.NON_UNIQUE) === 0 ? 'UNIQUE' : 'NORMAL';
    const line = parsed.indexLines.get(name) ?? '';
    indexes.push({
      id: newId('i'),
      origName: name,
      name,
      type,
      method: ((/USING (BTREE|HASH)/i.exec(line)?.[1] ?? '').toUpperCase() as IndexDef['method']),
      fields: parts.map((p) => ({
        name: str(p.COLUMN_NAME),
        subPart: p.SUB_PART === null || p.SUB_PART === undefined ? '' : String(p.SUB_PART),
        order: str(p.COLLATION) === 'D' ? 'DESC' : '',
        expr: p.EXPRESSION ? str(p.EXPRESSION) : undefined
      })),
      comment: str(first.INDEX_COMMENT),
      invisible: str(first.IS_VISIBLE) === 'NO' || str(first.IGNORED) === 'YES',
      parser: /WITH PARSER `?(\w+)`?/i.exec(line)?.[1] ?? '',
      keyBlockSize: /KEY_BLOCK_SIZE=(\d+)/i.exec(line)?.[1] ?? ''
    });
  }

  // foreign keys
  const fkMap = new Map<string, ForeignKeyDef>();
  for (const r of fkRows) {
    const name = str(r.name);
    let fk = fkMap.get(name);
    if (!fk) {
      fk = {
        id: newId('r'),
        origName: name,
        name,
        fields: [],
        refSchema: str(r.refSchema),
        refTable: str(r.refTable),
        refFields: [],
        onDelete: str(r.onDelete).toUpperCase() as FkAction,
        onUpdate: str(r.onUpdate).toUpperCase() as FkAction
      };
      fkMap.set(name, fk);
    }
    fk.fields.push(str(r.col));
    fk.refFields.push(str(r.refCol));
  }

  const triggerDefs: TriggerDef[] = trig.map((t) => ({
    id: newId('t'),
    origName: t.name,
    name: t.name,
    timing: t.timing,
    event: t.event,
    body: t.statement,
    definer: t.definer,
    orderType: '',
    orderOther: ''
  }));

  return {
    schema,
    name: table,
    origName: table,
    fields,
    primaryKey,
    indexes,
    foreignKeys: [...fkMap.values()],
    checks: parsed.checks,
    triggers: triggerDefs,
    options,
    comment: str(info.comment),
    partition: parsed.partition
  };
}
