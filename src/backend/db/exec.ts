// Script execution for the query editor / console: splits statements, runs them
// one by one, collects result sets, messages and warnings.

import type { ExecuteOptions, ExecuteResult, StatementResult } from '@shared/types';
import { tr } from '@shared/i18n';
import { splitStatements, type SplitStatement } from '@shared/sql/splitter';
import { toSqlError } from '../errors';
import { emit } from '../events';
import type { HistoryStore } from '../store/history';
import { normalizeRows, type RawOk } from './driver';
import { toResultColumn } from './fieldTypes';
import type { Session, SessionManager } from './sessions';

interface RunToken {
  cancelled: boolean;
}

export class QueryRunner {
  private running = new Map<string, RunToken>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly history: HistoryStore
  ) {}

  async execute(sessionId: string, sql: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
    const s = this.sessions.get(sessionId);
    const t0 = Date.now();
    const statements: SplitStatement[] = opts.noSplit
      ? [{ sql: sql.trim(), start: 0, end: sql.length, delimiter: '' }]
      : splitStatements(sql, { delimiter: opts.delimiter });
    const token: RunToken = { cancelled: false };
    this.running.set(sessionId, token);
    const results: StatementResult[] = [];
    let cancelled = false;
    try {
      for (let i = 0; i < statements.length; i++) {
        if (token.cancelled) {
          cancelled = true;
          break;
        }
        const st = statements[i];
        if (!st.sql) continue;
        if (opts.queryId) emit('query:progress', { queryId: opts.queryId, index: i, total: statements.length, sql: st.sql });
        const ok = await this.runStatement(s, st.sql, i, opts, results, token);
        if (token.cancelled) {
          cancelled = true;
          break;
        }
        if (!ok && opts.stopOnError !== false) break;
      }
    } finally {
      this.running.delete(sessionId);
    }
    return { results, totalMs: Date.now() - t0, cancelled, database: s.database };
  }

  private async runStatement(
    s: Session,
    sql: string,
    index: number,
    opts: ExecuteOptions,
    results: StatementResult[],
    token: RunToken
  ): Promise<boolean> {
    const startedAt = Date.now();
    let kill: Promise<void> | null = null;
    try {
      const raw = await s.run(sql, {
        maxRows: opts.maxRows ?? 0,
        onTruncate: () => {
          // stop the server from sending the remaining rows
          kill = this.sessions.killQuery(s).catch(() => undefined);
        }
      });
      if (kill) await kill;
      const durationMs = Date.now() - startedAt;
      let produced = 0;
      let rowCount = 0;
      for (const r of raw) {
        if (r.kind !== 'rows') continue;
        produced++;
        rowCount += r.rows.length;
        results.push({
          index,
          sql,
          kind: 'resultset',
          columns: r.fields.map(toResultColumn),
          rows: normalizeRows(r.rows),
          truncated: r.truncated,
          startedAt,
          durationMs
        });
      }
      const okPackets = raw.filter((r): r is RawOk => r.kind === 'ok');
      const last = okPackets[okPackets.length - 1];
      if (!produced) {
        const res: StatementResult = {
          index,
          sql,
          kind: 'ok',
          affectedRows: okPackets.reduce((a, r) => a + r.affectedRows, 0),
          changedRows: last?.changedRows,
          insertId: last?.insertId,
          warningCount: last?.warningStatus ?? 0,
          info: last?.info,
          startedAt,
          durationMs
        };
        if (res.warningCount) res.warnings = await this.warnings(s);
        results.push(res);
      }
      if (opts.history !== false) {
        this.history.add({
          connectionId: s.connectionId,
          connectionName: s.config.name,
          database: s.database,
          sql,
          durationMs,
          ok: true,
          affectedRows: produced ? undefined : okPackets.reduce((a, r) => a + r.affectedRows, 0),
          rows: produced ? rowCount : undefined
        });
      }
      return true;
    } catch (e) {
      if (kill) await kill;
      const durationMs = Date.now() - startedAt;
      const err = token.cancelled ? { ...toSqlError(e, sql), message: tr('Abgebrochen durch Benutzer', 'Cancelled by user') } : toSqlError(e, sql);
      results.push({ index, sql, kind: 'error', error: err, startedAt, durationMs });
      if (opts.history !== false) {
        this.history.add({
          connectionId: s.connectionId,
          connectionName: s.config.name,
          database: s.database,
          sql,
          durationMs,
          ok: false,
          error: err.message
        });
      }
      return false;
    }
  }

  private async warnings(s: Session): Promise<StatementResult['warnings']> {
    try {
      const r = await s.rowset('SHOW WARNINGS');
      return r.rows.map((row) => ({ level: String(row[0]), code: Number(row[1]), message: String(row[2]) }));
    } catch {
      return [];
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const token = this.running.get(sessionId);
    if (token) token.cancelled = true;
    const s = this.sessions.get(sessionId);
    if (s.isBusy) await this.sessions.killQuery(s);
  }
}
