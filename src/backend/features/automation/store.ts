// Job files, run history and run locks of the automation feature.
//   <profilesDir>/automation/<jobId>.json                     job
//   <profilesDir>/automation/runs/<jobId>/<runId>.json        run summary
//   <profilesDir>/automation/runs/<jobId>/<runId>.log.json    run log
//   <profilesDir>/automation/locks/<jobId>.lock               running job (pid), prevents parallel runs

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AutomationJob, JobStep, RunRecord, RunSummary, ScheduleType } from '@shared/apis/automation';
import { defaultEmail, defaultSchedule } from '@shared/automation/schedule';
import { normalizeBackupOptions } from '@shared/backup/options';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { runStatusLabel, stepStatusLabel, triggerLabel } from '@shared/automation/labels';
import { deepMerge, formatDateTime } from '@shared/util';
import type { BackupOptions } from '@shared/apis/backup';
import { KsError } from '../../errors';
import { profilesDir } from '../../store/settings';
import { readJson, writeJson } from '../../util/jsonFile';

const MAX_RUNS = 100;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const RUN_RE = /^\d{14}-[a-z0-9]{1,12}$/;
const TYPES: ScheduleType[] = ['once', 'minutes', 'hourly', 'daily', 'weekly', 'monthly'];

export const automationDir = (): string => path.join(profilesDir(), 'automation');

export function checkJobId(id: string): string {
  if (!ID_RE.test(id ?? '')) throw new KsError(tr('Ungültige Auftrags-ID', 'Invalid job id'));
  return id;
}

const jobFile = (id: string) => path.join(automationDir(), `${checkJobId(id)}.json`);
const runsDir = (id: string) => path.join(automationDir(), 'runs', checkJobId(id));

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function normalizeStep(raw: unknown): JobStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  const base = { id: str(r.id) || newId('s'), name: str(r.name), enabled: r.enabled !== false, continueOnError: !!r.continueOnError };
  switch (r.kind) {
    case 'sql':
      return { ...base, kind: 'sql', connectionId: str(r.connectionId), database: str(r.database), source: r.source === 'file' ? 'file' : 'text', sql: str(r.sql), file: str(r.file) };
    case 'backup':
      return { ...base, kind: 'backup', connectionId: str(r.connectionId), database: str(r.database), options: normalizeBackupOptions(r.options as Partial<BackupOptions>) };
    case 'profile':
      return { ...base, kind: 'profile', profileKind: str(r.profileKind), profileName: str(r.profileName) };
    default:
      return null;
  }
}

export function normalizeJob(raw: unknown): AutomationJob {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const now = Date.now();
  const schedule = deepMerge(defaultSchedule(), r.schedule ?? {});
  schedule.weekdays = Array.isArray(schedule.weekdays) ? [...new Set(schedule.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
  schedule.monthDays = Array.isArray(schedule.monthDays) ? [...new Set(schedule.monthDays.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 31))] : [];
  schedule.interval = Math.max(1, Math.min(9999, Math.floor(Number(schedule.interval) || 1)));
  if (!TYPES.includes(schedule.type)) schedule.type = 'daily';
  if (schedule.runner !== 'windows') schedule.runner = 'app';
  schedule.enabled = !!schedule.enabled;
  schedule.end = /^\d{4}-\d{2}-\d{2}$/.test(str(schedule.end)) ? str(schedule.end) : '';
  const email = deepMerge(defaultEmail(), r.email ?? {});
  return {
    id: str(r.id),
    name: str(r.name),
    description: str(r.description),
    steps: Array.isArray(r.steps) ? r.steps.map(normalizeStep).filter((s): s is JobStep => !!s) : [],
    schedule,
    email,
    windowsTask: typeof r.windowsTask === 'string' && r.windowsTask ? r.windowsTask : null,
    createdAt: Number(r.createdAt) || now,
    updatedAt: Number(r.updatedAt) || now
  };
}

export async function listJobs(): Promise<AutomationJob[]> {
  let names: string[];
  try {
    names = await fs.readdir(automationDir());
  } catch {
    return [];
  }
  const jobs: AutomationJob[] = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.json')) continue;
    const raw = await readJson<unknown>(path.join(automationDir(), n), null);
    if (!raw) continue;
    const job = normalizeJob(raw);
    if (ID_RE.test(job.id) && `${job.id}.json`.toLowerCase() === n.toLowerCase()) jobs.push(job);
  }
  return jobs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadJob(id: string): Promise<AutomationJob> {
  const raw = await readJson<unknown>(jobFile(id), null);
  if (!raw) throw new KsError(tr('Der Auftrag wurde nicht gefunden.', 'The job was not found.'), 'NOT_FOUND');
  return normalizeJob(raw);
}

export function saveJobFile(job: AutomationJob): Promise<void> {
  return writeJson(jobFile(job.id), job);
}

export async function deleteJobFiles(id: string): Promise<void> {
  await fs.rm(jobFile(id), { force: true });
  await fs.rm(runsDir(id), { recursive: true, force: true });
}

// ───────────────────────── Runs ─────────────────────────

export function newRunId(time: number = Date.now()): string {
  return `${String(time).padStart(14, '0')}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runIds(jobId: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(runsDir(jobId));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.endsWith('.log.json'))
    .map((n) => n.slice(0, -5))
    .filter((n) => RUN_RE.test(n))
    .sort();
}

export async function saveRun(rec: RunRecord): Promise<void> {
  const dir = runsDir(rec.jobId);
  const { log, ...summary } = rec;
  await writeJson(path.join(dir, `${rec.runId}.log.json`), log);
  await writeJson(path.join(dir, `${rec.runId}.json`), summary);
  const ids = await runIds(rec.jobId);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_RUNS))) {
    await fs.rm(path.join(dir, `${id}.json`), { force: true });
    await fs.rm(path.join(dir, `${id}.log.json`), { force: true });
  }
}

export async function listRuns(jobId: string): Promise<RunSummary[]> {
  const out: RunSummary[] = [];
  for (const id of (await runIds(jobId)).reverse()) {
    const s = await readJson<RunSummary | null>(path.join(runsDir(jobId), `${id}.json`), null);
    if (s) out.push(s);
  }
  return out;
}

export async function lastRun(jobId: string): Promise<RunSummary | null> {
  const ids = await runIds(jobId);
  const id = ids[ids.length - 1];
  return id ? readJson<RunSummary | null>(path.join(runsDir(jobId), `${id}.json`), null) : null;
}

export async function loadRun(jobId: string, runId: string): Promise<RunRecord> {
  if (!RUN_RE.test(runId)) throw new KsError(tr('Ungültige Lauf-ID', 'Invalid run id'));
  const s = await readJson<RunSummary | null>(path.join(runsDir(jobId), `${runId}.json`), null);
  if (!s) throw new KsError(tr('Das Ausführungsprotokoll wurde nicht gefunden.', 'The run log was not found.'), 'NOT_FOUND');
  const log = await readJson<RunRecord['log']>(path.join(runsDir(jobId), `${runId}.log.json`), []);
  return { ...s, log };
}

export async function clearRunFiles(jobId: string): Promise<void> {
  await fs.rm(runsDir(jobId), { recursive: true, force: true });
}

const LEVEL: Record<string, string> = { info: 'INFO ', warn: 'WARN ', error: 'FEHLER', success: 'OK   ' };

/** Plain text log of a run (e-mail attachment) */
export function runLogText(rec: RunRecord): string {
  const head = [
    `KS Table – ${tr('Automatisierung', 'Automation')}`,
    `${tr('Auftrag', 'Job')}: ${rec.jobName}`,
    `${tr('Status', 'Status')}: ${runStatusLabel(rec.status)}`,
    `${tr('Start', 'Start')}: ${formatDateTime(rec.startedAt)} (${triggerLabel(rec.trigger)})`,
    `${tr('Ende', 'End')}: ${rec.endedAt ? formatDateTime(rec.endedAt) : '–'}`,
    '',
    ...rec.steps.map((s) => `- ${s.name}: ${stepStatusLabel(s.status)}${s.message ? ` – ${s.message}` : ''}`),
    '',
    ''
  ];
  const lines = rec.log.map((l) => `${formatDateTime(l.time)}  ${LEVEL[l.level] ?? l.level}  ${l.message}`);
  return [...head, ...lines].join('\r\n');
}

// ───────────────────────── Locks ─────────────────────────

const lockFile = (id: string) => path.join(automationDir(), 'locks', `${checkJobId(id)}.lock`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/** Takes the run lock of a job; returns the release function or null when another process runs the job. */
export async function acquireLock(jobId: string): Promise<(() => Promise<void>) | null> {
  const file = lockFile(jobId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await fs.open(file, 'wx');
      await h.writeFile(JSON.stringify({ pid: process.pid, time: Date.now() }));
      await h.close();
      return () => fs.rm(file, { force: true });
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      const info = await readJson<{ pid?: number; time?: number }>(file, {});
      const fresh = Date.now() - Number(info.time ?? 0) < 24 * 3_600_000;
      if (info.pid && info.pid !== process.pid && alive(info.pid) && fresh) return null;
      await fs.rm(file, { force: true });
    }
  }
  return null;
}
