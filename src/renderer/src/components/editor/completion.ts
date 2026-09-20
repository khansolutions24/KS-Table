// SQL code completion: keywords, functions, databases, tables and columns of the
// current database, columns of tables referenced in the statement (incl. aliases),
// and additional sources (e.g. code snippets).

import type { CompletionTable } from '@shared/api';
import { statementAt } from '@shared/sql/splitter';
import { api } from '../../api/client';
import { getSettings } from '../../store/settings';
import { metaSession, onDatabaseRefresh, useWorkspace } from '../../store/workspace';
import { monaco } from './monaco';
import { MYSQL_FUNCTIONS, MYSQL_KEYWORDS, MYSQL_TYPES, NON_ALIAS_WORDS } from './mysqlWords';

export interface CompletionContext {
  connectionId: string | null;
  database: string | null;
}

type Range = { startLineNumber: number; endLineNumber: number; startColumn: number; endColumn: number };
export type CompletionSource = (
  ctx: CompletionContext,
  range: Range
) => monaco.languages.CompletionItem[] | Promise<monaco.languages.CompletionItem[]>;

const contexts = new Map<string, CompletionContext>();
const cache = new Map<string, Promise<CompletionTable[]>>();
const sources: CompletionSource[] = [];

export function setCompletionContext(modelUri: string, ctx: CompletionContext | null): void {
  if (ctx) contexts.set(modelUri, ctx);
  else contexts.delete(modelUri);
}

/** Additional completion items, e.g. user snippets. */
export function registerCompletionSource(source: CompletionSource): void {
  sources.push(source);
}

export function invalidateCompletion(connectionId: string, database?: string): void {
  for (const k of [...cache.keys()]) {
    if (k.startsWith(`${connectionId}|`) && (!database || k === `${connectionId}|${database}`)) cache.delete(k);
  }
}

onDatabaseRefresh(invalidateCompletion);

function tablesOf(connectionId: string, db: string): Promise<CompletionTable[]> {
  const key = `${connectionId}|${db}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => api.meta.completion(metaSession(connectionId), db))().catch(() => {
      cache.delete(key);
      return [];
    });
    cache.set(key, p);
  }
  return p;
}

const unq = (s: string) => (s.startsWith('`') ? s.slice(1, -1).replace(/``/g, '`') : s);
const IDENT = '(`(?:[^`]|``)+`|[A-Za-z_$][\\w$]*)';

interface TableRef {
  db: string | null;
  table: string;
  alias: string | null;
}

/** FROM / JOIN / UPDATE / INTO table references (with aliases) of a statement */
export function tableRefs(sql: string): TableRef[] {
  const out: TableRef[] = [];
  const re = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO|TABLE|,)\\s*${IDENT}(?:\\s*\\.\\s*${IDENT})?(?:\\s+(?:AS\\s+)?${IDENT})?`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const a = unq(m[1]);
    const b = m[2] ? unq(m[2]) : null;
    let alias = m[3] ? unq(m[3]) : null;
    if (alias && NON_ALIAS_WORDS.has(alias.toUpperCase())) alias = null;
    if (NON_ALIAS_WORDS.has(a.toUpperCase()) || a.toUpperCase() === 'SELECT') continue;
    out.push(b ? { db: a, table: b, alias } : { db: null, table: a, alias });
  }
  return out;
}

const K = monaco.languages.CompletionItemKind;

function kw(word: string): string {
  return getSettings().editor.uppercaseKeywords ? word : word.toLowerCase();
}

function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) && !MYSQL_KEYWORDS.includes(name.toUpperCase()) ? name : '`' + name.replace(/`/g, '``') + '`';
}

let registered = false;

export function registerSqlCompletion(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider('mysql', {
    triggerCharacters: ['.', '`'],
    provideCompletionItems: async (model, position) => {
      const ctx = contexts.get(model.uri.toString()) ?? { connectionId: null, database: null };
      const word = model.getWordUntilPosition(position);
      const range: Range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn
      };
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const stmt = statementAt(text, offset)?.sql ?? text.slice(Math.max(0, offset - 4000), offset + 2000);
      const before = model.getValueInRange({ startLineNumber: Math.max(1, position.lineNumber - 3), startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const suggestions: monaco.languages.CompletionItem[] = [];
      const cid = ctx.connectionId;
      const conn = cid ? useWorkspace.getState().conns[cid] : undefined;
      const open = conn?.status === 'open';

      // qualified: something.<cursor>
      const q = new RegExp(`${IDENT}\\s*\\.\\s*\`?[\\w$]*$`).exec(before);
      if (q && open && cid) {
        const qual = unq(q[1]);
        const refs = tableRefs(stmt);
        const byAlias = refs.find((r) => r.alias?.toLowerCase() === qual.toLowerCase()) ?? refs.find((r) => r.table.toLowerCase() === qual.toLowerCase());
        if (byAlias) {
          const tables = await tablesOf(cid, byAlias.db ?? ctx.database ?? '');
          const t = tables.find((x) => x.name.toLowerCase() === byAlias.table.toLowerCase());
          t?.columns.forEach((c, i) =>
            suggestions.push({ label: { label: c.name, description: c.type }, kind: K.Field, insertText: quoteIfNeeded(c.name), range, sortText: `0${String(i).padStart(4, '0')}` })
          );
        }
        if (conn?.databases.some((d) => d.name.toLowerCase() === qual.toLowerCase())) {
          const tables = await tablesOf(cid, conn.databases.find((d) => d.name.toLowerCase() === qual.toLowerCase())!.name);
          for (const t of tables) {
            suggestions.push({ label: { label: t.name, description: t.type === 'view' ? 'view' : 'table' }, kind: t.type === 'view' ? K.Interface : K.Struct, insertText: quoteIfNeeded(t.name), range, sortText: `1${t.name}` });
          }
        }
        if (!byAlias && ctx.database) {
          const tables = await tablesOf(cid, ctx.database);
          const t = tables.find((x) => x.name.toLowerCase() === qual.toLowerCase());
          t?.columns.forEach((c, i) =>
            suggestions.push({ label: { label: c.name, description: c.type }, kind: K.Field, insertText: quoteIfNeeded(c.name), range, sortText: `0${String(i).padStart(4, '0')}` })
          );
        }
        return { suggestions };
      }

      if (open && cid) {
        // columns of referenced tables
        const refs = tableRefs(stmt);
        const seen = new Set<string>();
        for (const r of refs) {
          const tables = await tablesOf(cid, r.db ?? ctx.database ?? '');
          const t = tables.find((x) => x.name.toLowerCase() === r.table.toLowerCase());
          if (!t) continue;
          for (const c of t.columns) {
            if (seen.has(c.name)) continue;
            seen.add(c.name);
            suggestions.push({
              label: { label: c.name, description: `${r.alias ?? t.name} · ${c.type}` },
              kind: K.Field,
              insertText: quoteIfNeeded(c.name),
              range,
              sortText: `0${c.name}`
            });
          }
        }
        if (ctx.database) {
          const tables = await tablesOf(cid, ctx.database);
          for (const t of tables) {
            suggestions.push({
              label: { label: t.name, description: t.type === 'view' ? 'view' : 'table' },
              kind: t.type === 'view' ? K.Interface : K.Struct,
              insertText: quoteIfNeeded(t.name),
              range,
              sortText: `1${t.name}`
            });
          }
          const ds = conn?.dbs[ctx.database];
          for (const r of ds?.routines ?? []) {
            suggestions.push({
              label: { label: r.name, description: r.type.toLowerCase() },
              kind: K.Method,
              insertText: r.type === 'FUNCTION' ? `${quoteIfNeeded(r.name)}($0)` : quoteIfNeeded(r.name),
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
              sortText: `2${r.name}`
            });
          }
        }
        for (const d of conn?.databases ?? []) {
          suggestions.push({ label: { label: d.name, description: 'database' }, kind: K.Module, insertText: quoteIfNeeded(d.name), range, sortText: `5${d.name}` });
        }
      }

      for (const k of MYSQL_KEYWORDS) suggestions.push({ label: kw(k), kind: K.Keyword, insertText: kw(k), range, sortText: `3${k}` });
      for (const f of MYSQL_FUNCTIONS) {
        suggestions.push({
          label: { label: kw(f), description: 'function' },
          kind: K.Function,
          insertText: `${kw(f)}($0)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: `4${f}`
        });
      }
      for (const t of MYSQL_TYPES) suggestions.push({ label: { label: kw(t), description: 'type' }, kind: K.TypeParameter, insertText: kw(t), range, sortText: `4${t}` });

      for (const s of sources) {
        try {
          suggestions.push(...(await s(ctx, range)));
        } catch {
          // ignore broken sources
        }
      }
      return { suggestions };
    }
  });
}
