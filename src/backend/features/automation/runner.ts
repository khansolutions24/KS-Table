// Execution of an automation job: steps in order, run record, e-mail notification.

import type { AutomationJob, JobStep, ProfileStep, RunRecord, RunTrigger, SqlStep } from '@shared/apis/automation';
import type { TaskLogEntry } from '@shared/types';
import { defaultStepName, profileKindLabel, runStatusLabel, triggerLabel } from '@shared/automation/labels';
import { tr } from '@shared/i18n';
import { splitStatements } from '@shared/sql/splitter';
import { formatDuration, formatNumber } from '@shared/util';
import type { BackendContext } from '../../api';
import { KsError } from '../../errors';
import { fsApi } from '../../fsApi';
import { getProfileRunner } from '../../profileRunners';
import { CancelledError, type TaskContext } from '../../tasks';
import { errorText } from '../backup/common';
import { runBackup } from '../backup/create';
import { createProfilesApi } from '../profiles';
import { sendRunMail } from './mail';
import { newRunId, saveRun } from './store';

const short = (sql: string): string => {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length > 90 ? `${one.slice(0, 87)}…` : one;
};

async function runSqlStep(ctx: BackendContext, step: SqlStep, t: TaskContext): Promise<string> {
  if (!step.connectionId) throw new KsError(tr('Es ist keine Verbindung ausgewählt.', 'No connection is selected.'));
  let sql = step.sql;
  if (step.source === 'file') {
    if (!step.file.trim()) throw new KsError(tr('Es ist keine SQL-Datei angegeben.', 'No SQL file is specified.'));
    sql = await fsApi.readText(step.file);
    t.log('info', tr('SQL-Datei: {f}', 'SQL file: {f}', { f: step.file }));
  }
  const statements = splitStatements(sql);
  if (!statements.length) throw new KsError(tr('Der Schritt enthält keine SQL-Anweisungen.', 'The step contains no SQL statements.'));
  const s = await ctx.sessions.open(step.connectionId, step.database || null);
  const onAbort = () => void ctx.runner.cancel(s.id).catch(() => undefined);
  t.signal.addEventListener('abort', onAbort);
  const verbose = statements.length <= 200;
  let affected = 0;
  try {
    for (const [i, st] of statements.entries()) {
      t.throwIfCancelled();
      t.progress(i / statements.length, `${i + 1}/${statements.length}`);
      const res = await ctx.runner.execute(s.id, st.sql, { noSplit: true, maxRows: 1000, history: false });
      if (res.cancelled || t.signal.aborted) throw new CancelledError();
      const err = res.results.find((r) => r.kind === 'error');
      if (err) {
        const e = err.error;
        throw new KsError(
          tr('Anweisung {i} ({q}): {m}', 'Statement {i} ({q}): {m}', { i: i + 1, q: short(st.sql), m: `${e?.message ?? ''}${e?.errno ? ` (${e.errno})` : ''}` })
        );
      }
      const a = res.results.reduce((acc, r) => acc + (r.affectedRows ?? 0), 0);
      const rows = res.results.reduce((acc, r) => acc + (r.rows?.length ?? 0), 0);
      affected += a;
      if (verbose) {
        const what = res.results.some((r) => r.kind === 'resultset')
          ? tr('{n} Zeilen', '{n} rows', { n: formatNumber(rows) })
          : tr('{n} Datensätze betroffen', '{n} records affected', { n: formatNumber(a) });
        t.log('info', `${i + 1}: ${short(st.sql)} – ${what}`);
      }
    }
  } finally {
    t.signal.removeEventListener('abort', onAbort);
    await ctx.sessions.close(s.id);
  }
  return tr('{n} Anweisungen ausgeführt, {a} Datensätze betroffen', '{n} statements executed, {a} records affected', {
    n: statements.length,
    a: formatNumber(affected)
  });
}

function describeResult(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const o = r as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.file === 'string') parts.push(o.file);
  const labels: Record<string, string> = {
    rows: tr('Datensätze', 'records'),
    objects: tr('Objekte', 'objects'),
    statements: tr('Anweisungen', 'statements'),
    errors: tr('Fehler', 'errors')
  };
  for (const [k, label] of Object.entries(labels)) if (typeof o[k] === 'number') parts.push(`${formatNumber(o[k] as number)} ${label}`);
  return parts.join(', ');
}

async function runProfileStep(ctx: BackendContext, step: ProfileStep, t: TaskContext): Promise<string> {
  const runner = getProfileRunner(step.profileKind);
  if (!runner) {
    throw new KsError(
      tr('Für Profile vom Typ „{k}“ ist in dieser Version kein Ausführungsmodul vorhanden.', 'No runner is available for profiles of type "{k}" in this version.', {
        k: profileKindLabel(step.profileKind)
      })
    );
  }
  if (!step.profileName) throw new KsError(tr('Es ist kein Profil ausgewählt.', 'No profile is selected.'));
  let data: unknown;
  try {
    data = await createProfilesApi().load(step.profileKind, step.profileName);
  } catch {
    throw new KsError(tr('Das Profil „{p}“ wurde nicht gefunden.', 'Profile "{p}" was not found.', { p: step.profileName }));
  }
  return describeResult(await runner(ctx, data, t));
}

async function runStep(ctx: BackendContext, step: JobStep, t: TaskContext): Promise<string> {
  switch (step.kind) {
    case 'sql':
      return runSqlStep(ctx, step, t);
    case 'backup': {
      if (!step.connectionId || !step.database) throw new KsError(tr('Verbindung oder Datenbank fehlt.', 'Connection or database is missing.'));
      const r = await runBackup(ctx, { connectionId: step.connectionId, database: step.database, options: step.options }, t);
      return describeResult(r);
    }
    default:
      return runProfileStep(ctx, step, t);
  }
}

/** Runs all enabled steps, sends the notification and stores the run record. Never throws for step errors. */
export async function executeJob(ctx: BackendContext, job: AutomationJob, trigger: RunTrigger, t: TaskContext): Promise<RunRecord> {
  const started = Date.now();
  const rec: RunRecord = {
    runId: newRunId(started),
    jobId: job.id,
    jobName: job.name,
    trigger,
    status: 'running',
    startedAt: started,
    endedAt: null,
    message: '',
    steps: [],
    mail: '',
    log: []
  };
  const log = (level: TaskLogEntry['level'], message: string) => {
    t.log(level, message);
    rec.log.push({ time: Date.now(), level, message });
  };
  const connName = (id: string) => {
    try {
      return ctx.connections.get(id).name;
    } catch {
      return id;
    }
  };
  log('info', tr('Auftrag „{j}“ gestartet ({t})', 'Job "{j}" started ({t})', { j: job.name, t: triggerLabel(trigger) }));
  const active = job.steps.filter((s) => s.enabled);
  if (!active.length) log('warn', tr('Der Auftrag enthält keine aktiven Schritte.', 'The job contains no active steps.'));

  let failed = 0;
  let succeeded = 0;
  let aborted = false;
  let cancelled = false;
  let index = 0;
  let firstError = '';
  for (const step of job.steps) {
    const name = step.name.trim() || defaultStepName(step, connName);
    if (!step.enabled) {
      rec.steps.push({ stepId: step.id, name, status: 'skipped', message: tr('Deaktiviert', 'Disabled'), durationMs: 0 });
      continue;
    }
    if (aborted || cancelled || t.signal.aborted) {
      cancelled = cancelled || t.signal.aborted;
      rec.steps.push({
        stepId: step.id,
        name,
        status: cancelled ? 'cancelled' : 'skipped',
        message: cancelled ? tr('Abgebrochen', 'Cancelled') : tr('Nicht ausgeführt', 'Not executed'),
        durationMs: 0
      });
      continue;
    }
    const i = index++;
    log('info', tr('Schritt {i}/{n}: {s}', 'Step {i}/{n}: {s}', { i: i + 1, n: active.length, s: name }));
    const sub: TaskContext = {
      taskId: t.taskId,
      signal: t.signal,
      log,
      progress: (v, m) => t.progress(v === null ? null : (i + Math.min(1, Math.max(0, v))) / active.length, m ?? name),
      throwIfCancelled: () => t.throwIfCancelled()
    };
    sub.progress(0);
    const t0 = Date.now();
    try {
      const message = await runStep(ctx, step, sub);
      succeeded++;
      rec.steps.push({ stepId: step.id, name, status: 'success', message, durationMs: Date.now() - t0 });
      log('success', tr('Schritt „{s}“ abgeschlossen ({d})', 'Step "{s}" finished ({d})', { s: name, d: formatDuration(Date.now() - t0) }));
    } catch (e) {
      if (e instanceof CancelledError || t.signal.aborted) {
        cancelled = true;
        rec.steps.push({ stepId: step.id, name, status: 'cancelled', message: tr('Abgebrochen', 'Cancelled'), durationMs: Date.now() - t0 });
        log('warn', tr('Schritt „{s}“ abgebrochen', 'Step "{s}" cancelled', { s: name }));
        continue;
      }
      failed++;
      const m = errorText(e);
      if (!firstError) firstError = `${name}: ${m}`;
      rec.steps.push({ stepId: step.id, name, status: 'error', message: m, durationMs: Date.now() - t0 });
      log('error', tr('Schritt „{s}“ fehlgeschlagen: {m}', 'Step "{s}" failed: {m}', { s: name, m }));
      if (!step.continueOnError) {
        aborted = true;
        log('error', tr('Der Auftrag wird nach diesem Fehler beendet.', 'The job stops after this error.'));
      }
    }
  }

  rec.endedAt = Date.now();
  rec.status = cancelled ? 'cancelled' : failed === 0 ? 'success' : aborted || succeeded === 0 ? 'error' : 'warning';
  rec.message =
    rec.status === 'success'
      ? tr('{n} Schritte erfolgreich ausgeführt', '{n} steps executed successfully', { n: succeeded })
      : rec.status === 'cancelled'
        ? tr('Abgebrochen', 'Cancelled')
        : rec.status === 'warning'
          ? tr('{f} von {n} Schritten fehlgeschlagen – {e}', '{f} of {n} steps failed – {e}', { f: failed, n: failed + succeeded, e: firstError })
          : firstError || tr('Fehlgeschlagen', 'Failed');
  const level = rec.status === 'success' ? 'success' : rec.status === 'error' ? 'error' : 'warn';
  log(level, tr('Auftrag „{j}“ beendet: {s} ({d})', 'Job "{j}" finished: {s} ({d})', { j: job.name, s: runStatusLabel(rec.status), d: formatDuration(rec.endedAt - started) }));

  const em = job.email;
  if (em.enabled && ((rec.status === 'success' && em.onSuccess) || (rec.status !== 'success' && em.onFailure))) {
    try {
      rec.mail = await sendRunMail(job, rec);
      log('info', rec.mail);
    } catch (e) {
      rec.mail = tr('E-Mail-Versand fehlgeschlagen: {m}', 'Sending the e-mail failed: {m}', { m: errorText(e) });
      log('warn', rec.mail);
    }
  }
  try {
    await saveRun(rec);
  } catch (e) {
    t.log('warn', tr('Das Ausführungsprotokoll konnte nicht gespeichert werden: {m}', 'The run log could not be saved: {m}', { m: errorText(e) }));
  }
  return rec;
}
