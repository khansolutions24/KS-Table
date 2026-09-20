import type { ExecuteResult } from '@shared/types';
import { api, RpcError } from '../api/client';
import { metaSession } from '../store/workspace';

/** Executes SQL on the navigator session of a connection and throws the first statement error. */
export async function runSql(connectionId: string, sql: string, opts: { noSplit?: boolean } = {}): Promise<ExecuteResult> {
  const res = await api.query.execute(metaSession(connectionId), sql, { stopOnError: true, noSplit: opts.noSplit });
  const err = res.results.find((r) => r.kind === 'error');
  if (err?.error) throw new RpcError(err.error);
  return res;
}
