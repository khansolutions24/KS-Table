// Visual query builder entry point (used by the query editor and the view designer).

import { createElement } from 'react';
import { openDialog } from '../../components/ui/Dialog';

export interface QueryBuilderOptions {
  connectionId: string;
  database: string | null;
  /** SQL to start from (SELECT statements are parsed back into the builder when possible) */
  sql?: string;
}

/** Opens the visual query builder. Resolves with the generated SQL, or null when cancelled. */
export async function openQueryBuilder(opts: QueryBuilderOptions): Promise<string | null> {
  const { QueryBuilderDialog } = await import('./QueryBuilderDialog');
  const r = await openDialog<string | null>((close) => createElement(QueryBuilderDialog, { opts, close }));
  return r ?? null;
}
