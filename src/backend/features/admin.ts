// Server monitor helpers and "find in database" (tasks).

import type { AdminApi } from '@shared/apis/admin';
import { isValidVariableName, setVariableSql } from '@shared/admin/variables';
import { tr } from '@shared/i18n';
import type { BackendContext } from '../api';
import { KsError, toSqlError } from '../errors';
import { disposeFind, findHits, startFind } from './admin/find';
import { innodbStatus, processList, status, variables } from './admin/monitor';

export function createAdminApi(ctx: BackendContext): AdminApi {
  const S = (id: string) => ctx.sessions.get(id);

  /** Executes an administrative statement and records it in the history log */
  const run = async (sessionId: string, sql: string): Promise<void> => {
    const s = S(sessionId);
    const t0 = Date.now();
    try {
      await s.exec(sql);
      ctx.logFor(s)(sql, true, Date.now() - t0);
    } catch (e) {
      ctx.logFor(s)(sql, false, Date.now() - t0, toSqlError(e).message);
      throw e;
    }
  };

  return {
    processList: (sid) => processList(S(sid)),
    kill: async (sid, id, queryOnly) => {
      if (!/^\d+$/.test(id)) throw new KsError(tr('Ungültige Verbindungs-ID', 'Invalid connection id'));
      await run(sid, `KILL ${queryOnly ? 'QUERY ' : ''}${id}`);
    },
    variables: (sid) => variables(S(sid)),
    setVariable: async (sid, scope, name, value, mode) => {
      if (!isValidVariableName(name)) throw new KsError(tr('Ungültiger Variablenname: {n}', 'Invalid variable name: {n}', { n: name }));
      if (scope === 'PERSIST' && (S(sid).server.type !== 'mysql' || S(sid).server.versionNumber < 80000)) {
        throw new KsError(tr('SET PERSIST wird erst ab MySQL 8.0 unterstützt.', 'SET PERSIST requires MySQL 8.0 or later.'));
      }
      const sql = setVariableSql(scope, name, value, mode);
      await run(sid, sql);
      return sql;
    },
    status: (sid) => status(S(sid)),
    innodbStatus: (sid) => innodbStatus(S(sid)),
    findStart: async (options) => startFind(ctx, options),
    findHits: async (taskId, from) => findHits(taskId, from),
    findDispose: async (taskId) => disposeFind(ctx, taskId)
  };
}
