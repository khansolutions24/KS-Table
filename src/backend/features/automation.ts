// Automation (namespace api.automation): batch jobs, in-app scheduler, Windows task scheduler,
// e-mail notification and the headless mode `KS Table --run-job <id>` (see src/main/index.ts).

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AutomationApi,
  AutomationEnvironment,
  AutomationJob,
  JobListItem,
  RunRecord,
  RunSummary,
  RunTrigger,
  SaveJobResult,
  WindowsTaskState
} from '@shared/apis/automation';
import { runStatusLabel } from '@shared/automation/labels';
import { nextRun, parseLocal } from '@shared/automation/schedule';
import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';
import { formatDateTime } from '@shared/util';
import type { BackendContext } from '../api';
import { KsError } from '../errors';
import { profileRunnerKinds } from '../profileRunners';
import { CancelledError, type TaskContext } from '../tasks';
import { errorText } from './backup/common';
import { sendTestMail } from './automation/mail';
import { executeJob } from './automation/runner';
import {
  acquireLock,
  automationDir,
  checkJobId,
  clearRunFiles,
  deleteJobFiles,
  lastRun,
  listJobs,
  listRuns,
  loadJob,
  loadRun,
  normalizeJob,
  saveJobFile
} from './automation/store';
import { deleteTask, formatCommand, launchCommand, registerTask, schtasksAvailable, taskExists, taskNameFor, taskXml } from './automation/windows';

const TICK_MS = 20_000;

const summaryOf = (rec: RunRecord): RunSummary => {
  const { log: _log, ...summary } = rec;
  return summary;
};

class AutomationService {
  /** jobId → task id of runs in this process */
  private readonly running = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private lastTick = Date.now();

  constructor(private readonly ctx: BackendContext) {}

  /** Starts jobs whose schedule (runner "app") became due since the previous check. */
  startScheduler(): void {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const since = this.lastTick;
    this.lastTick = now;
    let jobs: AutomationJob[];
    try {
      jobs = await listJobs();
    } catch {
      return;
    }
    for (const job of jobs) {
      const sc = job.schedule;
      if (!sc.enabled || sc.runner !== 'app' || this.running.has(job.id) || !job.steps.length) continue;
      const due = nextRun(sc, since);
      if (due !== null && due <= now) this.start(job, 'schedule');
    }
  }

  private async execute(job: AutomationJob, trigger: RunTrigger, t: TaskContext): Promise<RunRecord> {
    const release = await acquireLock(job.id);
    if (!release) {
      throw new KsError(tr('Der Auftrag „{j}“ wird bereits von einem anderen Prozess ausgeführt.', 'Job "{j}" is already being run by another process.', { j: job.name }));
    }
    try {
      return await executeJob(this.ctx, job, trigger, t);
    } finally {
      await release();
    }
  }

  /** Runs the job as a background task (progress + log in the task panel); returns the task id. */
  start(job: AutomationJob, trigger: RunTrigger): string {
    const existing = this.running.get(job.id);
    if (existing) return existing;
    const taskId = this.ctx.tasks.start('automation', tr('Automatisierung – {j}', 'Automation – {j}', { j: job.name }), async (t) => {
      try {
        const rec = await this.execute(job, trigger, t);
        if (rec.status === 'cancelled') throw new CancelledError();
        if (rec.status === 'error') throw new KsError(rec.message);
        return summaryOf(rec);
      } finally {
        this.running.delete(job.id);
      }
    });
    this.running.set(job.id, taskId);
    return taskId;
  }

  /** Headless run: resolves with the run record (or the error that prevented the run). */
  runAndWait(job: AutomationJob, trigger: RunTrigger): Promise<RunRecord | Error> {
    return new Promise((resolve) => {
      this.ctx.tasks.start('automation', tr('Automatisierung – {j}', 'Automation – {j}', { j: job.name }), async (t) => {
        try {
          const rec = await this.execute(job, trigger, t);
          resolve(rec);
          return summaryOf(rec);
        } catch (e) {
          resolve(e instanceof Error ? e : new Error(String(e)));
          throw e;
        }
      });
    });
  }

  async list(): Promise<JobListItem[]> {
    const now = Date.now();
    const jobs = await listJobs();
    return Promise.all(
      jobs.map(async (job) => ({
        job,
        lastRun: await lastRun(job.id).catch(() => null),
        nextRun: job.schedule.enabled ? nextRun(job.schedule, now) : null,
        taskId: this.running.get(job.id) ?? null
      }))
    );
  }

  async save(input: AutomationJob): Promise<SaveJobResult> {
    const job = normalizeJob(input);
    if (!job.id) job.id = newId('j');
    checkJobId(job.id);
    job.name = job.name.trim();
    if (!job.name) throw new KsError(tr('Bitte einen Namen für den Auftrag angeben.', 'Please enter a name for the job.'));
    if (job.schedule.enabled && !parseLocal(job.schedule.start)) {
      throw new KsError(tr('Der Startzeitpunkt des Zeitplans ist ungültig.', 'The start time of the schedule is invalid.'));
    }
    const prev = await loadJob(job.id).catch(() => null);
    job.createdAt = prev?.createdAt ?? Date.now();
    job.updatedAt = Date.now();
    job.windowsTask = prev?.windowsTask ?? null;
    let windowsError: string | null = null;
    const wanted = job.schedule.enabled && job.schedule.runner === 'windows';
    try {
      if (wanted) {
        const cmd = launchCommand();
        if ('error' in cmd) throw new KsError(cmd.error);
        if (!schtasksAvailable()) throw new KsError(tr('schtasks.exe wurde nicht gefunden.', 'schtasks.exe was not found.'));
        const name = taskNameFor(job);
        if (job.windowsTask && job.windowsTask !== name) await deleteTask(job.windowsTask);
        await registerTask(name, taskXml(job, cmd));
        job.windowsTask = name;
      } else if (job.windowsTask) {
        await deleteTask(job.windowsTask);
        job.windowsTask = null;
      }
    } catch (e) {
      windowsError = errorText(e);
    }
    await saveJobFile(job);
    return { job, windowsError };
  }

  async remove(id: string): Promise<void> {
    const job = await loadJob(id).catch(() => null);
    if (job?.windowsTask) await deleteTask(job.windowsTask);
    await deleteJobFiles(id);
  }

  async windowsTaskState(id: string): Promise<WindowsTaskState | null> {
    const job = await loadJob(id);
    if (!job.windowsTask) return null;
    return { name: job.windowsTask, exists: await taskExists(job.windowsTask) };
  }

  environment(): AutomationEnvironment {
    const cmd = launchCommand();
    const reason = 'error' in cmd ? cmd.error : !schtasksAvailable() ? tr('schtasks.exe wurde nicht gefunden.', 'schtasks.exe was not found.') : '';
    return {
      windowsTasks: !reason,
      windowsReason: reason,
      launchCommand: 'error' in cmd ? '' : formatCommand(cmd, '<id>'),
      folder: automationDir()
    };
  }
}

let service: AutomationService | null = null;

export function createAutomationApi(ctx: BackendContext): AutomationApi {
  const svc = new AutomationService(ctx);
  service = svc;
  // the headless instance only runs its own job
  if (!process.argv.includes('--run-job')) svc.startScheduler();
  return {
    list: () => svc.list(),
    get: (id) => loadJob(id),
    save: (job) => svc.save(job),
    remove: (id) => svc.remove(id),
    run: async (id) => svc.start(await loadJob(id), 'manual'),
    runs: (id) => listRuns(checkJobId(id)),
    runLog: (id, runId) => loadRun(checkJobId(id), runId),
    clearRuns: (id) => clearRunFiles(checkJobId(id)),
    profileKinds: async () => profileRunnerKinds(),
    windowsTask: (id) => svc.windowsTaskState(id),
    environment: async () => svc.environment(),
    sendTestMail: (to, smtp) => sendTestMail(to, smtp)
  };
}

/**
 * Headless mode (`--run-job <id>`, started by the Windows task scheduler): runs the job, stores the
 * run record and a line in automation/cmdline.log and returns the process exit code (0 = success).
 */
export async function runJobHeadless(ctx: BackendContext, jobId: string): Promise<number> {
  const svc = service ?? new AutomationService(ctx);
  const note = async (msg: string) => {
    try {
      await fs.mkdir(automationDir(), { recursive: true });
      await fs.appendFile(path.join(automationDir(), 'cmdline.log'), `${formatDateTime(Date.now())}  [${process.pid}]  ${msg}\r\n`, 'utf8');
    } catch {
      // logging must not change the exit code
    }
  };
  let job: AutomationJob;
  try {
    job = await loadJob(jobId);
  } catch (e) {
    await note(`--run-job ${jobId}: ${errorText(e)}`);
    return 1;
  }
  await note(tr('Auftrag „{j}“ gestartet', 'Job "{j}" started', { j: job.name }));
  const res = await svc.runAndWait(job, 'windows');
  if (res instanceof Error) {
    await note(`${job.name}: ${res.message}`);
    return 1;
  }
  await note(`${job.name}: ${runStatusLabel(res.status)} – ${res.message}`);
  return res.status === 'success' ? 0 : 1;
}
