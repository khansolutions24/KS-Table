// Execute SQL file: streams huge scripts statement by statement.

import type { ExecSqlFileProfile, ExecSqlFileResult } from '@shared/apis/io';
import { tr } from '@shared/i18n';
import { formatBytes, formatDuration, formatNumber } from '@shared/util';
import { SqlStreamSplitter, type StreamStatement } from '@shared/io/sqlStream';
import type { BackendContext } from '../../api';
import type { TaskContext } from '../../tasks';
import { KsError, isFatalConnectionError, toSqlError } from '../../errors';
import { fileSize, readTextChunks } from './files';

const MAX_ERROR_LOG = 500;

export function normalizeExecProfile(p: ExecSqlFileProfile): ExecSqlFileProfile {
  if (!p || typeof p !== 'object') throw new KsError(tr('Ungültiges Profil.', 'Invalid profile.'));
  const out: ExecSqlFileProfile = {
    version: 1,
    connectionId: String(p.connectionId ?? ''),
    database: p.database || null,
    files: Array.isArray(p.files) ? p.files.filter(Boolean) : [],
    encoding: p.encoding || 'auto',
    continueOnError: !!p.continueOnError,
    transactionMode: p.transactionMode ?? 'autocommit'
  };
  if (!out.connectionId) throw new KsError(tr('Keine Verbindung angegeben.', 'No connection specified.'));
  if (!out.files.length) throw new KsError(tr('Keine SQL-Datei angegeben.', 'No SQL file specified.'));
  return out;
}

function preview(sql: string): string {
  const one = sql.replace(/\s+/g, ' ');
  return one.length > 160 ? `${one.slice(0, 160)} …` : one;
}

export async function runExecSqlFile(ctx: BackendContext, profile: ExecSqlFileProfile, t: TaskContext): Promise<ExecSqlFileResult> {
  const p = normalizeExecProfile(profile);
  const t0 = Date.now();
  let total = 0;
  for (const f of p.files) total += await fileSize(f);
  const s = await ctx.sessions.open(p.connectionId, p.database);
  let statements = 0;
  let errors = 0;
  let bytesDone = 0;
  let inTx = false;
  const onAbort = () => {
    if (s.isBusy) void ctx.sessions.killQuery(s).catch(() => undefined);
  };
  t.signal.addEventListener('abort', onAbort);
  try {
    if (p.transactionMode === 'noAutocommit') await s.exec('SET autocommit = 0');
    if (p.transactionMode === 'transaction') await s.exec('START TRANSACTION');
    inTx = p.transactionMode !== 'autocommit';
    let lastReport = 0;
    const report = (file: string, fileBytes: number) => {
      const now = Date.now();
      if (now - lastReport < 150) return;
      lastReport = now;
      t.progress(
        total ? Math.min(0.999, (bytesDone + fileBytes) / total) : null,
        tr('{n} Anweisungen · {b} von {t} · {e} Fehler · {f}', '{n} statements · {b} of {t} · {e} errors · {f}', {
          n: formatNumber(statements),
          b: formatBytes(bytesDone + fileBytes),
          t: formatBytes(total),
          e: errors,
          f: file.split(/[\\/]/).pop() ?? file
        })
      );
    };
    for (const file of p.files) {
      t.throwIfCancelled();
      const name = file.split(/[\\/]/).pop() ?? file;
      t.log('info', tr('Führe {f} aus ({s}) …', 'Executing {f} ({s}) …', { f: name, s: formatBytes(await fileSize(file)) }));
      const splitter = new SqlStreamSplitter();
      let fileBytes = 0;
      const before = { statements, errors };
      const exec = async (list: StreamStatement[]) => {
        for (const st of list) {
          t.throwIfCancelled();
          statements++;
          try {
            await s.run(st.sql, { maxRows: 1 });
          } catch (e) {
            t.throwIfCancelled();
            errors++;
            const err = toSqlError(e);
            const msg = tr('{f}, Zeile {l}: {m}', '{f}, line {l}: {m}', { f: name, l: st.line, m: err.message });
            if (errors <= MAX_ERROR_LOG) t.log('error', `${msg}\n  ${preview(st.sql)}`);
            else if (errors === MAX_ERROR_LOG + 1) t.log('warn', tr('Weitere Fehler werden nicht mehr einzeln protokolliert.', 'Further errors are not logged individually.'));
            const fatal = isFatalConnectionError(e) || (inTx && (err.errno === 1213 || err.errno === 1205));
            if (!p.continueOnError || fatal) throw new KsError(msg);
          }
          report(file, fileBytes);
        }
      };
      for await (const chunk of readTextChunks(file, p.encoding, (n) => (fileBytes += n))) {
        await exec(splitter.feed(chunk));
      }
      await exec(splitter.end());
      bytesDone += fileBytes;
      t.log(
        'info',
        tr('{f}: {n} Anweisungen, {e} Fehler', '{f}: {n} statements, {e} errors', { f: name, n: formatNumber(statements - before.statements), e: errors - before.errors })
      );
    }
    if (inTx) {
      await s.exec('COMMIT');
      inTx = false;
    }
    const durationMs = Date.now() - t0;
    t.log(
      errors ? 'warn' : 'success',
      tr('Fertig: {n} Anweisungen, {e} Fehler, {b} in {d}.', 'Finished: {n} statements, {e} errors, {b} in {d}.', {
        n: formatNumber(statements),
        e: errors,
        b: formatBytes(bytesDone),
        d: formatDuration(durationMs)
      })
    );
    return { files: p.files.length, statements, errors, bytes: bytesDone, durationMs };
  } catch (e) {
    if (inTx) {
      await s.exec('ROLLBACK').catch(() => undefined);
      t.log('warn', tr('Die Transaktion wurde zurückgesetzt.', 'The transaction was rolled back.'));
    }
    throw e;
  } finally {
    t.signal.removeEventListener('abort', onAbort);
    await ctx.sessions.close(s.id);
  }
}
