// Code snippets for the query editor: cached list and a completion source offering them.

import type { Snippet } from '@shared/apis/snippets';
import { tr } from '@shared/i18n';
import { api } from '../../api/client';
import { registerCompletionSource } from '../../components/editor/completion';
import { monaco } from '../../components/editor/monaco';

const TTL_MS = 30_000;
let cache: { at: number; list: Snippet[] } | null = null;
let pending: Promise<Snippet[]> | null = null;

export function loadSnippets(force = false): Promise<Snippet[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.list);
  if (!force && pending) return pending;
  const p = api.snippets
    .list()
    .then((list) => {
      cache = { at: Date.now(), list };
      return list;
    })
    .finally(() => {
      if (pending === p) pending = null;
    });
  pending = p;
  return p;
}

let registered = false;

/** Registers the snippet completion source once per app. */
export function ensureSnippetCompletion(): void {
  if (registered) return;
  registered = true;
  registerCompletionSource(async (_ctx, range) => {
    const list = await loadSnippets().catch(() => [] as Snippet[]);
    return list.map((s) => ({
      label: { label: s.name, description: s.group ? `${tr('Snippet', 'Snippet')} · ${s.group}` : tr('Snippet', 'Snippet') },
      kind: monaco.languages.CompletionItemKind.Snippet,
      insertText: s.sql,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      detail: s.description,
      documentation: { value: '```sql\n' + s.sql + '\n```' },
      range,
      sortText: `6${s.name}`
    }));
  });
}
