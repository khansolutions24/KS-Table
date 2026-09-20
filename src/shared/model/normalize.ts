// Conversions between database table designs and model designs, plus SQL text helpers
// used by reverse engineering, forward engineering and model ↔ database comparison.

import type { TableDesign } from '../types';

/** Makes a design loaded from a database consistent and comparable with model designs. */
export function normalizeDbDesign(d: TableDesign): TableDesign {
  return {
    ...d,
    fields: d.fields.map((f) => {
      // the loader flags DEFAULT_GENERATED columns (DEFAULT CURRENT_TIMESTAMP …) as generated
      if (f.generated && f.generatedExpr.trim()) return f;
      return f.generated || f.generatedExpr || f.generatedStored ? { ...f, generated: false, generatedExpr: '', generatedStored: false } : f;
    }),
    // information_schema reports a prefix length of 32 for SPATIAL index parts; it cannot be written back
    indexes: d.indexes.map((ix) => (ix.type === 'SPATIAL' && ix.fields.some((p) => p.subPart) ? { ...ix, fields: ix.fields.map((p) => ({ ...p, subPart: '' })) } : ix))
  };
}

/** A database table design as stored in a model: no schema, own-schema foreign keys without refSchema. */
export function toModelDesign(d: TableDesign, sourceSchema: string): TableDesign {
  const n = normalizeDbDesign(d);
  return {
    ...n,
    schema: '',
    foreignKeys: n.foreignKeys.map((fk) => ({ ...fk, refSchema: !fk.refSchema || fk.refSchema.toLowerCase() === sourceSchema.toLowerCase() ? '' : fk.refSchema }))
  };
}

/** A model design placed into a database (schema '' = unqualified names). */
export function retarget(d: TableDesign, schema: string): TableDesign {
  return {
    ...d,
    schema,
    foreignKeys: d.foreignKeys.map((fk) => (fk.refSchema ? fk : { ...fk, refSchema: schema }))
  };
}

/** Removes `schema`. qualifiers (backtick quoted) outside of string literals, e.g. from view definitions. */
export function stripSchemaQualifier(sql: string, schema: string): string {
  if (!schema) return sql;
  const q = ('`' + schema.replace(/`/g, '``') + '`.').toLowerCase();
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      if (sql.slice(i, i + q.length).toLowerCase() === q) {
        i += q.length;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '`') {
          if (sql[j + 1] === '`') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** View SELECT text for comparisons: whitespace collapsed, case folded, trailing semicolons removed. */
export function normalizeViewSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Loose normal form of SQL expressions (generated columns, defaults, checks) to recognize
 * expressions that the server rewrote: no backticks, no charset introducers, no whitespace,
 * lower case, synonyms of CURRENT_TIMESTAMP unified, outer parentheses removed.
 */
export function looseExpr(expr: string): string {
  let s = expr
    .replace(/_[a-z0-9]+(?=')/gi, '')
    .replace(/`/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  for (;;) {
    if (!(s.startsWith('(') && s.endsWith(')'))) break;
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      if (depth === 0 && i < s.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    s = s.slice(1, -1);
  }
  return s.replace(/^(now|current_timestamp|localtime|localtimestamp)(\(\))?$/, 'current_timestamp').replace(/^(now|current_timestamp|localtime|localtimestamp)\((\d+)\)$/, 'current_timestamp($2)');
}
